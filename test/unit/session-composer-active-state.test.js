'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const calmThemeCss = fs.readFileSync(
  path.join(__dirname, '..', '..', 'styles', 'calm-theme.css'),
  'utf8',
).replace(/\r\n?/g, '\n');
const appJs = fs.readFileSync(path.join(__dirname, '..', '..', 'app.js'), 'utf8');
const sessionConfig = require('../../client/app/session-config');

function ruleBody(css, selector) {
  const start = css.indexOf(selector);
  assert.ok(start >= 0, `missing CSS rule: ${selector}`);
  const bodyStart = css.indexOf('{', start);
  const bodyEnd = css.indexOf('}', bodyStart);
  assert.ok(bodyStart >= 0 && bodyEnd > bodyStart, `invalid CSS rule: ${selector}`);
  return css.slice(bodyStart + 1, bodyEnd);
}

function classSpecificity(selector) {
  return (selector.match(/\.[A-Za-z0-9_-]+/g) || []).length;
}

function testSessionPromptAndModelButtonsKeepVisibleActiveStatesInCalmTheme() {
  // The final visual layer rewrites every composer action button to the
  // neutral surface. Those generic selectors have two classes and therefore
  // beat the base `.session-*-btn.has-session-*` rules that only carry two
  // classes as well. The calm layer must define matching active overrides
  // with higher specificity so configured prompt/model buttons still change
  // color instead of remaining indistinguishable from unconfigured buttons.
  const genericPrompt = '.composer-actions .session-prompt-btn';
  const genericModel = '.composer-actions .session-model-btn';
  const activePrompt = '.composer-actions .session-prompt-btn.has-session-prompt';
  const activeModel = '.composer-actions .session-model-btn.has-session-model';

  for (const [selector, generic] of [[activePrompt, genericPrompt], [activeModel, genericModel]]) {
    assert.ok(
      classSpecificity(selector) > classSpecificity(generic),
      `${selector} must be more specific than ${generic}`,
    );

    const body = ruleBody(calmThemeCss, selector);
    assert.match(body, /border-color\s*:\s*var\(--chatui-accent-border\)\s*!important/,
      `${selector} must visibly change the border`);
    assert.match(body, /background\s*:\s*var\(--chatui-accent-soft\)\s*!important/,
      `${selector} must visibly change the background`);
    assert.match(body, /color\s*:\s*var\(--chatui-accent\)\s*!important/,
      `${selector} must visibly change the icon color`);
  }
}

function testSessionPromptButtonsReturnToNeutralWhenCleared() {
  assert.strictEqual(
    sessionConfig.hasSessionPromptContent({ hasSystemPromptOverride: true, systemPrompt: ' 自定义提示词 ' }),
    true,
    'non-empty session prompt must stay visually active',
  );
  assert.strictEqual(
    sessionConfig.hasSessionPromptContent({ hasSystemPromptOverride: true, systemPrompt: '   ' }),
    false,
    'cleared session prompt must return the button to neutral',
  );
  assert.strictEqual(
    sessionConfig.hasSessionPromptContent({ hasSystemPromptOverride: false, systemPrompt: 'x' }),
    false,
    'following the global prompt must not look like a session override',
  );
  assert.strictEqual(
    sessionConfig.hasSessionImageStyleContent({ hasImageStylePromptOverride: true, imageStylePrompt: ' 素描 ' }),
    true,
    'non-empty image style prompt must stay visually active',
  );
  assert.strictEqual(
    sessionConfig.hasSessionImageStyleContent({ hasImageStylePromptOverride: true, imageStylePrompt: '' }),
    false,
    'cleared image style prompt must return the button to neutral',
  );

  const promptRender = appJs.slice(appJs.indexOf('function renderSessionPromptArea'), appJs.indexOf('function renderSessionImageStyleArea'));
  const imageRender = appJs.slice(appJs.indexOf('function renderSessionImageStyleArea'), appJs.indexOf('function setSessionChatModel'));
  assert.match(promptRender, /hasSessionPromptContent\(/,
    'prompt button render must use the content-based active helper');
  assert.match(imageRender, /hasSessionImageStyleContent\(/,
    'image style button render must use the content-based active helper');
}

module.exports = [
  testSessionPromptAndModelButtonsKeepVisibleActiveStatesInCalmTheme,
  testSessionPromptButtonsReturnToNeutralWhenCleared,
];
