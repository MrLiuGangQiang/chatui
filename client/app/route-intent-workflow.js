(function initChatUIRouteIntentWorkflow(root) {
  'use strict';

  const requestCompatibility = root?.[Symbol.for('chatui.module-registry.v1')]?.get('requestCompatibility')
    || (typeof require === 'function' ? require('../services/request-compatibility') : {});
  const requestJsonWithStructuredOutputFallback = requestCompatibility.requestJsonWithStructuredOutputFallback;
  const requestJsonWithReasoningParamFallback = requestCompatibility.requestJsonWithReasoningParamFallback;
  const submitWorkflowPolicy = root?.[Symbol.for('chatui.module-registry.v1')]?.get('submitWorkflowPolicy')
    || (typeof require === 'function' ? require('./submit-workflow-policy') : {});
  const createBoundedIntentRequest = submitWorkflowPolicy.createBoundedIntentRequest;
  const createIntentPipelineCancellation = submitWorkflowPolicy.createIntentPipelineCancellation;
  const executionStatus = root?.[Symbol.for('chatui.module-registry.v1')]?.get('executionStatus')
    || (typeof require === 'function' ? require('./execution-status') : {});

  const INTENT_DEADLINE_MS = Number(submitWorkflowPolicy.INTENT_PIPELINE_DEADLINE_MS);
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

    // The submit workflow supplies one absolute deadline. This workflow only
    // consumes the remaining budget; it never starts a second model-specific
    // timeout window.

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
        route_model_auth_error: '本次未执行：意图模型鉴权失败。请检查 Endpoint 和 API Key 权限后重试。',
        route_model_rate_limited: '本次未执行：意图模型请求受到限流。请稍后重试或检查配额。',
        route_model_request_rejected: '本次未执行：意图模型拒绝了路由请求。请检查模型和接口配置。',
        route_model_upstream_error: '本次未执行：意图模型上游服务异常。请稍后重试。',
        route_model_network_error: '本次未执行：无法连接意图模型服务。请检查 Endpoint 和网络连接。',
        route_context_unavailable: '本次未执行：当前会话上下文读取失败。为避免错误路由，请刷新后重试。',
        route_input_too_long: '本次未执行：输入内容超过单条消息限制。请改为上传文本文件或分段发送。',
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

    function createRouteContextError(cause) {
      const error = new Error('Route context is unavailable');
      error.code = 'ROUTE_CONTEXT_BUILD_FAILED';
      error.routeContextFailure = true;
      error.cause = cause;
      return error;
    }

    function routeErrorReason(error) {
      const statusCode = Number(error?.statusCode || error?.status) || 0;
      const code = String(error?.code || error?.providerCode || '').trim().toUpperCase();
      if (error?.code === 'ROUTE_INTENT_TIMEOUT') return 'route_model_timeout';
      if (error?.code === 'INPUT_TOO_LONG') return 'route_input_too_long';
      if (statusCode === 401 || statusCode === 403 || /(?:AUTH|API_KEY|UNAUTHORIZED|FORBIDDEN)/.test(code)) {
        return 'route_model_auth_error';
      }
      if (statusCode === 429 || /(?:RATE_LIMIT|QUOTA)/.test(code)) return 'route_model_rate_limited';
      if (statusCode >= 500) return 'route_model_upstream_error';
      if (code === 'NETWORK_REQUEST_FAILED' || /(?:ECONN|ENOTFOUND|ETIMEDOUT|NETWORK)/.test(code)) {
        return 'route_model_network_error';
      }
      if (statusCode >= 400) return 'route_model_request_rejected';
      return error?.retryable === true ? 'route_models_unavailable' : 'route_workflow_error';
    }

    function routeErrorAllowsFallback(error) {
      const statusCode = Number(error?.statusCode || error?.status) || 0;
      const code = String(error?.code || error?.providerCode || '').trim().toUpperCase();
      if ((statusCode >= 400 && statusCode < 500)
          || /(?:AUTH|API_KEY|UNAUTHORIZED|FORBIDDEN|RATE_LIMIT|QUOTA)/.test(code)) return false;
      return error?.retryable === true
        || statusCode >= 500
        || code === 'NETWORK_REQUEST_FAILED'
        || /(?:ECONN|ENOTFOUND|ETIMEDOUT|NETWORK)/.test(code);
    }

    function isRouteCancellation(error, parentSignal = null, deadline = null) {
      return parentSignal?.aborted === true
        || deadline?.cancelled === true
        || error?.code === 'ROUTE_INTENT_CANCELLED';
    }

    function isRouteTimeout(error, deadline = null) {
      return deadline?.timedOut === true || error?.code === 'ROUTE_INTENT_TIMEOUT';
    }

    // Route context builder
    function compactRouteContextForIntent(context = {}) {
      try {
        if (!context || typeof context !== 'object' || Array.isArray(context)) {
          throw new TypeError('Route context must be an object');
        }
        const trimmer = root?.ChatUICore?.imageRouteContext?.trimRouteContextToSize
          || (typeof require === 'function' ? require('../core/image-route-context').trimRouteContextToSize : null);
        if (typeof trimmer === 'function') {
          const compacted = trimmer(context, ROUTE_CONTEXT_MAX_CHARS);
          if (!compacted || typeof compacted !== 'object' || Array.isArray(compacted)) {
            throw new TypeError('Route context compactor returned an invalid value');
          }
          return compacted;
        }
        const next = {
          ...context,
          recent_messages: Array.isArray(context.recent_messages) ? [...context.recent_messages] : [],
        };
        while (next.recent_messages.length && JSON.stringify(next).length > ROUTE_CONTEXT_MAX_CHARS) {
          next.recent_messages.shift();
        }
        return next;
      } catch (error) {
        if (error?.code === 'ROUTE_CONTEXT_BUILD_FAILED') throw error;
        throw createRouteContextError(error);
      }
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
          try {
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
          } catch (error) {
            console.warn('[route] optional image memory unavailable', {
              name: String(error?.name || 'Error'),
              code: String(error?.code || 'IMAGE_MEMORY_UNAVAILABLE'),
            });
          }
        }
        return compactedContext;
      } catch (error) {
        if (error?.code === 'ROUTE_CONTEXT_BUILD_FAILED') throw error;
        throw createRouteContextError(error);
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
      if (typeof createBoundedIntentRequest !== 'function'
          || typeof createIntentPipelineCancellation !== 'function'
          || !Number.isFinite(INTENT_DEADLINE_MS)
          || INTENT_DEADLINE_MS <= 0) {
        return completeRoute(intentFailureRoute('route_service_unavailable'), 'route_policy');
      }

      const parentSignal = routeOptions?.signal;
      const requestedDeadlineAt = Number(routeOptions?.deadlineAt);
      const requestedDeadlineMs = Number(routeOptions?.deadlineMs);
      const relativeDeadlineAt = Number.isFinite(requestedDeadlineMs) && requestedDeadlineMs > 0
        ? Date.now() + requestedDeadlineMs
        : 0;
      const absoluteDeadlineAt = Number.isFinite(requestedDeadlineAt) && requestedDeadlineAt > 0
        ? requestedDeadlineAt
        : 0;
      const deadlineAt = absoluteDeadlineAt && relativeDeadlineAt
        ? Math.min(absoluteDeadlineAt, relativeDeadlineAt)
        : absoluteDeadlineAt || relativeDeadlineAt || Date.now() + INTENT_DEADLINE_MS;
      const intentDeadline = createBoundedIntentRequest(parentSignal, deadlineAt);
      let context = routeContextOverride || {};
      let attachmentMeta = [];
      const failRoute = (reason, source = 'intent_model') => completeRoute(
        intentFailureRoute(String(reason || 'route_models_unavailable')),
        source,
      );
      const cancellationError = error => error?.code === 'ROUTE_INTENT_CANCELLED'
        ? error
        : createIntentPipelineCancellation();
      const requestWithinDeadline = payload => intentDeadline.raceFactory(
        () => requestRouteIntent(
          payload,
          config,
          headers || {},
          intentDeadline.signal,
          routeOptions,
          intentDeadline.assertActive,
        ),
      );
      let config = {};

      try {
        intentDeadline.assertActive();
        emitStage('reading_context');
        try {
          context = routeContextOverride ? compactRouteContextForIntent(routeContextOverride) : buildRouteContext(sessionId);
        } catch (error) {
          if (error?.code === 'ROUTE_CONTEXT_BUILD_FAILED') {
            console.warn('[route] core context unavailable', {
              name: String(error?.cause?.name || error?.name || 'Error'),
              code: String(error?.cause?.code || error?.code || 'ROUTE_CONTEXT_BUILD_FAILED'),
            });
            return failRoute('route_context_unavailable', 'route_context');
          }
          throw error;
        }
        intentDeadline.assertActive();

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

        config = typeof getConfig === 'function' ? getConfig() : {};
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

        const inspectResponse = (response, modelRole) => {
          emitStage('validating_route', { modelRole });
          try {
            const raw = routeSvc.extractRouteText(response);
            const parsed = routeSvc.inspectModelRouteResult(raw, {
              input, attachments: attachmentMeta, context,
              ...routeCompilationOptions(config, deps.state?.mode || 'chat', deps.state?.autoMode !== false),
              currentTurn: routeOptions?.currentTurn || null,
            });
            return parsed?.route || null;
          } catch (error) {
            console.warn('[route] invalid intent model response', {
              modelRole,
              name: String(error?.name || 'Error'),
              code: String(error?.code || 'ROUTE_INTENT_INVALID'),
            });
            return null;
          }
        };

        const payload = routeSvc.buildRoutePayload({
          model: primaryModel, input, attachments: attachmentMeta, context,
          currentMode: deps.state?.mode || 'chat',
          autoMode: deps.state?.autoMode !== false,
          currentTurn: routeOptions?.currentTurn || null,
        });

        emitStage('recognizing_intent', { modelRole: 'primary' });
        let primaryError = null;
        let invalidModelOutput = false;
        try {
          const response = await requestWithinDeadline(payload);
          const route = response ? inspectResponse(response, 'primary') : null;
          intentDeadline.assertActive();
          if (route) return completeRoute(route, 'primary_model');
          invalidModelOutput = true;
        } catch (error) {
          if (isRouteCancellation(error, parentSignal, intentDeadline)) throw cancellationError(error);
          if (isRouteTimeout(error, intentDeadline)) return failRoute('route_model_timeout');
          primaryError = error;
          if (!routeErrorAllowsFallback(error)) return failRoute(routeErrorReason(error));
        }

        const canTryFallback = fallbackModel
          && fallbackModel !== primaryModel
          && config.baseUrl
          && (invalidModelOutput || routeErrorAllowsFallback(primaryError));
        let fallbackError = null;
        if (canTryFallback) {
          intentDeadline.assertActive();
          emitStage('retrying_route_model', { modelRole: 'fallback' });
          const fallbackPayload = routeSvc.buildRoutePayload({
            model: fallbackModel, input, attachments: attachmentMeta, context,
            currentMode: deps.state?.mode || 'chat',
            autoMode: deps.state?.autoMode !== false,
            currentTurn: routeOptions?.currentTurn || null,
          });
          try {
            const fallbackResponse = await requestWithinDeadline(fallbackPayload);
            const route = fallbackResponse ? inspectResponse(fallbackResponse, 'fallback') : null;
            intentDeadline.assertActive();
            if (route) return completeRoute(route, 'fallback_model');
            invalidModelOutput = true;
          } catch (error) {
            if (isRouteCancellation(error, parentSignal, intentDeadline)) throw cancellationError(error);
            if (isRouteTimeout(error, intentDeadline)) return failRoute('route_model_timeout');
            fallbackError = error;
          }
        }

        // Every unavailable, timed-out, or non-canonical intent-model result
        // fails closed. No local route or plain-chat semantic fallback is allowed.
        if (fallbackError) return failRoute(routeErrorReason(fallbackError));
        if (invalidModelOutput) return completeRoute(intentFailureRoute('route_intent_invalid'), 'invalid_model_output');
        if (primaryError) return failRoute(routeErrorReason(primaryError));
        console.warn('[route] All intent models failed; execution is blocked');
        return failRoute('route_models_unavailable');

      } catch (error) {
        if (isRouteCancellation(error, parentSignal, intentDeadline)) throw cancellationError(error);
        if (isRouteTimeout(error, intentDeadline)) return failRoute('route_model_timeout');
        if (error?.code === 'ROUTE_CONTEXT_BUILD_FAILED') return failRoute('route_context_unavailable', 'route_context');
        return failRoute(routeErrorReason(error));
      } finally {
        intentDeadline.dispose();
      }
    }


    // Intent requests use the shared OpenAI-compatible request adapter.
    async function requestRouteIntent(payload, config, headers, signal, routeOptions = null, beforeAttempt = null) {
      const baseUrl = String(config?.baseUrl || '').replace(/\/+$/, '');
      const apiUrl = `${baseUrl}/chat/completions`;
      const assertAttemptActive = () => {
        if (typeof beforeAttempt === 'function') beforeAttempt();
      };
      const request = typeof deps.requestJson === 'function'
        ? nextPayload => {
          assertAttemptActive();
          return deps.requestJson(apiUrl, nextPayload, config.apiKey, {
            method: 'POST',
            headers: headers || {},
            signal,
            requestPurpose: 'intent_recognition',
            submissionId: routeOptions?.submissionId || '',
          });
        }
        : async nextPayload => {
          assertAttemptActive();
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
      let attempt = nextPayload => request(nextPayload);
      if (typeof requestJsonWithReasoningParamFallback === 'function') {
        const inner = attempt;
        attempt = nextPayload => requestJsonWithReasoningParamFallback(inner, nextPayload);
      }
      if (typeof requestJsonWithStructuredOutputFallback === 'function') {
        const inner = attempt;
        attempt = nextPayload => requestJsonWithStructuredOutputFallback(inner, nextPayload);
      }
      return attempt(payload);
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
