'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const packageJson = require('../../package.json');
const packageLock = require('../../package-lock.json');
const dependencyLoader = require('../../client/app/markdown/dependency-loader');

const ROOT = path.join(__dirname, '../..');

function assertExactVersion(value, label) {
  assert.match(String(value || ''), /^\d+\.\d+\.\d+$/, `${label} must use an exact version`);
}

function testBrowserVendorPackagesStayInSync() {
  const cases = [
    {
      packageName: 'dompurify',
      resourceId: 'dompurify',
      vendorPath: 'vendor/purify.min.js',
      installedPath: 'node_modules/dompurify/dist/purify.min.js',
    },
    {
      packageName: 'mermaid',
      resourceId: 'mermaid',
      vendorPath: 'vendor/mermaid.min.js',
      installedPath: 'node_modules/mermaid/dist/mermaid.min.js',
    },
  ];

  for (const item of cases) {
    const version = packageJson.devDependencies[item.packageName];
    assertExactVersion(version, item.packageName);
    assert.strictEqual(packageLock.packages[''].devDependencies[item.packageName], version,
      `${item.packageName} root lock metadata must match package.json`);
    assert.strictEqual(packageLock.packages[`node_modules/${item.packageName}`]?.version, version,
      `${item.packageName} installed lock version must match package.json`);

    const resource = dependencyLoader.resources.scripts.find(candidate => candidate.id === item.resourceId);
    assert.ok(resource, `${item.resourceId} must remain registered in the browser dependency loader`);
    assert.ok(resource.cdn.includes(`/${item.packageName}/${version}/`),
      `${item.resourceId} CDN fallback must use the package version shipped locally`);

    const vendor = fs.readFileSync(path.join(ROOT, item.vendorPath));
    const installed = fs.readFileSync(path.join(ROOT, item.installedPath));
    assert.strictEqual(Buffer.compare(vendor, installed), 0,
      `${item.vendorPath} must be byte-identical to the installed ${item.packageName} distribution`);
  }
}

function testUndiciDependencyAndOverrideStayInSync() {
  const version = packageJson.dependencies.undici;
  assertExactVersion(version, 'undici');
  assert.strictEqual(packageJson.overrides.undici, version,
    'the direct undici dependency and npm override must not diverge');
  assert.strictEqual(packageLock.packages[''].dependencies.undici, version,
    'the root lock metadata must match the undici dependency');
  assert.strictEqual(packageLock.packages['node_modules/undici']?.version, version,
    'the resolved undici version must match the audited direct dependency');
}

function testDependencyLoaderHasExplicitCacheRevision() {
  const indexHtml = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  assert.match(indexHtml, /client\/app\/markdown\/dependency-loader\.js\?v=[0-9.]+/,
    'the browser dependency loader must keep an explicit cache-busting revision');
}

module.exports = [
  testBrowserVendorPackagesStayInSync,
  testUndiciDependencyAndOverrideStayInSync,
  testDependencyLoaderHasExplicitCacheRevision,
];
