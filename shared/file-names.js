(function initChatUIFileNames(root) {
  'use strict';

  const SHANGHAI_TIME_ZONE = 'Asia/Shanghai';

  function pad2(value) {
    return String(value).padStart(2, '0');
  }

  function timestampPrefix(date = new Date()) {
    const d = date instanceof Date ? date : new Date(date);
    try {
      const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: SHANGHAI_TIME_ZONE,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).formatToParts(d).reduce((acc, part) => {
        if (part.type !== 'literal') acc[part.type] = part.value;
        return acc;
      }, {});
      return `${parts.year}${parts.month}${parts.day}${parts.hour}${parts.minute}`;
    } catch {
      const shifted = new Date(d.getTime() + 8 * 60 * 60 * 1000);
      return `${shifted.getUTCFullYear()}${pad2(shifted.getUTCMonth() + 1)}${pad2(shifted.getUTCDate())}${pad2(shifted.getUTCHours())}${pad2(shifted.getUTCMinutes())}`;
    }
  }

  function safeFilenamePart(value = '', fallback = 'file', maxLength = 48) {
    const cleaned = String(value || '')
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, maxLength)
      .replace(/[. ]+$/g, '');
    return cleaned || fallback;
  }

  function normalizeExt(ext = '') {
    return String(ext || '').replace(/^\.+/, '').replace(/[^a-z0-9]+/gi, '').toLowerCase();
  }

  function splitFilename(filename = '', fallbackExt = '') {
    const clean = safeFilenamePart(filename, '', 120);
    const match = clean.match(/^(.*?)(?:\.([A-Za-z0-9]{1,12}))?$/);
    const stem = safeFilenamePart(match?.[1] || clean, 'file');
    const ext = normalizeExt(match?.[2] || fallbackExt);
    return { stem, ext };
  }

  function hasTimestampPrefix(filename = '') {
    return /^\d{12}(?:[-_.]|$)/.test(String(filename || ''));
  }

  function timestampedFilename({ stem = 'file', ext = '', date = new Date() } = {}) {
    const normalizedExt = normalizeExt(ext);
    return `${timestampPrefix(date)}${normalizedExt ? `.${normalizedExt}` : ''}`;
  }

  function timestampExistingFilename(filename = '', { fallbackStem = 'file', fallbackExt = '', date = new Date(), keepExistingTimestamp = true } = {}) {
    const raw = String(filename || '').trim();
    const ext = splitFilename(raw, fallbackExt).ext || normalizeExt(fallbackExt);
    return timestampedFilename({ ext, date });
  }

  const api = Object.freeze({
    SHANGHAI_TIME_ZONE,
    timestampPrefix,
    safeFilenamePart,
    normalizeExt,
    splitFilename,
    hasTimestampPrefix,
    timestampedFilename,
    timestampExistingFilename,
  });

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.ChatUIFileNames = api;
  if (root?.window) root.window.ChatUIFileNames = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
