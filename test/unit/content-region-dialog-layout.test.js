'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

function testFixedDialogsCenterWithinChatContentRegion() {
  const css = fs.readFileSync(path.join(__dirname, '../../styles/flat-theme.css'), 'utf8');
  assert.ok(css.includes('--dialog-content-start:var(--session-sidebar-width)'));
  assert.ok(css.includes('body.session-sidebar-collapsed{\n  --dialog-content-start:var(--session-rail-width)'));
  assert.ok(css.includes('.toast-popup{\n  left:calc(var(--dialog-content-start) + (100vw - var(--dialog-content-start))/2)!important'));
  assert.ok(css.includes('#configModal.modal.show{\n    padding-left:calc(var(--dialog-content-start) + 24px)!important'));
  assert.ok(css.includes('.confirm-dialog{\n    padding-left:calc(var(--dialog-content-start) + 22px)!important'));
  assert.ok(css.includes('.web-preview-dialog{\n    padding-left:calc(var(--dialog-content-start) + 24px)!important'));
  assert.ok(css.includes('.image-preview{\n    padding-left:calc(var(--dialog-content-start) + 28px)!important'));
  assert.ok(css.includes('.route-diagram-modal{\n    padding-left:calc(var(--dialog-content-start) + clamp(16px,3vw,40px))!important'));
  assert.ok(css.includes('@media (max-width:840px){') && css.includes('--dialog-content-start:0px'));
}

module.exports = [testFixedDialogsCenterWithinChatContentRegion];
