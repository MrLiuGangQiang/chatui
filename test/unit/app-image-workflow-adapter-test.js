const assert = require('assert');
const fs = require('fs');
const path = require('path');
const app = fs.readFileSync(path.join(__dirname, '../../app.js'), 'utf8');
function asyncBodyOf(name) {
  const marker = `async function ${name}(`;
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
const body = asyncBodyOf('sendImage');
assert.ok(body.includes('getImageWorkflow().sendImage'), 'sendImage delegates to image workflow');
assert.ok(!body.includes('startImageGenerationJob'), 'root sendImage job start implementation removed');
assert.ok(!body.includes('imageResultToHtml'), 'root sendImage result implementation removed');
assert.ok(app.includes('ChatUIAppImageWorkflow'), 'app requires image workflow');
console.log('app image workflow adapter ok');
