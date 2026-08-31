const assert = require('assert');
const fs = require('fs');
const path = require('path');
const staticBundle = require('../../server/services/static-bundle.service');

// Regression gate for the intent waiting surface: restoring the theme to the
// remote baseline dropped the styles the new intent status trace needs, so the
// waiting message rendered without its card layout. These selectors must be
// present in the source and in the served bundle.
const INTENT_WAITING_SELECTORS = [
  '.intent-reasoning-trace',
  '.intent-waiting-surface',
  '.intent-reasoning-steps',
  '@keyframes intentReasoningEllipsis',
];

function testIntentWaitingSurfaceStylesSurviveBundleAssembly() {
  const root = path.join(__dirname, '../..');
  const source = fs.readFileSync(path.join(root, 'styles/calm-theme.css'), 'utf8');
  for (const selector of INTENT_WAITING_SELECTORS) {
    assert.ok(source.includes(selector), `calm-theme.css must keep ${selector}`);
  }
  const entries = staticBundle.parseAssetManifest(root, `${root}${path.sep}`, 'css');
  const calmTheme = entries.find(entry => entry.urlPath === '/styles/calm-theme.css');
  assert.ok(calmTheme, 'calm-theme.css must be part of the CSS asset manifest');
  const body = staticBundle.buildBundleBody([calmTheme], 'css').toString('utf8');
  for (const selector of INTENT_WAITING_SELECTORS) {
    assert.ok(body.includes(selector), `CSS bundle must preserve ${selector} from calm-theme.css`);
  }
}

module.exports = [testIntentWaitingSurfaceStylesSurviveBundleAssembly];