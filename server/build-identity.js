'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const RUNTIME_ROOT_FILES = Object.freeze([
  'package.json',
  'package-lock.json',
  'server.js',
  'index.html',
  'route.html',
  'app.js',
  'styles.css',
  'favicon.svg',
]);
const RUNTIME_ROOT_DIRECTORIES = Object.freeze([
  'config',
  'styles',
  'client',
  'server',
  'shared',
  'vendor',
]);

function normalizedRelativePath(root, filePath) {
  return path.relative(root, filePath).split(path.sep).join('/');
}

function isDockerRuntimeFile(relativePath) {
  const normalized = String(relativePath || '').replace(/\\/g, '/').replace(/^\.\//, '');
  const base = path.posix.basename(normalized);
  if (!normalized || normalized === 'vendor/chunks' || normalized.startsWith('vendor/chunks/')) return false;
  if (base === '.env' || base.startsWith('.env.') || base.endsWith('.local') || base.endsWith('.md')) return false;
  return true;
}

function collectDirectoryFiles(root, directory, files) {
  const absolute = path.join(root, directory);
  if (!fs.existsSync(absolute)) return;
  for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
    const entryPath = path.join(absolute, entry.name);
    const relativePath = normalizedRelativePath(root, entryPath);
    if (!isDockerRuntimeFile(relativePath)) continue;
    if (entry.isDirectory()) collectDirectoryFiles(root, relativePath, files);
    else if (entry.isFile()) files.push(relativePath);
  }
}

function runtimeSourceFiles(root) {
  const resolvedRoot = path.resolve(root);
  const files = RUNTIME_ROOT_FILES.filter(relativePath => (
    isDockerRuntimeFile(relativePath) && fs.existsSync(path.join(resolvedRoot, relativePath))
  ));
  for (const directory of RUNTIME_ROOT_DIRECTORIES) collectDirectoryFiles(resolvedRoot, directory, files);
  return [...new Set(files)].sort();
}

function runtimeFileContent(relativePath, content) {
  const extension = path.posix.extname(String(relativePath || '')).toLowerCase();
  if (!['.js', '.cjs', '.mjs', '.json', '.html', '.css', '.svg', '.txt', '.xml'].includes(extension)) return content;
  return Buffer.from(String(content).replace(/\r\n?/g, '\n'), 'utf8');
}

function computeRuntimeSourceRevision(root) {
  const resolvedRoot = path.resolve(root);
  const hash = crypto.createHash('sha256');
  for (const relativePath of runtimeSourceFiles(resolvedRoot)) {
    const content = runtimeFileContent(relativePath, fs.readFileSync(path.join(resolvedRoot, relativePath)));
    hash.update(relativePath);
    hash.update('\0');
    hash.update(String(content.length));
    hash.update('\0');
    hash.update(content);
    hash.update('\0');
  }
  return `sha256:${hash.digest('hex')}`;
}

function gitOutput(root, args) {
  try {
    return String(execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }) || '').trim();
  } catch {
    return '';
  }
}

function localGitIdentity(root) {
  const gitSha = gitOutput(root, ['rev-parse', 'HEAD']);
  if (!gitSha) return { gitSha: 'unknown', dirty: false };
  const status = gitOutput(root, ['status', '--porcelain', '--untracked-files=all']);
  return { gitSha, dirty: !!status };
}

function createBuildIdentity({ root, version, env = process.env } = {}) {
  const sourceRevision = computeRuntimeSourceRevision(root);
  const expectedSourceRevision = String(env.CHATUI_SOURCE_REVISION || '').trim();
  if (expectedSourceRevision && expectedSourceRevision !== sourceRevision) {
    throw new Error(`[build-identity] runtime source mismatch: expected ${expectedSourceRevision}, found ${sourceRevision}`);
  }
  const injectedGitSha = String(env.CHATUI_BUILD_SHA || '').trim();
  const local = injectedGitSha ? null : localGitIdentity(root);
  const gitSha = injectedGitSha || local?.gitSha || 'unknown';
  const dirty = injectedGitSha ? String(env.CHATUI_BUILD_DIRTY || '') === '1' : !!local?.dirty;
  return Object.freeze({
    version: String(version || '0.0.0'),
    gitSha,
    sourceRevision,
    dirty,
    mode: injectedGitSha ? 'image' : 'workspace',
  });
}

module.exports = {
  RUNTIME_ROOT_FILES,
  RUNTIME_ROOT_DIRECTORIES,
  isDockerRuntimeFile,
  runtimeSourceFiles,
  runtimeFileContent,
  computeRuntimeSourceRevision,
  localGitIdentity,
  createBuildIdentity,
};
