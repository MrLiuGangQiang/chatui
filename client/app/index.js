module.exports = {
  ...require('./browser'),
  displayItems: require('./display-items'),
  persistence: require('./persistence'),
  runs: require('./runs'),
  sessions: require('./sessions'),
  sessionConfig: require('./session-config'),
  formatting: require('./formatting'),
  // Legacy markdownUtils intentionally kept for compatibility only; main rendering uses ./markdown.
  markdownUtils: require('./markdown-utils'),
  markdown: require('./markdown'),
  state: require('./state'),
};
