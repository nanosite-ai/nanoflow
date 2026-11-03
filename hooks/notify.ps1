# Show one Windows toast notification (Action Center), with nothing to install: WinRT's ToastNotificationManager,
# raised under Windows PowerShell's own registered app id. The text goes in as text nodes, never as XML source.
# -Launch (nanoflow://open/<token>) makes a click open that link: the nanoflow: scheme, registered here for the
# current user, runs open-session.ps1, which brings up the session the token names.
param([string]$Title = 'nanoflow', [string]$Body = '', [string]$Launch = '')
$ErrorActionPreference = 'Stop'

[void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
[void][Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]

$xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
$lines = $xml.GetElementsByTagName('text')
[void]$lines.Item(0).AppendChild($xml.CreateTextNode($Title))
[void]$lines.Item(1).AppendChild($xml.CreateTextNode($Body))

if ($Launch -match '^nanoflow://open/[0-9a-f]{16}$') {
  # Written each time, as the plugin's folder moves with its version: the scheme always runs this copy's script.
  $script = Join-Path $PSScriptRoot 'open-session.ps1'
  $command = "`"$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe`" -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$script`" -Uri `"%1`""
  $key = 'HKCU:\Software\Classes\nanoflow'
  $current = (Get-ItemProperty "$key\shell\open\command" -ErrorAction SilentlyContinue).'(default)'
  if ($current -ne $command) {
    New-Item "$key\shell\open\command" -Force | Out-Null
    Set-ItemProperty $key '(default)' 'URL:nanoflow'
    Set-ItemProperty $key 'URL Protocol' ''
    Set-ItemProperty "$key\shell\open\command" '(default)' $command
  }
  $xml.DocumentElement.SetAttribute('activationType', 'protocol')
  $xml.DocumentElement.SetAttribute('launch', $Launch)
}

$appId = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe'
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show([Windows.UI.Notifications.ToastNotification]::new($xml))
