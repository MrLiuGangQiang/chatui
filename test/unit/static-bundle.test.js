const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const staticBundle = require('../../server/services/static-bundle.service');
const staticHttp = require('../../server/http/static');
const staticPathUtils = require('../../server/http/static-path-utils');

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

function testStaticPathUtilitiesPreserveTraversalAndHashingGuards() {
  const root = path.join(os.tmpdir(), 'chatui-static-root');
  const rootWithSep = `${root}${path.sep}`;
  assert.strictEqual(staticPathUtils.safeJoin(root, rootWithSep, '/client/app.js?v=1'), path.join(root, 'client/app.js'));
  assert.strictEqual(staticPathUtils.safeJoin(root, rootWithSep, '/%2e%2e/secret.txt'), null);
  assert.strictEqual(staticPathUtils.safeJoin(root, rootWithSep, '/%E0%A4%A'), null, 'malformed encoded paths must fail closed');
  assert.strictEqual(staticPathUtils.sha1('abc'), 'a9993e364706816aba3e25717850c26c9cd0d89d');
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

function testFileInputContractLoadsBeforeItsBrowserConsumers() {
  const root = path.join(__dirname, '../..');
  const entries = staticBundle.parseAssetManifest(root, `${root}${path.sep}`, 'js');
  const paths = entries.map(entry => entry.urlPath);
  const registryIndex = paths.indexOf('/client/runtime/module-registry.js');
  const responsesOutputIndex = paths.indexOf('/shared/responses-output.js');
  const textHashIndex = paths.indexOf('/client/core/text-hash.js');
  const coreIndex = paths.indexOf('/client/core/browser.js');
  const imageExecutionIndex = paths.indexOf('/client/core/image-execution.js');
  const taskContinuityIndex = paths.indexOf('/shared/task-continuity.js');
  const imageRouteContextIndex = paths.indexOf('/client/core/image-route-context.js');
  const attachmentsIndex = paths.indexOf('/client/core/attachments.js');
  const imageGenerationServiceIndex = paths.indexOf('/client/services/image-generation-service.js');
  const messagePrimitivesIndex = paths.indexOf('/client/core/message-primitives.js');
  const submitHelpersIndex = paths.indexOf('/client/app/submit-workflow.helpers.js');
  const routeServiceIndex = paths.indexOf('/client/services/route-service.js');
  const sharedPlanIndex = paths.indexOf('/shared/dispatch-contract.js');
  const imagePlanIndex = paths.indexOf('/shared/image-plan.js');
  const imageInstructionIndex = paths.indexOf('/shared/image-instruction.js');
  const capabilityRegistryIndex = paths.indexOf('/shared/capability-registry.js');
  const routeIntentIndex = paths.indexOf('/shared/route-intent.js');
  const resourceIdentityIndex = paths.indexOf('/client/core/resource-identity.js');
  const routeCandidatesIndex = paths.indexOf('/client/services/route-candidates.js');
  const routeMemoryRetrievalIndex = paths.indexOf('/client/services/route-memory-retrieval.js');
  const routePromptsIndex = paths.indexOf('/client/services/route-prompts.js');
  const routeSemanticNormalizerIndex = paths.indexOf('/client/services/route-semantic-normalizer.js');
  const routeResourceBindingIndex = paths.indexOf('/client/services/route-resource-binding.js');
  const routeImagePlanCompilerIndex = paths.indexOf('/client/services/route-image-plan-compiler.js');
  const sessionRecoveryIndex = paths.indexOf('/client/services/session-snapshot-recovery.js');
  const sessionDisplayIndex = paths.indexOf('/client/app/session-display.js');
  const submitPolicyIndex = paths.indexOf('/client/app/submit-workflow-policy.js');
  const executionStatusIndex = paths.indexOf('/client/app/execution-status.js');
  const formattingIndex = paths.indexOf('/client/app/formatting.js');
  const submitWorkflowIndex = paths.indexOf('/client/app/submit-workflow.js');
  const contractIndex = paths.indexOf('/shared/file-inputs.js');
  const chatServiceIndex = paths.indexOf('/client/services/chat-service.js');
  const workflowIndex = paths.indexOf('/client/app/attachments-workflow.js');

  assert.ok(registryIndex >= 0 && registryIndex < textHashIndex, 'the hidden module registry must load before registered browser modules');
  assert.ok(responsesOutputIndex >= 0 && registryIndex < responsesOutputIndex && responsesOutputIndex < routeServiceIndex,
    'the shared Responses output interpreter must register before route transport parsing');
  assert.ok(textHashIndex >= 0 && textHashIndex < coreIndex, 'shared text hashing must load before performance/render consumers');
  assert.ok(coreIndex >= 0 && contractIndex > coreIndex, 'the shared file-input contract must register after ChatUICore exists');
  assert.ok(imageExecutionIndex >= 0 && imageExecutionIndex < paths.indexOf('/client/app/image-workflow.js'), 'image execution policy must load before image workflow');
  assert.ok(taskContinuityIndex >= 0 && taskContinuityIndex < imageRouteContextIndex,
    'task continuity must register before browser route-context restoration captures the module');
  assert.ok(taskContinuityIndex < attachmentsIndex,
    'task continuity must register before shared image-context storage validation');
  assert.ok(taskContinuityIndex < imageGenerationServiceIndex && taskContinuityIndex < routeServiceIndex,
    'task continuity must register before image generation and route compilation consumers');
  assert.ok(messagePrimitivesIndex >= 0 && messagePrimitivesIndex < submitHelpersIndex, 'shared message primitives must load before submit workflow helpers');
  assert.ok(sharedPlanIndex >= 0 && sharedPlanIndex < routeServiceIndex, 'the shared dispatch-contract contract must load before route service composition');
  assert.ok(capabilityRegistryIndex >= 0 && capabilityRegistryIndex < routeIntentIndex, 'the capability registry must load before the route-intent protocol');
  assert.ok(routeIntentIndex >= 0 && routeIntentIndex < sharedPlanIndex, 'the route-intent protocol must load before the final dispatch-contract contract');
  assert.ok(imagePlanIndex >= 0 && imagePlanIndex < routeServiceIndex, 'the image-plan protocol must load before route service composition');
  assert.ok(imageInstructionIndex >= 0 && imageInstructionIndex < routeServiceIndex,
    'the image-instruction protocol must load before route service composition');
  assert.ok(routeIntentIndex < routeServiceIndex, 'the route-intent protocol must load before route service composition');
  assert.ok(resourceIdentityIndex >= 0 && resourceIdentityIndex < routeServiceIndex, 'resource identity must load before route service composition');
  assert.ok(routeCandidatesIndex >= 0 && routeCandidatesIndex < routeServiceIndex, 'route candidates must load before route service composition');
  assert.ok(routeMemoryRetrievalIndex >= 0 && routeMemoryRetrievalIndex < routeServiceIndex, 'route memory retrieval must load before route service composition');
  assert.ok(routePromptsIndex >= 0 && routePromptsIndex < routeServiceIndex, 'route prompts must load before route service composition');
  assert.ok(routeSemanticNormalizerIndex >= 0 && routeSemanticNormalizerIndex < routeServiceIndex, 'route semantic normalizer must load before route service composition');
  assert.ok(routeResourceBindingIndex >= 0 && routeResourceBindingIndex < routeServiceIndex, 'route resource binding must load before route service composition');
  assert.ok(routeImagePlanCompilerIndex >= 0 && routeResourceBindingIndex < routeImagePlanCompilerIndex && routeImagePlanCompilerIndex < routeServiceIndex,
    'route image-plan compiler must load after resource binding and before route service composition');
  assert.ok(sessionRecoveryIndex >= 0 && sessionRecoveryIndex < sessionDisplayIndex, 'session snapshot recovery must load before session display composition');
  assert.ok(submitPolicyIndex >= 0 && submitPolicyIndex < submitWorkflowIndex, 'submit policy must load before submit workflow composition');
  assert.ok(executionStatusIndex >= 0 && executionStatusIndex < formattingIndex, 'execution status policy must load before pending status formatting');
  assert.ok(executionStatusIndex < submitWorkflowIndex, 'execution status policy must load before submit workflow composition');
  assert.ok(executionStatusIndex < paths.indexOf('/client/app/chat-workflow.js'), 'execution status policy must load before chat workflow composition');
  assert.ok(executionStatusIndex < paths.indexOf('/client/app/image-workflow.js'), 'execution status policy must load before image workflow composition');
  assert.ok(executionStatusIndex < paths.indexOf('/client/app/route-intent-workflow.js'), 'execution status policy must load before route workflow composition');
  assert.ok(contractIndex < chatServiceIndex, 'the contract must load before chat payload construction');
  assert.ok(contractIndex < workflowIndex, 'the contract must load before attachment selection and upload workflows');
  assert.ok(!paths.includes('/client/services/attachment-service.js'), 'the removed local extraction service must not be bundled');
}

module.exports = [
  testStaticPathUtilitiesPreserveTraversalAndHashingGuards,
  testStaticBundleManifestParsesLocalEntriesOnly,
  testStaticBundleHelpersBuildExpectedBodyAndMetadata,
  testHeavyMarkdownEnhancementsAreDeferredFromPrimaryBundle,
  testFileInputContractLoadsBeforeItsBrowserConsumers,
];
