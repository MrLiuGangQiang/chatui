'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  DEFAULT_TIMEOUT_MS,
  TEST_DIRECTORIES,
  declaredTestNames,
  discoverTestFiles,
  parseCliArgs,
  restoreGlobalState,
  runTests,
  snapshotGlobalState,
  validateUniqueTestNames,
  validateDeclaredTestExports,
  withTimeout,
} = require('../run-tests');

function namedTest() {}

function testRunnerDiscoversAndFiltersFocusedSuites() {
  const all = discoverTestFiles();
  assert.ok(all.length >= 80);
  assert.ok(all.every(file => file.endsWith('.test.js')));
  const focused = discoverTestFiles({ filters: ['unit/server-hardening.test.js'] });
  assert.deepStrictEqual(focused.map(file => path.basename(file)), ['server-hardening.test.js']);
  const smokeFiles = discoverTestFiles({ filters: ['test/smoke'] });
  assert.ok(smokeFiles.length >= 2);
  assert.ok(smokeFiles.every(file => path.relative(path.join(__dirname, '..', 'smoke'), file).split(path.sep)[0] !== '..'));
  assert.ok(smokeFiles.some(file => path.basename(file) === 'multi-image-compose-flow.test.js'));
  assert.ok(smokeFiles.some(file => path.basename(file) === 'server-smoke.test.js'));

  const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'chatui-runner-discovery-'));
  try {
    const nested = path.join(testRoot, 'unit', 'nested');
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(nested, 'deep.test.js'), 'module.exports = [function testDeep() {}];\n');
    assert.deepStrictEqual(
      discoverTestFiles({ testRoot }).map(file => path.relative(testRoot, file).replace(/\\/g, '/')),
      ['unit/nested/deep.test.js'],
    );
  } finally {
    fs.rmSync(testRoot, { recursive: true, force: true });
  }
}

function testRunnerParsesTimeoutAndRejectsUnknownOptions() {
  assert.deepStrictEqual(parseCliArgs(['--list', 'unit/usage'], {}), {
    filters: ['unit/usage'],
    list: true,
    help: false,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  });
  assert.strictEqual(parseCliArgs(['--timeout=250'], {}).timeoutMs, 250);
  assert.strictEqual(parseCliArgs([], { CHATUI_TEST_TIMEOUT_MS: '900' }).timeoutMs, 900);
  assert.throws(() => parseCliArgs(['--timeout=0'], {}), /Invalid test timeout/);
  assert.throws(() => parseCliArgs(['--unknown'], {}), /Unknown test option/);
}

function testRunnerRejectsDuplicateNames() {
  const records = [
    { relativeFile: 'unit/a.test.js', test: namedTest },
    { relativeFile: 'unit/b.test.js', test: namedTest },
  ];
  assert.throws(() => validateUniqueTestNames(records), /Duplicate test name namedTest/);
}

function testRunnerRejectsDeclaredTestsMissingFromExports() {
  function testExported() {}
  const source = [
    '/* function testCommentedOut() {} */',
    'const example = "function testInsideString() {}";',
    "const quotePattern = /'/;",
    'function testExported() {}',
    'async function testSilentlySkipped() {}',
    'const testSkippedArrow = async () => {};',
    'function* testSkippedGenerator() {}',
  ].join('\n');
  assert.deepStrictEqual(declaredTestNames(source), ['testExported', 'testSilentlySkipped', 'testSkippedArrow', 'testSkippedGenerator']);
  assert.throws(
    () => validateDeclaredTestExports(source, [testExported], 'unit/example.test.js'),
    /declares tests that are not exported: testSilentlySkipped, testSkippedArrow, testSkippedGenerator/,
  );
}

async function testRunnerReportsTimeoutWithSuiteAndTestName() {
  await assert.rejects(
    withTimeout(() => new Promise(() => {}), 5, 'unit/hung.test.js > testHung'),
    /unit\/hung\.test\.js > testHung/,
  );
}

async function testRunnerReturnsDeterministicSummary() {
  const output = [];
  const result = await runTests(
    [{ relativeFile: 'unit/example.test.js', test: namedTest }],
    { timeoutMs: 50, log: line => output.push(line) },
  );
  assert.strictEqual(result.tests, 1);
  assert.strictEqual(result.files, 1);
  assert.ok(output[0].startsWith('SUITE unit/example.test.js'));
  assert.ok(output.at(-1).startsWith('All 1 tests across 1 files passed'));
}

async function testRunnerRestoresGlobalPropertiesAfterEachTest() {
  const leakKey = '__chatuiRunnerLeak';
  delete globalThis[leakKey];
  const before = snapshotGlobalState();
  globalThis[leakKey] = 'temporary';
  assert.ok(restoreGlobalState(before).includes(leakKey));
  assert.strictEqual(Object.prototype.hasOwnProperty.call(globalThis, leakKey), false);

  await runTests(
    [{ relativeFile: 'unit/global-leak.test.js', test: function testCreatesTemporaryGlobal() { globalThis[leakKey] = true; } }],
    { timeoutMs: 50, log: () => {} },
  );
  assert.strictEqual(Object.prototype.hasOwnProperty.call(globalThis, leakKey), false);
}

async function testRunnerRestoresGlobalsWhenATestFails() {
  const leakKey = '__chatuiRunnerFailureLeak';
  delete globalThis[leakKey];
  await assert.rejects(
    runTests(
      [{
        relativeFile: 'unit/failing-global.test.js',
        test: function testLeaksThenFails() {
          globalThis[leakKey] = true;
          throw new Error('expected test failure');
        },
      }],
      { timeoutMs: 50, log: () => {} },
    ),
    /expected test failure/,
  );
  assert.strictEqual(Object.prototype.hasOwnProperty.call(globalThis, leakKey), false);
}

async function testRunnerRestoresTheRealGlobalWhenGlobalThisIsReassigned() {
  const realGlobal = globalThis;
  await runTests(
    [{
      relativeFile: 'unit/global-this-replacement.test.js',
      test: function testReassignsGlobalThis() {
        globalThis.globalThis = { hijacked: true };
      },
    }],
    { timeoutMs: 50, log: () => {} },
  );
  assert.strictEqual(globalThis, realGlobal);
  assert.strictEqual(globalThis.globalThis, realGlobal);
}

function testRunnerRejectsEveryNewNonConfigurableGlobal() {
  const target = {};
  const snapshot = snapshotGlobalState(target);
  const leakKey = Symbol.for('chatui.runner.non-configurable-leak');
  Object.defineProperty(target, leakKey, { value: true, configurable: false });
  assert.throws(
    () => restoreGlobalState(snapshot, target),
    /cannot remove Symbol\(chatui\.runner\.non-configurable-leak\)/,
  );
}


function testRunnerDiscoveryExcludesRemovedLegacyDirectory() {
  assert.ok(!TEST_DIRECTORIES.includes('legacy'), 'the removed test/legacy directory must not be discovered anymore');
  const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'chatui-runner-no-legacy-'));
  try {
    fs.mkdirSync(path.join(testRoot, 'legacy'), { recursive: true });
    fs.mkdirSync(path.join(testRoot, 'unit'), { recursive: true });
    fs.writeFileSync(path.join(testRoot, 'legacy', 'legacy.test.js'), 'module.exports = [function testLegacy() {}];\n');
    fs.writeFileSync(path.join(testRoot, 'unit', 'kept.test.js'), 'module.exports = [function testKept() {}];\n');
    assert.deepStrictEqual(
      discoverTestFiles({ testRoot }).map(file => path.relative(testRoot, file).replace(/\\/g, '/')),
      ['unit/kept.test.js'],
    );
  } finally {
    fs.rmSync(testRoot, { recursive: true, force: true });
  }
}

module.exports = [
  testRunnerDiscoversAndFiltersFocusedSuites,
  testRunnerDiscoveryExcludesRemovedLegacyDirectory,
  testRunnerParsesTimeoutAndRejectsUnknownOptions,
  testRunnerRejectsDuplicateNames,
  testRunnerRejectsDeclaredTestsMissingFromExports,
  testRunnerReportsTimeoutWithSuiteAndTestName,
  testRunnerReturnsDeterministicSummary,
  testRunnerRestoresGlobalPropertiesAfterEachTest,
  testRunnerRestoresGlobalsWhenATestFails,
  testRunnerRestoresTheRealGlobalWhenGlobalThisIsReassigned,
  testRunnerRejectsEveryNewNonConfigurableGlobal,
];
