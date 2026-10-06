# Read-only: lists the pages of the job that is open in PlanSwift from its data folder.
# PlanSwift keeps the open job as an alias item (Data\Job\Data.xml) whose Link property points at
# \Storages\<storage>\Jobs\<job>; each page is a folder with a Data.xml of Class "Page".
# With -LiveNames, page names are then taken from PlanSwift itself (by GUID), so the list matches
# what PlanSwift shows even before it has written a change to the job folder.
param(
  [Parameter(Mandatory = $true)][string]$OutFile,
  [string]$PlanSwiftRoot = '',
  [switch]$LiveNames
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')
if ($env:PRECISE_BRIDGE_MOCK) { . $env:PRECISE_BRIDGE_MOCK }

function PropertyValue($item, [string]$name) {
  $p = @($item.Properties.Property) | Where-Object { $_.Name -eq $name } | Select-Object -First 1
  if ($null -eq $p) { return '' }
  return [string]$p.InnerText
}

function Find-PlanSwiftRoot {
  $candidates = @()
  if ($env:PRECISE_PLANSWIFT_ROOT) { $candidates += $env:PRECISE_PLANSWIFT_ROOT }
  $candidates += 'C:\Program Files (x86)\PlanSwift11'
  foreach ($base in @(${env:ProgramFiles(x86)}, $env:ProgramFiles) | Where-Object { $_ }) {
    $candidates += @(Get-ChildItem -LiteralPath $base -Directory -Filter 'PlanSwift*' -ErrorAction SilentlyContinue |
      Sort-Object Name -Descending | ForEach-Object FullName)
  }
  foreach ($c in $candidates) {
    if ($c -and (Test-Path -LiteralPath (Join-Path (Join-Path (Join-Path $c 'Data') 'Job') 'Data.xml'))) { return $c }
  }
  throw 'PlanSwift data folder not found. Set the PlanSwift folder in settings (for example C:\Program Files (x86)\PlanSwift11).'
}

# Page images: prefer full raster images over PDFs, then the largest file (skips thumbnails).
$rank = @{ '.tif' = 0; '.tiff' = 0; '.png' = 1; '.jpg' = 2; '.jpeg' = 2; '.bmp' = 3; '.pdf' = 4 }

try {
  if (-not $PlanSwiftRoot) { $PlanSwiftRoot = Find-PlanSwiftRoot }
  $data = Join-Path $PlanSwiftRoot 'Data'
  $aliasFile = Join-Path (Join-Path $data 'Job') 'Data.xml'
  if (-not (Test-Path -LiteralPath $aliasFile)) {
    throw "PlanSwift data not found in $PlanSwiftRoot. Check the PlanSwift folder in Settings."
  }
  $alias = Read-XmlFile $aliasFile
  $link = PropertyValue $alias.Item 'Link'
  $parts = @($link.Trim('\').Split('\') | Where-Object { $_ })
  if ($parts.Count -lt 4 -or $parts[0] -ne 'Storages' -or $parts[2] -ne 'Jobs') {
    throw 'Open a job in PlanSwift first. The current job link is missing or invalid.'
  }
  $storageDir = Join-Path (Join-Path $data 'Storages') $parts[1]
  $storage = Read-XmlFile (Join-Path $storageDir 'Data.xml')
  $externalRoot = PropertyValue $storage.Item 'Folder'
  $jobDir = if ($externalRoot) { $externalRoot } else { $storageDir }
  foreach ($part in $parts[2..($parts.Count - 1)]) { $jobDir = Join-Path $jobDir $part }
  $pagesDir = Join-Path $jobDir 'Pages'
  if (-not (Test-Path -LiteralPath $pagesDir -PathType Container)) { throw "Pages folder unavailable: $pagesDir" }
  $pagesDir = Convert-Path -LiteralPath $pagesDir

  $jobGuid = ''
  $jobXml = Join-Path $jobDir 'Data.xml'
  if (Test-Path -LiteralPath $jobXml) { try { $jobGuid = [string](Read-XmlFile $jobXml).Item.GUID } catch { } }

  $pages = @(Get-ChildItem -LiteralPath $pagesDir -Directory -Recurse | ForEach-Object {
    $xmlPath = Join-Path $_.FullName 'Data.xml'
    if (-not (Test-Path -LiteralPath $xmlPath)) { return }
    try { $page = Read-XmlFile $xmlPath } catch { return }
    if ($page.Item.Class -ne 'Page') { return }
    $image = Get-ChildItem -LiteralPath $_.FullName -File |
      Where-Object { $rank.ContainsKey($_.Extension.ToLowerInvariant()) } |
      Sort-Object @{ Expression = { $rank[$_.Extension.ToLowerInvariant()] } }, @{ Expression = { $_.Length }; Descending = $true } |
      Select-Object -First 1
    $order = 0
    [void][int]::TryParse((PropertyValue $page.Item 'OrderIndex'), [ref]$order)
    $relative = $_.FullName.Substring($pagesDir.Length).TrimStart('\', '/') -replace '/', '\'
    [pscustomobject]@{
      id = [string]$page.Item.GUID
      name = PropertyValue $page.Item 'Name'
      order = $order
      path = '\Job\Pages\' + $relative
      image = if ($image) { $image.FullName } else { '' }
    }
  } | Sort-Object order, path)

  $namesFrom = 'files'
  $liveError = ''
  if ($LiveNames -and $pages.Count) {
    try {
      $connection = Connect-PlanSwift
      $info = Get-JobPagesItem $connection.App
      $items = Resolve-Pages $info ([string[]]@($pages | ForEach-Object { $_.id }))
      $found = 0
      foreach ($p in $pages) {
        $item = $items[(Format-Guid $p.id)]
        if ($null -eq $item) { continue }
        $p.name = [string](Com-Get $item 'Name')
        $found++
      }
      if ($found -eq $pages.Count) { $namesFrom = 'planswift' }
      else { $namesFrom = 'mixed'; $liveError = "$($pages.Count - $found) page(s) from the job folder were not found in PlanSwift" }
    } catch {
      $liveError = Get-ErrorText $_
    }
  }

  Write-JsonFile $OutFile ([pscustomobject]@{
    ok = $true
    namesFrom = $namesFrom
    liveError = $liveError
    job = ($parts[3..($parts.Count - 1)] -join '\')
    jobGuid = $jobGuid
    jobDir = $jobDir
    link = $link
    planSwiftRoot = $PlanSwiftRoot
    version = 2
    pages = $pages
  })
} catch {
  Write-JsonFile $OutFile ([pscustomobject]@{ ok = $false; error = (Get-ErrorText $_) })
  exit 1
}
