#!/usr/bin/env node
const path = require('path');
const { loadLocalEnv } = require('./server/config/local-env');
const { resolvePidDir, resolvePidFiles, writePidFiles, removeOwnPidFiles } = require('./server/pid-files');

loadLocalEnv({ root: __dirname });

const { HOST, PORT } = require('./server/config');
const { createApp } = require('./server/app');

const { server, requestTrace } = createApp();

// HTTP server tuning: prevent socket exhaustion under high traffic
server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;
server.requestTimeout = 120000;
server.maxConnections = process.env.MAX_CONNECTIONS ? Number(process.env.MAX_CONNECTIONS) : Infinity;
const pidDir = resolvePidDir();
const pidFiles = resolvePidFiles({ port: PORT, pidDir });

function shutdown(signal) {
  server.close(() => {
    removeOwnPidFiles(pidFiles);
    process.exit(0);
  });
  setTimeout(() => {
    removeOwnPidFiles(pidFiles);
    process.exit(0);
  }, 3000).unref();
}

server.on('clientError', (_err, socket) => {
  socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
});

server.listen(PORT, HOST, () => {
  writePidFiles(pidFiles);
  console.log(`OpenAPI Chat Image is running locally: http://127.0.0.1:${PORT}`);
  console.log(`LAN access: http://<this-machine-ip>:${PORT}`);
  console.log(`Listening on: ${HOST}:${PORT}`);
  console.log(`PID: ${process.pid}`);
  if (requestTrace?.enabled) {
    const tracePath = path.relative(__dirname, requestTrace.filePath) || requestTrace.filePath;
    console.log(`[request-trace] writing redacted NDJSON to ${tracePath}`);
    requestTrace.record({ event: 'server.started', pid: process.pid, host: HOST, port: PORT });
  }
});

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('exit', () => removeOwnPidFiles(pidFiles));
