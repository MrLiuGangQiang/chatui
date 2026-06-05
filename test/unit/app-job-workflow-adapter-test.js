const assert = require('assert');
const fs = require('fs');
const path = require('path');

const app = fs.readFileSync(path.join(__dirname, '../../app.js'), 'utf8');

function bodyOf(name) {
  const start = app.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} exists`);
  const paramsStart = app.indexOf('(', start);
  let parenDepth = 0;
  let brace = -1;
  for (let i = paramsStart; i < app.length; i += 1) {
    if (app[i] === '(') parenDepth += 1;
    else if (app[i] === ')') {
      parenDepth -= 1;
      if (parenDepth === 0) {
        brace = app.indexOf('{', i);
        break;
      }
    }
  }
  assert.ok(brace > start, `${name} opening brace found`);
  let depth = 0;
  for (let i = brace; i < app.length; i += 1) {
    if (app[i] === '{') depth += 1;
    if (app[i] === '}') {
      depth -= 1;
      if (depth === 0) return app.slice(brace + 1, i);
    }
  }
  throw new Error(`cannot read ${name}`);
}

for (const name of ['saveImageJob', 'loadImageJob', 'clearImageJob', 'saveChatJob', 'loadChatJob', 'loadDisplayChatJob', 'loadLatestChatJob', 'clearChatJob', 'waitJobEvent']) {
  const body = bodyOf(name);
  assert.ok(body.includes('getJobWorkflow()'), `${name} delegates to job workflow`);
}

const waitBody = bodyOf('waitJobEvent');
assert.ok(!waitBody.includes('new Promise'), 'waitJobEvent root implementation removed');
assert.ok(!waitBody.includes('new EventSource'), 'waitJobEvent root EventSource implementation removed');

console.log('app job workflow adapter ok');
