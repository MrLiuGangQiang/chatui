'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { checkVendor } = require('../../scripts/check-vendor');

function testVendoredRuntimeAssetsMatchLockedPackageSources() {
  const result = checkVendor();
  assert.strictEqual(result.assets, 77, 'every shipped JavaScript, CSS, and KaTeX font asset must be accounted for');
  assert.strictEqual(result.packages, 15, 'the manifest must retain source and license metadata for every vendored package');
  assert.strictEqual(result.licenses, 16, 'both DOMPurify alternatives and every other complete upstream license must ship with vendor assets');
}

function testVendorCheckRejectsDriftUntrackedAssetsAndVersionMismatch() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chatui-vendor-check-'));
  try {
    const packageRoot = path.join(root, 'node_modules', 'fixture-package');
    fs.mkdirSync(path.join(packageRoot, 'dist'), { recursive: true });
    fs.mkdirSync(path.join(root, 'vendor'), { recursive: true });
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
      dependencies: { 'fixture-package': '1.0.0' },
    }), 'utf8');
    fs.writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify({
      packages: { 'node_modules/fixture-package': { version: '1.0.0' } },
    }), 'utf8');
    fs.writeFileSync(path.join(packageRoot, 'dist', 'fixture.js'), 'window.fixture = true;\n', 'utf8');
    fs.writeFileSync(path.join(root, 'vendor', 'fixture.js'), 'window.fixture = true;\n', 'utf8');
    fs.mkdirSync(path.join(root, 'vendor', 'licenses'));
    fs.writeFileSync(path.join(packageRoot, 'LICENSE'), 'Fixture license\n', 'utf8');
    fs.writeFileSync(path.join(root, 'vendor', 'licenses', 'fixture.txt'), 'Fixture license\n', 'utf8');
    const manifestPath = path.join(root, 'manifest.json');
    const manifest = {
      schema_version: 'chatui-vendor-manifest.v1',
      assets: [{
        target: 'vendor/fixture.js',
        package: 'fixture-package',
        version: '1.0.0',
        license: 'MIT',
        source: 'dist/fixture.js',
        mode: 'exact',
      }],
      directories: [],
      licenses: [{
        package: 'fixture-package',
        version: '1.0.0',
        license: 'MIT',
        sources: ['LICENSE'],
        targets: ['vendor/licenses/fixture.txt'],
      }],
    };
    fs.writeFileSync(manifestPath, JSON.stringify(manifest), 'utf8');
    assert.deepStrictEqual(checkVendor({ root, manifestPath }), { assets: 1, packages: 1, licenses: 1 });

    fs.writeFileSync(path.join(root, 'vendor', 'fixture.js'), 'window.fixture = false;\n', 'utf8');
    assert.throws(() => checkVendor({ root, manifestPath }), /differs from its locked package source/);

    fs.writeFileSync(path.join(root, 'vendor', 'fixture.js'), 'window.fixture = true;\n', 'utf8');
    fs.writeFileSync(path.join(root, 'vendor', 'undeclared.css'), 'body {}\n', 'utf8');
    assert.throws(() => checkVendor({ root, manifestPath }), /runtime assets are not declared/);
    fs.rmSync(path.join(root, 'vendor', 'undeclared.css'));

    fs.writeFileSync(path.join(root, 'vendor', 'undeclared.wasm'), 'not-real-wasm\n', 'utf8');
    assert.throws(() => checkVendor({ root, manifestPath }), /runtime assets are not declared/, 'non-JS/CSS browser assets must not bypass the manifest');
    fs.rmSync(path.join(root, 'vendor', 'undeclared.wasm'));

    manifest.assets[0].version = '2.0.0';
    fs.writeFileSync(manifestPath, JSON.stringify(manifest), 'utf8');
    assert.throws(() => checkVendor({ root, manifestPath }), /does not match package-lock\.json/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

module.exports = [
  testVendoredRuntimeAssetsMatchLockedPackageSources,
  testVendorCheckRejectsDriftUntrackedAssetsAndVersionMismatch,
];
