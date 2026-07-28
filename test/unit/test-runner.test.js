'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  TEST_DIRECTORIES,
  DEFAULT_TEST_TIMEOUT_MS,
  discoverTestFiles,
  normalizeSuite,
  selectTestFiles,
  validateTestRecords,
  loadTests,
  testFileFilters,
  selectTestRecords,
  testTimeoutMs,
  executeTest,
  run,
} = require('../run-tests');

const fixturePath = path.join(__dirname, 'fixture.test.js');

function record(name, test) {
  return { name, test, filePath: fixturePath, label: 'unit/fixture.test.js' };
}

function testRunnerRejectsEmptyMalformedAndAnonymousSuites() {
  assert.throws(() => normalizeSuite({}, fixturePath), /must export an array/);
  assert.throws(() => normalizeSuite([], fixturePath), /at least one test/);
  assert.throws(() => normalizeSuite([null], fixturePath), /entry 1 must be a function/);
  const anonymous = () => {};
  Object.defineProperty(anonymous, 'name', { value: '' });
  assert.throws(() => normalizeSuite([anonymous], fixturePath), /entry 1 must be a named function/);
}

function testRunnerRecursivelyDiscoversNestedSuitesInDeterministicOrder() {
  assert.deepStrictEqual(TEST_DIRECTORIES, ['unit', 'smoke', 'legacy'], 'focused suites should fail before the legacy regression backlog');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chatui-runner-discovery-'));
  try {
    const unit = path.join(root, 'unit');
    const nested = path.join(unit, 'nested');
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(unit, 'z.test.js'), 'module.exports = [function testTopLevelFixture() {}];\n', 'utf8');
    fs.writeFileSync(path.join(nested, 'a.test.js'), 'module.exports = [function testNestedFixture() {}];\n', 'utf8');
    fs.writeFileSync(path.join(nested, 'ignored.js'), 'throw new Error("not a test suite");\n', 'utf8');

    const discovered = discoverTestFiles(unit).map(filePath => path.relative(root, filePath).replace(/\\/g, '/'));
    assert.deepStrictEqual(discovered, ['unit/nested/a.test.js', 'unit/z.test.js']);
    const records = loadTests({ root, directories: ['unit'] });
    assert.deepStrictEqual(records.map(item => item.label), discovered);
    assert.deepStrictEqual(records.map(item => item.name), ['testNestedFixture', 'testTopLevelFixture']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function testRunnerRejectsDuplicateNamesAndInvalidTimeoutConfiguration() {
  const first = record('testSameName', () => {});
  const second = { ...record('testSameName', () => {}), label: 'smoke/other.test.js' };
  assert.throws(() => validateTestRecords([first, second]), /Duplicate test name testSameName/);
  assert.throws(() => validateTestRecords([]), /No tests were discovered/);
  assert.strictEqual(testTimeoutMs(''), DEFAULT_TEST_TIMEOUT_MS);
  assert.strictEqual(testTimeoutMs('1250'), 1250);
  for (const invalid of ['0', '-1', '1.5', 'NaN']) {
    assert.throws(() => testTimeoutMs(invalid), /positive integer/);
  }
}

function testRunnerFileFiltersSelectRealSuitesAndRejectTypos() {
  const records = [
    record('testUnitFixture', () => {}),
    { ...record('testSmokeFixture', () => {}), label: 'smoke/server-smoke.test.js' },
  ];
  assert.deepStrictEqual(testFileFilters(['test\\unit\\fixture.test.js']), ['unit/fixture.test.js']);
  assert.deepStrictEqual(selectTestRecords(records, ['unit/fixture.test.js']).map(item => item.name), ['testUnitFixture']);
  assert.deepStrictEqual(selectTestRecords(records, ['smoke']).map(item => item.name), ['testSmokeFixture']);
  assert.throws(() => testFileFilters(['../outside.test.js']), /Invalid test file filter/);
  assert.throws(() => selectTestRecords(records, ['unit/typo.test.js']), /No tests matched/);
}

function testRunnerFiltersFilesBeforeLoadingSuites() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chatui-runner-filter-'));
  try {
    const unit = path.join(root, 'unit');
    fs.mkdirSync(unit, { recursive: true });
    const selectedPath = path.join(unit, 'selected.test.js');
    const excludedPath = path.join(unit, 'excluded.test.js');
    fs.writeFileSync(selectedPath, 'module.exports = [function testSelectedFixture() {}];\n', 'utf8');
    fs.writeFileSync(excludedPath, 'throw new Error("excluded suite was loaded");\n', 'utf8');

    assert.deepStrictEqual(
      selectTestFiles([excludedPath, selectedPath], ['unit/selected.test.js'], root),
      [selectedPath],
    );
    const records = loadTests({ root, directories: ['unit'], filters: ['unit/selected.test.js'] });
    assert.deepStrictEqual(records.map(item => item.name), ['testSelectedFixture']);
    assert.throws(
      () => loadTests({ root, directories: ['unit'] }),
      /excluded suite was loaded/,
      'a full run must still load and validate every discovered suite',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function testRunnerAwaitsAsyncTestsAndReportsFileProvenance() {
  const events = [];
  const tests = [record('testAsyncFixture', async () => {
    await Promise.resolve();
    events.push('completed');
  })];
  const count = await run({ tests, timeoutMs: 100, log: message => events.push(message) });
  assert.strictEqual(count, 1);
  assert.deepStrictEqual(events, [
    'completed',
    'PASS unit/fixture.test.js > testAsyncFixture',
    'All 1 tests passed.',
  ]);
}

async function testRunnerFailsAnUnsettledAsyncTestWithinItsDeadline() {
  const stalled = record('testStalledFixture', () => new Promise(() => {}));
  await assert.rejects(
    executeTest(stalled, 10),
    /Test timed out after 10ms: unit\/fixture\.test\.js > testStalledFixture/,
  );
}

module.exports = [
  testRunnerRejectsEmptyMalformedAndAnonymousSuites,
  testRunnerRecursivelyDiscoversNestedSuitesInDeterministicOrder,
  testRunnerRejectsDuplicateNamesAndInvalidTimeoutConfiguration,
  testRunnerFileFiltersSelectRealSuitesAndRejectTypos,
  testRunnerFiltersFilesBeforeLoadingSuites,
  testRunnerAwaitsAsyncTestsAndReportsFileProvenance,
  testRunnerFailsAnUnsettledAsyncTestWithinItsDeadline,
];
