'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
function testMessageActionColorsCoverBothRolesAndImageActions() {
  const css = fs.readFileSync(path.join(__dirname, '../../styles/flat-theme.css'), 'utf8');
  const colorStart = css.indexOf('/* Message action colors');
  const lifecycleStart = css.indexOf('/* Canonical message action lifecycle', colorStart);
  const rules = css.slice(colorStart, lifecycleStart >= 0 ? lifecycleStart : undefined);
  const dom = new JSDOM(`<style>${rules}</style><div class="message user"><div class="msg-actions"></div></div><div class="message assistant"><div class="msg-actions"></div></div>`);
  for (const actions of dom.window.document.querySelectorAll('.msg-actions')) {
    for (const [className, attr, color] of [
      ['copy-btn', '', '#9333ea'], ['download-answer-btn', '', '#2563eb'],
      ['edit-btn', '', '#d97706'], ['refresh-btn', '', '#059669'],
      ['quote-btn', '', '#0891b2'], ['force-image-btn', '', '#db2777'],
      ['mobile-more-btn', '', '#64748b'], ['', 'data-download-all-images', '#2563eb'],
      ['', 'data-copy-image', '#9333ea'], ['', 'data-share-image', '#0891b2'],
      ['copy-btn copied', '', '#059669'],
    ]) {
      const button = dom.window.document.createElement('button');
      button.className = className;
      if (attr) button.setAttribute(attr, '1');
      actions.appendChild(button);
      assert.ok(dom.window.getComputedStyle(button).getPropertyValue('--message-action-color').trim().includes(color));
    }
  }
  // Freeze icon-only wiring: semantic colors must not alter layout or action visibility.
  assert.match(rules, /\.msg-actions button svg \*/);
  assert.doesNotMatch(rules, /(?:width|height|display|position|opacity|background)\s*:/);
  dom.window.close();
}
module.exports = [testMessageActionColorsCoverBothRolesAndImageActions];
