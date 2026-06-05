const assert = require('assert');
const fs = require('fs');
const path = require('path');
const app = fs.readFileSync(path.join(__dirname, '../../app.js'), 'utf8');
function bodyOf(name) {
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
const body = bodyOf('imageResultToHtml');
assert.ok(body.includes('getImageResultWorkflow().imageResultToHtml'), 'imageResultToHtml delegates to workflow');
assert.ok(!body.includes('for(let e=0'), 'root image result loop removed');
assert.ok(!body.includes('persistImageSrc(t.src'), 'root image persistence implementation removed');
console.log('app image result workflow adapter ok');
