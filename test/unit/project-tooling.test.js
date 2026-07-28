'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const packageJson = require('../../package.json');
const { checkProject } = require('../../scripts/check-project');
const { checkArchitecture, checkBoundaries, readBaseline } = require('../../scripts/check-architecture');
const { checkSyntax } = require('../../scripts/check-syntax');
const { releaseVersion, verifyRelease } = require('../../scripts/verify-release');

function testProjectToolingChecksStaticAndPackageContracts() {
  const result = checkProject();
  assert.strictEqual(result.version, packageJson.version);
  assert.strictEqual(result.staticFiles, 5);
}

function testProductionDependenciesDeclareDirectServerImports() {
  assert.strictEqual(packageJson.dependencies?.undici, '7.28.0', 'undici must be installed in the production image');
  assert.ok(!packageJson.devDependencies?.undici, 'undici must not be development-only');
}

function testReleaseVerificationRequiresMatchingSemverTag() {
  const tag = `v${packageJson.version}`;
  assert.strictEqual(releaseVersion(tag), packageJson.version);
  assert.strictEqual(verifyRelease(tag).tag, tag);
  assert.throws(() => releaseVersion(packageJson.version), /vMAJOR\.MINOR\.PATCH/);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chatui-release-check-'));
  try {
    const version = '9.8.7';
    fs.mkdirSync(path.join(root, 'server', 'http'), { recursive: true });
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
      name: 'fixture',
      version,
      private: true,
      scripts: packageJson.scripts,
    }), 'utf8');
    fs.writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify({
      version,
      packages: { '': { version } },
    }), 'utf8');
    fs.writeFileSync(path.join(root, 'Dockerfile'), 'COPY index.html route.html app.js styles.css favicon.svg ./\n', 'utf8');
    fs.writeFileSync(path.join(root, 'server', 'http', 'static.js'), "module.exports = { isPublicStaticPath(value) { return ['/index.html', '/route.html', '/app.js', '/styles.css', '/favicon.svg'].includes(value); } };\n", 'utf8');
    for (const file of ['index.html', 'route.html', 'app.js', 'styles.css', 'favicon.svg']) {
      fs.writeFileSync(path.join(root, file), `${file}\n`, 'utf8');
    }

    assert.strictEqual(
      verifyRelease(`v${version}`, { root }).tag,
      `v${version}`,
      'tag metadata validation must not require release notes that the mandated process adds after tag publication',
    );
    assert.ok(!fs.existsSync(path.join(root, 'docs')), 'the fixture deliberately has no release notes at tag time');
    assert.throws(() => verifyRelease('v9.8.6', { root }), /must match package\.json and package-lock\.json/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function testDeliveryWorkflowsKeepDockerAndGitHubReleaseOwnershipSeparate() {
  const root = path.join(__dirname, '../..');
  const ci = fs.readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8');
  const release = fs.readFileSync(path.join(root, '.github/workflows/dockerhub.yml'), 'utf8');

  assert.ok(ci.includes('load: true') && ci.includes('docker run --detach'), 'CI must load and start the image it built');
  for (const endpoint of ['/api/version', '/route.html', '/vendor/markdown-it.min.js', '/vendor/manifest.json']) {
    assert.ok(ci.includes(endpoint), `container smoke validation must request ${endpoint}`);
  }
  assert.ok(ci.includes('npm ls --omit=dev --all') && ci.includes('require("./server/extract/office")') && ci.includes('must not be installed in the production image'), 'CI must verify the complete omit=dev production dependency tree inside the built image');
  assert.ok(release.includes('docker-publish:'), 'the tag workflow must retain Docker publication');
  assert.ok(release.includes('node scripts/verify-release.js'), 'the tag workflow must validate version metadata');
  assert.ok(!release.includes('github-release:'), 'the Docker workflow must not take over the later explicit GitHub Release step');
  assert.ok(!release.includes('docs/releases/'), 'tag validation must not depend on post-tag release notes');
  assert.ok(!release.includes('github.rest.repos.createRelease'), 'Docker publication must not silently create a GitHub Release');
}

function testSyntaxCheckCoversEveryProjectJavaScriptFileAndRejectsInvalidModules() {
  const current = checkSyntax();
  assert.ok(current.files > 200, 'the syntax gate must cover project modules, scripts, and tests rather than only two root entries');
  for (const required of ['app.js', 'server.js', 'client/core/task-state.js', 'server/http/static.js', 'scripts/check-syntax.js', 'test/run-tests.js']) {
    assert.ok(current.relativeFiles.includes(required), `syntax gate must include ${required}`);
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chatui-syntax-check-'));
  try {
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(path.join(root, 'entry.js'), "'use strict';\n", 'utf8');
    fs.writeFileSync(path.join(root, 'src', 'valid.js'), 'module.exports = { ok: true };\n', 'utf8');
    const options = { root, rootFiles: ['entry.js'], sourceRoots: ['src'] };
    assert.deepStrictEqual(checkSyntax(options).relativeFiles, ['entry.js', 'src/valid.js']);

    fs.writeFileSync(path.join(root, 'src', 'invalid.js'), 'module.exports = ;\n', 'utf8');
    assert.throws(() => checkSyntax(options), /invalid\.js is not valid CommonJS JavaScript/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}


function testArchitectureCheckFreezesLegacyGrowth() {
  const current = checkArchitecture();
  assert.ok(current.appJsBytes <= current.appJsMaxBytes);
  const baseline = readBaseline();
  assert.strictEqual(current.withScopes, Object.values(baseline.legacyWithScopes).reduce((sum, count) => sum + count, 0));
  assert.ok(current.globalNamespaceExports <= baseline.maxGlobalNamespaceExports);
  assert.ok(current.boundaryFiles > 100, 'the architecture gate must inspect every owned client/server/shared JavaScript file');

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chatui-architecture-check-'));
  try {
    fs.mkdirSync(path.join(root, 'client'), { recursive: true });
    fs.mkdirSync(path.join(root, 'server'), { recursive: true });
    fs.mkdirSync(path.join(root, 'shared'), { recursive: true });
    fs.writeFileSync(path.join(root, 'app.js'), 'ok', 'utf8');
    const fixtureBaseline = { appJsMaxBytes: 2, maxGlobalNamespaceExports: 0, legacyWithScopes: {} };
    assert.doesNotThrow(() => checkArchitecture({ root, baseline: fixtureBaseline }));

    fs.writeFileSync(path.join(root, 'client', 'new-workflow.js'), 'with (deps) {}', 'utf8');
    assert.throws(() => checkArchitecture({ root, baseline: fixtureBaseline }), /New or expanded with-scopes are forbidden/);

    fs.writeFileSync(path.join(root, 'client', 'new-workflow.js'), '', 'utf8');
    const staleWithBaseline = { ...fixtureBaseline, legacyWithScopes: { 'client/new-workflow.js': 1 } };
    assert.throws(() => checkArchitecture({ root, baseline: staleWithBaseline }), /Update the baseline when removing recorded legacy debt/);

    fs.writeFileSync(path.join(root, 'client', 'new-workflow.js'), 'window.ChatUINewFeature = {};', 'utf8');
    assert.throws(() => checkArchitecture({ root, baseline: fixtureBaseline }), /browser global namespace exports grew/);

    fs.writeFileSync(path.join(root, 'client', 'new-workflow.js'), '', 'utf8');
    fs.writeFileSync(path.join(root, 'app.js'), 'too large', 'utf8');
    assert.throws(() => checkArchitecture({ root, baseline: fixtureBaseline }), /root app\.js grew/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function testArchitectureCheckEnforcesExecutableLayerBoundaries() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chatui-boundary-check-'));
  try {
    for (const directory of ['client', 'server', 'shared']) fs.mkdirSync(path.join(root, directory));
    const client = path.join(root, 'client', 'feature.js');
    const server = path.join(root, 'server', 'service.js');
    const shared = path.join(root, 'shared', 'contract.js');
    fs.writeFileSync(client, "require('../shared/contract');\n// require('fs');\nconst text = \"require('../server/private')\";\n", 'utf8');
    fs.writeFileSync(server, "require('../shared/contract');\n", 'utf8');
    fs.writeFileSync(shared, "module.exports = { ok: true };\n// process.env.NOT_REAL\n", 'utf8');
    assert.strictEqual(checkBoundaries({ root }).files, 3, 'allowed inward dependencies and comment/string examples must pass');

    fs.writeFileSync(client, "require('node:fs');\n", 'utf8');
    assert.throws(() => checkBoundaries({ root }), /client\/feature\.js imports Node built-in node:fs/);
    fs.writeFileSync(client, "require('../server/service');\n", 'utf8');
    assert.throws(() => checkBoundaries({ root }), /client\/feature\.js imports server code/);
    fs.writeFileSync(client, "module.exports = {};\n", 'utf8');

    fs.writeFileSync(server, "require('../client/feature');\n", 'utf8');
    assert.throws(() => checkBoundaries({ root }), /server\/service\.js imports client code/);
    fs.writeFileSync(server, "module.exports = {};\n", 'utf8');

    fs.writeFileSync(shared, "require('../server/service');\n", 'utf8');
    assert.throws(() => checkBoundaries({ root }), /shared\/contract\.js imports server code/);
    fs.writeFileSync(shared, "const value = process.env.SECRET;\n", 'utf8');
    assert.throws(() => checkBoundaries({ root }), /shared\/contract\.js reads process\.env/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

module.exports = [
  testProjectToolingChecksStaticAndPackageContracts,
  testProductionDependenciesDeclareDirectServerImports,
  testArchitectureCheckFreezesLegacyGrowth,
  testArchitectureCheckEnforcesExecutableLayerBoundaries,
  testSyntaxCheckCoversEveryProjectJavaScriptFileAndRejectsInvalidModules,
  testReleaseVerificationRequiresMatchingSemverTag,
  testDeliveryWorkflowsKeepDockerAndGitHubReleaseOwnershipSeparate,
];
