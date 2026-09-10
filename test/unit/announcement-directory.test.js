'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  MAX_ANNOUNCEMENT_BYTES,
  RUNTIME_ANNOUNCEMENT_FILENAME,
  readAnnouncements,
} = require('../../server/services/announcements.service');

function writeFile(root, relativePath, contents) {
  const filePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents, 'utf8');
  return filePath;
}

function announcementDocument(title, summary = '') {
  return `---\npublished_at: 2026-09-10\nbadge: 运营公告\nsummary: ${summary}\n---\n# ${title}\n\n${title}正文`;
}

function testRuntimeAnnouncementUsesOnlyTheFixedFilename() {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatui-announcement-fixed-'));
  try {
    writeFile(runtimeDir, '_template.md', announcementDocument('模板'));
    writeFile(runtimeDir, '2026-09-10-01.md', announcementDocument('其他文件'));
    writeFile(runtimeDir, RUNTIME_ANNOUNCEMENT_FILENAME, announcementDocument('正式公告', '正式摘要'));

    const announcements = readAnnouncements({ runtimeDir });
    assert.strictEqual(announcements.length, 1);
    assert.match(announcements[0].version, /^announcement-[a-f0-9]{16}$/);
    assert.strictEqual(announcements[0].title, '正式公告');
    assert.strictEqual(announcements[0].summary, '正式摘要');
    assert.strictEqual(announcements[0].badge, '运营公告');
    assert.strictEqual(announcements[0].publishedAt, '2026-09-10');
    assert.match(announcements[0].body, /正式公告正文/);
  } finally {
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  }
}

function testChangingFixedAnnouncementContentChangesItsReadIdentity() {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatui-announcement-revision-'));
  try {
    const filePath = writeFile(runtimeDir, RUNTIME_ANNOUNCEMENT_FILENAME, announcementDocument('第一版'));
    const first = readAnnouncements({ runtimeDir })[0];
    fs.writeFileSync(filePath, announcementDocument('第二版'), 'utf8');
    const second = readAnnouncements({ runtimeDir })[0];
    assert.ok(first && second);
    assert.notStrictEqual(first.version, second.version);
    assert.strictEqual(second.title, '第二版');
  } finally {
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  }
}

function testInvalidOrOversizedFixedAnnouncementReturnsNoAnnouncement() {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatui-announcement-invalid-'));
  try {
    const filePath = path.join(runtimeDir, RUNTIME_ANNOUNCEMENT_FILENAME);
    fs.writeFileSync(filePath, '# \n\n', 'utf8');
    assert.deepStrictEqual(readAnnouncements({ runtimeDir }), []);

    fs.writeFileSync(filePath, `# 超大公告\n\n${'x'.repeat(MAX_ANNOUNCEMENT_BYTES)}`, 'utf8');
    assert.deepStrictEqual(readAnnouncements({ runtimeDir }), []);
  } finally {
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  }
}

function testMissingFixedAnnouncementReturnsNoAnnouncements() {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatui-announcement-missing-'));
  try {
    writeFile(runtimeDir, '_template.md', announcementDocument('模板'));
    assert.deepStrictEqual(readAnnouncements({ runtimeDir }), []);
    assert.deepStrictEqual(readAnnouncements({ runtimeDir: path.join(runtimeDir, 'missing-dir') }), []);
    assert.deepStrictEqual(readAnnouncements({}), []);
  } finally {
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  }
}

module.exports = [
  testRuntimeAnnouncementUsesOnlyTheFixedFilename,
  testChangingFixedAnnouncementContentChangesItsReadIdentity,
  testInvalidOrOversizedFixedAnnouncementReturnsNoAnnouncement,
  testMissingFixedAnnouncementReturnsNoAnnouncements,
];
