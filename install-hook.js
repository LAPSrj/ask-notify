#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const os = require('os');

const NOTIFY_COMMAND = `node ${path.resolve(__dirname, 'notify.js')}`;
const OPEN_FILE_COMMAND = `node ${path.resolve(__dirname, 'open-file.js')}`;
const SETTINGS_DIR = path.join(os.homedir(), '.claude');
const SETTINGS_PATH = path.join(SETTINGS_DIR, 'settings.json');

fs.mkdirSync(SETTINGS_DIR, { recursive: true });

let settings = {};
let originalText = '';
if (fs.existsSync(SETTINGS_PATH)) {
  originalText = fs.readFileSync(SETTINGS_PATH, 'utf8');
  if (originalText.trim()) {
    try {
      settings = JSON.parse(originalText);
    } catch (err) {
      console.error(`Could not parse ${SETTINGS_PATH}: ${err.message}`);
      console.error('Fix the JSON manually, then re-run this script.');
      process.exit(1);
    }
  }
}

settings.hooks = settings.hooks || {};

// A hook entry is "ours" if any of its commands reference the given script name.
function hasHook(entries, scriptName) {
  return (entries || []).some((entry) =>
    Array.isArray(entry.hooks) &&
    entry.hooks.some((h) => h && h.type === 'command' && typeof h.command === 'string' && h.command.includes(scriptName))
  );
}

let changed = false;

// 1. Notification hook → toast on approval prompts (notify.js)
settings.hooks.Notification = settings.hooks.Notification || [];
if (hasHook(settings.hooks.Notification, 'notify.js')) {
  console.log(`Notification hook (notify.js) already present in ${SETTINGS_PATH} — leaving as-is.`);
} else {
  settings.hooks.Notification.push({
    matcher: '',
    hooks: [{ type: 'command', command: NOTIFY_COMMAND }],
  });
  console.log(`Adding Notification hook: ${NOTIFY_COMMAND}`);
  changed = true;
}

// 2. PostToolUse hook → open / toast files sent via SendUserFile (open-file.js)
settings.hooks.PostToolUse = settings.hooks.PostToolUse || [];
if (hasHook(settings.hooks.PostToolUse, 'open-file.js')) {
  console.log(`PostToolUse hook (open-file.js) already present in ${SETTINGS_PATH} — leaving as-is.`);
} else {
  settings.hooks.PostToolUse.push({
    matcher: 'SendUserFile',
    hooks: [{ type: 'command', command: OPEN_FILE_COMMAND }],
  });
  console.log(`Adding PostToolUse hook (SendUserFile): ${OPEN_FILE_COMMAND}`);
  changed = true;
}

if (!changed) {
  process.exit(0);
}

if (originalText) {
  fs.writeFileSync(`${SETTINGS_PATH}.bak`, originalText);
  console.log(`Backed up existing settings to ${SETTINGS_PATH}.bak`);
}

fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + '\n');
console.log(`Updated ${SETTINGS_PATH}.`);
console.log('Restart any running Claude Code sessions to pick up the new hooks.');
