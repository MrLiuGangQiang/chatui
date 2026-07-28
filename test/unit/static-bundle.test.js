const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const staticBundle = require('../../server/services/static-bundle.service');
const staticHttp = require('../../server/http/static');

function withTempBundleRoot(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chatui-static-bundle-'));
  try {
    fs.mkdirSync(path.join(root, 'styles'), { recursive: true });
    fs.mkdirSync(path.join(root, 'client'), { recursive: true });
    fs.writeFileSync(path.join(root, 'styles/app.css'), '.hero{background:url(icons/bg.svg?v=1)}\n', 'utf8');
    fs.writeFileSync(path.join(root, 'client/app.js'), 'window.ChatUI={};\n', 'utf8');
    fs.writeFileSync(path.join(root, 'index.html'), `<!doctype html>
<template id="chatuiAssetManifest">
  <link rel="preload stylesheet" href="styles/app.css?v=1">
  <link rel="stylesheet" href="/assets/chatui.bundle.css?v=ignored">
  <link rel="stylesheet" href="https://cdn.example.com/remote.css">
  <script src="./client/app.js?v=2"></script>
  <script src="/assets/chatui.bundle.js?v=ignored"></script>
  <script src="data:text/javascript,console.log(1)"></script>
</template>`, 'utf8');
    return run(root, `${root}${path.sep}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function testStaticBundleManifestParsesLocalEntriesOnly() {
  withTempBundleRoot((root, rootWithSep) => {
    const css = staticBundle.parseAssetManifest(root, rootWithSep, 'css');
    const js = staticBundle.parseAssetManifest(root, rootWithSep, 'js');

    assert.strictEqual(css.length, 1);
    assert.strictEqual(css[0].href, 'styles/app.css?v=1');
    assert.strictEqual(css[0].urlPath, '/styles/app.css');
    assert.strictEqual(css[0].filePath, path.join(root, 'styles/app.css'));

    assert.strictEqual(js.length, 1);
    assert.strictEqual(js[0].href, './client/app.js?v=2');
    assert.strictEqual(js[0].urlPath, '/client/app.js');
  });
}

function testStaticBundleHelpersBuildExpectedBodyAndMetadata() {
  withTempBundleRoot((root, rootWithSep) => {
    assert.strictEqual(staticBundle.contentTypeForBundle('css'), 'text/css; charset=utf-8');
    assert.strictEqual(staticBundle.contentTypeForBundle('js'), 'application/javascript; charset=utf-8');
    assert.strictEqual(staticBundle.bundleCacheKey('css', 'sig'), 'css:sig');
    assert.strictEqual(staticBundle.resolveBundleEntry(root, rootWithSep, '../secret.css'), null);

    const cssMeta = staticBundle.bundleMetadata(root, rootWithSep, 'css');
    assert.strictEqual(cssMeta.entries.length, 1);
    assert.ok(/^"[a-f0-9]{32}"$/.test(cssMeta.etag), 'bundle metadata should expose stable quoted etag');

    const cssBody = staticBundle.buildBundleBody(cssMeta.entries, 'css').toString('utf8');
    assert.ok(cssBody.includes('/* /styles/app.css */'));
    assert.ok(cssBody.includes('url(/styles/icons/bg.svg?v=1)'), 'relative CSS urls should be rewritten against source asset path');

    const jsBody = staticBundle.buildBundleBody(staticBundle.parseAssetManifest(root, rootWithSep, 'js'), 'js').toString('utf8');
    assert.ok(jsBody.includes(';\n/* /client/app.js */'));
    assert.ok(jsBody.includes('window.ChatUI={}'));

    const rewritten = staticHttp.rewriteBundleUrls(
      '<link rel="stylesheet" href="./assets/chatui.bundle.css?v=old"><script src="./assets/chatui.bundle.js?v=old"></script>',
      root,
      rootWithSep,
    );
    assert.match(rewritten, new RegExp(`chatui\\.bundle\\.css\\?v=${staticBundle.bundleRevision(root, rootWithSep, 'css')}`));
    assert.match(rewritten, new RegExp(`chatui\\.bundle\\.js\\?v=${staticBundle.bundleRevision(root, rootWithSep, 'js')}`));

    const firstRevision = staticBundle.bundleRevision(root, rootWithSep, 'js');
    fs.appendFileSync(path.join(root, 'client/app.js'), 'window.ChatUIRevision=2;\n', 'utf8');
    const secondRevision = staticBundle.bundleRevision(root, rootWithSep, 'js');
    assert.notStrictEqual(secondRevision, firstRevision, 'changing a bundled source must automatically change its URL revision');
  });
}

function testHeavyMarkdownEnhancementsAreDeferredFromPrimaryBundle() {
  assert.deepStrictEqual(staticBundle.DEFERRED_MARKDOWN_SCRIPT_PATHS, [
    '/vendor/highlight-common.min.js',
    '/vendor/katex.min.js',
  ]);
  for (const asset of staticBundle.DEFERRED_MARKDOWN_SCRIPT_PATHS) {
    assert.ok(!staticBundle.MARKDOWN_CORE_SCRIPT_PATHS.includes(asset), `${asset} must not be concatenated into chatui.bundle.js`);
  }
  const loader = fs.readFileSync(path.join(__dirname, '../../client/app/markdown/dependency-loader.js'), 'utf8');
  assert.match(loader, /local: '\.\/vendor\/highlight-common\.min\.js'/, 'highlight.js must remain available from the self-hosted dependency loader');
  assert.match(loader, /local: '\.\/vendor\/katex\.min\.js'/, 'KaTeX must remain available from the self-hosted dependency loader');
}

module.exports = [
  testStaticBundleManifestParsesLocalEntriesOnly,
  testStaticBundleHelpersBuildExpectedBodyAndMetadata,
  testHeavyMarkdownEnhancementsAreDeferredFromPrimaryBundle,
];
