#!/usr/bin/env node
// PostToolUse hook for Claude Code's SendUserFile tool.
//
// When Claude "sends" a file to the user (a tool meant for remote/web sessions
// where the file shows up in the chat UI), the local CLI has no way to display
// it. This hook bridges that gap on Windows/WSL:
//
//   - If the Windows Terminal tab running this session is the foreground
//     window, the file(s) open immediately with their default Windows app —
//     you're looking at the session, so zero friction.
//   - Otherwise a toast notification is shown (caption + file names).
//     Clicking the toast opens the file(s) via the askclaude:openfile
//     protocol action handled by focus-terminal.ps1.
//
// Register in ~/.claude/settings.json (install-hook.js does this for you):
//   {
//     "hooks": {
//       "PostToolUse": [
//         {
//           "matcher": "SendUserFile",
//           "hooks": [
//             { "type": "command", "command": "node /absolute/path/to/ask-notify/open-file.js" }
//           ]
//         }
//       ]
//     }
//   }
//
// Manual testing:
//   node open-file.js payload.json                # read payload from file instead of stdin
//   node open-file.js payload.json --force-open   # skip focus check, open directly
//   node open-file.js payload.json --force-toast  # skip focus check, always toast
//   node open-file.js payload.json --debug        # run PowerShell synchronously, print its output

const { spawn, spawnSync, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const MAX_LAUNCH_URI = 1800; // beyond this, pass paths via a list file instead

const args = process.argv.slice(2);
const forceOpen = args.includes('--force-open');
const forceToast = args.includes('--force-toast');
const debug = args.includes('--debug');
const payloadFile = args.find((a) => !a.startsWith('--'));

if (payloadFile) {
  run(readPayload(payloadFile));
} else {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => { raw += chunk; });
  process.stdin.on('end', () => run(parseJson(raw)));
}

function run(payload) {
  if (!payload) return;

  // Matcher should already scope this, but don't trust it blindly.
  if (payload.tool_name && payload.tool_name !== 'SendUserFile') return;

  const cwd = payload.cwd || process.cwd();
  const caption = (payload.tool_input && payload.tool_input.caption) || '';
  const project = cwd ? path.basename(cwd) : '';

  // Prefer resolved paths from tool_response.attachments; fall back to tool_input.files.
  const localPaths = collectPaths(payload, cwd);
  if (localPaths.length === 0) return;

  // Convert to Windows paths (UNC for Linux-fs files). On native Windows the
  // paths are already Windows paths.
  const winPaths = localPaths.map(toWindowsPath).filter(Boolean);
  if (winPaths.length === 0) return;

  // Stamp the Windows Terminal tab title with a sentinel so the PowerShell
  // focus check can tell whether THIS session's tab is the one in the
  // foreground. Same technique as notify.js.
  const wtSession = process.env.WT_SESSION || '';
  const shortId = wtSession ? wtSession.slice(0, 8) : '';
  const tabTitle = shortId
    ? `● Claude · ${project || 'session'} [${shortId}]`
    : '';
  let mode = 'auto';
  if (forceOpen) mode = 'open';
  else if (forceToast) mode = 'toast';
  else if (!tabTitle) mode = 'toast'; // no WT session → can't focus-check → toast
  if (mode === 'auto') setTabTitle(tabTitle);

  // Build the click-to-open launch URI. Windows filenames can't contain '|',
  // so it's a safe separator after URL-decoding.
  let launchUri = 'askclaude:openfile?paths=' + winPaths.map(encodeURIComponent).join('|');
  if (launchUri.length > MAX_LAUNCH_URI) {
    const listPath = writeListFile(winPaths);
    if (listPath) launchUri = 'askclaude:openfile?list=' + encodeURIComponent(listPath);
  }

  // Toast text: project, caption (or a default line), file names.
  const n = winPaths.length;
  const title = project ? `${project} · ${n} file${n > 1 ? 's' : ''} from Claude` : `Claude sent ${n} file${n > 1 ? 's' : ''}`;
  const names = localPaths.map((p) => path.basename(p)).join(', ');
  const texts = [title];
  if (caption) texts.push(truncate(caption, 200));
  texts.push(truncate(names, 120) + ' — click to open');
  const textArray = texts.map(psString).join(', ');

  const pathArray = winPaths.map(psString).join(', ');
  const appId = 'ClaudeCode.AskNotify';

  const ps = `
$ErrorActionPreference = 'Stop'

$mode = ${psString(mode)}
$targetTitle = ${psString(tabTitle)}
$paths = @(${pathArray})
$focused = $false

if ($mode -eq 'open') {
    $focused = $true
} elseif ($mode -eq 'auto' -and $targetTitle) {
    # Is the foreground window the Windows Terminal tab running this session?
    try {
        Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes -ErrorAction Stop
        Add-Type -Name OpenFileU -Namespace AskNotify -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern System.IntPtr GetForegroundWindow();
'@ -ErrorAction SilentlyContinue
        $fgHwnd = [AskNotify.OpenFileU]::GetForegroundWindow()
        if ($fgHwnd -ne [IntPtr]::Zero) {
            $fgEl = [System.Windows.Automation.AutomationElement]::FromHandle($fgHwnd)
            if ($fgEl -and $fgEl.Current.ClassName -eq 'CASCADIA_HOSTING_WINDOW_CLASS') {
                $tabCond = New-Object System.Windows.Automation.PropertyCondition(
                    [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
                    [System.Windows.Automation.ControlType]::TabItem)
                $tabs = $fgEl.FindAll([System.Windows.Automation.TreeScope]::Descendants, $tabCond)
                foreach ($t in $tabs) {
                    try {
                        $sip = $t.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern)
                        if ($sip.Current.IsSelected -and $t.Current.Name -eq $targetTitle) { $focused = $true; break }
                    } catch {}
                }
            }
        }
    } catch {}
}

if ($focused) {
    # User is looking at this session's terminal — open the files directly.
    # Pause between launches: firing several files at a cold-starting UWP app
    # (e.g. Photos) in a tight loop collapses the activations and only the first
    # opens. A short gap lets each activation register.
    $first = $true
    foreach ($p in $paths) {
        if (-not (Test-Path -LiteralPath $p)) { continue }
        if (-not $first) { Start-Sleep -Milliseconds 600 }
        $first = $false
        try { Invoke-Item -LiteralPath $p -ErrorAction Stop }
        catch { Start-Process explorer.exe -ArgumentList "\`"$p\`"" }
    }
    exit 0
}

# Not focused — show a toast; clicking it opens the file(s).
Import-Module BurntToast -ErrorAction Stop
$texts = @(${textArray})
$textXml = ''
foreach ($t in $texts) { $textXml += "<text>$([System.Security.SecurityElement]::Escape($t))</text>" }
$launch = [System.Security.SecurityElement]::Escape(${psString(launchUri)})
$xml = "<toast launch='$launch' activationType='protocol'><visual><binding template='ToastGeneric'>$textXml</binding></visual><audio src='ms-winsoundevent:Notification.Default'/></toast>"
$xmlDoc = New-Object Windows.Data.Xml.Dom.XmlDocument
$xmlDoc.LoadXml($xml)
$toast = New-Object Windows.UI.Notifications.ToastNotification $xmlDoc
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier(${psString(appId)}).Show($toast)
`;

  const encoded = Buffer.from(ps, 'utf16le').toString('base64');

  if (debug) {
    // Synchronous run with visible output, for manual testing/troubleshooting.
    const r = spawnSync('powershell.exe', ['-NoProfile', '-EncodedCommand', encoded], { encoding: 'utf8' });
    if (r.stdout) process.stdout.write(r.stdout);
    if (r.stderr) process.stderr.write(r.stderr);
    console.log(`mode=${mode} exit=${r.status}`);
    process.exit(0);
  }

  const child = spawn('powershell.exe', ['-NoProfile', '-EncodedCommand', encoded], {
    stdio: 'ignore',
    detached: true,
  });
  child.on('error', () => process.exit(0));
  child.unref();
}

function collectPaths(payload, cwd) {
  const attachments = (payload.tool_response && payload.tool_response.attachments) || [];
  let raw = attachments.map((a) => a && a.path).filter(Boolean);
  if (raw.length === 0) {
    raw = (payload.tool_input && payload.tool_input.files) || [];
  }
  const out = [];
  for (const p of raw) {
    const resolved = path.resolve(cwd, p);
    try {
      if (fs.statSync(resolved).isFile()) out.push(resolved);
    } catch { /* missing file — skip */ }
  }
  return out;
}

/** WSL path → Windows path. On native Windows, return the path unchanged. */
function toWindowsPath(p) {
  if (process.platform === 'win32') return p;
  try {
    return execFileSync('wslpath', ['-w', p], { encoding: 'utf8', timeout: 10000 }).trim();
  } catch {
    return null;
  }
}

/** Write Windows paths (one per line) to a temp list file; return a Windows-readable path to it. */
function writeListFile(winPaths) {
  try {
    const dir = process.platform === 'win32' ? require('os').tmpdir() : '/tmp';
    const file = path.join(dir, `asknotify-open-${process.pid}-${Date.now()}.txt`);
    fs.writeFileSync(file, winPaths.join('\r\n'), 'utf8');
    return toWindowsPath(file);
  } catch {
    return null;
  }
}

function readPayload(file) {
  try {
    return parseJson(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function parseJson(raw) {
  try { return JSON.parse(raw); } catch { return null; }
}

function psString(s) {
  return "'" + String(s).replace(/'/g, "''") + "'";
}

function truncate(s, max) {
  s = String(s).replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

// Write an OSC 0 escape to the controlling TTY to set the terminal's tab
// title to the sentinel the PowerShell focus check matches against.
// Best-effort: swallow any errors (no TTY, closed fd, etc.).
function setTabTitle(title) {
  const safe = String(title).replace(/[\x00-\x1F\x7F]/g, ' ');
  const payload = `\x1b]0;${safe}\x07`;
  const ttyPath = process.platform === 'win32' ? '\\\\.\\CONOUT$' : '/dev/tty';
  let fd;
  try {
    fd = fs.openSync(ttyPath, 'w');
    fs.writeSync(fd, payload);
  } catch { /* no tty, ignore */ }
  finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
  }
}
