const assert = require('assert');
const fs = require('fs');
const workflow = require('../../client/app/message-workflow');

(function run() {
  const message = workflow.createMessageWorkflow({ state: {} });
  assert.strictEqual(typeof message.updateMessage, 'function');
  assert.strictEqual(typeof message.updateMessageContentLight, 'function');
  assert.strictEqual(typeof message.addMessage, 'function');
  const source = fs.readFileSync('client/app/message-workflow.js', 'utf8');
  assert.ok(source.includes('tpl.innerHTML = render(text);'), 'large final markdown should parse once as a full document');
  assert.ok(!source.includes('render(chunks[index++])'), 'large final markdown must not parse split chunks independently');
  assert.ok(source.includes('preserveMessageBottomAnchor?.(messageNode, 72)'), 'progressive DOM mounting should preserve the stream-end viewport anchor');
  assert.ok(source.includes('restoreProgressiveAnchor?.();'), 'progressive DOM mounting should restore the captured anchor while mounting');
  assert.ok(!source.includes('scrollToActiveOutput?.(messageNode, { force: true, active: true, settle: false, margin: 72 })'), 'final remount must not force a new follow-scroll target');
  assert.ok(!source.includes('skipMermaid:!phase.final'), 'streaming chunks must not run full markdown enhancement or auto mermaid resource loading');
  assert.ok(source.includes('if(phase.final)enhanceRenderedMarkdown(root,{skipMermaid:!0'), 'only final streaming phase may run basic markdown enhancement, with mermaid auto-render disabled');
  assert.ok(source.includes('s.deferEnhance?(n.dataset.renderedHash=n.dataset.rawHash'), 'session restore can defer expensive per-message enhancement');
  assert.ok(source.includes('enhanceRenderedMarkdown(n,{skipMermaid:!0,allowResourceLoad:!0})'), 'normal final/history message enhancement may load markdown resources but must keep mermaid auto-render disabled');
  console.log('app message workflow ok');
})();
