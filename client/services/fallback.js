(function initChatUIServicesFallback(global) {
  'use strict';

  const root = global.globalThis || global;
  const browser = root.window || global.window || global;
  const core = browser.ChatUICore || root.ChatUICore || {};
  const http = core.http || {};
  const reasoning = core.reasoning || {};
  const imageRouteContext = core.imageRouteContext || browser.ChatUICoreImageRouteContext || root.ChatUICoreImageRouteContext || {};
  const imageReferences = core.imageReferences || browser.ChatUICoreImageReferences || root.ChatUICoreImageReferences || {};
  const attachments = core.attachments || browser.ChatUICoreAttachments || root.ChatUICoreAttachments || {};

  const modelService = browser.ChatUIModelService || root.ChatUIModelService || {};
  const jobService = browser.ChatUIJobService || root.ChatUIJobService || {};
  const chatService = browser.ChatUIChatService || root.ChatUIChatService || {};
  const routeService = browser.ChatUIRouteService || root.ChatUIRouteService || {};
  const imageGenerationService = browser.ChatUIImageGenerationService || root.ChatUIImageGenerationService || {};
  const imageService = browser.ChatUIImageService || root.ChatUIImageService || {};

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
    stripJsonFence: text => routeService.stripJsonFence(text),
    parseRouteResult: (text, normalizeRoute) => routeService.parseRouteResult(text, normalizeRoute || imageRouteContext.normalizeRoute),
    inferLocalImageRoute: (input = '', files = [], normalizeRoute) => routeService.inferLocalImageRoute(input, files, normalizeRoute || imageRouteContext.normalizeRoute),
    buildRoutePayload: options => routeService.buildRoutePayload(options),
    extractRouteText: response => routeService.extractRouteText(response),
  });

  const images = Object.freeze({
    extractImageResult: result => imageService.extractImageResult(result),
    buildImageCompletionMessage: options => imageService.buildImageCompletionMessage(options),
    buildPromptWithTextAttachments: (prompt, list, isImageFile = attachments.isImageFile) => imageGenerationService.buildPromptWithTextAttachments(prompt, list, isImageFile),
    buildImagePromptWithStylePrompt: (prompt, stylePrompt) => imageGenerationService.buildImagePromptWithStylePrompt(prompt, stylePrompt),
    buildImageRequestPayload: options => imageGenerationService.buildImageRequestPayload(options),
    createImageContext: options => imageGenerationService.createImageContext({ makeImageItemId: imageReferences.makeImageItemId, ...options }),
    imageFileToJobPayload: (attachment, readFileAsDataURL) => imageService.imageFileToJobPayload(attachment, readFileAsDataURL),
    imageFilesToJobPayload: (list, readFileAsDataURL) => imageService.imageFilesToJobPayload(list, readFileAsDataURL),
  });

  if (typeof window !== 'undefined') window.ChatUIServicesFallback = Object.freeze({ models, jobs, chat, route, images });
  else global.ChatUIServicesFallback = Object.freeze({ models, jobs, chat, route, images });
})(typeof window !== 'undefined' ? window : globalThis);
