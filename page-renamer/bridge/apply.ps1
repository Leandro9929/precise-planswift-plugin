# Renames PlanSwift pages through PlanSwift's COM interface (never by editing job files).
# Input: JSON { entries: [{ id, oldName, newName }], label, checkTakeoff }
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
  ok = $false; error = ''; connection = ''; jobName = ''; rolledBack = $false
  results = @(); propertyChanges = @(); takeoffChanges = @(); takeoffItems = 0; takeoffComplete = $false
}
$results = [ordered]@{}

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

  $connection = Connect-PlanSwift
  $app = $connection.App
  $report.connection = $connection.How
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
    [void]$targets.Add([pscustomobject]@{ Entry = $e; Item = $item; Before = (Get-PropertySnapshot $item) })
  }

  $fingerprint = $null
  if ($request.checkTakeoff -ne $false) {
    $fingerprint = Get-TakeoffFingerprint $app $info.RootPath
    $report.takeoffItems = $fingerprint.Items.Count
    $report.takeoffComplete = $fingerprint.Complete
  }

  $done = New-Object System.Collections.ArrayList
  $failure = ''
  [void](Com-Get $app 'NewChangeGroup' @($label))
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
    [void](Com-Get $app 'PostChanges')

    $propertyChanges = New-Object System.Collections.ArrayList
    foreach ($t in $done) {
      foreach ($c in (Compare-PageSnapshot $t.Before (Get-PropertySnapshot $t.Item) $t.Entry.oldName $t.Entry.newName)) {
        [void]$propertyChanges.Add("$($t.Entry.newName): $c")
      }
    }
    $report.propertyChanges = @($propertyChanges)
    if ($propertyChanges.Count) { throw "Page properties other than the name changed: $($propertyChanges[0])" }

    if ($null -ne $fingerprint) {
      $diff = @(Compare-Fingerprint $fingerprint (Get-TakeoffFingerprint $app $info.RootPath))
      if ($diff.Count) {
        Start-Sleep -Seconds 2
        $diff = @(Compare-Fingerprint $fingerprint (Get-TakeoffFingerprint $app $info.RootPath))
      }
      $report.takeoffChanges = $diff
      if ($diff.Count) { throw "Takeoff quantities changed during the rename ($($diff.Count) items)." }
    }
  } catch {
    $failure = Get-ErrorText $_
  }

  if ($failure) {
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
  $report.results = @($results.Values)
  Write-JsonFile $OutFile $report
}
if (-not $report.ok) { exit 1 }
