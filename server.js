#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { HOST, PORT } = require('./server/config');
const { createApp } = require('./server/app');

const { server } = createApp();
const pidFiles = [path.join(__dirname, 'temp', `chatui-${PORT}.pid`)];
if (Number(PORT) === 8765) pidFiles.push(path.join(__dirname, 'temp', 'chatui-server.pid'));

function writePidFiles() {
  try {
    fs.mkdirSync(path.join(__dirname, 'temp'), { recursive: true });
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
