param([string]$UriArg = '')

# Route by URI action. Whole URI looks like
#   askclaude:<action>?<query>
# Actions:
#   focus    — select + focus the Windows Terminal tab named in 'title'
#              (askclaude:focus?session=<GUID>&title=<url-encoded-title>)
#   openfile — open file(s) with their default Windows app
#              (askclaude:openfile?paths=<url-encoded-path>|<url-encoded-path>
#               or askclaude:openfile?list=<url-encoded-path-to-list-file>)
$action = 'focus'
if ($UriArg -match '^[A-Za-z]+:([^?]+)') { $action = $matches[1].ToLower() }

# Parse query params generically.
$params = @{}
if ($UriArg -match '\?(.+)$') {
    foreach ($pair in ($matches[1] -split '&')) {
        if ($pair -match '^([^=]+)=(.*)$') {
            $params[$matches[1]] = [System.Uri]::UnescapeDataString($matches[2])
        }
    }
}

if ($action -eq 'openfile') {
    # Collect paths: pipe-separated in 'paths' (Windows filenames can't contain
    # '|', so it's a safe separator), and/or one-per-line in a 'list' file.
    $paths = @()
    if ($params['paths']) { $paths += ($params['paths'] -split '\|') }
    if ($params['list'] -and (Test-Path -LiteralPath $params['list'])) {
        $paths += (Get-Content -LiteralPath $params['list'] | Where-Object { $_ -and $_.Trim() })
    }
    # Pause between launches: firing several files at a cold-starting UWP app
    # (e.g. Photos) in a tight loop collapses the activations and only the first
    # opens. A short gap lets each activation register.
    $first = $true
    foreach ($p in $paths) {
        $p = $p.Trim()
        if (-not $p) { continue }
        if (-not (Test-Path -LiteralPath $p)) { continue }
        if (-not $first) { Start-Sleep -Milliseconds 600 }
        $first = $false
        try { Invoke-Item -LiteralPath $p -ErrorAction Stop }
        catch { Start-Process explorer.exe -ArgumentList "`"$p`"" }
    }
    exit 0
}

# --- focus action (default) ---
$target = @{ title = $params['title']; session = $params['session'] }

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

# Selecting a tab via UIA moves the selected-state but leaves keyboard focus on
# the tab header. To let the user type / press Enter immediately we explicitly
# SetFocus on the terminal pane. Prefer TermControl (WT's terminal widget); fall
# back to the first visible, keyboard-focusable, non-TabItem descendant.
function Focus-TabContent($window) {
    $auto = [System.Windows.Automation.AutomationElement]
    $termCond = New-Object System.Windows.Automation.PropertyCondition(
        $auto::ClassNameProperty, 'TermControl')
    try { $terms = $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, $termCond) } catch { $terms = $null }
    if ($terms) {
        foreach ($t in $terms) {
            $isOff = $true
            try { $isOff = $t.Current.IsOffscreen } catch {}
            if (-not $isOff) {
                try { $t.SetFocus(); return } catch {}
            }
        }
    }
    $focusCond = New-Object System.Windows.Automation.AndCondition(
        (New-Object System.Windows.Automation.PropertyCondition($auto::IsKeyboardFocusableProperty, $true)),
        (New-Object System.Windows.Automation.PropertyCondition($auto::IsOffscreenProperty, $false))
    )
    try { $els = $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, $focusCond) } catch { return }
    foreach ($e in $els) {
        $ct = $null
        try { $ct = $e.Current.ControlType } catch { continue }
        if ($ct -ne [System.Windows.Automation.ControlType]::TabItem) {
            try { $e.SetFocus(); return } catch {}
        }
    }
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
                # Focus window, then move keyboard focus to the pane
                Focus-Hwnd $window.Current.NativeWindowHandle
                Focus-TabContent $window
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
