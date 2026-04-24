$ErrorActionPreference = 'Stop'

$AppId = 'ClaudeCode.AskNotify'
$DisplayName = 'Claude Code'
$UriScheme = 'askclaude'
$AppDir = Join-Path $env:LOCALAPPDATA 'ClaudeCode.AskNotify'
$LogoPng = Join-Path $AppDir 'logo.png'
$LogoIco = Join-Path $AppDir 'logo.ico'
$FocusScript = Join-Path $AppDir 'focus-terminal.ps1'
$FocusVbs = Join-Path $AppDir 'focus-terminal.vbs'
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

if (Get-Module -ListAvailable -Name BurntToast) {
    Write-Host 'BurntToast is already installed.' -ForegroundColor Green
} else {
    Write-Host 'Installing BurntToast for the current user...' -ForegroundColor Cyan
    if ((Get-PSRepository -Name PSGallery).InstallationPolicy -ne 'Trusted') {
        Set-PSRepository -Name PSGallery -InstallationPolicy Trusted
    }
    Install-Module -Name BurntToast -Scope CurrentUser -Force -AllowClobber
}
Import-Module BurntToast

if (-not (Test-Path $AppDir)) { New-Item -ItemType Directory -Path $AppDir -Force | Out-Null }

Write-Host "Copying assets to $AppDir..." -ForegroundColor Cyan
Copy-Item -Path (Join-Path $ScriptDir 'logo.png') -Destination $LogoPng -Force
Copy-Item -Path (Join-Path $ScriptDir 'logo.ico') -Destination $LogoIco -Force
Copy-Item -Path (Join-Path $ScriptDir 'focus-terminal.ps1') -Destination $FocusScript -Force
Copy-Item -Path (Join-Path $ScriptDir 'focus-terminal.vbs') -Destination $FocusVbs -Force

Write-Host "Registering AUMID '$AppId' with DisplayName '$DisplayName'..." -ForegroundColor Cyan
$RegPath = "HKCU:\Software\Classes\AppUserModelId\$AppId"
if (-not (Test-Path $RegPath)) { New-Item -Path $RegPath -Force | Out-Null }
Set-ItemProperty -Path $RegPath -Name 'DisplayName' -Value $DisplayName
Set-ItemProperty -Path $RegPath -Name 'IconUri' -Value $LogoIco
New-ItemProperty -Path $RegPath -Name 'IconBackgroundColor' -Value '00000000' -PropertyType String -Force | Out-Null

Write-Host "Registering '${UriScheme}://' URI scheme (click-toast-to-focus-terminal)..." -ForegroundColor Cyan
$SchemeRoot = "HKCU:\Software\Classes\$UriScheme"
$SchemeCmd = Join-Path $SchemeRoot 'shell\open\command'
if (-not (Test-Path $SchemeRoot)) { New-Item -Path $SchemeRoot -Force | Out-Null }
if (-not (Test-Path $SchemeCmd))  { New-Item -Path $SchemeCmd  -Force | Out-Null }
Set-Item -Path $SchemeRoot -Value "URL:$DisplayName Focus Protocol"
New-ItemProperty -Path $SchemeRoot -Name 'URL Protocol' -Value '' -PropertyType String -Force | Out-Null
$CommandLine = "wscript.exe `"$FocusVbs`" `"%1`""
Set-Item -Path $SchemeCmd -Value $CommandLine

$texts = @('Setup complete', 'Toasts will fire when Claude Code needs your approval. (Click this toast to test the focus-terminal action.)')
$imageXml = ''
if (Test-Path $LogoPng) {
    $escLogo = [System.Security.SecurityElement]::Escape($LogoPng)
    $imageXml = "<image placement='appLogoOverride' hint-crop='none' src='$escLogo'/>"
}
$textXml = ''
foreach ($t in $texts) { $textXml += "<text>$([System.Security.SecurityElement]::Escape($t))</text>" }
$launch = [System.Security.SecurityElement]::Escape("${UriScheme}:focus")
$xml = "<toast launch='$launch' activationType='protocol'><visual><binding template='ToastGeneric'>$imageXml$textXml</binding></visual><audio src='ms-winsoundevent:Notification.Default'/></toast>"

$xmlDoc = New-Object Windows.Data.Xml.Dom.XmlDocument
$xmlDoc.LoadXml($xml)
$toast = New-Object Windows.UI.Notifications.ToastNotification $xmlDoc
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($AppId).Show($toast)

Write-Host 'Done.' -ForegroundColor Green
