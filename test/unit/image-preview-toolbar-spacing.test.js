const assert = require('assert');
const fs = require('fs');
const path = require('path');

function testImagePreviewCompressionUsesExistingThemeSpacing() {
  const css = fs.readFileSync(path.join(__dirname, '../../styles/flat-theme.css'), 'utf8');
  // Freeze the toolbar's desktop/mobile layout wiring, including the fourth action.
  for (const [name, desktop, mobile] of [
    ['close', 14, 10], ['download', 56, 46], ['copy', 98, 82], ['compress-download', 140, 118],
  ]) {
    const positions = [...css.matchAll(new RegExp('\\.image-preview-' + name + '\\s*\\{\\s*right:\\s*(\\d+)px\\s*!important;?\\s*\\}', 'g'))].map(match => Number(match[1]));
    assert.deepStrictEqual(positions, [desktop, mobile], name + ' must have only one position per breakpoint');
  }
  const rootCss = fs.readFileSync(path.join(__dirname, '../../styles.css'), 'utf8');
  assert.strictEqual((rootCss.match(/\.image-preview-compress-download\s*\{[^}]*right:/g) || []).length, 0,
    'base stylesheet must not accumulate competing compression offsets');
}
module.exports = [testImagePreviewCompressionUsesExistingThemeSpacing];
