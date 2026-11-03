# Show one Windows toast notification (Action Center), with nothing to install: WinRT's ToastNotificationManager,
# raised under Windows PowerShell's own registered app id. The text goes in as text nodes, never as XML source.
param([string]$Title = 'nanoflow', [string]$Body = '')
$ErrorActionPreference = 'Stop'

[void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
[void][Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]

$xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
$lines = $xml.GetElementsByTagName('text')
[void]$lines.Item(0).AppendChild($xml.CreateTextNode($Title))
[void]$lines.Item(1).AppendChild($xml.CreateTextNode($Body))

$appId = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe'
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show([Windows.UI.Notifications.ToastNotification]::new($xml))
