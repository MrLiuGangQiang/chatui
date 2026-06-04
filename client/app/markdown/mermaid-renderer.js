'use strict';

// Compatibility entrypoint: Mermaid block discovery/rendering is implemented in
// enhancer.js and used by both browser and Node tests.
const { normalizeArchitectureMermaidSource, collectMermaidBlocks, initMermaidToggleUI, renderMermaidBlockOnDemand, showMermaidSource, renderMermaidBlocks } = require('./enhancer');

module.exports = { normalizeArchitectureMermaidSource, collectMermaidBlocks, initMermaidToggleUI, renderMermaidBlockOnDemand, showMermaidSource, renderMermaidBlocks };
