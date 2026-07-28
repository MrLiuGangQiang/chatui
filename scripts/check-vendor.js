#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_MANIFEST_PATH = path.join(ROOT, 'vendor', 'manifest.json');
const VENDOR_METADATA_FILES = new Set(['README.md', 'manifest.json']);

function fail(message) {
  throw new Error(`[vendor-check] ${message}`);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function relativePath(root, filePath) {
  return path.relative(root, filePath).replace(/\\/g, '/');
}

function resolveInside(root, relative, label) {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, String(relative || ''));
  if (resolved === resolvedRoot || !resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    fail(`${label} must stay inside ${relativePath(ROOT, resolvedRoot) || resolvedRoot}: ${relative}.`);
  }
  return resolved;
}

function listFiles(directory) {
  if (!fs.statSync(directory, { throwIfNoEntry: false })?.isDirectory()) {
    fail(`directory is missing: ${directory}.`);
  }
  const files = [];
  const queue = [directory];
  while (queue.length) {
    const current = queue.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) queue.push(entryPath);
      else if (entry.isFile()) files.push(entryPath);
    }
  }
  return files.sort((left, right) => left.localeCompare(right));
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function packageMetadata(packageJson, packageLock, entry) {
  const packageName = String(entry.package || '').trim();
  const version = String(entry.version || '').trim();
  const license = String(entry.license || '').trim();
  if (!packageName || !version || !license) fail('every manifest entry must declare package, version, and license.');
  const declared = packageJson.dependencies?.[packageName]
    || packageJson.devDependencies?.[packageName]
    || packageJson.optionalDependencies?.[packageName];
  if (!declared) fail(`${packageName}@${version} is not a direct package.json dependency.`);
  const installedVersion = packageLock.packages?.[`node_modules/${packageName}`]?.version;
  if (installedVersion !== version) {
    fail(`${packageName} manifest version ${version} does not match package-lock.json ${installedVersion || '(missing)'}.`);
  }
  return { packageName, version };
}

function assertExactFile(targetPath, sourcePath, targetLabel) {
  if (!fs.statSync(targetPath, { throwIfNoEntry: false })?.isFile()) fail(`asset is missing: ${targetLabel}.`);
  if (!fs.statSync(sourcePath, { throwIfNoEntry: false })?.isFile()) fail(`package source is missing for ${targetLabel}: ${sourcePath}.`);
  const target = fs.readFileSync(targetPath);
  const source = fs.readFileSync(sourcePath);
  if (!target.equals(source)) fail(`${targetLabel} differs from its locked package source.`);
}

function checkVendor({ root = ROOT, manifestPath = path.join(root, 'vendor', 'manifest.json') } = {}) {
  const manifest = readJson(manifestPath);
  if (manifest.schema_version !== 'chatui-vendor-manifest.v1') fail('unsupported or missing manifest schema_version.');
  if (!Array.isArray(manifest.assets) || !manifest.assets.length) fail('manifest must contain assets.');
  if (!Array.isArray(manifest.directories)) fail('manifest directories must be an array.');
  if (!Array.isArray(manifest.licenses) || !manifest.licenses.length) fail('manifest must contain license files.');

  const packageJson = readJson(path.join(root, 'package.json'));
  const packageLock = readJson(path.join(root, 'package-lock.json'));
  const vendorRoot = path.join(root, 'vendor');
  const accounted = new Set();
  const packages = new Set();
  const accountedLicenses = new Set();

  for (const entry of manifest.assets) {
    const { packageName } = packageMetadata(packageJson, packageLock, entry);
    packages.add(packageName);
    const targetPath = resolveInside(vendorRoot, path.relative('vendor', entry.target), 'asset target');
    const targetLabel = relativePath(root, targetPath);
    if (accounted.has(targetLabel)) fail(`duplicate manifest target: ${targetLabel}.`);
    accounted.add(targetLabel);

    if (entry.mode === 'exact') {
      const packageRoot = path.join(root, 'node_modules', packageName);
      const sourcePath = resolveInside(packageRoot, entry.source, 'package source');
      assertExactFile(targetPath, sourcePath, targetLabel);
    } else if (entry.mode === 'sha256') {
      if (!fs.statSync(targetPath, { throwIfNoEntry: false })?.isFile()) fail(`asset is missing: ${targetLabel}.`);
      const expected = String(entry.sha256 || '').toLowerCase();
      const actual = sha256(fs.readFileSync(targetPath));
      if (!/^[a-f0-9]{64}$/.test(expected) || actual !== expected) {
        fail(`${targetLabel} checksum does not match its reviewed browser build.`);
      }
    } else {
      fail(`${targetLabel} has unsupported verification mode: ${entry.mode}.`);
    }
  }

  for (const entry of manifest.directories) {
    const { packageName } = packageMetadata(packageJson, packageLock, entry);
    packages.add(packageName);
    if (entry.mode !== 'exact') fail(`${entry.target} has unsupported directory verification mode: ${entry.mode}.`);
    const targetDirectory = resolveInside(vendorRoot, path.relative('vendor', entry.target), 'directory target');
    const packageRoot = path.join(root, 'node_modules', packageName);
    const sourceDirectory = resolveInside(packageRoot, entry.source, 'package directory source');
    const targetFiles = listFiles(targetDirectory);
    const sourceFiles = listFiles(sourceDirectory);
    const targetNames = targetFiles.map(filePath => relativePath(targetDirectory, filePath));
    const sourceNames = sourceFiles.map(filePath => relativePath(sourceDirectory, filePath));
    if (JSON.stringify(targetNames) !== JSON.stringify(sourceNames)) {
      fail(`${entry.target} file set differs from ${packageName}/${entry.source}.`);
    }
    for (let index = 0; index < targetFiles.length; index += 1) {
      const targetLabel = relativePath(root, targetFiles[index]);
      assertExactFile(targetFiles[index], sourceFiles[index], targetLabel);
      if (accounted.has(targetLabel)) fail(`duplicate manifest target: ${targetLabel}.`);
      accounted.add(targetLabel);
    }
  }

  const licensedPackages = new Set();
  for (const entry of manifest.licenses) {
    const { packageName } = packageMetadata(packageJson, packageLock, entry);
    licensedPackages.add(packageName);
    const sources = Array.isArray(entry.sources) ? entry.sources : [];
    const targets = Array.isArray(entry.targets) ? entry.targets : [];
    if (!sources.length || sources.length !== targets.length) {
      fail(`${packageName} license sources and targets must be non-empty arrays of equal length.`);
    }
    const packageRoot = path.join(root, 'node_modules', packageName);
    for (let index = 0; index < sources.length; index += 1) {
      const sourcePath = resolveInside(packageRoot, sources[index], 'package license source');
      const targetPath = resolveInside(path.join(vendorRoot, 'licenses'), path.relative('vendor/licenses', targets[index]), 'license target');
      const targetLabel = relativePath(root, targetPath);
      assertExactFile(targetPath, sourcePath, targetLabel);
      if (accountedLicenses.has(targetLabel)) fail(`duplicate license target: ${targetLabel}.`);
      accountedLicenses.add(targetLabel);
    }
  }
  const missingLicenses = [...packages].filter(packageName => !licensedPackages.has(packageName));
  const unrelatedLicenses = [...licensedPackages].filter(packageName => !packages.has(packageName));
  if (missingLicenses.length || unrelatedLicenses.length) {
    fail(`license package set differs from runtime asset packages (missing: ${missingLicenses.join(', ') || 'none'}; unrelated: ${unrelatedLicenses.join(', ') || 'none'}).`);
  }
  const licenseFiles = listFiles(path.join(vendorRoot, 'licenses')).map(filePath => relativePath(root, filePath));
  const undeclaredLicenses = licenseFiles.filter(filePath => !accountedLicenses.has(filePath));
  if (undeclaredLicenses.length) fail(`license files are not declared in vendor/manifest.json: ${undeclaredLicenses.join(', ')}.`);
  const absentLicenses = [...accountedLicenses].filter(filePath => !licenseFiles.includes(filePath));
  if (absentLicenses.length) fail(`declared license files are missing: ${absentLicenses.join(', ')}.`);

  const runtimeAssets = listFiles(vendorRoot)
    .filter(filePath => {
      const vendorRelative = relativePath(vendorRoot, filePath);
      return !vendorRelative.startsWith('licenses/') && !VENDOR_METADATA_FILES.has(vendorRelative);
    })
    .map(filePath => relativePath(root, filePath));
  const unaccounted = runtimeAssets.filter(filePath => !accounted.has(filePath));
  if (unaccounted.length) fail(`runtime assets are not declared in vendor/manifest.json: ${unaccounted.join(', ')}.`);
  const missing = [...accounted].filter(filePath => !runtimeAssets.includes(filePath));
  if (missing.length) fail(`manifest entries are not runtime vendor assets: ${missing.join(', ')}.`);

  return { assets: runtimeAssets.length, packages: packages.size, licenses: licenseFiles.length };
}

if (require.main === module) {
  const result = checkVendor();
  console.log(`Vendor checks passed for ${result.assets} assets and ${result.licenses} license files from ${result.packages} locked packages.`);
}

module.exports = {
  ROOT,
  DEFAULT_MANIFEST_PATH,
  VENDOR_METADATA_FILES,
  listFiles,
  sha256,
  checkVendor,
};
