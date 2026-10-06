param([string]$PlanSwiftRoot = 'C:\Program Files (x86)\PlanSwift11')
$ErrorActionPreference = 'Stop'

function PropertyValue($item, [string]$name) {
  $p = @($item.Properties.Property) | Where-Object { $_.Name -eq $name } | Select-Object -First 1
  if ($null -eq $p) { return '' }
  return [string]$p.InnerText
}

$data = Join-Path $PlanSwiftRoot 'Data'
$alias = [xml](Get-Content -LiteralPath (Join-Path $data 'Job\Data.xml') -Raw)
$link = PropertyValue $alias.Item 'Link'
$parts = @($link.Trim('\').Split('\') | Where-Object { $_ })
if ($parts.Count -lt 4 -or $parts[0] -ne 'Storages' -or $parts[2] -ne 'Jobs') {
  throw 'Open a PlanSwift job first. The current job link is missing or invalid.'
}
$storageName = $parts[1]
$storageDir = Join-Path (Join-Path $data 'Storages') $storageName
$storage = [xml](Get-Content -LiteralPath (Join-Path $storageDir 'Data.xml') -Raw)
$externalRoot = PropertyValue $storage.Item 'Folder'
$base = if ($externalRoot) { $externalRoot } else { $storageDir }
$jobDir = $base
foreach ($part in $parts[2..($parts.Count - 1)]) { $jobDir = Join-Path $jobDir $part }
$pagesDir = Join-Path $jobDir 'Pages'
if (-not (Test-Path -LiteralPath $pagesDir -PathType Container)) { throw "Pages directory unavailable: $pagesDir" }

$pages = @(Get-ChildItem -LiteralPath $pagesDir -Directory -Recurse | ForEach-Object {
  $xmlPath = Join-Path $_.FullName 'Data.xml'
  if (-not (Test-Path -LiteralPath $xmlPath)) { return }
  try { $page = [xml](Get-Content -LiteralPath $xmlPath -Raw) } catch { return }
  if ($page.Item.Class -ne 'Page') { return }
  $image = Get-ChildItem -LiteralPath $_.FullName -File | Where-Object { $_.Extension -match '^\.(tif|tiff|png|jpe?g|bmp|pdf)$' } | Select-Object -First 1
  $relative = $_.FullName.Substring($pagesDir.Length).TrimStart('\')
  [pscustomobject]@{
    id = [string]$page.Item.GUID
    name = PropertyValue $page.Item 'Name'
    order = [int](PropertyValue $page.Item 'OrderIndex')
    path = '\Job\Pages\' + $relative
    image = if ($image) { $image.FullName } else { '' }
  }
} | Sort-Object order,path)

[pscustomobject]@{
  job = ($parts[3..($parts.Count - 1)] -join '\')
  jobDir = $jobDir
  link = $link
  version = 1
  pages = $pages
} | ConvertTo-Json -Depth 5 -Compress
