(function initChatUIConfigStorageKeys(root) {
  'use strict';

  const storageKeys = Object.freeze({
    CONFIG_KEY: 'openapi-chat-image-config-v2',
    CHAT_KEY: 'openapi-chat-image-chat-v1',
    UI_KEY: 'openapi-chat-image-ui-v1',
    SESSIONS_KEY: 'openapi-chat-image-sessions-v1',
    ACTIVE_SESSION_KEY: 'openapi-chat-image-active-session-v1',
    LAST_IMAGE_KEY: 'openapi-chat-image-last-image-v1',
    REASONING_PERSIST_KEY: 'openapi-chat-reasoning-persist-v1',
    REASONING_MODE_KEY: 'openapi-chat-reasoning-mode-v1',
    REASONING_TYPE_KEY: 'openapi-chat-reasoning-type-v1',
    SESSION_SIDEBAR_COLLAPSED_KEY: 'openapi-chat-image-session-sidebar-collapsed-v1',
    IMAGE_JOB_KEY: 'openapi-chat-image-job-v1',
    CHAT_JOB_KEY: 'openapi-chat-image-chat-job-v1',
    IMAGE_BATCH_JOB_KEY: 'openapi-chat-image-batch-v1',
    IMAGE_DB: 'openapi-chat-image-db-v1',
    IMAGE_STORE: 'images',
  });

  const api = Object.freeze({ storageKeys });

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.ChatUIConfig = Object.freeze({ ...(root.ChatUIConfig || {}), storageKeys });
  if (root?.window) root.window.ChatUIConfig = root.ChatUIConfig;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
