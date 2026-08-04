const path = require('path');
const crypto = require('crypto');

function safeJoin(root, rootWithSep, urlPath) {
  try {
    const cleanPath = decodeURIComponent(String(urlPath || '').split('?')[0]);
    const filePath = path.normalize(path.join(root, cleanPath === '/' ? 'index.html' : cleanPath));
    if (filePath !== root && !filePath.startsWith(rootWithSep)) return null;
    return filePath;
  } catch {
    return null;
  }
}

function sha1(value) {
  return crypto.createHash('sha1').update(value).digest('hex');
}

module.exports = { safeJoin, sha1 };
