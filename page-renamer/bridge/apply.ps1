param([Parameter(Mandatory=$true)][string]$InputFile)
$ErrorActionPreference = 'Stop'
$request = Get-Content -LiteralPath $InputFile -Raw | ConvertFrom-Json
$app = New-Object -ComObject 'PlanSwift9.PlanSwift'
if (-not $app.IsJobOpen()) { throw 'Open the target job in PlanSwift before applying names.' }

$jobAlias = [xml](Get-Content -LiteralPath 'C:\Program Files (x86)\PlanSwift11\Data\Job\Data.xml' -Raw)
$activeLink = [string](@($jobAlias.Item.Properties.Property) | Where-Object Name -eq 'Link' | Select-Object -First 1).InnerText
if ($activeLink -ne $request.link) { throw 'The active PlanSwift job changed. Reload the preview.' }

function ComGet($object, [string]$member) {
  try { return $object.GetType().InvokeMember($member, [Reflection.BindingFlags]::GetProperty, $null, $object, $null) }
  catch { return $object.GetType().InvokeMember($member, [Reflection.BindingFlags]::InvokeMethod, $null, $object, @()) }
}
function ComSet($object, [string]$member, [string]$value) {
  $null = $object.GetType().InvokeMember($member, [Reflection.BindingFlags]::SetProperty, $null, $object, @($value))
}

$items = @()
foreach ($entry in @($request.entries)) {
  if (-not $entry.newName -or $entry.newName -match '[\\/:*?"<>|]' -or $entry.newName.Length -gt 120) {
    throw "Invalid page name for $($entry.path)"
  }
  $item = $app.GetItem([string]$entry.path)
  if ($null -eq $item) { throw "Page missing: $($entry.path)" }
  if ([string](ComGet $item 'GUID') -ne [string]$entry.id -or [string](ComGet $item 'Name') -ne [string]$entry.oldName) {
    throw "Page changed since preview: $($entry.path)"
  }
  $items += [pscustomobject]@{ item=$item; entry=$entry }
}

$done = @()
try {
  $app.NewChangeGroup('Precise Page Renamer')
  foreach ($row in $items) {
    ComSet $row.item 'Name' ([string]$row.entry.newName)
    $done += [pscustomobject]@{ id=$row.entry.id; oldName=$row.entry.oldName; newName=$row.entry.newName }
  }
  $app.PostChanges()
} catch {
  $cause = $_.Exception.Message
  for ($i=$done.Count-1; $i -ge 0; $i--) {
    try { ComSet $items[$i].item 'Name' ([string]$items[$i].entry.oldName) } catch { }
  }
  try { $app.PostChanges() } catch { }
  throw "Apply failed; attempted to restore changed pages. $cause"
}
[pscustomobject]@{ applied=$done } | ConvertTo-Json -Depth 4 -Compress
