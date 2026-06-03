'use strict';

// Compatibility entrypoint: Mermaid block discovery/rendering is implemented in
// enhancer.js and used by both browser and Node tests.
const { collectMermaidBlocks, renderMermaidBlocks } = require('./enhancer');

module.exports = { collectMermaidBlocks, renderMermaidBlocks };
