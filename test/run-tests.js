'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');

const TEST_DIRECTORIES = Object.freeze(['unit', 'smoke']);
const DEFAULT_TIMEOUT_MS = 10_000;
// Internal protocol between the parallel parent and its serial child shards.
const SHARD_SUMMARY_PREFIX = '__CHATUI_TEST_SUMMARY__';
const FINAL_SUMMARY_LINE = /^All \d+ tests across \d+ files passed in \d+ ms\.$/;
const AUTO_PARALLEL_MIN_FILES = 8;
const MAX_AUTO_JOBS = 6;
const RUNNER_GLOBAL = globalThis;
const RunnerMap = Map;
const RunnerSet = Set;
const RunnerTypeError = TypeError;
const reflectOwnKeys = Reflect.ownKeys;
const getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const defineProperty = Object.defineProperty;
const stringifyKey = String;

// Node installs undici's global dispatcher as non-configurable symbol properties
// the first time its web APIs are read. Install that runtime-owned state before
// per-test snapshots so every later non-configurable addition is a real leak.
for (const key of ['fetch', 'Headers', 'Request', 'Response', 'FormData', 'WebSocket', 'EventSource']) {
  try { void RUNNER_GLOBAL[key]; } catch {}
}

function normalizePath(value) {
  return String(value || '').replace(/\\/g, '/').replace(/^\.\//, '');
}

function collectTestFiles(directory) {
  if (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) return [];
  return fs.readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap(entry => {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) return collectTestFiles(entryPath);
      return entry.isFile() && entry.name.endsWith('.test.js') ? [entryPath] : [];
    });
}

function discoverTestFiles({ testRoot = __dirname, filters = [] } = {}) {
  const files = TEST_DIRECTORIES.flatMap(directory => collectTestFiles(path.join(testRoot, directory)));

  const normalizedFilters = filters.map(normalizePath).filter(Boolean);
  if (!normalizedFilters.length) return files;
  return files.filter(file => {
    const relative = normalizePath(path.relative(testRoot, file));
    const withRoot = `test/${relative}`;
    return normalizedFilters.some(filter => {
      const normalized = filter.replace(/^test\//, '').replace(/\.js$/, '');
      return relative === filter
        || withRoot === filter
        || relative.replace(/\.js$/, '') === normalized
        || withRoot.replace(/\.js$/, '') === normalized
        || relative.includes(normalized);
    });
  });
}

function maskCommentsAndStrings(source = '') {
  const input = String(source);
  let output = '';
  let state = 'code';
  let regexClass = false;
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    const next = input[index + 1];
    if (state === 'code') {
      if (char === '/' && next === '/') {
        output += '  ';
        index += 1;
        state = 'line-comment';
      } else if (char === '/' && next === '*') {
        output += '  ';
        index += 1;
        state = 'block-comment';
      } else if (char === '/') {
        output += ' ';
        regexClass = false;
        state = 'regex';
      } else if (char === "'" || char === '"' || char === '`') {
        output += ' ';
        state = char === "'" ? 'single-quote' : char === '"' ? 'double-quote' : 'template';
      } else output += char;
      continue;
    }
    if (state === 'line-comment') {
      if (char === '\n' || char === '\r') {
        output += char;
        state = 'code';
      } else output += ' ';
      continue;
    }
    if (state === 'block-comment') {
      if (char === '*' && next === '/') {
        output += '  ';
        index += 1;
        state = 'code';
      } else output += char === '\n' || char === '\r' ? char : ' ';
      continue;
    }
    if (state === 'regex') {
      if (char === '\n' || char === '\r') {
        output += char;
        state = 'code';
      } else if (char === '\\') {
        output += ' ';
        if (index + 1 < input.length) {
          index += 1;
          output += input[index] === '\n' || input[index] === '\r' ? input[index] : ' ';
        }
      } else {
        output += ' ';
        if (char === '[') regexClass = true;
        else if (char === ']') regexClass = false;
        else if (char === '/' && !regexClass) state = 'code';
      }
      continue;
    }
    if (char === '\\') {
      output += ' ';
      if (index + 1 < input.length) {
        index += 1;
        output += input[index] === '\n' || input[index] === '\r' ? input[index] : ' ';
      }
    } else if (
      (state === 'single-quote' && char === "'")
      || (state === 'double-quote' && char === '"')
      || (state === 'template' && char === '`')
    ) {
      output += ' ';
      state = 'code';
    } else output += char === '\n' || char === '\r' ? char : ' ';
  }
  return output;
}

function declaredTestNames(source = '') {
  const code = maskCommentsAndStrings(source);
  const matches = [];
  for (const match of code.matchAll(/^(?:async\s+)?function\s*\*?\s*(test[A-Za-z0-9_$]+)\s*\(/gm)) {
    matches.push({ index: match.index, name: match[1] });
  }
  const assignedFunction = /^(?:const|let|var)\s+(test[A-Za-z0-9_$]+)\s*=\s*(?:async\s+)?(?:function\s*\*?(?:\s+[A-Za-z_$][A-Za-z0-9_$]*)?\s*\(|(?:\([^;\n]*\)|[A-Za-z_$][A-Za-z0-9_$]*)\s*=>)/gm;
  for (const match of code.matchAll(assignedFunction)) matches.push({ index: match.index, name: match[1] });
  return matches.sort((left, right) => left.index - right.index).map(match => match.name);
}

function validateDeclaredTestExports(source, suite, relativeFile) {
  const exported = new Set(suite.map(test => typeof test === 'function' ? test.name : ''));
  const omitted = declaredTestNames(source).filter(name => !exported.has(name));
  if (omitted.length) {
    throw new Error(`Test suite ${relativeFile} declares tests that are not exported: ${omitted.join(', ')}.`);
  }
}

function loadTestFiles(files, { testRoot = __dirname } = {}) {
  const records = [];
  for (const file of files) {
    const suite = require(file);
    const relativeFile = normalizePath(path.relative(testRoot, file));
    if (!Array.isArray(suite)) throw new Error(`Test suite ${relativeFile} must export an array.`);
    if (!suite.length) throw new Error(`Test suite ${relativeFile} must export at least one test.`);
    validateDeclaredTestExports(fs.readFileSync(file, 'utf8'), suite, relativeFile);
    suite.forEach((test, index) => {
      if (typeof test !== 'function') throw new Error(`Test suite ${relativeFile} entry ${index + 1} must be a function.`);
      if (!test.name) throw new Error(`Test suite ${relativeFile} entry ${index + 1} must use a named function.`);
      records.push({ file, relativeFile, test });
    });
  }
  return records;
}

function validateUniqueTestNames(records) {
  const owners = new Map();
  for (const record of records) {
    const previous = owners.get(record.test.name);
    if (previous) {
      throw new Error(`Duplicate test name ${record.test.name}: ${previous} and ${record.relativeFile}.`);
    }
    owners.set(record.test.name, record.relativeFile);
  }
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parseCliArgs(argv = process.argv.slice(2), env = process.env) {
  const options = {
    filters: [],
    list: false,
    help: false,
    timeoutMs: positiveInteger(env.CHATUI_TEST_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
    jobs: positiveInteger(env.CHATUI_TEST_JOBS, 0) || null,
    shardSummary: false,
  };
  for (const argument of argv) {
    if (argument === '--list') options.list = true;
    else if (argument === '--serial') options.jobs = 1;
    else if (argument === '--shard-summary') options.shardSummary = true;
    else if (argument.startsWith('--jobs=')) {
      const raw = argument.slice('--jobs='.length);
      const jobs = positiveInteger(raw, 0);
      if (!jobs) throw new Error(`Invalid shard count: ${raw}. Expected a positive integer.`);
      options.jobs = jobs;
    }
    else if (argument === '--help' || argument === '-h') options.help = true;
    else if (argument.startsWith('--timeout=')) {
      const raw = argument.slice('--timeout='.length);
      const timeoutMs = positiveInteger(raw, 0);
      if (!timeoutMs) throw new Error(`Invalid test timeout: ${raw}. Expected a positive integer in milliseconds.`);
      options.timeoutMs = timeoutMs;
    } else if (argument.startsWith('-')) {
      throw new Error(`Unknown test option: ${argument}`);
    } else options.filters.push(argument);
  }
  return options;
}

function withTimeout(test, timeoutMs, label) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Test timed out after ${timeoutMs} ms: ${label}`)), timeoutMs);
  });
  return Promise.race([Promise.resolve().then(test), timeout]).finally(() => clearTimeout(timer));
}

function snapshotGlobalState(target = RUNNER_GLOBAL) {
  return new RunnerMap(reflectOwnKeys(target).map(key => [key, getOwnPropertyDescriptor(target, key)]));
}

function descriptorsMatch(left, right) {
  if (!left || !right) return left === right;
  return left.configurable === right.configurable
    && left.enumerable === right.enumerable
    && left.writable === right.writable
    && left.value === right.value
    && left.get === right.get
    && left.set === right.set;
}

function restoreGlobalState(snapshot, target = RUNNER_GLOBAL) {
  if (!(snapshot instanceof RunnerMap)) throw new RunnerTypeError('Global state snapshot must be a Map.');
  const restored = [];
  const failures = [];
  const originalKeys = new RunnerSet(snapshot.keys());

  for (const key of reflectOwnKeys(target)) {
    if (originalKeys.has(key)) continue;
    const descriptor = getOwnPropertyDescriptor(target, key);
    if (descriptor?.configurable && delete target[key]) restored.push(stringifyKey(key));
    else failures.push(`cannot remove ${stringifyKey(key)}`);
  }

  for (const [key, descriptor] of snapshot) {
    const current = getOwnPropertyDescriptor(target, key);
    if (descriptorsMatch(current, descriptor)) continue;
    try {
      defineProperty(target, key, descriptor);
      restored.push(stringifyKey(key));
    } catch (error) {
      failures.push(`cannot restore ${String(key)}: ${error?.message || error}`);
    }
  }

  if (failures.length) throw new Error(`Failed to restore test global state: ${failures.join('; ')}.`);
  return restored;
}

async function runIsolatedTest(test, timeoutMs, label) {
  const target = RUNNER_GLOBAL;
  const globalSnapshot = snapshotGlobalState(target);
  let testError = null;
  try {
    await withTimeout(test, timeoutMs, label);
  } catch (error) {
    testError = error;
  }

  let cleanupError = null;
  try {
    restoreGlobalState(globalSnapshot, target);
  } catch (error) {
    cleanupError = error;
  }

  if (testError && cleanupError) {
    throw new AggregateError([testError, cleanupError], `${label} failed and global cleanup also failed.`);
  }
  if (testError) throw testError;
  if (cleanupError) throw cleanupError;
}

async function runTests(records, { timeoutMs = DEFAULT_TIMEOUT_MS, log = console.log } = {}) {
  validateUniqueTestNames(records);
  const startedAt = Date.now();
  const suiteSizes = records.reduce((sizes, record) => sizes.set(record.relativeFile, (sizes.get(record.relativeFile) || 0) + 1), new Map());
  let currentFile = '';
  for (const record of records) {
    if (record.relativeFile !== currentFile) {
      currentFile = record.relativeFile;
      log(`SUITE ${currentFile} (${suiteSizes.get(currentFile)})`);
    }
    const testStartedAt = Date.now();
    await runIsolatedTest(record.test, timeoutMs, `${record.relativeFile} > ${record.test.name}`);
    log(`PASS ${record.test.name} (${Date.now() - testStartedAt} ms)`);
  }
  const fileCount = new Set(records.map(record => record.relativeFile)).size;
  const durationMs = Date.now() - startedAt;
  log(`All ${records.length} tests across ${fileCount} files passed in ${durationMs} ms.`);
  return { tests: records.length, files: fileCount, durationMs };
}

function resolveJobCount(options, fileCount) {
  if (options.jobs != null) return Math.max(1, Math.min(options.jobs, fileCount));
  if (fileCount < AUTO_PARALLEL_MIN_FILES) return 1;
  const cores = os.availableParallelism ? os.availableParallelism() : os.cpus().length;
  return Math.max(1, Math.min(cores, MAX_AUTO_JOBS, fileCount));
}

// Focused runs stay serial (process startup dominates); the full gate spreads
// suites over shard processes, heaviest files first so jsdom suites separate.
function shardFiles(files, shardCount) {
  const count = Math.max(1, Math.min(shardCount, files.length));
  const shards = Array.from({ length: count }, () => []);
  files
    .map(file => ({ file, size: fs.statSync(file).size }))
    .sort((left, right) => right.size - left.size || normalizePath(left.file).localeCompare(normalizePath(right.file)))
    .forEach((entry, index) => shards[index % count].push(entry.file));
  return shards;
}

function spawnShard(shard, index, options, log) {
  const tag = `shard-${index + 1}`;
  const args = [__filename, '--serial', '--shard-summary'];
  if (options.timeoutMs) args.push(`--timeout=${options.timeoutMs}`);
  // Discovery only returns files under this directory, so filters stay repo-relative.
  const child = spawn(process.execPath, args.concat(shard.map(f => normalizePath(path.relative(__dirname, f)))), { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let summary = null;
  readline.createInterface({ input: child.stdout }).on('line', line => {
    if (!line) return;
    if (line.startsWith(SHARD_SUMMARY_PREFIX)) {
      summary = JSON.parse(line.slice(SHARD_SUMMARY_PREFIX.length));
      return;
    }
    log(`[${tag}] ${line}`);
  });
  readline.createInterface({ input: child.stderr }).on('line', line => {
    if (line) console.error(`[${tag}] ${line}`);
  });
  return new Promise((resolveShard, rejectShard) => {
    child.on('error', rejectShard);
    child.on('close', code => resolveShard({ tag, code, summary }));
  });
}

async function runSharded(files, options, { log = console.log } = {}) {
  const startedAt = Date.now();
  const shards = shardFiles(files, resolveJobCount(options, files.length));
  const results = await Promise.all(shards.map((shard, index) => spawnShard(shard, index, options, log)));
  const failed = results.filter(result => result.code !== 0 || !result.summary);
  if (failed.length) {
    throw new Error(`Test ${failed.map(f => `${f.tag} (exit ${f.code})`).join(', ')} failed; see the tagged [shard-*] output above.`);
  }
  // Cross-shard name uniqueness can only be checked once every shard reported.
  const owners = new Map();
  for (const result of results) {
    for (const [name, file] of result.summary.names) {
      const previous = owners.get(name);
      if (previous && previous !== file) throw new Error(`Duplicate test name ${name}: ${previous} and ${file}.`);
      owners.set(name, file);
    }
  }
  const totalTests = results.reduce((sum, result) => sum + result.summary.tests, 0);
  const durationMs = Date.now() - startedAt;
  log(`All ${totalTests} tests across ${files.length} files passed in ${durationMs} ms (${shards.length} parallel shards).`);
  return { tests: totalTests, files: files.length, durationMs };
}

function usage() {
  return [
    'Usage: node test/run-tests.js [test-file-or-name ...] [options]',
    '',
    'Options:',
    '  --list              List selected test files without running them',
    '  --timeout=<ms>      Per-test timeout (default: 10000)',
    '  --jobs=<n>          Run suites across n parallel shard processes',
    '  --serial            Force single-process serial execution',
    '  -h, --help          Show this help',
  ].join('\n');
}

async function main(argv = process.argv.slice(2)) {
  const options = parseCliArgs(argv);
  if (options.help) {
    console.log(usage());
    return;
  }
  const files = discoverTestFiles({ filters: options.filters });
  if (!files.length) throw new Error(`No test files matched: ${options.filters.join(', ') || '(all tests)'}.`);
  if (options.list) {
    files.forEach(file => console.log(normalizePath(path.relative(__dirname, file))));
    return;
  }
  const jobs = options.shardSummary ? 1 : resolveJobCount(options, files.length);
  if (jobs > 1) {
    await runSharded(files, { ...options, jobs });
    return;
  }
  const records = loadTestFiles(files);
  if (options.shardSummary) {
    const stats = await runTests(records, {
      timeoutMs: options.timeoutMs,
      log: line => { if (!FINAL_SUMMARY_LINE.test(line)) console.log(line); },
    });
    console.log(SHARD_SUMMARY_PREFIX + JSON.stringify({
      ...stats,
      names: records.map(record => [record.test.name, record.relativeFile]),
    }));
    return;
  }
  await runTests(records, options);
}

module.exports = {
  TEST_DIRECTORIES,
  DEFAULT_TIMEOUT_MS,
  SHARD_SUMMARY_PREFIX,
  FINAL_SUMMARY_LINE,
  AUTO_PARALLEL_MIN_FILES,
  MAX_AUTO_JOBS,
  normalizePath,
  resolveJobCount,
  shardFiles,
  runSharded,
  discoverTestFiles,
  declaredTestNames,
  validateDeclaredTestExports,
  loadTestFiles,
  validateUniqueTestNames,
  parseCliArgs,
  withTimeout,
  snapshotGlobalState,
  restoreGlobalState,
  runIsolatedTest,
  runTests,
  usage,
  main,
};

if (require.main === module) {
  main().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
