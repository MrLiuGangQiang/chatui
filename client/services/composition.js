(function initChatUIServicesComposition(global) {
  'use strict';

  const root = global.globalThis || global;
  const browser = root.window || global.window || global;
  const core = browser.ChatUICore || root.ChatUICore || {};
  const http = core.http || {};
  const reasoning = core.reasoning || {};
  const imageReferences = core.imageReferences || browser.ChatUICoreImageReferences || root.ChatUICoreImageReferences || {};
  const attachments = core.attachments || browser.ChatUICoreAttachments || root.ChatUICoreAttachments || {};

  const modelService = browser.ChatUIModelService || root.ChatUIModelService || {};
  const jobService = browser.ChatUIJobService || root.ChatUIJobService || {};
  const chatService = browser.ChatUIChatService || root.ChatUIChatService || {};
  const routeService = browser.ChatUIRouteService || root.ChatUIRouteService || {};
  const promptComposerService = browser.ChatUIPromptComposerService || root.ChatUIPromptComposerService || {};
  const imageGenerationService = browser.ChatUIImageGenerationService || root.ChatUIImageGenerationService || {};
  const imageService = browser.ChatUIImageService || root.ChatUIImageService || {};
  const attachmentService = browser.ChatUIAttachmentService || root.ChatUIAttachmentService || {};
  const runtimeService = browser.ChatUIRuntimeService || root.ChatUIRuntimeService || {};
  const clarificationService = browser.ChatUIClarificationService || root.ChatUIClarificationService || {};

  function fetchImpl() { return global.fetch.bind(global); }
  function parseResponseJson(response) {
    const parse = http.parseResponseJson || (async res => {
      const text = await res.text();
      try { return text ? JSON.parse(text) : null; } catch { return { raw: text }; }
    });
    return parse(response);
  }
  function normalizeError(error, payload) {
    const normalize = http.normalizeError || ((err, body) => body?.error?.message || body?.message || err?.message || '请求失败');
    return normalize(error, payload);
  }
  function toProxyUrl(url, baseUrl) {
    return http.toProxyUrl ? http.toProxyUrl(url, baseUrl) : String(url || '').startsWith(baseUrl) ? `/api${String(url).slice(String(baseUrl).length)}` : url;
  }

  function withHttpDeps(options = {}) {
    return { fetchImpl: options.fetchImpl || fetchImpl(), parseResponseJson, normalizeError, ...options };
  }

  const models = Object.freeze({
    requestModels: options => modelService.requestModels(withHttpDeps(options)),
  });

  const jobs = Object.freeze({
    makeClientJobId: jobService.makeClientJobId,
    makeClientImageJobId: jobService.makeClientImageJobId,
    makeClientChatJobId: jobService.makeClientChatJobId,
    startChatJob: options => jobService.startChatJob(withHttpDeps(options)),
    registerChatStreamJob: options => jobService.registerChatStreamJob(withHttpDeps(options)),
    getJob: options => jobService.getJob(withHttpDeps(options)),
    abortManagedJob: options => jobService.abortManagedJob(withHttpDeps(options)),
    disposeManagedJob: options => jobService.disposeManagedJob(withHttpDeps(options)),
    waitJobEvent: options => jobService.waitJobEvent(options),
    startImageGenerationJob: options => jobService.startImageGenerationJob(withHttpDeps(options)),
  });

  const chat = Object.freeze({
    extractChatJobText: data => chatService.extractChatJobText(data),
    requestJson: options => chatService.requestJson({ toProxyUrl, parseResponseJson, normalizeError, fetchImpl: options?.fetchImpl || fetchImpl(), ...options }),
    parseSseLine: line => chatService.parseSseLine(line, reasoning.extractStreamDelta || (() => ({}))),
  });

  const route = Object.freeze({
    ROUTE_SYSTEM_PROMPT: routeService.ROUTE_SYSTEM_PROMPT,
    INTENT_REVIEW_SYSTEM_PROMPT: routeService.INTENT_REVIEW_SYSTEM_PROMPT,
    stripJsonFence: text => routeService.stripJsonFence(text),
    needsIntentReview: (routeInfo, context) => routeService.needsIntentReview(routeInfo, context),
    parseRouteResult: (text, options) => routeService.parseRouteResult(text, options),
    buildRoutePayload: options => routeService.buildRoutePayload(options),
    buildIntentReviewPayload: options => routeService.buildIntentReviewPayload(options),
    extractRouteText: response => routeService.extractRouteText(response),
  });

  const promptComposer = Object.freeze({
    candidateForResource: (resource, context) => promptComposerService.candidateForResource(resource, context),
    resolveBaseText: (resource, context) => promptComposerService.resolveBaseText(resource, context),
    composeImageGeneratePrompt: (task, context, input) => promptComposerService.composeImageGeneratePrompt(task, context, input),
    composeImageEditPrompt: (task, context, input) => promptComposerService.composeImageEditPrompt(task, context, input),
  });

  const images = Object.freeze({
    extractImageResult: result => imageService.extractImageResult(result),
    buildImageCompletionMessage: options => imageService.buildImageCompletionMessage(options),
    buildPromptWithTextAttachments: (prompt, list, isImageFile = attachments.isImageFile) => imageGenerationService.buildPromptWithTextAttachments(prompt, list, isImageFile),
    buildImagePromptWithStylePrompt: (prompt, stylePrompt) => imageGenerationService.buildImagePromptWithStylePrompt(prompt, stylePrompt),
    buildImageRequestPayload: options => imageGenerationService.buildImageRequestPayload(options),
    buildGptImage2TaskPayload: options => imageGenerationService.buildGptImage2TaskPayload(options),
    createImageContext: options => imageGenerationService.createImageContext({ makeImageItemId: imageReferences.makeImageItemId, ...options }),
    imageFileToJobPayload: (attachment, readFileAsDataURL) => imageService.imageFileToJobPayload(attachment, readFileAsDataURL),
    imageFilesToJobPayload: (list, readFileAsDataURL) => imageService.imageFilesToJobPayload(list, readFileAsDataURL),
  });

  const attachmentsApi = Object.freeze({
    extractFileText: options => attachmentService.extractFileText(withHttpDeps(options)),
  });

  const runtime = Object.freeze({
    requestAppVersion: options => runtimeService.requestAppVersion(withHttpDeps(options)),
  });

  const api = Object.freeze({ models, jobs, chat, route, promptComposer, images, attachments: attachmentsApi, runtime, clarification: clarificationService });
  if (typeof window !== 'undefined') {
    window.ChatUIServicesComposition = api;
    window.ChatUIServicesFallback = api;
  } else {
    global.ChatUIServicesComposition = api;
    global.ChatUIServicesFallback = api;
  }
})(typeof window !== 'undefined' ? window : globalThis);
