'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const createDOMPurify = require('dompurify');
const { JSDOM } = require('jsdom');

const linkPolicy = require('../../client/app/markdown/link-policy');
const commonSanitizer = require('../../client/app/markdown/sanitizer');
const markdownEngine = require('../../client/app/markdown/markdown-engine');
const markdownDependencyLoader = require('../../client/app/markdown/dependency-loader');
const mediaWorkflow = require('../../client/app/media-workflow');
const routeService = require('../../client/services/route-service');
const usageStatsService = require('../../client/services/usage-stats');
const usageStatsAuth = require('../../client/ui/usage-stats-auth');
const webPreviewCore = require('../../client/core/web-preview');
const webPreviewUi = require('../../client/ui/web-preview');

const projectRoot = path.resolve(__dirname, '..', '..');

function browserSanitizerApi() {
  const dom = new JSDOM('', { url: 'https://chatui.example/' });
  dom.window.DOMPurify = createDOMPurify(dom.window);
  dom.window.ChatUIMarkdownLinkPolicy = linkPolicy;
  const context = vm.createContext({ window: dom.window, globalThis: dom.window, console });
  const source = fs.readFileSync(path.join(projectRoot, 'client/app/markdown/browser-sanitizer.js'), 'utf8');
  vm.runInContext(source, context, { filename: 'client/app/markdown/browser-sanitizer.js' });
  return dom.window.ChatUIMarkdownSanitizer;
}

function assertSanitizedUrlAttributes(sanitizeHtml, label) {
  const raster = 'data:image/png;base64,AAAA';
  const svg = 'data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9ImFsZXJ0KDEpIj48L3N2Zz4=';
  const html = [
    `<a id="data-link" href="${raster}">data</a>`,
    '<a id="script-link" href="java&#10;script:alert(1)">script</a>',
    '<a id="safe-link" href="https://example.com/docs">safe</a>',
    `<img id="raster" src="${raster}" srcset="https://attacker.example/a.png 2x">`,
    `<img id="svg" src="${svg}">`,
    '<img id="html" src="data:text/html,&lt;script&gt;alert(1)&lt;/script&gt;">',
    '<img id="blob" src="blob:https://chatui.example/image-id">',
  ].join('');
  const document = new JSDOM(`<body>${sanitizeHtml(html)}</body>`).window.document;
  assert.strictEqual(document.querySelector('#data-link').hasAttribute('href'), false, `${label}: data URI anchors must be stripped`);
  assert.strictEqual(document.querySelector('#script-link').hasAttribute('href'), false, `${label}: control-character protocol variants must be stripped`);
  assert.strictEqual(document.querySelector('#safe-link').getAttribute('href'), 'https://example.com/docs', `${label}: HTTPS navigation must remain usable`);
  assert.strictEqual(document.querySelector('#raster').getAttribute('src'), raster, `${label}: raster image data must remain usable on img[src]`);
  assert.strictEqual(document.querySelector('#raster').hasAttribute('srcset'), false, `${label}: unparsed srcset candidates must be stripped`);
  assert.strictEqual(document.querySelector('#svg').hasAttribute('src'), false, `${label}: SVG data URIs must be stripped`);
  assert.strictEqual(document.querySelector('#html').hasAttribute('src'), false, `${label}: HTML data URIs must be stripped`);
  assert.strictEqual(document.querySelector('#blob').getAttribute('src'), 'blob:https://chatui.example/image-id', `${label}: browser-owned Blob images must remain usable`);
}

function testMarkdownUrlPolicyIsAttributeAndElementSpecific() {
  assertSanitizedUrlAttributes(commonSanitizer.sanitizeHtml, 'CommonJS sanitizer');
  assertSanitizedUrlAttributes(browserSanitizerApi().sanitizeHtml, 'browser sanitizer');
  assert.strictEqual(linkPolicy.isSafeMarkdownLink('data:image/svg+xml;base64,PHN2Zz48L3N2Zz4='), false);
  assert.strictEqual(linkPolicy.isSafeMarkdownLink('java\nscript:alert(1)'), false);
  assert.strictEqual(linkPolicy.isSafeMarkdownLink('data:image/png;base64,AAAA'), true, 'the parser may accept raster data so the element-aware sanitizer can retain an image');

  const renderedRaster = markdownEngine.renderMarkdown('![safe](data:image/png;base64,AAAA)');
  const renderedSvg = markdownEngine.renderMarkdown('![unsafe](data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=)');
  assert.match(renderedRaster, /src="data:image\/png;base64,AAAA"/);
  assert.doesNotMatch(renderedSvg, /src="data:image\/svg\+xml/i);
}

function createMediaWorkflow(fetchCalls) {
  const fetch = async (url, options = {}) => {
    fetchCalls.push({ url: String(url), options });
    if (url === '/api/image') {
      return { ok: true, headers: { get: () => 'image/png' }, blob: async () => ({ via: 'proxy' }) };
    }
    const shouldFallback = String(url).includes('fallback');
    return {
      ok: !shouldFallback,
      headers: { get: () => shouldFallback ? 'text/plain' : 'image/png' },
      blob: async () => ({ via: 'direct', url: String(url) }),
    };
  };
  return mediaWorkflow.createMediaWorkflow({
    IMAGE_DB: 'audit-db',
    IMAGE_STORE: 'images',
    TRANSPARENT_PIXEL: 'data:image/gif;base64,AAAA',
    URL,
    fetch,
    parseResponseJson: async () => ({}),
    normalizeError: () => 'proxy failed',
    imageStoreHelpers: {
      createImageStore: () => ({
        openImageDb: async () => null,
        putImageBlob: async () => {},
        getImageBlob: async () => null,
        clearImageDb: async () => {},
        deleteImageDbKeys: async () => {},
        getImageDbKeys: async () => [],
      }),
      collectIndexedDbKeys: (_value, target) => target,
    },
    localStorage: { getItem: () => null },
    state: { sessions: [], attachments: [], activeRuns: new Map(), liveRuns: new Map(), activeSessionId: '' },
    sessionImageJobKey: () => 'image-job',
    sessionChatJobKey: () => 'chat-job',
    pendingSubmitKey: () => 'pending-submit',
  });
}

async function testImageFetchOnlySendsCredentialsToAbsoluteTrustedOrigin() {
  const calls = [];
  const workflow = createMediaWorkflow(calls);
  const options = { baseUrl: 'https://api.example.com/v1', apiKey: 'secret-key' };

  await workflow.fetchImageBlob('https://api.example.com/files/a.png', options);
  await workflow.fetchImageBlob('https://attacker.example/collect.png', options);
  await workflow.fetchImageBlob('/relative/image.png', options);
  await workflow.fetchImageBlob('not a valid absolute URL', options);
  await workflow.fetchImageBlob('https://attacker.example/fallback.png', options);

  assert.strictEqual(calls[0].options.headers.Authorization, 'Bearer secret-key');
  for (const index of [1, 2, 3, 4]) {
    assert.strictEqual(calls[index].options.headers.Authorization, undefined, `request ${index} must not leak the configured API key`);
  }
  const proxy = calls[5];
  assert.strictEqual(proxy.url, '/api/image');
  assert.strictEqual(proxy.options.headers.Authorization, undefined, 'the same-origin proxy request must not synthesize an Authorization header');
  assert.deepStrictEqual(JSON.parse(proxy.options.body), {
    baseUrl: options.baseUrl,
    apiKey: options.apiKey,
    url: 'https://attacker.example/fallback.png',
  });
}

async function testImageResponseStreamingStopsAtTheBrowserSizeLimit() {
  let reads = 0;
  let canceled = false;
  const response = {
    headers: { get: name => name === 'content-type' ? 'image/png' : null },
    body: {
      getReader: () => ({
        async read() {
          reads += 1;
          if (reads === 1) return { done: false, value: new Uint8Array(4) };
          return { done: false, value: new Uint8Array(4) };
        },
        async cancel() { canceled = true; },
        releaseLock() {},
      }),
    },
  };
  await assert.rejects(mediaWorkflow.readImageResponseBlob(response, 6), /exceeds the browser size limit/);
  assert.strictEqual(reads, 2);
  assert.strictEqual(canceled, true, 'the response stream must be canceled as soon as the byte ceiling is crossed');
}

function routeDecision() {
  return {
    schema_version: 'route_decision.v1', readiness: 'ready', operation: 'edit_image', relation: 'continuation',
    bindings: [{ candidate_key: 'i1', role: 'target' }],
    changes: [{ op: 'replace', target: 'color', value: 'red' }], constraints: [],
    clarification: { question: '', unresolved: [] }, confidence: 0.99, rationale: 'preserve selected target',
  };
}

function selectedContext(candidate, selected) {
  return {
    image_candidates: [candidate],
    clarification_context: { selected_choices: [{ resource_key: 'r1', type: 'image', role: 'target', ...selected }] },
  };
}

function testClarificationSelectionCannotCrossSourceOrReferenceIdentity() {
  const exact = selectedContext(
    { index: 4, source: 'history', image_id: 'shared-id', reference_id: 'shared-ref' },
    { index: 1, source: 'history', id: 'shared-id', reference_id: 'shared-ref' },
  );
  assert.ok(routeService.inspectRouteResult(JSON.stringify(routeDecision()), { input: 'make it red', context: exact }).route, 'a stable ID may repair display-index drift within the same source and reference');

  const crossSource = selectedContext(
    { index: 1, source: 'current', image_id: 'shared-id', reference_id: 'shared-ref' },
    { index: 8, source: 'history', id: 'shared-id', reference_id: 'shared-ref' },
  );
  assert.strictEqual(routeService.inspectRouteResult(JSON.stringify(routeDecision()), { input: 'make it red', context: crossSource }).route, null);

  const referenceConflict = selectedContext(
    { index: 1, source: 'history', image_id: 'shared-id', reference_id: 'other-ref' },
    { index: 1, source: 'history', id: 'shared-id', reference_id: 'shared-ref' },
  );
  assert.strictEqual(routeService.inspectRouteResult(JSON.stringify(routeDecision()), { input: 'make it red', context: referenceConflict }).route, null);
}

function testVirtualRenderBootstrapDefaultsSafelyWhenStorageThrows() {
  const html = fs.readFileSync(path.join(projectRoot, 'index.html'), 'utf8');
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => match[1]);
  const bootstrap = scripts.find(source => source.includes('CHATUI_ENABLE_VIRTUAL_RENDER'));
  assert.ok(bootstrap, 'the pre-bundle render bootstrap must remain present');
  const window = {};
  vm.runInNewContext(bootstrap, {
    window,
    localStorage: { getItem() { throw new DOMException('denied', 'SecurityError'); } },
  });
  assert.strictEqual(window.CHATUI_ENABLE_VIRTUAL_RENDER, true);
  assert.strictEqual(JSON.stringify(window.CHATUI_RENDER_CACHE_OPTIONS), JSON.stringify({ maxEntries: 240, maxChars: 5000000 }));
  assert.strictEqual(JSON.stringify(window.CHATUI_RENDER_SCHEDULER_OPTIONS), JSON.stringify({ budgetMs: 9, batchSize: 3, timeoutMs: 900 }));
}

async function testMarkdownDependenciesFailClosedToVerifiedLocalAssets() {
  const allResources = [
    ...markdownDependencyLoader.resources.styles,
    ...markdownDependencyLoader.resources.scripts,
  ];
  assert.ok(allResources.length > 0);
  allResources.forEach(resource => {
    assert.match(resource.local, /^\.\/vendor\//, `${resource.id} must resolve from the packaged vendor tree`);
    assert.strictEqual(Object.hasOwn(resource, 'cdn'), false, `${resource.id} must not retain an executable CDN fallback`);
  });

  const appended = [];
  const document = {
    baseURI: 'https://chatui.example/',
    querySelector() { return null; },
    querySelectorAll() { return []; },
    createElement(tagName) { return { tagName: tagName.toUpperCase(), dataset: {} }; },
    head: { appendChild(node) { appended.push(node); queueMicrotask(() => node.onerror?.()); } },
    body: { appendChild(node) { appended.push(node); queueMicrotask(() => node.onerror?.()); } },
  };
  const root = { document, console: { warn() {}, info() {}, log() {} } };
  const result = await markdownDependencyLoader.createBrowserLoader(root, document).loadMermaid();
  assert.match(result.error, /Failed to load markdown dependency/);
  assert.deepStrictEqual(appended.map(node => node.src), ['./vendor/mermaid.min.js']);
}

function testWebPreviewPopupsCannotEscapeTheSandbox() {
  const host = new JSDOM('<!doctype html><body></body>', { url: 'https://chatui.example/' });
  const popup = new JSDOM('<!doctype html><title>Loading</title>', {
    url: 'https://chatui.example/',
    runScripts: 'dangerously',
  }).window;
  popup.focus = () => {};
  const controller = webPreviewUi.createWebPreviewController({
    document: host.window.document,
    core: webPreviewCore,
    openWindow: () => popup,
  });
  assert.strictEqual(controller.openPreviewInNewWindow({
    title: 'Untrusted preview',
    source: '<html><body><script>window.open("https://attacker.example/")</script></body></html>',
  }), true);
  const sandbox = popup.document.getElementById('preview').getAttribute('sandbox');
  assert.match(sandbox, /(?:^|\s)allow-popups(?:\s|$)/);
  assert.doesNotMatch(sandbox, /allow-popups-to-escape-sandbox/);
  assert.doesNotMatch(sandbox, /allow-same-origin/);

  const index = fs.readFileSync(path.join(projectRoot, 'index.html'), 'utf8');
  const staticFrame = index.match(/<iframe id="webPreviewFrame"[^>]*>/)?.[0] || '';
  assert.match(staticFrame, /sandbox=/);
  assert.doesNotMatch(staticFrame, /allow-popups-to-escape-sandbox/);
  assert.doesNotMatch(staticFrame, /allow-same-origin/);
}

async function testUsageRequestsBindCredentialsToTheConfiguredUpstream() {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return {
      ok: true,
      headers: {
        get(name) {
          if (String(name).toLowerCase() === 'content-type') {
            return url.endsWith('/export') ? 'application/octet-stream' : 'application/json';
          }
          return null;
        },
      },
      async text() { return '{}'; },
      async blob() { return new Blob(['workbook']); },
    };
  };

  const baseUrl = '  https://API.Example.com/v1///  ';
  try {
    await usageStatsService.requestOverview('secret', 'model', 'week', 'today', baseUrl);
    await usageStatsService.requestRanking('secret', 'model', 'today', baseUrl);
    await usageStatsService.requestPersonal('secret', 'model', 'today', baseUrl);
    await usageStatsService.verifyDepartmentPassword('department-secret', 'secret', 'model', baseUrl);
    await usageStatsService.requestDepartmentSummary('department-secret', 'secret', 'model', 'today', baseUrl);
    await usageStatsService.requestDepartmentRanking('department-secret', 'secret', 'model', 'today', baseUrl);
    await usageStatsService.requestDepartmentUsers('department-secret', 'secret', 'model', 'dept-1', 'today', baseUrl);
    await usageStatsService.exportDepartmentUsage('department-secret', 'secret', 'model', 'today', baseUrl);
    await usageStatsService.submitFeedback('feedback', 'secret', 'model', baseUrl);
  } finally {
    if (originalFetch === undefined) delete globalThis.fetch;
    else globalThis.fetch = originalFetch;
  }

  assert.strictEqual(calls.length, 9, 'every usage endpoint must be exercised by this contract test');
  for (const call of calls) {
    assert.strictEqual(call.body.base_url, 'https://api.example.com/v1');
  }
  assert.strictEqual(usageStatsService.normalizeBaseUrl('https://user:pass@example.com/v1'), '');
  assert.strictEqual(usageStatsService.normalizeBaseUrl('https://api.example.com/v1?tenant=other'), '');
  assert.strictEqual(usageStatsService.normalizeBaseUrl('https://api.example.com/v1#fragment'), '');
  assert.strictEqual(usageStatsService.normalizeBaseUrl('javascript:alert(1)'), '');
}

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: key => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key),
    values,
  };
}

function testUsageSecretsUseSessionStorageWithSafeMigrationAndFallback() {
  const session = memoryStorage();
  const legacy = memoryStorage({ [usageStatsAuth.DEPARTMENT_PASSWORD_KEY]: ' legacy-password ' });
  usageStatsAuth.clearDepartmentPassword(session, legacy);
  legacy.setItem(usageStatsAuth.DEPARTMENT_PASSWORD_KEY, ' legacy-password ');

  assert.strictEqual(usageStatsAuth.getDepartmentPassword(session, legacy), 'legacy-password');
  assert.strictEqual(session.getItem(usageStatsAuth.DEPARTMENT_PASSWORD_KEY), 'legacy-password');
  assert.strictEqual(legacy.getItem(usageStatsAuth.DEPARTMENT_PASSWORD_KEY), null, 'the long-lived legacy copy must be deleted after migration');
  assert.strictEqual(usageStatsAuth.currentBaseUrl({ getElement: id => id === 'baseUrl' ? { value: 'https://api.example.com/v1/' } : null }), 'https://api.example.com/v1');

  const denied = {
    getItem() { throw new DOMException('denied', 'SecurityError'); },
    setItem() { throw new DOMException('denied', 'SecurityError'); },
    removeItem() { throw new DOMException('denied', 'SecurityError'); },
  };
  usageStatsAuth.setDepartmentPassword('memory-only', denied, denied);
  assert.strictEqual(usageStatsAuth.getDepartmentPassword(denied, denied), 'memory-only');
  usageStatsAuth.clearDepartmentPassword(denied, denied);
  assert.strictEqual(usageStatsAuth.getDepartmentPassword(denied, denied), '');
}

module.exports = [
  testMarkdownUrlPolicyIsAttributeAndElementSpecific,
  testImageFetchOnlySendsCredentialsToAbsoluteTrustedOrigin,
  testImageResponseStreamingStopsAtTheBrowserSizeLimit,
  testClarificationSelectionCannotCrossSourceOrReferenceIdentity,
  testVirtualRenderBootstrapDefaultsSafelyWhenStorageThrows,
  testMarkdownDependenciesFailClosedToVerifiedLocalAssets,
  testWebPreviewPopupsCannotEscapeTheSandbox,
  testUsageRequestsBindCredentialsToTheConfiguredUpstream,
  testUsageSecretsUseSessionStorageWithSafeMigrationAndFallback,
];
