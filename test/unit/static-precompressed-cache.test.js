'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { serveStatic } = require('../../server/http/static');

function requestStatic(root, headers = {}) {
  return new Promise((resolve) => {
    const result = { status: 0, headers: {}, body: Buffer.alloc(0) };
    const req = { url: '/client/cache.js', method: 'GET', headers };
    const res = {
      writeHead(status, responseHeaders) {
        result.status = status;
        result.headers = responseHeaders;
      },
      end(body = '') {
        result.body = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
        resolve(result);
      },
    };
    serveStatic(req, res, { root, rootWithSep: `${root}${path.sep}` });
  });
}

async function testPrecompressedStaticEtagChangesWithTheServedVariant() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chatui-precompressed-etag-'));
  try {
    fs.mkdirSync(path.join(root, 'client'), { recursive: true });
    const sourcePath = path.join(root, 'client/cache.js');
    const gzipPath = `${sourcePath}.gz`;
    fs.writeFileSync(sourcePath, 'source file', 'utf8');
    const sourceTime = new Date(Date.now() - 10_000);
    fs.utimesSync(sourcePath, sourceTime, sourceTime);

    fs.writeFileSync(gzipPath, zlib.gzipSync('version-one'));
    const firstTime = new Date(Date.now() + 1_000);
    fs.utimesSync(gzipPath, firstTime, firstTime);
    const first = await requestStatic(root, { 'accept-encoding': 'gzip' });

    assert.strictEqual(first.status, 200);
    assert.strictEqual(first.headers['Content-Encoding'], 'gzip');
    assert.strictEqual(zlib.gunzipSync(first.body).toString('utf8'), 'version-one');

    fs.writeFileSync(gzipPath, zlib.gzipSync('version-two'));
    const secondTime = new Date(Date.now() + 3_000);
    fs.utimesSync(gzipPath, secondTime, secondTime);
    const second = await requestStatic(root, {
      'accept-encoding': 'gzip',
      'if-none-match': first.headers.ETag,
    });

    assert.strictEqual(second.status, 200, 'a changed precompressed variant must not reuse the old ETag as a stale 304');
    assert.notStrictEqual(second.headers.ETag, first.headers.ETag);
    assert.strictEqual(zlib.gunzipSync(second.body).toString('utf8'), 'version-two');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

module.exports = [
  testPrecompressedStaticEtagChangesWithTheServedVariant,
];
