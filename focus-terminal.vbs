' Wrapper invoked by the askclaude:// URI scheme handler.
' Runs focus-terminal.ps1 with no visible window — using powershell.exe
' directly leaves a brief console flash on screen even with
' -WindowStyle Hidden, because PowerShell creates its own host window
' before applying the style. WScript.Shell.Run(..., 0, False) launches
' the child fully hidden.

Option Explicit

Dim sh, psPath, arg, cmd
Set sh = CreateObject("WScript.Shell")
psPath = sh.ExpandEnvironmentStrings("%LOCALAPPDATA%\ClaudeCode.AskNotify\focus-terminal.ps1")

arg = ""
If WScript.Arguments.Count > 0 Then arg = WScript.Arguments(0)

cmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File """ & psPath & """ """ & arg & """"
sh.Run cmd, 0, False
