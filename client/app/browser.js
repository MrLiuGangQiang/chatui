(function () {
  const appState = window.ChatUIAppState || window.ChatUIApp?.state || {};


  const sessionConfig = window.ChatUIAppSessionConfig || window.ChatUIApp?.sessionConfig || {};

  const formatting = window.ChatUIAppFormatting || window.ChatUIApp?.formatting || {};



  const markdownUtils = window.ChatUIAppMarkdownUtils || window.ChatUIApp?.markdownUtils || {};

  const runs = window.ChatUIAppRuns || window.ChatUIApp?.runs || {};



  const sessions = window.ChatUIAppSessions || window.ChatUIApp?.sessions || {};


  const persistence = window.ChatUIAppPersistence || window.ChatUIApp?.persistence || {};
  const stripLargeDataUrlsFromText = persistence.stripLargeDataUrlsFromText || (text => String(text || ''));
  const sanitizeAttachmentContextForStorage = persistence.sanitizeAttachmentContextForStorage || (() => '');
  const sanitizeStoredDisplayItem = persistence.sanitizeStoredDisplayItem || (item => item || {});
  const sanitizeStoredMessage = persistence.sanitizeStoredMessage || (message => message || {});
  const stripLargePayloadData = persistence.stripLargePayloadData || (value => value);
  const compactJobForStorage = persistence.compactJobForStorage || (job => job);
  function safeSetJsonStorage(key, value, maxItems = 80, storage = localStorage) {
    return persistence.safeSetJsonStorage ? persistence.safeSetJsonStorage(storage, key, value, maxItems) : null;
  }
  function safeSetJobStorage(key, job, storage = localStorage) {
    return persistence.safeSetJobStorage ? persistence.safeSetJobStorage(storage, key, job) : undefined;
  }

  const displayItems = window.ChatUIAppDisplayItems || window.ChatUIApp?.displayItems || {};

  window.ChatUIApp = Object.freeze({
    ...(window.ChatUIApp || {}),
    state: Object.freeze(appState),
    sessionConfig: Object.freeze(sessionConfig),

    formatting: Object.freeze(formatting),
    markdownUtils: Object.freeze(markdownUtils),
    runs: Object.freeze(runs),
    sessions: Object.freeze(sessions),
    persistence: Object.freeze({ ...persistence, stripLargeDataUrlsFromText, sanitizeAttachmentContextForStorage, sanitizeStoredDisplayItem, sanitizeStoredMessage, safeSetJsonStorage, stripLargePayloadData, compactJobForStorage, safeSetJobStorage }),
    displayItems: Object.freeze(displayItems),
  });
})();
