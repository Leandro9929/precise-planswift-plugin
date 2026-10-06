# Shared helpers for the PlanSwift bridge scripts. Windows PowerShell 5.1 compatible.
#
# COM surface used here was checked against the PlanSwift9 type library shipped in
# PlanSwift's official SDK examples (github.com/PlanSwift/sdk-examples-2010,
# Interop.PlanSwift9.dll):
#   IPlanSwift: Root(), GetItem(FullPath), NewChangeGroup(GroupName), PostChanges(), Edition()
#   IItem:      Name (get/set), GUID(), FullPath(), ChildCount(), ChildItem[Index],
#               GetItemByGUID(aGUID), ItemType, PropertyCount(), PropertyItem[Index],
#               GetPropertyResultAsString(PropertyName, Default)
#   IPropertyObject: Name, ResultAsString()
# The library has no IsJobOpen; an open job is detected by resolving Root.FullPath + '\Job\Pages',
# the same pattern the official examples use for '\Job\Takeoff'.

$script:ProgId = 'PlanSwift9.PlanSwift'
$script:ClassId = 'B521BEFE-947B-4FDD-8EA5-6478E4CB7D1D'
$script:GetFlags = [Reflection.BindingFlags]'InvokeMethod, GetProperty, Public, Instance'
$script:SetFlags = [Reflection.BindingFlags]'SetProperty, Public, Instance'
$script:Utf8 = New-Object System.Text.UTF8Encoding $false

function Write-JsonFile([string]$Path, $Value) {
  $json = ConvertTo-Json -InputObject $Value -Depth 10 -Compress
  [IO.File]::WriteAllText($Path, $json, $script:Utf8)
}

function Read-JsonFile([string]$Path) {
  return ([IO.File]::ReadAllText($Path, [Text.Encoding]::UTF8) | ConvertFrom-Json)
}

function Add-JsonLine([string]$Path, $Value) {
  if (-not $Path) { return }
  $json = ConvertTo-Json -InputObject $Value -Depth 6 -Compress
  [IO.File]::AppendAllText($Path, $json + "`n", $script:Utf8)
}

# XmlDocument.Load honours the file's own encoding declaration; Get-Content would decode as ANSI on 5.1.
function Read-XmlFile([string]$Path) {
  $doc = New-Object System.Xml.XmlDocument
  $doc.Load((Convert-Path -LiteralPath $Path))
  return $doc
}

# Late-bound IDispatch call that works for methods, properties and indexed properties alike.
function Com-Get($Object, [string]$Member, [object[]]$Arguments = @()) {
  if ($null -eq $Object) { throw "PlanSwift returned no object for $Member." }
  return $Object.GetType().InvokeMember($Member, $script:GetFlags, $null, $Object, $Arguments)
}

# Strips the reflection wrappers so the user sees PlanSwift's own error text.
function Get-ErrorText($ErrorRecord) {
  $e = $ErrorRecord.Exception
  while ($null -ne $e.InnerException -and ($e -is [Management.Automation.MethodInvocationException] -or $e -is [Reflection.TargetInvocationException])) {
    $e = $e.InnerException
  }
  return $e.Message
}

function Com-Set($Object, [string]$Member, $Value) {
  [void]$Object.GetType().InvokeMember($Member, $script:SetFlags, $null, $Object, @($Value))
}

function Com-TryGet($Object, [string]$Member, [object[]]$Arguments = @(), $Default = $null) {
  try { return (Com-Get $Object $Member $Arguments) } catch { return $Default }
}

function Format-Guid([string]$Guid) {
  return ([string]$Guid).Trim().Trim('{', '}').ToUpperInvariant()
}

function Get-PlanSwiftProcesses {
  return @(Get-Process -Name 'PlanSwift*' -ErrorAction SilentlyContinue)
}

function Get-ProcessCommandLine([int]$Id) {
  try { return [string](Get-CimInstance Win32_Process -Filter "ProcessId=$Id" -ErrorAction Stop).CommandLine } catch { return '' }
}

# Attaches to the PlanSwift that is already open. Refuses to start PlanSwift, and if Windows
# launches a second copy (different elevation between PlanSwift and this tool), closes that copy
# before anything is read or written.
function Connect-PlanSwift {
  $before = Get-PlanSwiftProcesses
  if ($before.Count -eq 0) { throw 'PlanSwift is not running. Open PlanSwift and the job, then try again.' }
  $app = $null
  $how = ''
  try {
    $app = [Runtime.InteropServices.Marshal]::GetActiveObject($script:ProgId)
    $how = 'running object table'
  } catch { $app = $null }
  if ($null -eq $app) {
    try { $app = New-Object -ComObject $script:ProgId }
    catch {
      $type = [Type]::GetTypeFromCLSID([Guid]$script:ClassId)
      if ($null -eq $type) { throw "PlanSwift's COM server ($script:ProgId) is not registered on this PC." }
      $app = [Activator]::CreateInstance($type)
    }
    $how = 'class factory'
  }
  $spawned = @(Get-PlanSwiftProcesses | Where-Object { @($before | ForEach-Object Id) -notcontains $_.Id })
  if ($spawned.Count) {
    try { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($app) } catch { }
    $app = $null
    Start-Sleep -Seconds 2
    foreach ($p in $spawned) {
      $commandLine = Get-ProcessCommandLine $p.Id
      if (-not $p.HasExited -and $commandLine -match '(?i)(-|/)(Embedding|Automation)') {
        try { Stop-Process -Id $p.Id -Force -ErrorAction Stop } catch { }
      }
    }
    throw ('Windows started a second PlanSwift instead of connecting to the open one. This happens when ' +
      'PlanSwift and this tool run at different permission levels (one of them "as administrator"). ' +
      "Start this tool from PlanSwift's Plugins button, or run both normally. Nothing was changed.")
  }
  return [pscustomobject]@{ App = $app; How = $how; ProcessCount = $before.Count }
}

function Get-JobPagesItem($App) {
  $root = Com-Get $App 'Root'
  $rootPath = [string](Com-Get $root 'FullPath')
  $pages = $null
  try { $pages = Com-Get $App 'GetItem' @($rootPath + '\Job\Pages') } catch { $pages = $null }
  if ($null -eq $pages) { throw 'PlanSwift reports no open job. Open the job in PlanSwift, then reload.' }
  $job = Com-TryGet $App 'GetItem' @($rootPath + '\Job')
  return [pscustomobject]@{
    RootPath = $rootPath
    Pages = $pages
    PagesPath = [string](Com-TryGet $pages 'FullPath' @() '')
    JobName = [string](Com-TryGet $job 'Name' @() '')
  }
}

# Depth- and size-bounded walk used when GetItemByGUID is unavailable or ambiguous.
function Find-ItemsByGuid($Start, [string[]]$Guids, [int]$MaxDepth = 4, [int]$MaxNodes = 20000) {
  $wanted = @{}
  foreach ($g in $Guids) { $wanted[(Format-Guid $g)] = $true }
  $found = @{}
  $queue = New-Object System.Collections.Queue
  $queue.Enqueue(@($Start, 0))
  $visited = 0
  while ($queue.Count -and $found.Count -lt $wanted.Count -and $visited -lt $MaxNodes) {
    $entry = $queue.Dequeue()
    $node = $entry[0]
    $depth = $entry[1]
    $count = [int](Com-TryGet $node 'ChildCount' @() 0)
    for ($i = 0; $i -lt $count; $i++) {
      $child = Com-TryGet $node 'ChildItem' @($i)
      if ($null -eq $child) { continue }
      $visited++
      $guid = Format-Guid (Com-TryGet $child 'GUID' @() '')
      if ($guid -and $wanted.ContainsKey($guid)) { $found[$guid] = $child }
      elseif ($depth + 1 -lt $MaxDepth) { $queue.Enqueue(@($child, ($depth + 1))) }
    }
  }
  return $found
}

function Resolve-Pages($PagesInfo, [string[]]$Guids) {
  $result = @{}
  $missing = New-Object System.Collections.ArrayList
  foreach ($g in $Guids) {
    $item = Com-TryGet $PagesInfo.Pages 'GetItemByGUID' @($g)
    $ok = $false
    if ($null -ne $item) {
      $guid = [string](Com-TryGet $item 'GUID' @() '')
      $full = [string](Com-TryGet $item 'FullPath' @() '')
      $inJob = (-not $PagesInfo.PagesPath) -or $full.StartsWith($PagesInfo.PagesPath + '\', [StringComparison]::OrdinalIgnoreCase)
      $ok = ((Format-Guid $guid) -eq (Format-Guid $g)) -and $inJob
    }
    if ($ok) { $result[(Format-Guid $g)] = $item } else { [void]$missing.Add($g) }
  }
  if ($missing.Count) {
    $walked = Find-ItemsByGuid $PagesInfo.Pages ([string[]]$missing)
    foreach ($key in $walked.Keys) { $result[$key] = $walked[$key] }
  }
  return $result
}

# Property names whose value may legitimately follow the page name.
$script:NameLinked = '^(Name|Caption|Title|Description|FullName|FullPath|Path|DisplayName)$|Date|Time|Modified|Changed|Updated'

function Get-PropertySnapshot($Item, [int]$Max = 400) {
  $snapshot = [ordered]@{}
  $count = [int](Com-TryGet $Item 'PropertyCount' @() 0)
  for ($i = 0; $i -lt [Math]::Min($count, $Max); $i++) {
    $prop = Com-TryGet $Item 'PropertyItem' @($i)
    if ($null -eq $prop) { continue }
    $name = [string](Com-TryGet $prop 'Name' @() '')
    if (-not $name -or $snapshot.Contains($name)) { continue }
    $snapshot[$name] = [string](Com-TryGet $prop 'ResultAsString' @() '')
  }
  return $snapshot
}

function Compare-PageSnapshot($Before, $After, [string]$OldName, [string]$NewName) {
  $changes = New-Object System.Collections.ArrayList
  foreach ($name in $Before.Keys) {
    if ($name -match $script:NameLinked) { continue }
    $old = [string]$Before[$name]
    $new = if ($After.Contains($name)) { [string]$After[$name] } else { '<missing>' }
    if ($old -eq $new) { continue }
    if ($OldName -and $old.Contains($OldName) -and $new -eq $old.Replace($OldName, $NewName)) { continue }
    [void]$changes.Add("$name`: '$old' -> '$new'")
  }
  return $changes
}

# Quantity fingerprint of the takeoff tree, so a rename that disturbs measurements is caught.
function Get-TakeoffFingerprint($App, [string]$RootPath, [int]$MaxDepth = 6, [int]$MaxNodes = 4000) {
  $map = @{}
  $takeoff = Com-TryGet $App 'GetItem' @($RootPath + '\Job\Takeoff')
  if ($null -eq $takeoff) { return [pscustomobject]@{ Items = $map; Complete = $false } }
  $queue = New-Object System.Collections.Queue
  $queue.Enqueue(@($takeoff, 0))
  $visited = 0
  while ($queue.Count -and $visited -lt $MaxNodes) {
    $entry = $queue.Dequeue()
    $node = $entry[0]
    $depth = $entry[1]
    $count = [int](Com-TryGet $node 'ChildCount' @() 0)
    for ($i = 0; $i -lt $count -and $visited -lt $MaxNodes; $i++) {
      $child = Com-TryGet $node 'ChildItem' @($i)
      if ($null -eq $child) { continue }
      $visited++
      $guid = [string](Com-TryGet $child 'GUID' @() '')
      $qty = [string](Com-TryGet $child 'GetPropertyResultAsString' @('Qty', '') '')
      $children = [int](Com-TryGet $child 'ChildCount' @() 0)
      if ($guid) { $map[$guid] = "$qty|$children" }
      if ($depth + 1 -lt $MaxDepth) { $queue.Enqueue(@($child, ($depth + 1))) }
    }
  }
  return [pscustomobject]@{ Items = $map; Complete = ($queue.Count -eq 0) }
}

function Compare-Fingerprint($Before, $After) {
  $changes = New-Object System.Collections.ArrayList
  foreach ($guid in $Before.Items.Keys) {
    $old = $Before.Items[$guid]
    if (-not $After.Items.ContainsKey($guid) -and -not $After.Complete) { continue }
    $new = if ($After.Items.ContainsKey($guid)) { $After.Items[$guid] } else { '<missing>' }
    if ($old -ne $new) { [void]$changes.Add("$guid`: $old -> $new") }
  }
  return $changes
}

$script:Reserved = '^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..*)?$'

# Mirrors lib/naming.js validateName so a malformed request can never reach PlanSwift.
function Assert-PageName([string]$Name) {
  if (-not $Name) { throw 'A page name is empty.' }
  if ($Name.Length -gt 120) { throw "Page name is longer than 120 characters: $Name" }
  if ($Name -match '[\\/:*?"<>|]' -or $Name -match '[\x00-\x1F\x7F]') { throw "Page name contains a character PlanSwift cannot store: $Name" }
  if ($Name -ne $Name.Trim() -or $Name.EndsWith('.')) { throw "Page name cannot start or end with a space or end with a period: $Name" }
  if ($Name -match $script:Reserved) { throw "Page name is reserved by Windows: $Name" }
}
