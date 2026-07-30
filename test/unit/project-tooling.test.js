'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const packageJson = require('../../package.json');
const { readVersion } = require('../../scripts/version-source');
const {
  REQUIRED_DOCUMENTATION_FILES,
  REQUIRED_RUNTIME_FILES,
  REQUIRED_SCRIPTS,
  REQUIRED_STATIC_FILES,
  checkProject,
} = require('../../scripts/check-project');
const { checkArchitecture, readBaseline } = require('../../scripts/check-architecture');
const { SOURCE_ROOTS, checkSyntax } = require('../../scripts/check-syntax');
const { releaseVersion, verifyRelease } = require('../../scripts/verify-release');

function writeFixtureFile(root, relativePath, contents = '') {
  const filePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents, 'utf8');
}

function createProjectFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chatui-project-check-'));
  const fixturePackage = {
    name: 'chatui-project-check-fixture',
    version: '1.2.3',
    private: true,
    scripts: Object.fromEntries(REQUIRED_SCRIPTS.map(script => [script, `node ${script}.js`])),
  };
  writeFixtureFile(root, 'package.json', `${JSON.stringify(fixturePackage, null, 2)}\n`);
  writeFixtureFile(root, 'version.json', `${JSON.stringify({ version: fixturePackage.version }, null, 2)}\n`);
  writeFixtureFile(root, 'package-lock.json', `${JSON.stringify({
    name: fixturePackage.name,
    version: fixturePackage.version,
    lockfileVersion: 3,
    packages: { '': { name: fixturePackage.name, version: fixturePackage.version } },
  }, null, 2)}\n`);
  writeFixtureFile(root, 'Dockerfile', 'COPY route.html ./\n');
  writeFixtureFile(root, 'server/http/static.js', "const PUBLIC_ROOT_FILES = new Set(['/route.html']);\n");
  for (const file of [...REQUIRED_STATIC_FILES, ...REQUIRED_RUNTIME_FILES, ...REQUIRED_DOCUMENTATION_FILES]) {
    writeFixtureFile(root, file, `${file}\n`);
  }
  return { root, fixturePackage };
}

function writeFixturePackage(root, fixturePackage) {
  writeFixtureFile(root, 'package.json', `${JSON.stringify(fixturePackage, null, 2)}\n`);
}

function createSyntaxFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chatui-syntax-check-'));
  for (const directory of SOURCE_ROOTS) fs.mkdirSync(path.join(root, directory), { recursive: true });
  writeFixtureFile(root, 'app.js', "'use strict';\n");
  writeFixtureFile(root, 'server.js', "'use strict';\n");
  return root;
}

function testProjectToolingChecksStaticAndPackageContracts() {
  const result = checkProject();
  assert.strictEqual(result.version, readVersion());
  assert.strictEqual(result.version, packageJson.version);
  assert.strictEqual(result.staticFiles, 5);
  assert.strictEqual(result.runtimeFiles, 1);
  assert.strictEqual(result.documentationFiles, 2);
  assert.strictEqual(packageJson.scripts['check:syntax'], 'node scripts/check-syntax.js');
}

function testProjectCheckRejectsInvalidPrivateAndScriptContracts() {
  const { root, fixturePackage } = createProjectFixture();
  try {
    fixturePackage.private = 'false';
    writeFixturePackage(root, fixturePackage);
    assert.throws(
      () => checkProject({ root }),
      /package\.json must declare private: true/
    );

    fixturePackage.private = true;
    fixturePackage.scripts.test = '   ';
    writeFixturePackage(root, fixturePackage);
    assert.throws(
      () => checkProject({ root }),
      /package\.json must define a non-empty test script/
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function testProjectCheckRejectsVersionMirrorDrift() {
  const { root } = createProjectFixture();
  try {
    writeFixtureFile(root, 'package.json', JSON.stringify({
      name: 'chatui-project-check-fixture', version: '1.2.4', private: true,
      scripts: Object.fromEntries(REQUIRED_SCRIPTS.map(script => [script, `node ${script}.js`])),
    }, null, 2));
    assert.throws(() => checkProject({ root }), /package\.json version 1\.2\.4 must match canonical 1\.2\.3/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function testProjectCheckRequiresRegularStaticRuntimeAndDocumentationFiles() {
  const { root } = createProjectFixture();
  try {
    fs.rmSync(path.join(root, 'server.js'));
    assert.throws(
      () => checkProject({ root }),
      /required runtime file is missing: server\.js/
    );

    fs.mkdirSync(path.join(root, 'server.js'));
    assert.throws(
      () => checkProject({ root }),
      /required runtime file must be a regular file: server\.js/
    );
    fs.rmSync(path.join(root, 'server.js'), { recursive: true });
    writeFixtureFile(root, 'server.js', "'use strict';\n");

    fs.rmSync(path.join(root, 'index.html'));
    fs.mkdirSync(path.join(root, 'index.html'));
    assert.throws(
      () => checkProject({ root }),
      /required static file must be a regular file: index\.html/
    );
    fs.rmSync(path.join(root, 'index.html'), { recursive: true });
    writeFixtureFile(root, 'index.html', '<!doctype html>\n');

    fs.rmSync(path.join(root, 'docs/development.md'));
    fs.mkdirSync(path.join(root, 'docs/development.md'));
    assert.throws(
      () => checkProject({ root }),
      /required documentation file must be a regular file: docs\/development\.md/
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function testReleaseVerificationRequiresMatchingSemverTag() {
  const tag = `v${readVersion()}`;
  assert.strictEqual(releaseVersion(tag), readVersion());
  assert.strictEqual(verifyRelease(tag).tag, tag);
  assert.throws(() => releaseVersion(packageJson.version), /vMAJOR\.MINOR\.PATCH/);
}


function testArchitectureCheckFreezesLegacyGrowth() {
  const current = checkArchitecture();
  assert.ok(current.appJsBytes <= current.appJsMaxBytes);
  const baseline = readBaseline();
  assert.strictEqual(current.withScopes, Object.values(baseline.legacyWithScopes).reduce((sum, count) => sum + count, 0));
  assert.ok(current.globalNamespaceExports <= baseline.maxGlobalNamespaceExports);

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

function testSyntaxCheckRecursivelyIncludesControlledSourcesAndExcludesGeneratedDirectories() {
  const root = createSyntaxFixture();
  try {
    fs.mkdirSync(path.join(root, 'client', 'nested'), { recursive: true });
    fs.writeFileSync(path.join(root, 'client', 'nested', 'source.js'), 'const nestedSource = true;\n', 'utf8');

    for (const directory of ['node_modules', 'vendor', 'coverage', 'dist', 'temp', 'test-results']) {
      const excluded = path.join(root, 'client', directory);
      fs.mkdirSync(excluded, { recursive: true });
      fs.writeFileSync(path.join(excluded, 'invalid.js'), 'const = ;\n', 'utf8');
    }

    const result = checkSyntax({ root });
    assert.deepStrictEqual(result.files, ['app.js', 'client/nested/source.js', 'server.js']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function testSyntaxCheckRejectsInvalidNestedControlledJavaScript() {
  const root = createSyntaxFixture();
  try {
    fs.mkdirSync(path.join(root, 'server', 'api'), { recursive: true });
    fs.writeFileSync(path.join(root, 'server', 'api', 'invalid.js'), 'const = ;\n', 'utf8');

    assert.throws(
      () => checkSyntax({ root }),
      /JavaScript syntax check failed for 1 file\(s\):[\s\S]*server\/api\/invalid\.js/
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function testSyntaxCheckFailsClosedWhenControlledPathsAreMissingOrWrongType() {
  const root = createSyntaxFixture();
  try {
    fs.rmSync(path.join(root, 'server.js'));
    assert.throws(
      () => checkSyntax({ root }),
      /required root JavaScript file is missing: server\.js/
    );

    fs.mkdirSync(path.join(root, 'server.js'));
    assert.throws(
      () => checkSyntax({ root }),
      /required root JavaScript file has the wrong type: server\.js/
    );
    fs.rmSync(path.join(root, 'server.js'), { recursive: true });
    writeFixtureFile(root, 'server.js', "'use strict';\n");
    fs.rmSync(path.join(root, 'shared'), { recursive: true });
    assert.throws(
      () => checkSyntax({ root }),
      /required source directory is missing: shared/
    );

    writeFixtureFile(root, 'shared', 'not a directory\n');
    assert.throws(
      () => checkSyntax({ root }),
      /required source directory has the wrong type: shared/
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

module.exports = [
  testProjectToolingChecksStaticAndPackageContracts,
  testProjectCheckRejectsInvalidPrivateAndScriptContracts,
  testProjectCheckRejectsVersionMirrorDrift,
  testProjectCheckRequiresRegularStaticRuntimeAndDocumentationFiles,
  testArchitectureCheckFreezesLegacyGrowth,
  testReleaseVerificationRequiresMatchingSemverTag,
  testSyntaxCheckRecursivelyIncludesControlledSourcesAndExcludesGeneratedDirectories,
  testSyntaxCheckRejectsInvalidNestedControlledJavaScript,
  testSyntaxCheckFailsClosedWhenControlledPathsAreMissingOrWrongType,
];
