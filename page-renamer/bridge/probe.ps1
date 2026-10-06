# Read-only connection check. Reports what PlanSwift's COM interface exposes for the open job so
# the Windows test can be compared with the page list read from the job folder.
param(
  [Parameter(Mandatory = $true)][string]$OutFile,
  [string]$GuidsFile = ''
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')
if ($env:PRECISE_BRIDGE_MOCK) { . $env:PRECISE_BRIDGE_MOCK }

$report = [ordered]@{ ok = $false; error = ''; steps = @() }
$steps = New-Object System.Collections.ArrayList
function Step([string]$Name, [bool]$Ok, [string]$Detail) {
  [void]$steps.Add([pscustomobject]@{ name = $Name; ok = $Ok; detail = $Detail })
}

try {
  Step 'PowerShell' $true ("{0} ({1}-bit)" -f $PSVersionTable.PSVersion, ([IntPtr]::Size * 8))
  $connection = Connect-PlanSwift
  $app = $connection.App
  Step 'Connect' $true ("Attached through the {0}; {1} PlanSwift process(es) running" -f $connection.How, $connection.ProcessCount)
  Step 'Edition' $true ([string](Com-TryGet $app 'Edition' @() 'unknown'))
  $info = Get-JobPagesItem $app
  Step 'Open job' $true ("{0} (pages at {1})" -f $info.JobName, $info.PagesPath)
  $count = [int](Com-TryGet $info.Pages 'ChildCount' @() 0)
  $children = @()
  for ($i = 0; $i -lt [Math]::Min($count, 5); $i++) {
    $c = Com-TryGet $info.Pages 'ChildItem' @($i)
    $children += [pscustomobject]@{
      name = [string](Com-TryGet $c 'Name' @() '')
      guid = [string](Com-TryGet $c 'GUID' @() '')
      type = [string](Com-TryGet $c 'ItemType' @() '')
      fullPath = [string](Com-TryGet $c 'FullPath' @() '')
      children = [int](Com-TryGet $c 'ChildCount' @() 0)
    }
  }
  Step 'Pages' $true ("{0} top-level item(s) under Pages" -f $count)
  $report.samplePages = $children

  if ($GuidsFile -and (Test-Path -LiteralPath $GuidsFile)) {
    $wanted = @(Read-JsonFile $GuidsFile)
    $resolved = Resolve-Pages $info ([string[]]@($wanted | ForEach-Object { [string]$_.id }))
    $mismatch = @()
    foreach ($w in $wanted) {
      $item = $resolved[(Format-Guid $w.id)]
      if ($null -eq $item) { $mismatch += "missing: $($w.name)"; continue }
      $name = [string](Com-Get $item 'Name')
      if ($name -cne [string]$w.name) { $mismatch += "name differs: '$($w.name)' vs '$name'" }
    }
    Step 'Match job folder' ($mismatch.Count -eq 0) ("{0} of {1} pages matched by ID and name. {2}" -f ($wanted.Count - $mismatch.Count), $wanted.Count, (($mismatch | Select-Object -First 5) -join '; '))
    if ($wanted.Count) {
      $first = $resolved[(Format-Guid $wanted[0].id)]
      if ($null -ne $first) {
        $snap = Get-PropertySnapshot $first 80
        $report.firstPageProperties = $snap
        Step 'Page properties' $true ("{0} properties readable on '{1}'" -f $snap.Count, $wanted[0].name)
      }
    }
  }
  $fp = Get-TakeoffFingerprint $app $info.RootPath
  Step 'Takeoff check' $true ("{0} takeoff items fingerprinted{1}" -f $fp.Items.Count, $(if ($fp.Complete) { '' } else { ' (capped)' }))
  $report.ok = (@($steps | Where-Object { -not $_.ok }).Count -eq 0)
} catch {
  $report.error = Get-ErrorText $_
  Step 'Error' $false (Get-ErrorText $_)
} finally {
  $report.steps = @($steps)
  Write-JsonFile $OutFile $report
}
