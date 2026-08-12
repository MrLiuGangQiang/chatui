'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  computeRuntimeSourceRevision,
  createBuildIdentity,
  isDockerRuntimeFile,
  runtimeSourceFiles,
} = require('../../server/build-identity');

function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chatui-runtime-identity-'));
  fs.mkdirSync(path.join(root, 'server'), { recursive: true });
  fs.mkdirSync(path.join(root, 'client'), { recursive: true });
  fs.mkdirSync(path.join(root, 'vendor', 'chunks'), { recursive: true });
  fs.writeFileSync(path.join(root, 'version.json'), '{"version":"1.2.3"}');
  fs.writeFileSync(path.join(root, 'package.json'), '{"version":"1.2.3"}');
  fs.writeFileSync(path.join(root, 'server.js'), 'require("./server/app")');
  fs.writeFileSync(path.join(root, 'server', 'app.js'), 'module.exports = 1;');
  fs.writeFileSync(path.join(root, 'client', 'app.js'), 'window.ChatUI = {};\n');
  return root;
}

function testRuntimeSourceRevisionTracksExactlyDockerRuntimeCode() {
  const root = makeFixture();
  try {
    const before = computeRuntimeSourceRevision(root);
    assert.match(before, /^sha256:[a-f0-9]{64}$/);
    assert.deepStrictEqual(runtimeSourceFiles(root), ['client/app.js', 'package.json', 'server.js', 'server/app.js', 'version.json']);

    fs.writeFileSync(path.join(root, 'vendor', 'chunks', 'ignored.js'), 'ignored');
    fs.writeFileSync(path.join(root, 'client', 'notes.md'), 'ignored');
    fs.mkdirSync(path.join(root, 'docs', 'announcements'), { recursive: true });
    fs.writeFileSync(path.join(root, 'docs', 'announcements', 'v1.0.0.md'), '# Notice\n');
    const withAnnouncement = computeRuntimeSourceRevision(root);
    assert.notStrictEqual(withAnnouncement, before, 'versioned announcements are part of the Docker runtime identity');
    assert.strictEqual(isDockerRuntimeFile('docs/announcements/v1.0.0.md'), true);
    assert.strictEqual(isDockerRuntimeFile('docs/releases/v1.10.20.md'), false);
    assert.strictEqual(computeRuntimeSourceRevision(root), withAnnouncement, 'Docker-excluded files must not change runtime identity');

    fs.writeFileSync(path.join(root, 'client', 'app.js'), 'window.ChatUI = {};\r\n');
    assert.strictEqual(computeRuntimeSourceRevision(root), withAnnouncement, 'platform line endings must not make identical source look like a different image');

    fs.writeFileSync(path.join(root, 'client', 'app.js'), 'window.ChatUI = { fixed: true };');
    assert.notStrictEqual(computeRuntimeSourceRevision(root), withAnnouncement, 'a browser runtime change must change image identity');
    assert.strictEqual(isDockerRuntimeFile('vendor/chunks/a.js'), false);
    assert.strictEqual(isDockerRuntimeFile('client/app.js'), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function testInjectedImageIdentityFailsClosedOnSourceMismatch() {
  const root = makeFixture();
  try {
    const sourceRevision = computeRuntimeSourceRevision(root);
    const identity = createBuildIdentity({
      root,
      version: '1.2.3',
      env: { CHATUI_BUILD_SHA: 'abc123', CHATUI_SOURCE_REVISION: sourceRevision },
    });
    assert.deepStrictEqual(identity, {
      version: '1.2.3', gitSha: 'abc123', sourceRevision, dirty: false, mode: 'image',
    });
    assert.throws(() => createBuildIdentity({
      root,
      version: '1.2.3',
      env: { CHATUI_BUILD_SHA: 'abc123', CHATUI_SOURCE_REVISION: 'sha256:wrong' },
    }), /runtime source mismatch/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function testReleaseWorkflowsVerifyThenPromoteOneDigest() {
  const root = path.resolve(__dirname, '../..');
  const dockerfile = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8');
  const ci = fs.readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8');
  const release = fs.readFileSync(path.join(root, '.github/workflows/release.yml'), 'utf8');
  const preview = fs.readFileSync(path.join(root, 'scripts/preview-release.js'), 'utf8');
  const serverConfig = fs.readFileSync(path.join(root, 'server/config/index.js'), 'utf8');

  assert.match(dockerfile, /CHATUI_SOURCE_REVISION=\$\{CHATUI_SOURCE_REVISION\}/);
  assert.match(dockerfile, /COPY version\.json package\.json package-lock\.json \.\//,
    'Docker runtime must package the canonical version source');
  assert.match(dockerfile, /org\.opencontainers\.image\.revision/);
  assert.match(ci, /Verify exact container identity and assets/);
  assert.ok(ci.includes(`VERSION="$(node -p "require('./scripts/version-source').readVersion()")"`),
    'CI must resolve a non-empty canonical version without reading package.json');
  assert.ok(ci.includes('test -n "$VERSION"'),
    'CI must fail before building when the candidate version is empty');
  assert.ok(!ci.includes("require('./package.json')"),
    'CI must not use package.json as the canonical version source');
  assert.match(ci, /CHATUI_SOURCE_REVISION=\$\{\{ steps\.identity\.outputs\.source_revision \}\}/);
  assert.match(serverConfig, /require\('\.\.\/version-source'\)/);
  assert.ok(!serverConfig.includes("require('../../package.json')"),
    'server runtime must not use package.json as the canonical version source');
  assert.ok(release.includes(`SOURCE_VERSION="$(node -p "require('./scripts/version-source').readVersion()")"`),
    'release must resolve the canonical version without reading package.json');
  assert.ok(release.includes('test "$SOURCE_VERSION" ='),
    'release must reject a version source that disagrees with the tag');
  assert.ok(!release.includes("require('./package.json')"),
    'release must not use package.json as the canonical version source');
  assert.match(release, /Build and push immutable ACR candidate/);
  assert.match(release, /platforms: linux\/amd64/);
  assert.ok(!release.includes('linux/arm64'), 'release workflow must stay single-platform');
  assert.match(release, /provenance: false/,
    'ACR candidate pushes must disable unsupported BuildKit provenance attestations');
  assert.match(release, /sbom: false/,
    'ACR candidate pushes must disable unsupported BuildKit SBOM attestations');
  assert.match(release, /Verify the exact ACR candidate digest/);
  assert.match(release, /Promote the verified ACR digest without rebuilding/);
  assert.match(release, /--prefer-index=false/,
    'single-platform ACR promotion must preserve the verified candidate manifest digest');
  assert.match(release, /for tag in \"\$\{SEMVER\}\" \"\$\{VERSION\}\" \"latest\"/,
    'release tags must be promoted one at a time to avoid synthesized OCI indexes');
  assert.ok(release.indexOf('Verify the exact ACR candidate digest') < release.indexOf('Promote the verified ACR digest without rebuilding'),
    'ACR candidate verification must happen before promotion');
  assert.match(release, /Mirror verified image to Docker Hub/);
  assert.match(release, /Copy the verified ACR digest to Docker Hub without rebuilding/);
  assert.match(release, /imagetools create/);
  assert.match(release, /verify_digest\(\)/);
  assert.match(release, /for attempt in \$\(seq 1 12\)/);
  assert.ok(release.includes(`$1 == "Digest:" && $2 == expected`),
    'registry verification must parse the aligned digest field instead of assuming one space');
  assert.ok(!release.includes('imagetools inspect "$ref" | grep'),
    'registry verification must tolerate bounded propagation delay after promotion');
  assert.match(release, /verify-release-ref\.js/);
  assert.match(preview, /release preview requires a clean committed worktree/);
}

module.exports = [
  testRuntimeSourceRevisionTracksExactlyDockerRuntimeCode,
  testInjectedImageIdentityFailsClosedOnSourceMismatch,
  testReleaseWorkflowsVerifyThenPromoteOneDigest,
];
