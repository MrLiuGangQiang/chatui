const assert = require('assert');
const fs = require('fs');
const path = require('path');
const app = fs.readFileSync(path.join(__dirname, '../../app.js'), 'utf8');
function bodyOf(name, asyncFn = false) {
  const marker = `${asyncFn ? 'async ' : ''}function ${name}(`;
  const start = app.indexOf(marker);
  assert.ok(start >= 0, `${name} exists`);
  const ps = app.indexOf('(', start);
  let pd = 0, brace = -1;
  for (let i = ps; i < app.length; i += 1) {
    if (app[i] === '(') pd += 1;
    else if (app[i] === ')') { pd -= 1; if (pd === 0) { brace = app.indexOf('{', i); break; } }
  }
  let depth = 0;
  for (let i = brace; i < app.length; i += 1) {
    if (app[i] === '{') depth += 1;
    if (app[i] === '}') { depth -= 1; if (depth === 0) return app.slice(brace + 1, i); }
  }
  throw new Error(`cannot read ${name}`);
}
assert.ok(bodyOf('buildRouteContext').includes('getRouteDecisionWorkflow().buildRouteContext'), 'buildRouteContext delegates to route decision workflow');
assert.ok(bodyOf('getEffectiveRoute', true).includes('getRouteDecisionWorkflow().getEffectiveRoute'), 'getEffectiveRoute delegates to route decision workflow');
assert.ok(!bodyOf('buildRouteContext').includes('collectRecentImageReferences'), 'root buildRouteContext implementation removed');
assert.ok(!bodyOf('getEffectiveRoute', true).includes('requestJson'), 'root getEffectiveRoute implementation removed');
assert.ok(app.includes('ChatUIAppRouteDecisionWorkflow'), 'app requires route decision workflow');
console.log('app route decision workflow adapter ok');
