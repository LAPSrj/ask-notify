#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const os = require('os');

const NOTIFY_PATH = path.resolve(__dirname, 'notify.js');
const COMMAND = `node ${NOTIFY_PATH}`;
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
settings.hooks.Notification = settings.hooks.Notification || [];

const alreadyInstalled = settings.hooks.Notification.some((entry) =>
  Array.isArray(entry.hooks) &&
  entry.hooks.some((h) => h && h.type === 'command' && typeof h.command === 'string' && h.command.includes('notify.js'))
);

if (alreadyInstalled) {
  console.log(`ask-notify hook already present in ${SETTINGS_PATH} — leaving as-is.`);
  process.exit(0);
}

settings.hooks.Notification.push({
  matcher: '',
  hooks: [{ type: 'command', command: COMMAND }],
});

if (originalText) {
  fs.writeFileSync(`${SETTINGS_PATH}.bak`, originalText);
  console.log(`Backed up existing settings to ${SETTINGS_PATH}.bak`);
}

fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + '\n');
console.log(`Added Notification hook to ${SETTINGS_PATH}:`);
console.log(`  ${COMMAND}`);
console.log('Restart any running Claude Code sessions to pick it up.');
