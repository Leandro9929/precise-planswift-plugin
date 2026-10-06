# Renames PlanSwift pages through PlanSwift's COM interface (never by editing job files).
# Input: JSON { entries: [{ id, oldName, newName }], label, checkTakeoff, takeoffSeconds }
# Output: JSON report in -OutFile; one JSON line per page state change in -ProgressFile.
param(
  [Parameter(Mandatory = $true)][string]$InputFile,
  [Parameter(Mandatory = $true)][string]$OutFile,
  [string]$ProgressFile = ''
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')
if ($env:PRECISE_BRIDGE_MOCK) { . $env:PRECISE_BRIDGE_MOCK }

$report = [ordered]@{
  ok = $false; error = ''; connection = ''; jobName = ''; rolledBack = $false; timings = @()
  results = @(); propertyChanges = @(); propertyPages = 0; takeoffChanges = @(); takeoffItems = 0; takeoffComplete = $false
}
$results = [ordered]@{}

# Each step is written to the progress file as it starts, so a stall can be traced to its step.
$clock = [Diagnostics.Stopwatch]::StartNew()
$timings = New-Object System.Collections.ArrayList
$phaseName = ''
$phaseStart = 0
function Enter-Phase([string]$Name) {
  if ($script:phaseName) {
    [void]$script:timings.Add([pscustomobject]@{ phase = $script:phaseName; ms = [int]($script:clock.ElapsedMilliseconds - $script:phaseStart) })
  }
  $script:phaseName = $Name
  $script:phaseStart = $script:clock.ElapsedMilliseconds
  if ($Name) { Add-JsonLine $ProgressFile @{ phase = $Name; ms = [int]$script:clock.ElapsedMilliseconds } }
}

function Set-Result($Entry, [string]$Status, [string]$Name, [string]$Message = '') {
  $results[(Format-Guid $Entry.id)] = [pscustomobject]@{
    id = [string]$Entry.id; oldName = [string]$Entry.oldName; newName = [string]$Entry.newName
    status = $Status; currentName = $Name; message = $Message
  }
}

try {
  $request = Read-JsonFile $InputFile
  $entries = @($request.entries)
  $label = if ($request.label) { [string]$request.label } else { 'Precise Page Renamer' }
  if (-not $entries.Count) { throw 'Nothing to rename.' }
  $seen = @{}
  foreach ($e in $entries) {
    Assert-PageName ([string]$e.newName)
    $key = ([string]$e.newName).ToUpperInvariant()
    if ($seen.ContainsKey($key)) { throw "Two pages would both be named $($e.newName)." }
    $seen[$key] = $true
  }

  Enter-Phase 'connecting to PlanSwift'
  $connection = Connect-PlanSwift
  $app = $connection.App
  $report.connection = $connection.How
  Enter-Phase 'finding the pages in the open job'
  $info = Get-JobPagesItem $app
  $report.jobName = $info.JobName
  $items = Resolve-Pages $info ([string[]]@($entries | ForEach-Object { [string]$_.id }))

  $targets = New-Object System.Collections.ArrayList
  foreach ($e in $entries) {
    $item = $items[(Format-Guid $e.id)]
    if ($null -eq $item) { throw "Page '$($e.oldName)' was not found in the job open in PlanSwift. Reload and scan again." }
    $current = [string](Com-Get $item 'Name')
    if ($current -cne [string]$e.oldName) { throw "Page '$($e.oldName)' is now named '$current' in PlanSwift. Reload and scan again." }
    Set-Result $e 'not-attempted' $current
    [void]$targets.Add([pscustomobject]@{ Entry = $e; Item = $item; Before = $null })
  }

  # A sample of pages is enough to show a rename leaves page properties (scale and so on) alone;
  # every page is renamed by the same call.
  Enter-Phase 'reading page properties'
  $sampleClock = [Diagnostics.Stopwatch]::StartNew()
  foreach ($t in $targets) {
    if ($report.propertyPages -ge 3 -or ($report.propertyPages -ge 1 -and $sampleClock.Elapsed.TotalSeconds -ge 8)) { break }
    $t.Before = Get-PropertySnapshot $t.Item
    $report.propertyPages++
  }

  $fingerprint = $null
  if ($request.checkTakeoff -ne $false) {
    Enter-Phase 'reading takeoff quantities'
    $budget = if ($request.takeoffSeconds) { [double]$request.takeoffSeconds } else { 15 }
    $fingerprint = Get-TakeoffFingerprint $app $info.RootPath -Seconds $budget
    $report.takeoffItems = $fingerprint.Items.Count
    $report.takeoffComplete = $fingerprint.Complete
  }

  $done = New-Object System.Collections.ArrayList
  $failure = ''
  Enter-Phase 'starting the PlanSwift change group'
  [void](Com-Get $app 'NewChangeGroup' @($label))
  Enter-Phase 'renaming pages'
  try {
    foreach ($t in $targets) {
      $new = [string]$t.Entry.newName
      Com-Set $t.Item 'Name' $new
      [void]$done.Add($t)
      $actual = [string](Com-Get $t.Item 'Name')
      Add-JsonLine $ProgressFile @{ id = [string]$t.Entry.id; name = $actual }
      Set-Result $t.Entry 'renamed' $actual
      if ((Format-Guid (Com-Get $t.Item 'GUID')) -ne (Format-Guid $t.Entry.id)) { throw "PlanSwift reported a different page ID after renaming '$new'." }
      if ($actual -cne $new) { throw "PlanSwift stored '$actual' instead of '$new'." }
    }
    Enter-Phase 'saving the changes in PlanSwift'
    [void](Com-Get $app 'PostChanges')

    Enter-Phase 'checking page properties'
    $propertyChanges = New-Object System.Collections.ArrayList
    foreach ($t in @($done | Where-Object { $null -ne $_.Before })) {
      foreach ($c in (Compare-PageSnapshot $t.Before (Get-PropertySnapshot $t.Item) $t.Entry.oldName $t.Entry.newName)) {
        [void]$propertyChanges.Add("$($t.Entry.newName): $c")
      }
    }
    $report.propertyChanges = @($propertyChanges)
    if ($propertyChanges.Count) { throw "Page properties other than the name changed: $($propertyChanges[0])" }

    if ($null -ne $fingerprint) {
      Enter-Phase 'checking takeoff quantities'
      $diff = @(Compare-Fingerprint $fingerprint (Get-TakeoffRecheck $fingerprint ($budget * 2)))
      if ($diff.Count) {
        Start-Sleep -Seconds 2
        $diff = @(Compare-Fingerprint $fingerprint (Get-TakeoffRecheck $fingerprint ($budget * 2)))
      }
      $report.takeoffChanges = $diff
      if ($diff.Count) { throw "Takeoff quantities changed during the rename ($($diff.Count) items)." }
    }
  } catch {
    $failure = Get-ErrorText $_
  }

  if ($failure) {
    Enter-Phase 'setting the previous names back'
    $report.rolledBack = $true
    try { [void](Com-Get $app 'NewChangeGroup' @($label + ' (restore)')) } catch { }
    for ($i = $done.Count - 1; $i -ge 0; $i--) {
      $t = $done[$i]
      try {
        Com-Set $t.Item 'Name' ([string]$t.Entry.oldName)
        $actual = [string](Com-Get $t.Item 'Name')
        Add-JsonLine $ProgressFile @{ id = [string]$t.Entry.id; name = $actual }
        $status = if ($actual -ceq [string]$t.Entry.oldName) { 'restored' } else { 'restore-failed' }
        Set-Result $t.Entry $status $actual
      } catch {
        Set-Result $t.Entry 'restore-failed' ([string]$t.Entry.newName) (Get-ErrorText $_)
      }
    }
    try { [void](Com-Get $app 'PostChanges') } catch { }
    $stuck = @($results.Values | Where-Object { $_.status -eq 'restore-failed' })
    if ($stuck.Count) { throw "$failure $($stuck.Count) page(s) could not be set back; check them in PlanSwift: $(($stuck | ForEach-Object currentName) -join ', ')" }
    if ($done.Count) { throw "$failure Changed pages were set back to their previous names." }
    throw $failure
  }
  $report.ok = $true
} catch {
  $report.error = Get-ErrorText $_
} finally {
  Enter-Phase ''
  $report.timings = @($timings)
  $report.results = @($results.Values)
  Write-JsonFile $OutFile $report
}
if (-not $report.ok) { exit 1 }
