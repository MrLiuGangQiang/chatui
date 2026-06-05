const assert = require('assert');
const fs = require('fs');
const path = require('path');
const app = fs.readFileSync(path.join(__dirname, '../../app.js'), 'utf8');
function bodyOf(name) {
  const marker = `function ${name}(`;
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
for (const name of ['updateMessage', 'updateMessageContentLight', 'addMessage']) {
  const body = bodyOf(name);
  assert.ok(body.includes('getMessageWorkflow().'), `${name} delegates to message workflow`);
}
assert.ok(!bodyOf('updateMessage').includes('querySelector(".content")'), 'root updateMessage DOM implementation removed');
assert.ok(!bodyOf('addMessage').includes('messageTemplate'), 'root addMessage template implementation removed');
assert.ok(app.includes('ChatUIAppMessageWorkflow'), 'app requires message workflow');
console.log('app message workflow adapter ok');
