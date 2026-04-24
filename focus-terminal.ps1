param([string]$UriArg = '')

# Parse 'title' and 'session' query params out of the URI. Whole URI looks like
#   askclaude:focus?session=<GUID>&title=<url-encoded-title>
$target = @{ title = $null; session = $null }
if ($UriArg -match '\?(.+)$') {
    foreach ($pair in ($matches[1] -split '&')) {
        if ($pair -match '^([^=]+)=(.*)$') {
            $k = $matches[1]
            $v = [System.Uri]::UnescapeDataString($matches[2])
            if ($target.ContainsKey($k)) { $target[$k] = $v }
        }
    }
}

Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class U {
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr h, int n);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
}
"@

function Focus-Hwnd($hwnd) {
    if ($hwnd -eq 0 -or $hwnd -eq [IntPtr]::Zero) { return }
    $h = [IntPtr]$hwnd
    if ([U]::IsIconic($h)) { [void][U]::ShowWindowAsync($h, 9) } # SW_RESTORE
    [void][U]::SetForegroundWindow($h)
}

function Try-FocusTabByTitle($title) {
    if (-not $title) { return $false }
    $auto = [System.Windows.Automation.AutomationElement]
    $root = $auto::RootElement
    $wtClassCond = New-Object System.Windows.Automation.PropertyCondition(
        $auto::ClassNameProperty, 'CASCADIA_HOSTING_WINDOW_CLASS')
    $windows = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $wtClassCond)
    if (-not $windows -or $windows.Count -eq 0) { return $false }

    $tabCond = New-Object System.Windows.Automation.PropertyCondition(
        $auto::ControlTypeProperty, [System.Windows.Automation.ControlType]::TabItem)

    foreach ($window in $windows) {
        try {
            $tabs = $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, $tabCond)
        } catch { continue }
        foreach ($tab in $tabs) {
            $name = ''
            try { $name = $tab.Current.Name } catch { continue }
            if ($name -eq $title) {
                # Select tab
                try {
                    $sip = $tab.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern)
                    $sip.Select()
                } catch {
                    try {
                        $ip = $tab.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
                        $ip.Invoke()
                    } catch {}
                }
                # Focus window
                Focus-Hwnd $window.Current.NativeWindowHandle
                return $true
            }
        }
    }
    return $false
}

function Fallback-FocusAnyWT {
    $proc = Get-Process -Name WindowsTerminal -ErrorAction SilentlyContinue |
        Where-Object { $_.MainWindowHandle -ne 0 } |
        Sort-Object StartTime -Descending |
        Select-Object -First 1
    if ($proc) { Focus-Hwnd $proc.MainWindowHandle }
    # If no Windows Terminal is running, do nothing — launching a fresh
    # instance from a toast click would be surprising.
}

if (-not (Try-FocusTabByTitle $target.title)) {
    Fallback-FocusAnyWT
}
