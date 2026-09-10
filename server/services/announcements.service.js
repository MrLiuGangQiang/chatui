'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const RUNTIME_ANNOUNCEMENT_FILENAME = 'announcement.md';
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

function announcementVersion(source = '') {
  const digest = crypto.createHash('sha256').update(String(source || ''), 'utf8').digest('hex');
  return `announcement-${digest.slice(0, 16)}`;
}

function readRuntimeAnnouncements({ directory, fsImpl = fs } = {}) {
  if (!directory) return Object.freeze([]);
  const filePath = path.join(path.resolve(directory), RUNTIME_ANNOUNCEMENT_FILENAME);
  try {
    const stat = fsImpl.statSync(filePath);
    if (!stat.isFile() || stat.size > MAX_ANNOUNCEMENT_BYTES) return Object.freeze([]);
    const source = fsImpl.readFileSync(filePath, 'utf8');
    const parsed = parseAnnouncementDocument(source);
    if (!parsed.title || !parsed.body) return Object.freeze([]);
    return Object.freeze([
      Object.freeze({
        version: announcementVersion(source),
        title: parsed.title,
        summary: parsed.summary,
        publishedAt: parsed.publishedAt,
        badge: parsed.badge,
        body: parsed.body,
      }),
    ]);
  } catch {
    return Object.freeze([]);
  }
}

function readAnnouncements({ runtimeDir, fsImpl = fs } = {}) {
  return readRuntimeAnnouncements({ directory: runtimeDir, fsImpl });
}

module.exports = {
  RUNTIME_ANNOUNCEMENT_FILENAME,
  MAX_ANNOUNCEMENT_BYTES,
  parseAnnouncementDocument,
  announcementVersion,
  readRuntimeAnnouncements,
  readAnnouncements,
};
