#!/usr/bin/env node
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const serverJs = fs.readFileSync(path.join(__dirname, '../../server.js'), 'utf8');

assert.match(serverJs, /function resolvePidDir\(\)/, 'server resolves pid dir before writing pid files');
assert.match(serverJs, /CHATUI_DISABLE_PID_FILE/, 'pid file writing can be disabled in read-only containers');
assert.match(serverJs, /CHATUI_PID_DIR/, 'pid directory can be configured for containers');
assert.match(serverJs, /os\.tmpdir\(\)/, 'server falls back to the OS temp directory when project temp is not writable');
assert.ok(!serverJs.includes("fs.mkdirSync(path.join(__dirname, 'temp'), { recursive: true });\n    for (const file of pidFiles)"), 'server no longer requires project temp to be writable before startup');

console.log('server pid dir contract ok');
