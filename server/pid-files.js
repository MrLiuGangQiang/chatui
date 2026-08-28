'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// Process-level pid-file handling. Keep this helper pure and testable so the
// entrypoint only decides where to write one port-scoped file per instance.
function resolvePidDir({ env = process.env, root = path.resolve(__dirname, '..'), tmpdir = os.tmpdir() } = {}) {
  if (String(env.CHATUI_DISABLE_PID_FILE) === '1') return '';
  const candidates = [
    env.CHATUI_PID_DIR,
    path.join(root, 'temp'),
    path.join(tmpdir, 'chatui'),
  ].filter(Boolean);
  for (const dir of candidates) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.accessSync(dir, fs.constants.W_OK);
      return dir;
    } catch {}
  }
  return '';
}

function resolvePidFiles({ port, pidDir }) {
  if (!pidDir) return [];
  const normalizedPort = Number(port);
  if (!Number.isFinite(normalizedPort) || normalizedPort <= 0) return [];
  return [path.join(pidDir, 'chatui-' + normalizedPort + '.pid')];
}

function writePidFiles(files, pid = process.pid) {
  if (!Array.isArray(files) || !files.length) return;
  try {
    for (const file of files) fs.writeFileSync(file, String(pid) + '\n');
  } catch (err) {
    console.warn('[server] failed to write pid file:', err.message || err);
  }
}

function removeOwnPidFiles(files, pid = process.pid) {
  for (const file of Array.isArray(files) ? files : []) {
    try {
      if (fs.readFileSync(file, 'utf8').trim() === String(pid)) fs.rmSync(file, { force: true });
    } catch {}
  }
}

module.exports = { resolvePidDir, resolvePidFiles, writePidFiles, removeOwnPidFiles };
