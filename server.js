#!/usr/bin/env node
const fs = require('fs');
const os = require('os');
const path = require('path');
const { HOST, PORT } = require('./server/config');
const { createApp } = require('./server/app');

const { server } = createApp();

// HTTP server tuning: prevent socket exhaustion under high traffic
server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;
server.requestTimeout = 120000;
server.maxConnections = process.env.MAX_CONNECTIONS ? Number(process.env.MAX_CONNECTIONS) : Infinity;
function resolvePidDir() {
  if (process.env.CHATUI_DISABLE_PID_FILE === '1') return '';
  const candidates = [
    process.env.CHATUI_PID_DIR,
    path.join(__dirname, 'temp'),
    path.join(os.tmpdir(), 'chatui'),
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

const pidDir = resolvePidDir();
const pidFiles = pidDir ? [path.join(pidDir, `chatui-${PORT}.pid`)] : [];
if (pidDir && Number(PORT) === 8765) pidFiles.push(path.join(pidDir, 'chatui-server.pid'));

function writePidFiles() {
  if (!pidFiles.length) return;
  try {
    for (const file of pidFiles) fs.writeFileSync(file, `${process.pid}\n`);
  } catch (err) {
    console.warn('[server] failed to write pid file:', err.message || err);
  }
}

function removeOwnPidFiles() {
  for (const file of pidFiles) {
    try {
      if (fs.readFileSync(file, 'utf8').trim() === String(process.pid)) fs.rmSync(file, { force: true });
    } catch {}
  }
}

function shutdown(signal) {
  server.close(() => {
    removeOwnPidFiles();
    process.exit(0);
  });
  setTimeout(() => {
    removeOwnPidFiles();
    process.exit(0);
  }, 3000).unref();
}

server.on('clientError', (_err, socket) => {
  socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
});

server.listen(PORT, HOST, () => {
  writePidFiles();
  console.log(`OpenAPI Chat Image is running locally: http://127.0.0.1:${PORT}`);
  console.log(`LAN access: http://<this-machine-ip>:${PORT}`);
  console.log(`Listening on: ${HOST}:${PORT}`);
  console.log(`PID: ${process.pid}`);
});

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('exit', removeOwnPidFiles);
