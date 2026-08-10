(function initChatUIChangesLog(root) {
  'use strict';

  // Design doc v2.7 section 9: Visual Task changes log. The visual task keeps
  // an append-only semantic history in addition to the current semantic_state
  // snapshot. Each record is { schema_version, state_version, timestamp,
  // changes[], preserve, source: "intent" | "clarification" }. Corrections
  // like "刚才说的颜色不对" locate the previous round's modification through
  // this log instead of guessing from the merged snapshot. Older entries are
  // folded into a summary that only keeps the final merged result, bounded by
  // changes_log_retention (default 20). The log must never persist prompts,
  // API keys, credentials, canonical resource IDs or the final payload.

  const taskConstants = root?.[Symbol.for('chatui.module-registry.v1')]?.get('taskConstants')
    || root?.ChatUITaskConstants
    || (typeof require === 'function' ? require('./task-constants') : {});

  const CHANGES_LOG_VERSION = 'changes_log.v1';
  const DEFAULT_RETENTION = Number(taskConstants?.CHANGES_LOG_RETENTION) > 0
    ? Number(taskConstants.CHANGES_LOG_RETENTION)
    : 20;
  const SOURCES = new Set(['intent', 'clarification']);

  // Path-level forbidden prefixes mirror capability-registry's changes family
  // guard (prompt/request/operation/api/provider/credentials/resource/binding/
  // lifecycle are never valid semantic state paths).
  const FORBIDDEN_PATH_SEGMENTS = new Set([
    'prompt', 'request', 'operation', 'api', 'provider',
    'credentials', 'resource', 'resources', 'binding', 'bindings', 'lifecycle',
    '__proto__', 'prototype', 'constructor',
  ]);
  // Value-level forbidden content: credentials, secrets, canonical resource
  // identities and final payload material never enter the log, even nested.
  const FORBIDDEN_VALUE_PATTERN = /(?:api[_-]?key|secret|token|credential|authorization|password|resource[_-]?id|reference[_-]?id|payload)/i;

  function stringValue(value) {
    return value === undefined || value === null ? '' : String(value);
  }

  function sanitizeValue(value) {
    if (value === undefined || value === null) return value;
    if (typeof value === 'string') {
      return FORBIDDEN_VALUE_PATTERN.test(value) ? undefined : value;
    }
    if (Array.isArray(value)) {
      const cleaned = [];
      for (const item of value) {
        const result = sanitizeValue(item);
        if (result !== undefined) cleaned.push(result);
      }
      return cleaned;
    }
    if (typeof value === 'object') {
      const cleaned = {};
      for (const [key, item] of Object.entries(value)) {
        if (FORBIDDEN_PATH_SEGMENTS.has(key) || FORBIDDEN_VALUE_PATTERN.test(key)) continue;
        const result = sanitizeValue(item);
        if (result !== undefined) cleaned[key] = result;
      }
      return cleaned;
    }
    return value;
  }

  // Keep only family-safe { path, op, value } changes; drop any entry whose
  // path or value carries forbidden content (fail closed, never keep a
  // partially sanitized sensitive record).
  function sanitizeChanges(changes = []) {
    const items = Array.isArray(changes) ? changes : [];
    const result = [];
    for (const change of items) {
      if (!change || typeof change !== 'object') continue;
      const path = stringValue(change.path);
      const segments = path.split('.').map(segment => segment.trim()).filter(Boolean);
      if (!segments.length) continue;
      if (FORBIDDEN_PATH_SEGMENTS.has(segments[0])) continue;
      if (FORBIDDEN_PATH_SEGMENTS.has(path) || FORBIDDEN_VALUE_PATTERN.test(path)) continue;
      const value = sanitizeValue(change.value);
      if (value === undefined) continue;
      result.push({
        path,
        op: stringValue(change.op) || 'set',
        value,
      });
    }
    return result;
  }

  function sanitizePreserve(preserve = []) {
    const items = Array.isArray(preserve) ? preserve : [];
    const result = [];
    for (const item of items) {
      const cleaned = sanitizeValue(item);
      if (cleaned !== undefined && cleaned !== '') result.push(cleaned);
    }
    return result;
  }

  // Normalize one entry. Returns null when the entry carries no usable
  // changes (an empty batch is not an event worth recording).
  function sanitizeChangesEntry(entry = {}) {
    if (!entry || typeof entry !== 'object') return null;
    const changes = sanitizeChanges(entry.changes);
    if (!changes.length) return null;
    const source = SOURCES.has(entry.source) ? entry.source : 'intent';
    return Object.freeze({
      schema_version: CHANGES_LOG_VERSION,
      state_version: Number(entry.state_version) > 0 ? Number(entry.state_version) : 1,
      timestamp: Number(entry.timestamp) > 0 ? Number(entry.timestamp) : Date.now(),
      changes,
      preserve: sanitizePreserve(entry.preserve),
      source,
    });
  }

  // Fold entries older than the retention window into one summary that only
  // keeps the final merged result (last write wins per path).
  function foldEarlierEntries(entries = []) {
    if (!Array.isArray(entries) || !entries.length) return [];
    const merged = new Map();
    let preserve = [];
    let last = entries[entries.length - 1];
    for (const entry of entries) {
      for (const change of entry.changes || []) merged.set(change.path, change);
      if (Array.isArray(entry.preserve) && entry.preserve.length) preserve = entry.preserve;
      last = entry;
    }
    return [Object.freeze({
      schema_version: CHANGES_LOG_VERSION,
      state_version: Number(last?.state_version) > 0 ? Number(last.state_version) : 1,
      timestamp: Number(last?.timestamp) > 0 ? Number(last.timestamp) : Date.now(),
      changes: Array.from(merged.values()),
      preserve,
      source: 'intent',
      folded: true,
    })];
  }

  // Append one sanitized entry; older entries beyond the retention window are
  // folded into a summary. The log stays append-only: existing records are
  // never mutated in place.
  function appendChangesEntry(log = [], entry = {}, options = {}) {
    const list = Array.isArray(log) ? log : [];
    const sanitized = sanitizeChangesEntry(entry);
    if (!sanitized) return list;
    const retention = Number(options.retention) > 0 ? Number(options.retention) : DEFAULT_RETENTION;
    const next = [...list, sanitized];
    if (next.length <= retention) return next;
    const foldCount = next.length - retention;
    return [...foldEarlierEntries(next.slice(0, foldCount)), ...next.slice(foldCount)];
  }

  function createChangesLog(initial = []) {
    const list = Array.isArray(initial) ? initial : [];
    const log = [];
    for (const entry of list) {
      const sanitized = sanitizeChangesEntry(entry);
      if (sanitized) log.push(sanitized);
    }
    return log;
  }

  // Locate the previous round's modification for correction-style follow-ups
  // ("刚才说的颜色不对"): the most recent record is the last applied change
  // batch. Returns null for an empty log.
  function latestChangesFor(log = []) {
    const list = Array.isArray(log) ? log : [];
    return list.length ? list[list.length - 1] : null;
  }

  const api = Object.freeze({
    CHANGES_LOG_VERSION,
    DEFAULT_RETENTION,
    createChangesLog,
    appendChangesEntry,
    latestChangesFor,
    sanitizeChangesEntry,
    foldEarlierEntries,
  });

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  const registry = root?.[Symbol.for('chatui.module-registry.v1')]?.get('moduleRegistry');
  if (registry?.register) registry.register('changesLog', api);
  if (root) root.ChatUIChangesLog = api;
  if (root?.window) root.window.ChatUIChangesLog = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
