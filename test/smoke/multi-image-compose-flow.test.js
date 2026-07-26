const assert = require('assert');
const http = require('http');

const imageReferences = require('../../client/core/image-references');
const routeContext = require('../../client/core/image-route-context');
const routeService = require('../../client/services/route-service');
const imageContextWorkflow = require('../../client/app/image-context-workflow');
const imageService = require('../../client/services/image-service');
const imageJobs = require('../../server/jobs/image');

const PNG_DATA_URL = 'data:image/png;base64,iVBORw0KGgo=';

function completedImage(id, prompt) {
  return {
    role: 'assistant',
    displayItemId: id,
    content: `[图片生成完成] ${prompt}`,
    rawText: `[图片生成完成] ${prompt}`,
    imageContext: JSON.stringify({
      prompt,
      mode: 'image',
      target: 'previous',
      attachments: [{ name: `${id}.png`, type: 'image/png', src: PNG_DATA_URL, description: prompt, semantic_text: prompt }],
    }),
  };
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve(`http://127.0.0.1:${server.address().port}/v1`);
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

function imageReferenceClarificationContract(knownCandidate, choices) {
  const resources = [{
    key: 'r1',
    type: 'image',
    source: knownCandidate.source,
    role: 'reference',
    index: knownCandidate.index + 100,
    id: knownCandidate.image_id,
    reference_id: knownCandidate.reference_id,
    missing: false,
  }];
  return {
    schema_version: 'task_contract.v4',
    operation: 'image_reference_gen',
    relation: 'followup',
    resources,
    directive: {
      mode: 'patch',
      base_resource_keys: ['r1', 'r2'],
      unmentioned_policy: 'allow_change',
      operations: [{ op: 'add', target: 'composition', value: 'combine the selected references' }],
      constraints: [],
    },
    clarification: {
      question: '请选择要与猫合并的鱼图。',
      resume_operation: 'image_reference_gen',
      unresolved_resources: [{
        key: 'r2', type: 'image', role: 'reference', reason: 'ambiguous',
        choices: choices.map((candidate, index) => ({
          key: `c${index + 1}`,
          source: candidate.source,
          index: candidate.index + 100,
          id: candidate.image_id,
          reference_id: candidate.reference_id,
          label: candidate.prompt,
        })),
      }],
    },
    confidence: 0.95,
    review_reasons: ['ambiguous_reference'],
    rationale: 'the cat is unique but two fish candidates remain',
  };
}

async function testClarifiedMultiImageCompositionReachesImageEditsWithBothSelectedImages() {
  const messages = [
    { role: 'user', content: '画一只猫' }, completedImage('cat-result', '一只猫'),
    { role: 'user', content: '手绘一条鱼' }, completedImage('fish-sketch-result', '手绘一条鱼'),
    { role: 'user', content: '画一条彩色鱼' }, completedImage('fish-color-result', '画一条彩色鱼'),
    { role: 'user', content: '画一辆汽车' }, completedImage('car-result', '一辆汽车'),
  ];
  const references = routeContext.collectRecentImageReferences({ messages, limit: 10 });
  const context = routeContext.buildRouteContext({ messages, recentImageReferences: references });
  const input = '把猫和鱼合并成一张图，场景要自然协调';
  const catCandidate = context.image_candidates.find(candidate => candidate.prompt === '一只猫');
  const fishCandidates = context.image_candidates.filter(candidate => ['手绘一条鱼', '画一条彩色鱼'].includes(candidate.prompt));
  const clarificationRoute = routeService.parseRouteResult(JSON.stringify(imageReferenceClarificationContract(catCandidate, fishCandidates)), { input, context, attachments: [] });

  assert.strictEqual(clarificationRoute.needClarification, true);
  assert.strictEqual(clarificationRoute.api, 'clarify');
  assert.strictEqual(clarificationRoute.dispatchAuthorized, false);
  assert.strictEqual(routeService.isRouteDispatchable(clarificationRoute), false);
  const colorFishChoice = clarificationRoute.taskContract.clarification.unresolved_resources[0].choices.find(choice => choice.label === '画一条彩色鱼');
  const route = routeService.resolveClarificationRoute(clarificationRoute.taskContract, [{ resource_key: 'r2', choice_key: colorFishChoice.key }], { input });

  assert.strictEqual(route.operationType, 'image_reference_gen');
  assert.strictEqual(route.mode, 'edit_image');
  assert.strictEqual(route.api, 'image_edit');
  assert.strictEqual(route.dispatchAuthorized, true);
  assert.strictEqual(routeService.isRouteDispatchable(route), true);
  assert.strictEqual(route.selectedImageIds.length, 2);
  const routedCandidates = context.image_candidates.filter(candidate => route.selectedImageIds.includes(candidate.image_id));
  assert.deepStrictEqual(new Set(routedCandidates.map(candidate => candidate.prompt)), new Set(['一只猫', '画一条彩色鱼']));

  const state = { activeSessionId: 'smoke-session', lastGeneratedImage: null, sessions: [{ id: 'smoke-session', messages }] };
  const workflow = imageContextWorkflow.createImageContextWorkflow({
    getState: () => state,
    getActiveSession: () => state.sessions[0],
    isImageFile: item => String(item?.type || '').startsWith('image/'),
    imageRefToFile: async (_src, name) => ({ name, type: 'image/png', size: 8, dataUrl: PNG_DATA_URL }),
    normalizeLastGeneratedImage: routeContext.normalizeLastGeneratedImage,
    findImageReferenceById: (_sessionId, referenceId) => routeContext.findImageReferenceById({ messages, referenceId }),
    makeImageReferenceId: imageReferences.makeImageReferenceId,
    parseImageReferenceId: imageReferences.parseImageReferenceId,
    makeImageItemId: imageReferences.makeImageItemId,
    parseImageItemId: imageReferences.parseImageItemId,
    normalizeImageSelection: imageReferences.normalizeImageSelection,
    normalizeSelectedImageIds: imageReferences.normalizeSelectedImageIds,
  });
  const attachments = await workflow.getPreviousImageAttachments('smoke-session', null, route.selectedReferenceId, route.selectedImageIds);
  const files = await imageService.imageFilesToJobPayload(attachments, file => file.dataUrl);
  assert.strictEqual(files.length, 2);
  assert.deepStrictEqual(new Set(files.map(file => file.name)), new Set(['cat-result.png', 'fish-color-result.png']));

  let captured = null;
  const upstreamServer = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      captured = { url: req.url, headers: req.headers, body: Buffer.concat(chunks) };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"data":[{"url":"https://img.example/merged.png"}]}');
    });
  });
  const previousPrivateUpstream = process.env.CHATUI_ALLOW_PRIVATE_UPSTREAM;
  const baseUrl = await listen(upstreamServer);
  process.env.CHATUI_ALLOW_PRIVATE_UPSTREAM = '1';
  try {
    const job = imageJobs.createImageJobFromRequestBody('imgjob-semantic-smoke', {
      mode: 'edit_image',
      payload: { model: 'gpt-image-1', prompt: route.editInstruction },
      files,
    }, { baseUrl, apiKey: 'test-key', extraHeaders: {} });
    await imageJobs.runImageJob(job, { upstreamTimeoutMs: 5000 });
    assert.strictEqual(job.status, 'done');
    assert.strictEqual(captured.url, '/v1/images/edits');
    assert.match(captured.headers['content-type'], /^multipart\/form-data; boundary=/);
    const multipart = captured.body.toString('latin1');
    const multipartUtf8 = captured.body.toString('utf8');
    assert.strictEqual((multipart.match(/name="image\[\]"; filename=/g) || []).length, 2);
    assert.ok(multipart.includes('filename="cat-result.png"'));
    assert.ok(multipart.includes('filename="fish-color-result.png"'));
    assert.ok(!multipart.includes('filename="fish-sketch-result.png"'));
    assert.ok(!multipart.includes('filename="car-result.png"'));
    const promptPart = multipartUtf8.match(/name="prompt"\r\n\r\n([\s\S]*?)\r\n--/);
    assert.ok(promptPart, 'multipart request should contain a prompt field');
    assert.strictEqual(promptPart[1], input, 'multi-image composition must send the user prompt unchanged');
  } finally {
    if (previousPrivateUpstream === undefined) delete process.env.CHATUI_ALLOW_PRIVATE_UPSTREAM;
    else process.env.CHATUI_ALLOW_PRIVATE_UPSTREAM = previousPrivateUpstream;
    await close(upstreamServer);
  }
}

module.exports = [testClarifiedMultiImageCompositionReachesImageEditsWithBothSelectedImages];
