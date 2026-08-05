const fs = require('fs');
const path = require('path');
const { compareVersions } = require('./release-notes.service');

const ANNOUNCEMENT_FILE_PATTERN = /^v(\d+)\.(\d+)\.(\d+)\.md$/i;
const MAX_ANNOUNCEMENT_BYTES = 256 * 1024;
const FRONT_MATTER_PATTERN = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?/;

function frontMatterValue(value = '') {
  const text = String(value || '').trim();
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    return text.slice(1, -1).trim();
  }
  return text;
}

function parseAnnouncementDocument(source = '') {
  const text = String(source || '').trim();
  const match = text.match(FRONT_MATTER_PATTERN);
  const metadata = {};
  let body = text;
  if (match) {
    for (const line of match[1].split(/\r?\n/)) {
      const field = line.match(/^([a-z][a-z0-9_-]*)\s*:\s*(.*)$/i);
      if (!field) continue;
      metadata[field[1].toLowerCase()] = frontMatterValue(field[2]);
    }
    body = text.slice(match[0].length).trim();
  }
  const firstHeading = body.match(/^#\s+(.+)$/m);
  return Object.freeze({
    title: firstHeading ? firstHeading[1].trim() : '',
    summary: String(metadata.summary || '').trim(),
    publishedAt: /^\d{4}-\d{2}-\d{2}$/.test(metadata.published_at || '') ? metadata.published_at : '',
    badge: String(metadata.badge || '系统公告').trim().slice(0, 24) || '系统公告',
    body,
  });
}

function readAnnouncements({ root, fsImpl = fs } = {}) {
  const announcementRoot = path.join(path.resolve(root || process.cwd()), 'docs', 'announcements');
  let names;
  try {
    names = fsImpl.readdirSync(announcementRoot);
  } catch {
    return Object.freeze([]);
  }

  const announcements = names
    .map(name => {
      const match = String(name).match(ANNOUNCEMENT_FILE_PATTERN);
      if (!match) return null;
      const version = `v${match[1]}.${match[2]}.${match[3]}`;
      const filePath = path.join(announcementRoot, name);
      try {
        const stat = fsImpl.statSync(filePath);
        if (!stat.isFile() || stat.size > MAX_ANNOUNCEMENT_BYTES) return null;
        const parsed = parseAnnouncementDocument(fsImpl.readFileSync(filePath, 'utf8'));
        if (!parsed.body) return null;
        return Object.freeze({
          version,
          title: parsed.title || `ChatUI 公告 ${version}`,
          summary: parsed.summary,
          publishedAt: parsed.publishedAt,
          badge: parsed.badge,
          body: parsed.body,
        });
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((left, right) => compareVersions(left.version, right.version));

  return Object.freeze(announcements);
}

module.exports = {
  ANNOUNCEMENT_FILE_PATTERN,
  MAX_ANNOUNCEMENT_BYTES,
  parseAnnouncementDocument,
  readAnnouncements,
};
