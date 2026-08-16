(function initChatUIRouteIntentWorkflow(root) {
  'use strict';

  const requestCompatibility = root?.[Symbol.for('chatui.module-registry.v1')]?.get('requestCompatibility')
    || (typeof require === 'function' ? require('../services/request-compatibility') : {});
  const requestJsonWithStructuredOutputFallback = requestCompatibility.requestJsonWithStructuredOutputFallback;
  const requestJsonWithReasoningParamFallback = requestCompatibility.requestJsonWithReasoningParamFallback;
  const isNonStreamingResponsesEmptyStreamChunks = requestCompatibility.isNonStreamingResponsesEmptyStreamChunks;
  const chatCompletionsPayloadFromResponsesPayload = requestCompatibility.chatCompletionsPayloadFromResponsesPayload;
  const submitWorkflowPolicy = root?.[Symbol.for('chatui.module-registry.v1')]?.get('submitWorkflowPolicy')
    || (typeof require === 'function' ? require('./submit-workflow-policy') : {});
  const createBoundedIntentRequest = submitWorkflowPolicy.createBoundedIntentRequest;
  const createIntentPipelineCancellation = submitWorkflowPolicy.createIntentPipelineCancellation;
  const ROUTE_OUTCOMES = submitWorkflowPolicy.ROUTE_OUTCOMES;
  const normalizeRouteOutcome = submitWorkflowPolicy.normalizeRouteOutcome;
  const executionStatus = root?.[Symbol.for('chatui.module-registry.v1')]?.get('executionStatus')
    || (typeof require === 'function' ? require('./execution-status') : {});
  const taskConstantsModule = root?.[Symbol.for('chatui.module-registry.v1')]?.get('taskConstants')
    || root?.ChatUITaskConstants
    || (typeof require === 'function' ? require('../../shared/task-constants') : {});

  const MAX_MODEL_CALLS = Number(taskConstantsModule.MAX_MODEL_CALLS) || 6;
  const MODEL_ATTEMPT_LEDGER_VERSION = 'route_model_attempt_ledger.v1';

  function nonNegativeInteger(value = 0) {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? Math.floor(number) : 0;
  }

  function createModelAttemptBudgetError() {
    const error = new Error('Route model provider-attempt budget exceeded');
    error.code = 'MODEL_CALL_BUDGET_EXCEEDED';
    error.modelCallBudgetExceeded = true;
    return error;
  }

  function createModelAttemptLedger(seed = null, legacyCalls = 0) {
    const source = seed && typeof seed === 'object' && !Array.isArray(seed) ? seed : {};
    const migratedProviderAttempts = Math.max(
      nonNegativeInteger(source.provider_attempts),
      nonNegativeInteger(legacyCalls),
    );
    const state = {
      schema_version: MODEL_ATTEMPT_LEDGER_VERSION,
      max_provider_attempts: MAX_MODEL_CALLS,
      logical_rounds: nonNegativeInteger(source.logical_rounds),
      provider_attempts: migratedProviderAttempts,
      primary_attempts: nonNegativeInteger(source.primary_attempts)
        || (Object.keys(source).length ? 0 : migratedProviderAttempts),
      fallback_attempts: nonNegativeInteger(source.fallback_attempts),
      planning_attempts: nonNegativeInteger(source.planning_attempts),
      compatibility_attempts: nonNegativeInteger(source.compatibility_attempts),
      reasoning_fallback_attempts: nonNegativeInteger(source.reasoning_fallback_attempts),
      format_fallback_attempts: nonNegativeInteger(source.format_fallback_attempts),
    };
    const formatKey = payload => String(payload?.text?.format?.type || payload?.response_format?.type || 'plain');
    return Object.freeze({
      beginRound(descriptor = {}, payload = {}) {
        if (state.provider_attempts >= MAX_MODEL_CALLS) throw createModelAttemptBudgetError();
        state.logical_rounds += 1;
        return {
          phase: String(descriptor.phase || 'routing'),
          modelRole: String(descriptor.modelRole || 'primary'),
          providerAttempts: 0,
          originalReasoning: !!(payload?.reasoning_effort || payload?.reasoning),
          originalFormat: formatKey(payload),
        };
      },
      recordProviderAttempt(round = {}, payload = {}, metadata = {}) {
        if (state.provider_attempts >= MAX_MODEL_CALLS) throw createModelAttemptBudgetError();
        round.providerAttempts = nonNegativeInteger(round.providerAttempts) + 1;
        state.provider_attempts += 1;
        if (round.phase === 'planning') state.planning_attempts += 1;
        else if (round.modelRole === 'fallback') state.fallback_attempts += 1;
        else state.primary_attempts += 1;
        if (round.providerAttempts > 1) state.compatibility_attempts += 1;
        // Responses -> Chat Completions transport fallback intentionally omits
        // Responses-only reasoning fields. It is not a reasoning capability
        // rejection and must not inflate the reasoning fallback counter.
        if (round.originalReasoning && !payload?.reasoning_effort && !payload?.reasoning
            && metadata?.transportFallback !== true) state.reasoning_fallback_attempts += 1;
        if (formatKey(payload) !== round.originalFormat) state.format_fallback_attempts += 1;
      },
      snapshot() { return Object.freeze({ ...state }); },
    });
  }

  const INTENT_DEADLINE_MS = Number(submitWorkflowPolicy.INTENT_PIPELINE_DEADLINE_MS);

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

    function routeFailureOutcome(reason = '') {
      const normalized = String(reason || '').trim();
      if (['route_intent_invalid', 'image_plan_invalid'].includes(normalized)) {
        return ROUTE_OUTCOMES.INVALID_MODEL_OUTPUT;
      }
      if ([
        'route_model_unconfigured',
        'route_model_auth_error',
        'route_model_request_rejected',
        'route_input_too_long',
        'route_context_too_large',
        'route_service_unavailable',
      ].includes(normalized)) return ROUTE_OUTCOMES.CONFIGURATION_ERROR;
      return ROUTE_OUTCOMES.TRANSIENT_ERROR;
    }

    function routeFailureRoute(baseRoute = {}, reason = 'route_models_unavailable', message = '') {
      const normalizedReason = String(reason || 'route_models_unavailable').trim();
      const outcome = routeFailureOutcome(normalizedReason);
      const outcomeMessage = String(message || '本次未执行：意图模型当前不可用。请重试；若持续出现，请检查配置或更换意图模型。').trim();
      return {
        ...baseRoute,
        mode: 'chat', api: 'route_error', target: 'none', intent: 'route_error',
        outcome,
        outcomeMessage,
        retryable: outcome === ROUTE_OUTCOMES.TRANSIENT_ERROR,
        needClarification: false, dispatchAuthorized: false, readiness: 'failed',
        operationType: baseRoute.operationType || 'plain_chat',
        operationApi: baseRoute.operationApi || 'chat',
        operationMode: baseRoute.operationMode || 'chat',
        relation: baseRoute.relation || 'new',
        confidence: 0,
        resources: Array.isArray(baseRoute.resources) ? baseRoute.resources : [],
        executionResources: null,
        dispatchContract: null,
        imageRefs: Array.isArray(baseRoute.imageRefs) ? baseRoute.imageRefs : [],
        fileRefs: Array.isArray(baseRoute.fileRefs) ? baseRoute.fileRefs : [],
        messageRefs: Array.isArray(baseRoute.messageRefs) ? baseRoute.messageRefs : [],
        selectedIndexes: [], selectedImageIndexes: [], selectedFileIndexes: [],
        selectedImageIds: [], selectedReferenceId: '', usePreviousImage: false,
        contextualImagePrompt: '', editInstruction: '', evidence: normalizedReason,
        // Legacy presentation readers may still inspect clarificationQuestion;
        // outcome is the sole state discriminator and this text never creates a
        // pending clarification.
        clarificationQuestion: outcomeMessage,
        clarificationSlots: [],
        localClarification: false,
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
        route_context_too_large: '本次未执行：当前输入或已引用内容超过意图模型上下文窗口。请缩短当前内容或减少引用后重试。',
        route_input_too_long: '本次未执行：输入内容超过单条消息限制。请改为上传文本文件或分段发送。',
        route_service_unavailable: '本次未执行：意图路由服务当前不可用。请刷新页面后重试。',
        model_calls_exceeded: '本次未执行：本轮任务模型请求次数已达上限。请重试当前任务。',
      };
      const normalizedReason = String(reason || 'route_models_unavailable').trim();
      return routeFailureRoute({}, normalizedReason, messages[normalizedReason]);
    }

    function imagePlanFailureRoute(route = {}, question = '') {
      return {
        ...route,
        mode: 'chat',
        api: 'clarify',
        outcome: ROUTE_OUTCOMES.BUSINESS_CLARIFICATION,
        target: 'none',
        intent: 'clarify',
        needClarification: true,
        dispatchAuthorized: false,
        readiness: 'needs_clarification',
        dispatchContract: null,
        executionResources: null,
        clarificationQuestion: String(question || '多图任务规划失败，请重试。').trim(),
        clarificationSlots: [],
        imagePlan: null,
        imagePlanCompiled: null,
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
      if (error?.code === 'MODEL_CALL_BUDGET_EXCEEDED') return 'model_calls_exceeded';
      if (error?.code === 'INPUT_TOO_LONG') return 'route_input_too_long';
      if (error?.code === 'ROUTE_CONTEXT_REQUIRED_CONTENT_TOO_LARGE') return 'route_context_too_large';
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

    // The product task limit is enforced only by compileImagePlan. A request,
    // provider, or structured-output failure must never tell the user to reduce
    // task count: a legal five-task request would otherwise receive a false
    // over-limit diagnosis.
    function imagePlanRequestFailureQuestion(error) {
      const reason = routeErrorReason(error);
      const messages = {
        route_model_auth_error: '多图任务规划未完成：规划模型鉴权失败，请检查 Endpoint 和 API Key 权限后重试。',
        route_model_rate_limited: '多图任务规划未完成：规划模型请求受限，请稍后重试。',
        route_model_request_rejected: '多图任务规划未完成：规划模型拒绝了请求，请检查模型和接口配置后重试。',
        route_model_upstream_error: '多图任务规划未完成：规划模型服务异常，请稍后重试。',
        route_model_network_error: '多图任务规划未完成：无法连接规划模型服务，请检查网络后重试。',
      };
      return messages[reason] || '多图任务规划请求失败，请重试。';
    }

    function isRouteCancellation(error, parentSignal = null, deadline = null) {
      return parentSignal?.aborted === true
        || deadline?.cancelled === true
        || error?.code === 'ROUTE_INTENT_CANCELLED';
    }

    function isRouteTimeout(error, deadline = null) {
      return deadline?.timedOut === true || error?.code === 'ROUTE_INTENT_TIMEOUT';
    }

    // Route context builder. All trimming and required-content protection live
    // in the core route-context policy; this workflow only supplies model-window
    // configuration and treats policy failure as a typed route outcome.
    function routeContextCore() {
      const core = root?.ChatUICore?.imageRouteContext
        || root?.ChatUICoreImageRouteContext
        || (typeof require === 'function' ? require('../core/image-route-context') : null);
      if (typeof core?.buildRouteContext !== 'function'
          || typeof core?.applyRouteContextPolicy !== 'function') {
        throw new TypeError('Canonical route context policy is unavailable');
      }
      return core;
    }

    function routeContextPolicyOptions() {
      const config = typeof getConfig === 'function' ? getConfig() : {};
      return { contextWindowTokens: config?.context?.windowTokens };
    }

    function compactRouteContextForIntent(context = {}) {
      try {
        return routeContextCore().applyRouteContextPolicy(context, routeContextPolicyOptions());
      } catch (error) {
        if (error?.code === 'ROUTE_CONTEXT_REQUIRED_CONTENT_TOO_LARGE') throw error;
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
        const contextModule = routeContextCore();
        const contextWindowTokens = routeContextPolicyOptions().contextWindowTokens;
        const context = contextModule.buildRouteContext({
          messages,
          lastGeneratedImage: compactLastGenerated,
          latestUploadedImage: compactLatestUpload,
          latestImageReference,
          recentImageReferences,
          contextWindowTokens,
        });
        const compactedContext = compactRouteContextForIntent(context);
        const memoryBuilder = contextModule.buildImageMemoryCards;
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
        if (error?.code === 'ROUTE_CONTEXT_REQUIRED_CONTENT_TOO_LARGE') throw error;
        if (error?.code === 'ROUTE_CONTEXT_BUILD_FAILED') throw error;
        throw createRouteContextError(error);
      }
    }

    // ── Main route function ───────────────────────────────────────
    async function getEffectiveRoute(input, attachments = [], sessionId = '', headers = null, routeContextOverride = null, routeOptions = null) {
      // One task owns one provider-attempt ledger. Compatibility fallbacks are
      // real HTTP requests, so they are counted at the request boundary rather
      // than at the outer routing/planning call site. The serialized snapshot is
      // carried by pending clarification state and resumed on the next round.
      const attemptLedger = createModelAttemptLedger(
        routeOptions?.modelAttemptLedger,
        routeOptions?.modelCalls,
      );
      const routeSvc = root.ChatUIRouteService || root.window?.ChatUIRouteService;
      const emitStage = (stage, details = {}) => executionStatus.emitRouteStage?.(routeOptions, stage, details);
      const completeRoute = (route, source = '') => {
        const snapshot = attemptLedger.snapshot();
        const outcome = typeof normalizeRouteOutcome === 'function'
          ? normalizeRouteOutcome(route)
          : route?.needClarification ? 'business_clarification' : 'ready';
        let completed = route;
        if (route && typeof route === 'object') {
          if (Object.isExtensible(route)) {
            route.outcome = outcome;
            route.modelAttemptLedger = snapshot;
            route.modelCalls = snapshot.provider_attempts;
          } else {
            completed = { ...route, outcome, modelAttemptLedger: snapshot, modelCalls: snapshot.provider_attempts };
          }
        }
        const operation = completed?.operationType || completed?.dispatchContract?.operation || '';
        if (outcome === ROUTE_OUTCOMES.BUSINESS_CLARIFICATION) emitStage('preparing_clarification', { source, operation });
        else if (outcome === ROUTE_OUTCOMES.READY) emitStage('route_ready', { source, operation });
        else emitStage('route_failed', { source, operation, outcome });
        return completed;
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
      const cancellationError = error => {
        const cancelled = error?.code === 'ROUTE_INTENT_CANCELLED'
          ? error
          : createIntentPipelineCancellation();
        cancelled.routeOutcome = ROUTE_OUTCOMES.CANCELLED;
        return cancelled;
      };
      const requestWithinDeadline = (payload, descriptor = {}) => intentDeadline.raceFactory(() => {
        const round = attemptLedger.beginRound(descriptor, payload);
        return requestRouteIntent(
          payload,
          config,
          headers || {},
          intentDeadline.signal,
          routeOptions,
          (nextPayload, requestMetadata = {}) => {
            intentDeadline.assertActive();
            attemptLedger.recordProviderAttempt(round, nextPayload, requestMetadata);
          },
        );
      });
      let config = {};

      try {
        intentDeadline.assertActive();
        emitStage('reading_context');
        try {
          context = routeContextOverride ? compactRouteContextForIntent(routeContextOverride) : buildRouteContext(sessionId);
        } catch (error) {
          if (error?.code === 'ROUTE_CONTEXT_REQUIRED_CONTENT_TOO_LARGE') {
            return failRoute('route_context_too_large', 'route_context');
          }
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

        // Stage 2: only multi-image routes pay for a second model call. The
        // planning model is authoritative for task decomposition and per-task
        // prompts; a one-task plan collapses back to the normal single path.
        async function finalizeRoute(route, source = '') {
          if (!route || typeof routeSvc.shouldRequestImagePlan !== 'function' || !routeSvc.shouldRequestImagePlan(route)) {
            return completeRoute(route, source);
          }
          emitStage('planning_image_tasks', { modelRole: 'primary' });
          const goal = String(route.userGoal || route.dispatchContract?.arguments?.prompt || input || '').trim();
          const planPayload = routeSvc.buildImagePlanPayload({
            model: primaryModel,
            input,
            goal,
            attachments: attachmentMeta,
            context,
            currentTurn: routeOptions?.currentTurn || null,
          });
          try {
            intentDeadline.assertActive();
            const response = await requestWithinDeadline(planPayload, { phase: 'planning', modelRole: 'primary' });
            intentDeadline.assertActive();
            const raw = routeSvc.extractRouteText(response);
            const inspected = routeSvc.inspectImagePlanResult(raw);
            if (!inspected?.plan) {
              return completeRoute(routeFailureRoute(
                route,
                'image_plan_invalid',
                '本次未执行：多图任务规划模型返回了无效结构，请重试。',
              ), source);
            }
            const compiled = routeSvc.compileImagePlan(inspected.plan, {
              input,
              attachments: attachmentMeta,
              context,
              ...routeCompilationOptions(config, deps.state?.mode || 'chat', deps.state?.autoMode !== false),
              relation: route.relation,
              currentTurn: routeOptions?.currentTurn || null,
            });
            if (!compiled.ok) {
              return completeRoute(imagePlanFailureRoute(route, compiled.question || '多图任务无法执行，请调整后重试。'), source);
            }
            if (compiled.kind === 'single') {
              return completeRoute({
                ...(compiled.item.route || route),
                taskShape: 'single',
                imagePlan: null,
                imagePlanCompiled: null,
              }, source);
            }
            return completeRoute({
              ...route,
              taskShape: 'multi',
              imagePlan: inspected.plan,
              imagePlanCompiled: compiled,
            }, source);
          } catch (error) {
            if (isRouteCancellation(error, parentSignal, intentDeadline)) throw cancellationError(error);
            if (isRouteTimeout(error, intentDeadline)) return failRoute('route_model_timeout');
            if (error?.code === 'MODEL_CALL_BUDGET_EXCEEDED') return failRoute('model_calls_exceeded', 'model_call_budget');
            console.warn('[route] image plan model failed', {
              name: String(error?.name || 'Error'),
              code: String(error?.code || ''),
            });
            const reason = routeErrorReason(error);
            return completeRoute(routeFailureRoute(route, reason, imagePlanRequestFailureQuestion(error)), source);
          }
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
          const response = await requestWithinDeadline(payload, { phase: 'routing', modelRole: 'primary' });
          const route = response ? inspectResponse(response, 'primary') : null;
          intentDeadline.assertActive();
          if (route) return finalizeRoute(route, 'primary_model');
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
            const fallbackResponse = await requestWithinDeadline(fallbackPayload, { phase: 'routing', modelRole: 'fallback' });
            const route = fallbackResponse ? inspectResponse(fallbackResponse, 'fallback') : null;
            intentDeadline.assertActive();
            if (route) return finalizeRoute(route, 'fallback_model');
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
        if (error?.code === 'ROUTE_CONTEXT_REQUIRED_CONTENT_TOO_LARGE') return failRoute('route_context_too_large', 'route_context');
        if (error?.code === 'ROUTE_CONTEXT_BUILD_FAILED') return failRoute('route_context_unavailable', 'route_context');
        return failRoute(routeErrorReason(error));
      } finally {
        intentDeadline.dispose();
      }
    }


    // Intent recognition and image-plan calls are one-shot JSON requests. Some
    // gateways have a broken non-streaming Responses implementation: they return
    // 500 "empty stream chunks" even when stream:false was sent. Keep Responses
    // as the primary API, but retry that exact gateway defect through the
    // non-streaming Chat Completions transport. This is never an SSE fallback.
    async function requestRouteIntent(payload, config, headers, signal, routeOptions = null, beforeAttempt = null) {
      const baseUrl = String(config?.baseUrl || '').replace(/\/+$/, '');
      const assertAttemptActive = (nextPayload, requestMetadata = {}) => {
        if (typeof beforeAttempt === 'function') beforeAttempt(nextPayload, requestMetadata);
      };
      const requestFor = (apiUrl, requestMetadata = {}) => (typeof deps.requestJson === 'function'
        ? nextPayload => {
          assertAttemptActive(nextPayload, requestMetadata);
          return deps.requestJson(apiUrl, nextPayload, config.apiKey, {
            method: 'POST',
            headers: headers || {},
            signal,
            requestPurpose: 'intent_recognition',
            submissionId: routeOptions?.submissionId || '',
          });
        }
        : async nextPayload => {
          assertAttemptActive(nextPayload, requestMetadata);
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
            let raw = '';
            let parsed = null;
            try {
              raw = await resp.text();
              parsed = raw ? JSON.parse(raw) : null;
            } catch {}
            const providerError = parsed?.error && typeof parsed.error === 'object' ? parsed.error : parsed;
            const err = new Error(String(providerError?.message || parsed?.message || raw || `Route model HTTP ${resp.status}`));
            err.statusCode = Number(resp.status) || 0;
            err.status = err.statusCode;
            err.code = String(providerError?.code || providerError?.type || 'HTTP_REQUEST_FAILED');
            throw err;
          }
          return resp.json();
        });

      const requestWithCompatibility = (apiUrl, nextPayload, requestMetadata = {}) => {
        // Keep structured-output compatibility fallback for endpoints/models that
        // reject json_schema, while preserving the application request adapter's
        // positional contract (url, payload, apiKey, options).
        let attempt = requestFor(apiUrl, requestMetadata);
        if (typeof requestJsonWithReasoningParamFallback === 'function') {
          const inner = attempt;
          attempt = body => requestJsonWithReasoningParamFallback(inner, body);
        }
        if (typeof requestJsonWithStructuredOutputFallback === 'function') {
          const inner = attempt;
          attempt = body => requestJsonWithStructuredOutputFallback(inner, body);
        }
        return attempt(nextPayload);
      };

      try {
        return await requestWithCompatibility(`${baseUrl}/responses`, payload, { transportApi: 'responses' });
      } catch (error) {
        if (typeof isNonStreamingResponsesEmptyStreamChunks !== 'function'
            || !isNonStreamingResponsesEmptyStreamChunks(error)
            || typeof chatCompletionsPayloadFromResponsesPayload !== 'function') throw error;
        const chatPayload = chatCompletionsPayloadFromResponsesPayload(payload);
        if (!chatPayload) throw error;
        return requestWithCompatibility(`${baseUrl}/chat/completions`, chatPayload, {
          transportApi: 'chat',
          transportFallback: true,
        });
      }
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

  const api = Object.freeze({
    MODEL_ATTEMPT_LEDGER_VERSION,
    createModelAttemptLedger,
    createRouteIntentWorkflow,
  });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.ChatUIAppRouteIntentWorkflow = api;
  if (root?.window) root.window.ChatUIAppRouteIntentWorkflow = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
