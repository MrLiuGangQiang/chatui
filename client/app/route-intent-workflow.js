(function initChatUIRouteIntentWorkflow(root) {
  'use strict';

  const requestCompatibility = root?.[Symbol.for('chatui.module-registry.v1')]?.get('requestCompatibility')
    || (typeof require === 'function' ? require('../services/request-compatibility') : {});
  const requestJsonWithStructuredOutputFallback = requestCompatibility.requestJsonWithStructuredOutputFallback;
  const executionStatus = root?.[Symbol.for('chatui.module-registry.v1')]?.get('executionStatus')
    || (typeof require === 'function' ? require('./execution-status') : {});

  const INTENT_DEADLINE_MS = 60000;
  // Intent recognition receives as much semantic history as the bounded route
  // window allows. When it overflows, the oldest messages are removed first.
  const ROUTE_CONTEXT_MAX_CHARS = 8000;

  function createRouteIntentWorkflow(deps) {
    const {
      getConfig,
      getSessionRouteModel,
      getSessionChatModel,
      buildRouteAttachmentMetadata,
    } = deps;

    // ── Intent deadline ──────────────────────────────────────────
    function createIntentDeadline(parentSignal, timeoutMs) {
      const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
      let timedOut = false;
      let timer = null;

      if (controller && parentSignal) {
        if (parentSignal.aborted) controller.abort();
        else parentSignal.addEventListener('abort', () => controller.abort(), { once: true });
      }

      const signal = controller?.signal || parentSignal;

      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          timedOut = true;
          controller?.abort();
        }, timeoutMs);
      }

      return {
        signal,
        timedOut: false,
        get timedOut() { return timedOut; },
        async race(promise) { return promise; },
        timeoutError() {
          const e = new Error('Intent recognition timed out');
          e.code = 'ROUTE_INTENT_TIMEOUT';
          return e;
        },
        dispose() { if (timer) clearTimeout(timer); },
      };
    }

    // ── Default routes ────────────────────────────────────────────
    function routeCompilationOptions(config = {}, mode = 'chat', autoMode = true) {
      return {
        currentMode: mode,
        autoMode,
        defaults: {
          imageSize: String(config.imageSize || 'auto').trim() || 'auto',
        },
      };
    }

    function intentFailureRoute(reason = 'route_models_unavailable') {
      const messages = {
        route_intent_invalid: '本次未执行：意图模型返回了无效的任务结构。请重试；若持续出现，请更换意图模型。',
        route_model_unconfigured: '本次未执行：未配置可用的意图模型。请先完成配置后重试。',
        route_model_timeout: '本次未执行：意图识别超时。请重试；若持续出现，请更换意图模型。',
        route_service_unavailable: '本次未执行：意图路由服务当前不可用。请刷新页面后重试。',
      };
      const normalizedReason = String(reason || 'route_models_unavailable').trim();
      return {
        mode: 'chat', api: 'clarify', target: 'none', intent: 'clarify',
        needClarification: true, dispatchAuthorized: false, readiness: 'needs_clarification',
        operationType: 'plain_chat', operationApi: 'chat', operationMode: 'chat', relation: 'new',
        confidence: 0, resources: [], executionResources: null, dispatchContract: null,
        imageRefs: [], fileRefs: [], messageRefs: [],
        selectedIndexes: [], selectedImageIndexes: [], selectedFileIndexes: [],
        selectedImageIds: [], selectedReferenceId: '', usePreviousImage: false,
        contextualImagePrompt: '', editInstruction: '', evidence: normalizedReason,
        clarificationQuestion: messages[normalizedReason]
          || '本次未执行：意图模型当前不可用。请重试；若持续出现，请检查配置或更换意图模型。',
        clarificationSlots: [],
        localClarification: true,
      };
    }

    // Route context builder
    function compactRouteContextForIntent(context = {}) {
      const trimmer = root?.ChatUICore?.imageRouteContext?.trimRouteContextToSize
        || (typeof require === 'function' ? require('../core/image-route-context').trimRouteContextToSize : null);
      if (typeof trimmer === 'function') {
        try { return trimmer(context, ROUTE_CONTEXT_MAX_CHARS) || {}; } catch {}
      }
      const next = {
        ...(context || {}),
        recent_messages: Array.isArray(context?.recent_messages) ? [...context.recent_messages] : [],
      };
      while (next.recent_messages.length && JSON.stringify(next).length > ROUTE_CONTEXT_MAX_CHARS) {
        next.recent_messages.shift();
      }
      return next;
    }

    function buildRouteContext(sessionId) {
      try {
        const state = deps.state || root?.ChatUIApp?.state;
        const session = state?.sessions?.find(item => item.id === sessionId);
        const active = sessionId === state?.activeSessionId;
        const messages = active ? state?.messages || [] : session?.messages || [];
        const lastGeneratedImage = active ? state?.lastGeneratedImage : session?.lastGeneratedImage;
        const latestUploadedImage = deps.getLatestUploadedImageContext?.(sessionId) || null;
        const latestImageReference = deps.latestImageReferenceMeta?.(sessionId) || null;
        const recentImageReferences = deps.collectRecentImageReferences?.(sessionId, 6) || [];
        const makeReferenceId = deps.makeImageReferenceId || (value => `imgref_${String(value || 'latest')}`);
        const makeItemId = deps.makeImageItemId || ((referenceId, index) => `img_${referenceId}_${index}`);
        const compactLastGenerated = lastGeneratedImage ? {
          reference_id: makeReferenceId('latest'),
          prompt: String(lastGeneratedImage.prompt || '').slice(0, 300),
          updated_at: lastGeneratedImage.updatedAt || null,
          count: Array.isArray(lastGeneratedImage.images) ? lastGeneratedImage.images.length : lastGeneratedImage.src ? 1 : 0,
          candidates: (lastGeneratedImage.images || []).map((item, index) => ({
            index: index + 1,
            image_id: item.imageId || item.image_id || makeItemId(makeReferenceId('latest'), index + 1),
            resource_id: item.resourceId || item.resource_id || '',
            filename: item.filename || '',
            prompt: String(item.prompt || lastGeneratedImage.prompt || '').slice(0, 80),
            labels: item.labels || [],
          })),
        } : null;
        const compactLatestUpload = latestUploadedImage ? {
          prompt: String(latestUploadedImage.prompt || '').slice(0, 300),
          count: latestUploadedImage.attachments?.length || 0,
          target: latestUploadedImage.target || 'uploaded',
          updated_at: latestUploadedImage.updatedAt || null,
        } : null;
        const config = typeof getConfig === 'function' ? getConfig() : {};
        const contextWindowTokens = config?.context?.windowTokens;
        const contextBuilder = root?.ChatUICore?.imageRouteContext?.buildRouteContext;
        const context = typeof contextBuilder === 'function'
          ? contextBuilder({
            messages,
            lastGeneratedImage: compactLastGenerated,
            latestUploadedImage: compactLatestUpload,
            latestImageReference,
            recentImageReferences,
            maxChars: ROUTE_CONTEXT_MAX_CHARS,
            contextWindowTokens,
          })
          : {
            recent_messages: messages.map((message, index) => ({
              index: index + 1,
              id: message?.displayItemId || message?.display_item_id || message?.messageId || message?.message_id || message?.id || '',
              resource_id: message?.resourceId || message?.resource_id || '',
              role: message?.role || '',
              content: String(Array.isArray(message?.content) ? message?.rawText || '[非文本消息]' : message?.content || message?.rawText || '').slice(0, 600),
            })),
            last_generated_image: compactLastGenerated,
            latest_uploaded_image: compactLatestUpload,
            latest_image_reference: latestImageReference?.target !== 'none' ? latestImageReference : null,
            image_candidates: [],
            file_candidates: [],
          };
        if (Array.isArray(context?.recent_messages)) {
          context.recent_messages = context.recent_messages.map((message, index) => {
            const sourceIndex = Number(message?.index) - 1;
            const source = messages[Number.isInteger(sourceIndex) && sourceIndex >= 0 ? sourceIndex : index] || {};
            const id = message.id || source.displayItemId || source.display_item_id || source.messageId || source.message_id || source.id || '';
            const resourceId = message.resource_id || source.resourceId || source.resource_id || '';
            const identityAliases = source.identity_aliases || source.identityAliases || [];
            const next = {
              index: Number(message?.index) || index + 1,
              id,
              role: message.role || source.role || '',
            };
            if (message.content !== undefined && message.content !== null && String(message.content) !== '') next.content = message.content;
            if (resourceId) next.resource_id = resourceId;
            if (Array.isArray(identityAliases) && identityAliases.length) next.identity_aliases = identityAliases;
            return next;
          });
        }
        const compactedContext = compactRouteContextForIntent(context || {});
        const memoryBuilder = root?.ChatUICore?.imageRouteContext?.buildImageMemoryCards
          || (typeof require === 'function' ? require('../core/image-route-context').buildImageMemoryCards : null);
        if (typeof memoryBuilder === 'function') {
          const memoryCards = memoryBuilder({
            messages,
            lastGeneratedImage: compactLastGenerated,
            recentImageReferences,
          });
          if (Array.isArray(memoryCards) && memoryCards.length) {
            // Complete image memory is local-only. Keep it non-enumerable so it
            // cannot leak into serialized route context. The candidate retriever
            // may publish compact matching cards, but only the intent model may
            // decide whether one is part of the task.
            Object.defineProperty(compactedContext, 'image_memory_cards', {
              value: memoryCards,
              enumerable: false,
              configurable: true,
            });
          }
        }
        return compactedContext;
      } catch {
        return {};
      }
    }

    // ── Main route function ───────────────────────────────────────
    async function getEffectiveRoute(input, attachments = [], sessionId = '', headers = null, routeContextOverride = null, routeOptions = null) {
      const routeSvc = root.ChatUIRouteService || root.window?.ChatUIRouteService;
      const emitStage = (stage, details = {}) => executionStatus.emitRouteStage?.(routeOptions, stage, details);
      const completeRoute = (route, source = '') => {
        const operation = route?.operationType || route?.dispatchContract?.operation || '';
        if (route?.needClarification) emitStage('preparing_clarification', { source, operation });
        else emitStage('route_ready', { source, operation });
        return route;
      };

      if (!routeSvc?.buildRoutePayload) {
        return completeRoute(intentFailureRoute('route_service_unavailable'), 'route_service');
      }

      const parentSignal = routeOptions?.signal;
      const deadlineMs = routeOptions?.deadlineMs || INTENT_DEADLINE_MS;
      const intentDeadline = createIntentDeadline(parentSignal, deadlineMs);
      let context = routeContextOverride || {};
      let attachmentMeta = [];
      const failRoute = reason => completeRoute(
        intentFailureRoute(String(reason || 'route_models_unavailable')),
        'intent_model',
      );

      try {
        emitStage('reading_context');
        context = routeContextOverride ? compactRouteContextForIntent(routeContextOverride) : buildRouteContext(sessionId);

        if (Array.isArray(attachments) && attachments.length) {
          emitStage('collecting_resources', { attachmentCount: attachments.length });
        }
        attachmentMeta = typeof buildRouteAttachmentMetadata === 'function'
          ? buildRouteAttachmentMetadata(attachments || [])
          : (attachments || []).map((item, index) => ({
            type: String(item?.type || item?.mime || '').startsWith('image/') ? 'image' : 'file',
            name: item?.name || item?.filename || '',
            index: index + 1,
            source_index: Number(item?.sourceIndex || item?.source_index) || index + 1,
            source: item?.routeSource || item?.route_source || item?.source || 'current',
            id: item?.imageId || item?.image_id || item?.fileId || item?.file_id || item?.attachmentId || item?.attachment_id || item?.id || '',
            resource_id: item?.resourceId || item?.resource_id || '',
            reference_id: item?.referenceId || item?.reference_id || '',
          }));

        const config = typeof getConfig === 'function' ? getConfig() : {};
        // All task semantics come from the configured intent model.
        const primaryModel = typeof getSessionRouteModel === 'function'
          ? String(getSessionRouteModel(sessionId, config) || '').trim()
          : String(config.routeModel || config.chatModel || '').trim();
        const fallbackModel = typeof getSessionChatModel === 'function'
          ? String(getSessionChatModel(sessionId, config) || '').trim()
          : String(config.chatModel || '').trim();

        if (!primaryModel || !config.baseUrl) {
          return failRoute('route_model_unconfigured');
        }

        const payload = routeSvc.buildRoutePayload({
          model: primaryModel, input, attachments: attachmentMeta, context,
          currentMode: deps.state?.mode || 'chat',
          autoMode: deps.state?.autoMode !== false,
          currentTurn: routeOptions?.currentTurn || null,
        });

        // Try primary model
        emitStage('recognizing_intent', { modelRole: 'primary' });
        let response;
        let invalidModelOutput = false;
        try {
          response = await requestRouteIntent(payload, config, headers || {}, intentDeadline.signal, routeOptions);
        } catch (err) {
          if (err?.code === 'ROUTE_INTENT_TIMEOUT' || err?.name === 'AbortError') {
            return failRoute('route_model_timeout');
          }
          // Fall through to fallback
        }

        if (response) {
          emitStage('validating_route', { modelRole: 'primary' });
          const raw = routeSvc.extractRouteText(response);
          const parsed = routeSvc.inspectModelRouteResult(raw, {
            input, attachments: attachmentMeta, context,
            ...routeCompilationOptions(config, deps.state?.mode || 'chat', deps.state?.autoMode !== false),
            currentTurn: routeOptions?.currentTurn || null,
          });
          if (parsed.route) return completeRoute(parsed.route, 'primary_model');
          invalidModelOutput = true;
        }

        // Try fallback model (only if different from primary)
        if (fallbackModel && fallbackModel !== primaryModel && config.baseUrl) {
          emitStage('retrying_route_model', { modelRole: 'fallback' });
          const fbPayload = routeSvc.buildRoutePayload({
            model: fallbackModel, input, attachments: attachmentMeta, context,
            currentMode: deps.state?.mode || 'chat',
            autoMode: deps.state?.autoMode !== false,
            currentTurn: routeOptions?.currentTurn || null,
          });
          try {
            const fbResponse = await requestRouteIntent(fbPayload, config, headers || {}, intentDeadline.signal, routeOptions);
            emitStage('validating_route', { modelRole: 'fallback' });
            const fbRaw = routeSvc.extractRouteText(fbResponse);
            const fbParsed = routeSvc.inspectModelRouteResult(fbRaw, {
              input, attachments: attachmentMeta, context,
              ...routeCompilationOptions(config, deps.state?.mode || 'chat', deps.state?.autoMode !== false),
              currentTurn: routeOptions?.currentTurn || null,
            });
            if (fbParsed.route) return completeRoute(fbParsed.route, 'fallback_model');
            invalidModelOutput = true;
          } catch {}
        }

        // Every unavailable, timed-out, or non-canonical intent-model result
        // fails closed. No local route or plain-chat semantic fallback is allowed.
        if (invalidModelOutput) return completeRoute(intentFailureRoute('route_intent_invalid'), 'invalid_model_output');
        console.warn('[route] All intent models failed; execution is blocked');
        return failRoute('route_models_unavailable');

      } catch {
        return failRoute('route_workflow_error');
      } finally {
        intentDeadline.dispose();
      }
    }

    // Intent requests use the shared OpenAI-compatible request adapter.
    async function requestRouteIntent(payload, config, headers, signal, routeOptions = null) {
      const baseUrl = String(config?.baseUrl || '').replace(/\/+$/, '');
      const apiUrl = `${baseUrl}/chat/completions`;
      const request = typeof deps.requestJson === 'function'
        ? nextPayload => deps.requestJson(apiUrl, nextPayload, config.apiKey, {
          method: 'POST',
          headers: headers || {},
          signal,
          requestPurpose: 'intent_recognition',
          submissionId: routeOptions?.submissionId || '',
        })
        : async nextPayload => {
          const resp = await fetch(apiUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': 'Bearer ' + String(config?.apiKey || '').trim(),
              ...(headers || {}),
            },
            body: JSON.stringify(nextPayload),
            signal,
          });
          if (!resp.ok) {
            const err = new Error('Route model HTTP ' + resp.status);
            err.statusCode = resp.status;
            throw err;
          }
          return resp.json();
        };

      // Keep structured-output compatibility fallback for endpoints/models that
      // reject json_schema, while preserving the application request adapter's
      // positional contract (url, payload, apiKey, options).
      return typeof requestJsonWithStructuredOutputFallback === 'function'
        ? requestJsonWithStructuredOutputFallback(request, payload)
        : request(payload);
    }

    // ── Intent trace (for debugging) ──────────────────────────────
    let _trace = null;
    function setIntentTrace(t) { _trace = t; }
    function summarizeIntentTrace() { return _trace; }

    return Object.freeze({
      buildRouteContext,
      getEffectiveRoute,
      setIntentTrace,
      summarizeIntentTrace,
    });
  }

  const api = Object.freeze({ createRouteIntentWorkflow });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.ChatUIAppRouteIntentWorkflow = api;
  if (root?.window) root.window.ChatUIAppRouteIntentWorkflow = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
