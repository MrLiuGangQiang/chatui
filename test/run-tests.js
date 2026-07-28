'use strict';

const fs = require('fs');
const path = require('path');

const TEST_DIRECTORIES = Object.freeze(['unit', 'smoke', 'legacy']);
const DEFAULT_TEST_TIMEOUT_MS = 30_000;

function discoverTestFiles(directory) {
  if (!fs.statSync(directory, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`Test directory does not exist: ${directory}`);
  }
  const files = [];
  const visit = current => {
    const entries = fs.readdirSync(current, { withFileTypes: true })
      .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    for (const entry of entries) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) visit(entryPath);
      else if (entry.isFile() && entry.name.endsWith('.test.js')) files.push(entryPath);
    }
  };
  visit(directory);
  return files;
}

function normalizeSuite(suite, filePath, root = __dirname) {
  const label = path.relative(root, filePath).replace(/\\/g, '/');
  if (!Array.isArray(suite)) throw new Error(`Test suite ${label} must export an array.`);
  if (!suite.length) throw new Error(`Test suite ${label} must export at least one test.`);
  return suite.map((test, index) => {
    if (typeof test !== 'function') {
      throw new Error(`Test suite ${label} entry ${index + 1} must be a function.`);
    }
    const name = String(test.name || '').trim();
    if (!name) throw new Error(`Test suite ${label} entry ${index + 1} must be a named function.`);
    return { test, name, filePath, label };
  });
}

function selectTestFiles(filePaths, filters = [], root = __dirname) {
  if (!filters.length) return filePaths;
  const selected = filePaths.filter(filePath => {
    const label = path.relative(root, filePath).replace(/\\/g, '/');
    return filters.some(filter => label === filter || label.startsWith(`${filter}/`));
  });
  if (!selected.length) throw new Error(`No tests matched: ${filters.join(', ')}`);
  return selected;
}

function validateTestRecords(records) {
  if (!records.length) throw new Error('No tests were discovered.');
  const names = new Map();
  for (const record of records) {
    const previous = names.get(record.name);
    if (previous) {
      throw new Error(`Duplicate test name ${record.name}: ${previous.label} and ${record.label}.`);
    }
    names.set(record.name, record);
  }
  return records;
}

function loadTests({ root = __dirname, directories = TEST_DIRECTORIES, filters = [] } = {}) {
  const filePaths = directories.flatMap(directory => discoverTestFiles(path.join(root, directory)));
  const records = selectTestFiles(filePaths, filters, root)
    .flatMap(filePath => normalizeSuite(require(filePath), filePath, root));
  return validateTestRecords(records);
}

function testFileFilters(argv = []) {
  return argv.map(value => {
    const filter = String(value || '').trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/^test\//, '').replace(/\/$/, '');
    if (!filter || filter.startsWith('-') || filter.split('/').includes('..')) {
      throw new Error(`Invalid test file filter: ${value}`);
    }
    return filter;
  });
}

function selectTestRecords(records, filters = []) {
  if (!filters.length) return records;
  const selected = records.filter(record => filters.some(filter => record.label === filter || record.label.startsWith(`${filter}/`)));
  if (!selected.length) throw new Error(`No tests matched: ${filters.join(', ')}`);
  return selected;
}

function testTimeoutMs(value = process.env.CHATUI_TEST_TIMEOUT_MS) {
  if (value == null || value === '') return DEFAULT_TEST_TIMEOUT_MS;
  const timeoutMs = Number(value);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error('CHATUI_TEST_TIMEOUT_MS must be a positive integer.');
  }
  return timeoutMs;
}

async function executeTest(record, timeoutMs = DEFAULT_TEST_TIMEOUT_MS) {
  let timeout;
  try {
    await Promise.race([
      Promise.resolve().then(() => record.test()),
      new Promise((_, reject) => {
        timeout = setTimeout(() => {
          reject(new Error(`Test timed out after ${timeoutMs}ms: ${record.label} > ${record.name}`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

async function run({ tests = loadTests(), timeoutMs = testTimeoutMs(), log = console.log } = {}) {
  for (const record of tests) {
    await executeTest(record, timeoutMs);
    log(`PASS ${record.label} > ${record.name}`);
  }
  log(`All ${tests.length} tests passed.`);
  return tests.length;
}

module.exports = {
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
};

if (require.main === module) {
  Promise.resolve().then(() => {
    const filters = testFileFilters(process.argv.slice(2));
    return run({ tests: loadTests({ filters }) });
  }).catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
