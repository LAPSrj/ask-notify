# ask-notify

Native Windows toast notifications when Claude Code is waiting for you to
approve or deny a tool call. Uses Claude Code's `Notification` hook to fire
a toast via the [BurntToast](https://github.com/Windos/BurntToast) PowerShell
module. Works from WSL and from native Windows.

## How it works

1. Claude Code emits a `Notification` hook event whenever it needs the user's
   attention — permission prompts **and** the idle-waiting-for-input
   timeout share this single hook.
2. The hook runs `notify.js` with the event payload on stdin.
3. `notify.js` filters out the idle message (`"Claude is waiting for your
   input"`) so you only get notified when Claude actually needs an approval
   decision, not every time it stops talking.
4. `notify.js` tails the session's transcript JSONL (read from the payload's
   `transcript_path`) to find the pending `tool_use` — the one with no
   matching `tool_result` yet. Only the last ~64 KB of the transcript is
   read (with a 2 MB cap if needed), so this stays fast even on very large
   sessions. The tool name and key input (e.g. Bash command, file path,
   search pattern) are added to the toast body.
5. `notify.js` invokes `powershell.exe` with a base64-encoded PowerShell
   snippet that builds the toast XML directly and submits it via
   `ToastNotificationManager.CreateToastNotifier($AppId).Show(...)`. No
   app-logo image is attached to notification toasts — the text area gets
   the full width so longer commands or file paths stay readable.
6. Before firing the toast, `notify.js` writes an OSC 0 escape to
   `/dev/tty` (or `\\.\CONOUT$` on native Windows) that sets the current
   Windows Terminal tab's title to a sentinel like
   `● Claude · <project> [<8-char-session-id>]`. Claude Code is blocked
   on the permission prompt during this window, so the title stays
   stable until you answer — and the focus handler can use it to pick
   the exact tab.
7. The toast XML has
   `launch="askclaude:focus?session=<WT_SESSION>&title=<encoded-title>"` +
   `activationType="protocol"`. Clicking the toast body routes that URI
   to our registered `askclaude:` scheme, whose handler is
   `focus-terminal.ps1`. The handler uses **UI Automation** to walk every
   Windows Terminal window, find the `TabItem` whose name matches the
   sentinel, and select it via `SelectionItemPattern.Select()` — then
   bring the parent window to the foreground via `SetForegroundWindow`.
   If no matching tab is found (e.g. title was overwritten by another
   app), it falls back to focusing any WT window.
8. Windows shows a real toast in the Action Center, attributed to
   **Claude Code** via the registered AUMID.

The Node script is fire-and-forget (`detached` + `unref`) so the hook returns
instantly and never blocks Claude.

If you'd rather also be notified on idle, remove the `waiting for your input`
check at the top of `notify.js`.

## Prerequisites

- Windows 10 or 11 — **BurntToast is Windows-only**, since it wraps the
  WinRT `Windows.UI.Notifications` APIs. This project has no analog on
  native Linux or macOS.
- Node.js on your PATH (inside WSL for the WSL flow, or on Windows for
  the native-Windows flow).
- Claude Code, either inside WSL or installed natively on Windows.
- Windows PowerShell 5.1+ (ships with Windows). PowerShell Core on Linux
  will not work, even from WSL — the script calls `powershell.exe`,
  which is the Windows host.

## Install

Pick the flow that matches where you run Claude Code.

### From WSL

```bash
cd /path/to/ask-notify   # wherever you cloned it
./install.sh
```

### From native Windows (cmd or PowerShell)

```cmd
cd \path\to\ask-notify
install.cmd
```

Both wrappers do the same thing:

1. Run `install.ps1`, which:
   - Installs `BurntToast` from the PowerShell Gallery for the current user
     (trusting PSGallery if needed) if it's not already installed.
   - Copies the pre-built `logo.png` (256×256) and `logo.ico`
     (16/24/32/48/64/128/256 multi-size) from the repo to
     `%LOCALAPPDATA%\ClaudeCode.AskNotify\`. The 256×256 PNG is large
     enough for every Windows DPI scale (100%–400%), so Windows
     downsamples as needed.
   - Registers an AppUserModelID (`ClaudeCode.AskNotify`) in the registry
     with `DisplayName = "Claude Code"` and `IconUri` pointing at the
     `.ico`. This is what makes Windows attribute toasts to **Claude
     Code** instead of **Windows PowerShell**.
   - Fires a confirmation toast so you can see the branding in place.
2. Run `install-hook.js`, which idempotently adds the `Notification` hook
   entry to Claude Code's `settings.json` — `~/.claude/settings.json` on
   WSL/Linux/macOS, `%USERPROFILE%\.claude\settings.json` on native
   Windows. Node's `os.homedir()` picks the right location automatically.
   If `settings.json` already exists it is backed up to
   `settings.json.bak` before being rewritten. Re-running is safe — the
   script detects an existing entry and leaves the file alone.

Restart any running Claude Code sessions afterwards so the new hook is
picked up.

> If you use Claude Code in **both** WSL and native Windows, run the
> installer once from each — they write to two different `.claude`
> directories.

### Manual install (optional)

If you'd rather not run `install.sh`, you can do the two steps yourself.

Install BurntToast from a Windows PowerShell prompt:

```powershell
Install-Module -Name BurntToast -Scope CurrentUser
```

Add the hook to `~/.claude/settings.json` (inside WSL):

```json
{
  "hooks": {
    "Notification": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "node /absolute/path/to/ask-notify/notify.js"
          }
        ]
      }
    ]
  }
}
```

Use the absolute path to your clone (the `install-hook.js` helper does this
for you automatically).

## Test it

From a Claude Code session, ask Claude to do something that requires a
permission prompt (e.g. run an unfamiliar shell command). A Windows toast
should appear titled `Claude Code · <project-folder>` with the message Claude
displayed.

You can also test the script directly without Claude:

```bash
echo '{"message":"test from ask-notify","cwd":"'"$PWD"'"}' | node notify.js
```

## Customization

Open `notify.js` and tweak the PowerShell snippet. A few things you might want:

- **Sound**: change the `New-BTAudio -Source` value to another event from
  `Get-BTAudio` (e.g. `ms-winsoundevent:Notification.IM`,
  `Notification.Mail`, `Notification.Reminder`). To silence the toast,
  replace the `$audio` line with `$audio = New-BTAudio -Silent`.
- **App logo / icon**: the installer copies `logo.png` (used as the toast
  app-logo override on the install confirmation toast) and `logo.ico`
  (registered as the AUMID icon) into
  `%LOCALAPPDATA%\ClaudeCode.AskNotify\`. Replace either file with your
  own art — no reinstall needed for the PNG; rerun `install.ps1` if you
  swap the ICO so the registry IconUri picks it up.
- **Buttons**: add `-Actions (New-BTAction -Buttons (New-BTButton ...))` to
  the `New-BTContent` call. Useful if you want a "Focus terminal" action.
- **Snooze / persistence**: add `-Scenario Reminder` to `New-BTContent` to
  make the toast stay until dismissed.
- **Title**: edit the `title` line in `notify.js`.

See the [BurntToast docs](https://github.com/Windos/BurntToast/tree/main/Help)
for the full surface.

## Toast attribution ("Claude Code" instead of "Windows PowerShell")

This is handled automatically by the installer. It writes the following
registry entries under
`HKCU\Software\Classes\AppUserModelId\ClaudeCode.AskNotify`:

- `DisplayName = Claude Code`
- `IconUri = %LOCALAPPDATA%\ClaudeCode.AskNotify\logo.png`
- `IconBackgroundColor = 00000000` (transparent)

`notify.js` then passes `-AppId 'ClaudeCode.AskNotify'` to
`Submit-BTNotification`, and Windows resolves the attribution name + small
header icon from the registry keys above.

A registered AUMID without a Start Menu shortcut is enough for the
attribution name and the in-toast `AppLogoOverride` image to work; no
`.lnk` is created, so nothing shows up in Start Menu search. If you want
an even more complete identity (e.g. the app appearing in **Settings →
System → Notifications** with a specific icon), you can add a hidden
`.lnk` in `%APPDATA%\Microsoft\Windows\Start Menu\Programs` whose
`System.AppUserModel.ID` property matches `ClaudeCode.AskNotify` — the
`Hidden` attribute keeps it out of Start Menu search while still being
discoverable by the Shell. See BurntToast's
[AppId docs](https://github.com/Windos/BurntToast/blob/main/Help/New-BTAppId.md)
for details.

> Windows sometimes caches notification platform metadata; if the
> attribution still shows the old name after install, sign out and back
> in (or restart `explorer.exe`) once.

## Troubleshooting

**Nothing happens when Claude prompts.**
Check that the hook is configured: run `claude` and inspect
`~/.claude/settings.json`. Then test the script manually with the `echo |
node notify.js` line above. If that toast appears, the issue is the hook
wiring; if not, the issue is BurntToast.

**Toast appears but no sound.**
Windows Focus Assist or per-app notification settings may be muting it. Open
**Settings → System → Notifications**, find **Claude Code** (or whatever
`DisplayName` the AUMID is registered with), and ensure sound is enabled.

**`powershell.exe: command not found` from WSL.**
Your WSL `PATH` may not include `/mnt/c/Windows/System32`. Either fix the
path or replace `powershell.exe` in `notify.js` with the absolute path
`/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe`.

**`Import-Module BurntToast` fails.**
Re-run `./install.sh`. If `Install-Module` itself fails, you may need to
update PowerShellGet first:

```powershell
Install-Module -Name PowerShellGet -Force -AllowClobber
```

then restart PowerShell and try again.

**Toasts only show in Action Center, not as banners.**
That's a Windows notification setting. **Settings → System → Notifications →
[your AppId / PowerShell] → Show notification banners**.

## Files

- `notify.js` — the hook script Claude Code invokes
- `logo.png` / `logo.ico` — logo assets shipped with the package
- `focus-terminal.ps1` — click-toast handler; focuses the right Windows
  Terminal tab via UI Automation
- `focus-terminal.vbs` — tiny WScript wrapper that runs `focus-terminal.ps1`
  with no visible window (avoids the PowerShell console flash on click)
- `install.ps1` — installs BurntToast, copies the assets, registers the
  AUMID, and registers the `askclaude:` URI scheme
- `install-hook.js` — patches Claude Code's `settings.json` to register the hook
- `install.sh` — WSL wrapper that runs `install.ps1` then `install-hook.js`
- `install.cmd` — native-Windows wrapper that runs the same two steps
- `package.json` / `LICENSE` — npm metadata and MIT license
