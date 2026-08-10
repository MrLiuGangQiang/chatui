(function initChatUITaskConstants(root) {
  'use strict';

  // Centralized policy constants (design doc v2.7 section 12.1). These are
  // configuration knobs, not protocol fields: client and server read the same
  // values so convergence limits and budgets never drift apart.
  const api = Object.freeze({
    TASK_CONSTANTS_VERSION: 'task_constants.v1',
    // 澄清轮数上限（单一计数器）与任务级模型调用上限
    MAX_CLARIFICATION_ROUNDS: 3,
    MAX_MODEL_CALLS: 6,
    // Snapshot 上下文窗口与 changes log 保留轮数
    RECENT_MESSAGES_WINDOW: 20,
    CHANGES_LOG_RETENTION: 20,
    // 澄清过期时间（天）
    CLARIFICATION_TTL_DAYS: 7,
    // 输入与文件预算（与 preflight-guards.js / file-inputs.js 对齐）
    MAX_USER_MESSAGE_CHARS: 120000,
    MAX_FILE_BYTES: 10 * 1024 * 1024,
    MAX_REQUEST_BYTES: 10 * 1024 * 1024,
  });

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  const registry = root?.[Symbol.for('chatui.module-registry.v1')]?.get('moduleRegistry');
  if (registry?.register) registry.register('taskConstants', api);
  if (root) root.ChatUITaskConstants = api;
  if (root?.window) root.window.ChatUITaskConstants = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
