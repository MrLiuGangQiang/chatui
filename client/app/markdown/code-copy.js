'use strict';

// Compatibility entrypoint: code-copy implementation lives in enhancer.js so Markdown
// enhancement behavior stays single-sourced.
const { COPY_ICON_SVG, enhanceCodeCopy } = require('./enhancer');

module.exports = { enhanceCodeCopy, COPY_ICON_SVG };
