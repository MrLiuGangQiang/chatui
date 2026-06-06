#!/usr/bin/env node
const assert = require('assert');
const fs = require('fs');

const display = fs.readFileSync('client/app/display-history-workflow.js', 'utf8');
const app = fs.readFileSync('app.js', 'utf8');
const browser = fs.readFileSync('client/app/markdown/browser.js', 'utf8');
const loader = fs.readFileSync('client/app/markdown/dependency-loader.js', 'utf8');
const styles = fs.readFileSync('styles.css', 'utf8');

assert.ok(display.includes('deferEnhance:!0'), 'session/history restore must defer expensive per-message enhancement');
assert.ok(app.includes('function rerenderVisibleMarkdownMessages()'), 'app should define markdown ready follow-up');
const rerenderStart = app.indexOf('function rerenderVisibleMarkdownMessages()');
const rerenderEnd = app.indexOf('function waitForMarkdownReady', rerenderStart);
const rerenderBody = app.slice(rerenderStart, rerenderEnd);
assert.ok(rerenderBody.includes('enhanceRenderedMarkdown(e,{skipMermaid:!0,allowResourceLoad:!0})'), 'markdown ready follow-up should enhance in-place with mermaid auto-render disabled');
assert.ok(!rerenderBody.includes('t.innerHTML=renderMarkdown(s)'), 'markdown ready follow-up must not rewrite message HTML and cause flicker/resource reload');
assert.ok(rerenderBody.includes('delete e.dataset.deferEnhance'), 'deferred enhancement marker should be cleared after in-place enhancement');
assert.ok(browser.includes('loadCore?.()'), 'markdown ready must load only core dependencies by default');
assert.ok(!browser.includes('dependencyLoader?.loadAll?.() || Promise.resolve()'), 'markdown ready must not auto-load every optional dependency');
assert.ok(loader.includes("const loadAll = loadCore"), 'loadAll should remain core-only; Mermaid is manual-only');
assert.ok(loader.includes('const loadMermaid = () => loadScript'), 'manual Mermaid loading should have a dedicated entry');
assert.ok(!styles.includes('var(--session-tail-scroll-space,260px),260px'), 'tail space must not have an unbounded 260px feedback fallback');
assert.ok(display.includes('m=t=>!!String(t.rawText||"").trim()&&!isChatStatusText(t.rawText||"")'), 'pending live text from hidden streaming sessions must be restored immediately on session switch');
assert.ok(display.includes('||m(t)),n=t.filter'), 'pending live text should not wait for resume job bookkeeping before entering the DOM');
assert.ok(app.includes('deferEnhance:"1"===e.pending'), 'pending live nodes should avoid full enhancement/resource hydration when restored during session switch');

console.log('session switch resource storm contract ok');
