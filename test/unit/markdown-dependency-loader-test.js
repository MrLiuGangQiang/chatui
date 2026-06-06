const assert = require('assert');

const loader = require('../../client/app/markdown/dependency-loader.js');

const expectedScriptIds = [
  'markdown-it',
  'markdown-it-texmath',
  'markdown-it-multimd-table',
  'markdown-it-task-lists',
  'markdown-it-emoji',
  'markdown-it-footnote',
  'markdown-it-deflist',
  'markdown-it-abbr',
  'markdown-it-mark',
  'markdown-it-sub',
  'markdown-it-sup',
  'highlight-js',
  'katex',
  'mermaid',
  'dompurify',
];

assert.strictEqual(loader.VERSION, '2.0.3');
assert.strictEqual(loader.LOCAL_FIRST, true);
assert.ok(Array.isArray(loader.resources.styles));
assert.ok(Array.isArray(loader.resources.scripts));

for (const id of expectedScriptIds) {
  const resource = loader.resources.scripts.find((item) => item.id === id);
  assert.ok(resource, `missing script resource: ${id}`);
  assert.ok(/^https:\/\//.test(resource.cdn), `${id} must have CDN url`);
  assert.ok(resource.local.startsWith('./node_modules/') || resource.local.startsWith('./vendor/'), `${id} must have local fallback`);
  assert.ok(resource.global, `${id} must have readiness global`);
}

for (const resource of loader.resources.styles) {
  assert.ok(/^https:\/\//.test(resource.cdn), `${resource.id} must have CDN url`);
  assert.ok(resource.local.startsWith('./node_modules/') || resource.local.startsWith('./vendor/'), `${resource.id} must have local fallback`);
}

const readiness = loader.getReadiness();
assert.strictEqual(readiness.version, '2.0.3');
assert.strictEqual(readiness.ready, false);
assert.deepStrictEqual(Object.keys(readiness.scripts).sort(), expectedScriptIds.sort());
