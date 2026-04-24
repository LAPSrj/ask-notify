#!/usr/bin/env node
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { raw += chunk; });
process.stdin.on('end', () => {
  let payload = {};
  try { payload = JSON.parse(raw); } catch { /* fall through with defaults */ }

  const message = payload.message || '';

  // Claude Code's Notification hook fires for both permission prompts AND the
  // idle-waiting-for-input timeout. We only want approval prompts, so drop the
  // idle message.
  if (/waiting for your input/i.test(message)) return;
  if (!message) return;

  const cwd = payload.cwd || '';
  const project = cwd ? path.basename(cwd) : '';
  const title = project || 'Approval needed';

  const toolUse = readPendingToolUse(payload.transcript_path);
  const detail = summarizeToolUse(toolUse);

  const children = [title, message];
  if (detail) children.push(detail);
  const textArray = children.map(psString).join(', ');

  const appId = 'ClaudeCode.AskNotify';
  const wtSession = process.env.WT_SESSION || '';

  // Stamp the WT tab title with a sentinel the focus script can match.
  // Claude Code is blocked on the permission prompt while we do this, so the
  // title stays stable until the user answers. A marker like `CC:<short>`
  // keeps it unique across tabs without being visually noisy.
  const shortId = wtSession ? wtSession.slice(0, 8) : '';
  const tabTitle = shortId
    ? `● Claude · ${project || 'session'} [${shortId}]`
    : `● Claude · ${project || 'session'}`;
  if (wtSession) setTabTitle(tabTitle);

  const launchParams = [];
  if (wtSession) launchParams.push(`session=${encodeURIComponent(wtSession)}`);
  launchParams.push(`title=${encodeURIComponent(tabTitle)}`);
  const launchUri = `askclaude:focus?${launchParams.join('&')}`;

  const ps = `
$ErrorActionPreference = 'Stop'
Import-Module BurntToast -ErrorAction Stop

# If the Windows Terminal tab that triggered this notification is already the
# foreground window, the user is staring at it and doesn't need a toast. Check
# via UIA before spending the cycles to build and fire one.
$targetTitle = ${psString(tabTitle)}
if ($targetTitle) {
    try {
        Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes -ErrorAction Stop
        Add-Type -Name AskNotifyU -Namespace AskNotify -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern System.IntPtr GetForegroundWindow();
'@ -ErrorAction SilentlyContinue
        $fgHwnd = [AskNotify.AskNotifyU]::GetForegroundWindow()
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
                        if ($sip.Current.IsSelected -and $t.Current.Name -eq $targetTitle) { exit 0 }
                    } catch {}
                }
            }
        }
    } catch {}
}

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
  const child = spawn('powershell.exe', ['-NoProfile', '-EncodedCommand', encoded], {
    stdio: 'ignore',
    detached: true,
  });
  child.on('error', () => process.exit(0));
  child.unref();
});

function psString(s) {
  return "'" + String(s).replace(/'/g, "''") + "'";
}

// Write an OSC 0 escape to the controlling TTY to set the terminal's tab
// title. Claude Code is blocked on the permission prompt while the hook runs,
// so nothing else is writing to the TTY and the title stays until the user
// answers. Best-effort: swallow any errors (no TTY, closed fd, etc.).
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

// Read the transcript JSONL from the end in chunks to find the most recent
// tool_use that does not yet have a matching tool_result. Transcripts can be
// many MB, so we never load the whole file — we tail it in 64 KB slices up to
// a 2 MB cap, which in practice covers far more than the tail we need.
function readPendingToolUse(transcriptPath) {
  if (!transcriptPath) return null;
  let fd;
  try {
    const { size } = fs.statSync(transcriptPath);
    if (!size) return null;
    fd = fs.openSync(transcriptPath, 'r');

    const CHUNK = 64 * 1024;
    const MAX_READ = 2 * 1024 * 1024;
    const seenResults = new Set();

    let offset = size;
    let readTotal = 0;
    let leftover = '';

    while (offset > 0 && readTotal < MAX_READ) {
      const toRead = Math.min(CHUNK, offset);
      offset -= toRead;
      readTotal += toRead;

      const buf = Buffer.alloc(toRead);
      fs.readSync(fd, buf, 0, toRead, offset);
      const text = buf.toString('utf8') + leftover;

      let lines;
      if (offset > 0) {
        const firstNewline = text.indexOf('\n');
        if (firstNewline === -1) {
          leftover = text;
          continue;
        }
        leftover = text.slice(0, firstNewline);
        lines = text.slice(firstNewline + 1).split('\n');
      } else {
        leftover = '';
        lines = text.split('\n');
      }

      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i];
        if (!line || line.length < 2) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        const content = (msg && msg.message && msg.message.content) || (msg && msg.content);
        if (!Array.isArray(content)) continue;

        for (const c of content) {
          if (c && c.type === 'tool_result' && c.tool_use_id) {
            seenResults.add(c.tool_use_id);
          }
        }
        for (const c of content) {
          if (c && c.type === 'tool_use' && c.id && !seenResults.has(c.id)) {
            return { name: c.name, input: c.input };
          }
        }
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
  }
}

function summarizeToolUse(tu) {
  if (!tu || !tu.name) return '';
  const MAX = 120;
  const { name, input } = tu;
  let detail = '';
  if (input && typeof input === 'object') {
    if (name === 'Bash') detail = input.command || '';
    else if (name === 'Edit' || name === 'Write' || name === 'Read' || name === 'NotebookEdit') detail = input.file_path || '';
    else if (name === 'Glob' || name === 'Grep') detail = input.pattern || '';
    else if (name === 'WebFetch' || name === 'WebSearch') detail = input.url || input.query || '';
    else {
      try { detail = JSON.stringify(input); } catch { detail = ''; }
    }
  }
  detail = detail.replace(/\s+/g, ' ').trim();
  if (detail.length > MAX) detail = detail.slice(0, MAX - 1) + '…';
  return name + (detail ? `: ${detail}` : '');
}
