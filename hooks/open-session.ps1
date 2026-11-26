# Bring up the Claude session that works on a worktree, Windows Terminal only. In order:
#   0. -SessionId names a session that is running: select its own terminal tab                      -> "tab <title>"
#   1. a terminal tab whose title names the branch (the task title nanoflow sets): select it      -> "tab <title>"
#   2. a live Claude session titled with the branch: its own tab, else it is in another app        -> "tab <title>" / "running <id>"
#   3. a past Claude session titled with the branch: resume it in a new tab                          -> "resumed <id>"
#   4. none: a new tab in the worktree, running claude                                               -> "new"
# The main checkout passes no -Branch: its name is in too many titles to find its tab by, so it gets a new tab
# unless -SessionId finds it.
# -Uri nanoflow://open/<token> is a click on a desktop notification: the token's entry in
# ~/.claude/nanoflow/clicks.json (written by the session that raised it) gives the rest. An unknown token does nothing.
# Exit 2 when Windows Terminal (wt.exe) is not there to open a tab in. -DryRun says what it would do.
param([string]$Branch, [string]$Path, [string]$MainRoot, [string]$Title, [string]$SessionId, [string]$Uri, [switch]$DryRun)
$hintPid = 0
$ErrorActionPreference = 'Stop'
$config = if ($env:CLAUDE_CONFIG_DIR) { $env:CLAUDE_CONFIG_DIR } else { Join-Path $env:USERPROFILE '.claude' }

if ($Uri) {
  if ($Uri -notmatch '^nanoflow://open/([0-9a-f]{16})/?$') { exit 1 }
  $token = $Matches[1]
  $clicks = try { Get-Content (Join-Path $env:USERPROFILE '.claude\nanoflow\clicks.json') -Raw -Encoding UTF8 | ConvertFrom-Json } catch { $null }
  $click = if ($clicks) { $clicks.$token } else { $null }
  if (-not $click -or -not $click.path) { exit 1 }
  $Path = $click.path; $MainRoot = $click.mainRoot; $Title = $click.title
  $Branch = if ($click.branch) { $click.branch } else { '' }
  $SessionId = if ($click.sessionId) { $click.sessionId } else { '' }
  $hintPid = if ($click.pid) { [int]$click.pid } else { 0 }
}
if (-not $MainRoot) { $MainRoot = $Path }
if (-not $Title) { $Title = Split-Path $Path -Leaf }

# The branch as a whole word: feat/83-x must not find feat/830-y.
$names = if ($Branch) { '(?<![\w/-])' + [regex]::Escape($Branch) + '(?![\w-])' } else { $null }

Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
Add-Type -Namespace Nf -Name Win -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(System.IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool ShowWindow(System.IntPtr hWnd, int nCmdShow);
[DllImport("user32.dll")] public static extern bool IsIconic(System.IntPtr hWnd);
[DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, System.UIntPtr extra);
[DllImport("kernel32.dll")] public static extern bool FreeConsole();
[DllImport("kernel32.dll")] public static extern bool AttachConsole(uint pid);
[DllImport("kernel32.dll", CharSet = CharSet.Unicode)] public static extern System.IntPtr CreateFile(string name, uint access, uint share, System.IntPtr security, uint disposition, uint flags, System.IntPtr template);
[DllImport("kernel32.dll", CharSet = CharSet.Unicode)] public static extern bool WriteConsole(System.IntPtr handle, string text, int length, out int written, System.IntPtr reserved);
[DllImport("kernel32.dll")] public static extern bool CloseHandle(System.IntPtr handle);
[DllImport("kernel32.dll")] public static extern System.IntPtr GetStdHandle(int which);
[DllImport("kernel32.dll")] public static extern bool SetStdHandle(int which, System.IntPtr handle);
'@
$UIA = [System.Windows.Automation.AutomationElement]
$isTerminal = New-Object System.Windows.Automation.PropertyCondition($UIA::ClassNameProperty, 'CASCADIA_HOSTING_WINDOW_CLASS')
$isTab = New-Object System.Windows.Automation.PropertyCondition($UIA::ControlTypeProperty, [System.Windows.Automation.ControlType]::TabItem)

# Every Windows Terminal tab, with its window.
function Get-Tabs {
  foreach ($window in $UIA::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children, $isTerminal)) {
    foreach ($tab in $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, $isTab)) { @{ tab = $tab; window = $window } }
  }
}

function Select-Tab($found) {
  $found.tab.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern).Select()
  $hwnd = [IntPtr]$found.window.Current.NativeWindowHandle
  if ([Nf.Win]::IsIconic($hwnd)) { [void][Nf.Win]::ShowWindow($hwnd, 9) }
  # A tap of Alt first: Windows lets a background process take the foreground only after input.
  [Nf.Win]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero); [Nf.Win]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
  [void][Nf.Win]::SetForegroundWindow($hwnd)
}

# The live process of a Claude session, from the record each running session keeps under sessions/<pid>.json.
# The pid the notification recorded is tried first: one file, checked to still be that session (pids are reused).
function Get-SessionPid([string]$id, [int]$hint = 0) {
  if (-not $id) { return $null }
  $files = @(Get-ChildItem (Join-Path $config 'sessions') -Filter *.json -ErrorAction SilentlyContinue)
  if ($hint) { $files = @($files | Where-Object Name -eq "$hint.json") + @($files | Where-Object Name -ne "$hint.json") }
  foreach ($file in $files) {
    $record = try { Get-Content $file.FullName -Raw | ConvertFrom-Json } catch { $null }
    if ($record -and $record.sessionId -eq $id -and (Get-Process -Id $record.pid -ErrorAction SilentlyContinue)) { return [int]$record.pid }
  }
  $null
}

# The tab a process draws in. No API maps a process to its tab, so: join the process's console, set the
# terminal title to a one-off mark (an OSC 0 sequence, which reaches the tab), find the tab that shows it, and
# put the title back. Our own stdout/stderr are put back after, or what we print is lost.
function Find-ProcessTab([int]$processId) {
  $before = @{}
  foreach ($t in Get-Tabs) { $before[($t.tab.GetRuntimeId() -join '.')] = $t.tab.Current.Name }
  $stdout = [Nf.Win]::GetStdHandle(-11); $stderr = [Nf.Win]::GetStdHandle(-12)
  [void][Nf.Win]::FreeConsole()
  if (-not [Nf.Win]::AttachConsole($processId)) {
    [void][Nf.Win]::SetStdHandle(-11, $stdout); [void][Nf.Win]::SetStdHandle(-12, $stderr)
    return $null
  }
  $out = [Nf.Win]::CreateFile('CONOUT$', [uint32]'0xC0000000', 3, [IntPtr]::Zero, 3, 0, [IntPtr]::Zero)
  try {
    $mark = 'nanoflow-' + [guid]::NewGuid().ToString('N').Substring(0, 12)
    $written = 0
    $osc = [string][char]27 + ']0;' + $mark + [char]7
    [void][Nf.Win]::WriteConsole($out, $osc, $osc.Length, [ref]$written, [IntPtr]::Zero)
    for ($i = 0; $i -lt 20; $i++) {
      foreach ($t in Get-Tabs) {
        if ($t.tab.Current.Name -ne $mark) { continue }
        $old = $before[($t.tab.GetRuntimeId() -join '.')]
        if ($old) {
          $osc = [string][char]27 + ']0;' + $old + [char]7
          [void][Nf.Win]::WriteConsole($out, $osc, $osc.Length, [ref]$written, [IntPtr]::Zero)
        }
        $t.name = if ($old) { $old } else { $Title }
        return $t
      }
      Start-Sleep -Milliseconds 100
    }
    $null
  } finally {
    [void][Nf.Win]::CloseHandle($out)
    [void][Nf.Win]::FreeConsole()
    [void][Nf.Win]::SetStdHandle(-11, $stdout); [void][Nf.Win]::SetStdHandle(-12, $stderr)
  }
}

# 0. The session named, while it runs: its own tab.
$sessionPid = Get-SessionPid $SessionId $hintPid
if ($sessionPid) {
  $found = Find-ProcessTab $sessionPid
  if ($found) {
    if (-not $DryRun) { Select-Tab $found }
    "tab $($found.name)"
    exit 0
  }
}

# 1. A Windows Terminal tab titled with the branch.
if ($names) {
  foreach ($t in Get-Tabs) {
    if ($t.tab.Current.Name -notmatch $names) { continue }
    if (-not $DryRun) { Select-Tab $t }
    "tab $($t.tab.Current.Name)"
    exit 0
  }
}

# The session named runs, but not in a terminal tab we can see (another app): nothing to open.
if ($sessionPid) { "running $SessionId"; exit 0 }

$wt = Get-Command wt.exe -ErrorAction SilentlyContinue
if (-not $wt) { exit 2 }

# 2/3. A Claude session whose title (the custom-title record `nf task start` writes) names the branch. Its
# transcript sits under the folder the session started in: the main checkout or the worktree itself.
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
# A past session named by the click, though no title names it (the main checkout): resume that one.
if (-not $found -and $SessionId -match '^[0-9a-f-]{36}$') { $found = @{ id = $SessionId; cwd = $Path } }

if ($found) {
  $livePid = Get-SessionPid $found.id
  if ($livePid) {
    $tab = Find-ProcessTab $livePid
    if (-not $tab) { "running $($found.id)"; exit 0 }
    if (-not $DryRun) { Select-Tab $tab }
    "tab $($tab.name)"
    exit 0
  }
  if (-not $DryRun) { & $wt.Source -w 0 new-tab -d $found.cwd --title $Title claude --resume $found.id }
  "resumed $($found.id)"
  exit 0
}

# 4. A fresh session in the worktree.
if (-not $DryRun) { & $wt.Source -w 0 new-tab -d $Path --title $Title claude }
'new'
