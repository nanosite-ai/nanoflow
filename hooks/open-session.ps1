# Bring up the Claude session that works on a worktree, Windows Terminal only. In order:
#   1. a terminal tab whose title names the branch (the task title nanoflow sets): select it      -> "tab <title>"
#   2. a live Claude session titled with the branch but with no tab we can find (another app)       -> "running <id>"
#   3. a past Claude session titled with the branch: resume it in a new tab                          -> "resumed <id>"
#   4. none: a new tab in the worktree, running claude                                               -> "new"
# The main checkout passes no -Branch: its name is in too many titles to find its tab by, so it gets a new tab.
# Exit 2 when Windows Terminal (wt.exe) is not there to open a tab in. -DryRun says what it would do.
param([string]$Branch, [string]$Path, [string]$MainRoot, [string]$Title, [switch]$DryRun)
$ErrorActionPreference = 'Stop'
# The branch as a whole word: feat/83-x must not find feat/830-y.
$names = if ($Branch) { '(?<![\w/-])' + [regex]::Escape($Branch) + '(?![\w-])' } else { $null }

Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
Add-Type -Namespace Nf -Name Win -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(System.IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool ShowWindow(System.IntPtr hWnd, int nCmdShow);
[DllImport("user32.dll")] public static extern bool IsIconic(System.IntPtr hWnd);
'@
$UIA = [System.Windows.Automation.AutomationElement]

# 1. A Windows Terminal tab titled with the branch.
$isTerminal = New-Object System.Windows.Automation.PropertyCondition($UIA::ClassNameProperty, 'CASCADIA_HOSTING_WINDOW_CLASS')
$isTab = New-Object System.Windows.Automation.PropertyCondition($UIA::ControlTypeProperty, [System.Windows.Automation.ControlType]::TabItem)
if ($names) {
  foreach ($window in $UIA::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children, $isTerminal)) {
    foreach ($tab in $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, $isTab)) {
      if ($tab.Current.Name -notmatch $names) { continue }
      if ($DryRun) { "tab $($tab.Current.Name)"; exit 0 }
      $tab.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern).Select()
      $hwnd = [IntPtr]$window.Current.NativeWindowHandle
      if ([Nf.Win]::IsIconic($hwnd)) { [void][Nf.Win]::ShowWindow($hwnd, 9) }
      [void][Nf.Win]::SetForegroundWindow($hwnd)
      "tab $($tab.Current.Name)"
      exit 0
    }
  }
}

$wt = Get-Command wt.exe -ErrorAction SilentlyContinue
if (-not $wt) { exit 2 }

# 2/3. A Claude session whose title (the custom-title record `nf task start` writes) names the branch. Its
# transcript sits under the folder the session started in: the main checkout or the worktree itself.
$config = if ($env:CLAUDE_CONFIG_DIR) { $env:CLAUDE_CONFIG_DIR } else { Join-Path $env:USERPROFILE '.claude' }
$found = $null
# Only transcripts written since the worktree was made can be working on it: skips reading the rest.
$since = if (Test-Path $Path) { (Get-Item $Path).CreationTime } else { [datetime]::MinValue }
foreach ($root in $(if ($names) { @($Path, $MainRoot) } else { @() })) {
  $dir = Join-Path (Join-Path $config 'projects') (($root -replace '/', '\') -replace '[^a-zA-Z0-9]', '-')
  if (-not (Test-Path $dir)) { continue }
  foreach ($file in Get-ChildItem $dir -Filter *.jsonl | Where-Object LastWriteTime -ge $since | Sort-Object LastWriteTime -Descending) {
    $last = Select-String -Path $file.FullName -SimpleMatch '"type":"custom-title"' | Select-Object -Last 1
    if ($last -and $last.Line -match $names) {
      $found = @{ id = $file.BaseName; cwd = $root }
      break
    }
  }
  if ($found) { break }
}

if ($found) {
  $live = Get-ChildItem (Join-Path $config 'sessions') -Filter *.json -ErrorAction SilentlyContinue |
    ForEach-Object { try { Get-Content $_.FullName -Raw | ConvertFrom-Json } catch { $null } } |
    Where-Object { $_ -and $_.sessionId -eq $found.id -and (Get-Process -Id $_.pid -ErrorAction SilentlyContinue) }
  if ($live) { "running $($found.id)"; exit 0 }
  if (-not $DryRun) { & $wt.Source -w 0 new-tab -d $found.cwd --title $Title claude --resume $found.id }
  "resumed $($found.id)"
  exit 0
}

# 4. A fresh session in the worktree.
if (-not $DryRun) { & $wt.Source -w 0 new-tab -d $Path --title $Title claude }
'new'
