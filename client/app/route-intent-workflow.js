(function initChatUIRouteIntentWorkflow(root) {
  'use strict';

  const requestCompatibility = root?.[Symbol.for('chatui.module-registry.v1')]?.get('requestCompatibility')
    || (typeof require === 'function' ? require('../services/request-compatibility') : {});
  const requestJsonWithStructuredOutputFallback = requestCompatibility.requestJsonWithStructuredOutputFallback;
  const requestJsonWithReasoningParamFallback = requestCompatibility.requestJsonWithReasoningParamFallback;
  const requestJsonWithToolChoiceParamFallback = requestCompatibility.requestJsonWithToolChoiceParamFallback;
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
        if (round.originalReasoning && !payload?.reasoning_effort && !payload?.reasoning) {
          state.reasoning_fallback_attempts += 1;
        }
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

    // Compatibility is a capability negotiation, not a fresh Cartesian retry
    // matrix for every routing stage. Keep the learned profile private to this
    // workflow instance and key it by the actual endpoint/model pair.
    const compatibilityCapabilityCache = new Map();
    const compatibilityKey = (baseUrl = '', model = '') => `${String(baseUrl).replace(/\/+$/, '')}::${String(model || '').trim()}`;
    const compatibilityProfileFor = (baseUrl = '', model = '') => {
      const key = compatibilityKey(baseUrl, model);
      if (!compatibilityCapabilityCache.has(key)) compatibilityCapabilityCache.set(key, {});
      return compatibilityCapabilityCache.get(key);
    };

    // ── Route compilation context ─────────────────────────────────
    function routeCompilationOptions(_config = {}, mode = 'chat', autoMode = true) {
      return { currentMode: mode, autoMode };
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
        const routeDecision = routeSvc?.buildRouteDecision
          ? routeSvc.buildRouteDecision(route, { source, understandingShape, input, context })
          : null;
        let completed = route;
        if (route && typeof route === 'object') {
          if (Object.isExtensible(route)) {
            if (routeDecision) route.routeDecision = routeDecision;
            route.outcome = outcome;
            route.modelAttemptLedger = snapshot;
            route.modelCalls = snapshot.provider_attempts;
          } else {
            completed = {
              ...route,
              ...(routeDecision ? { routeDecision } : {}),
              outcome,
              modelAttemptLedger: snapshot,
              modelCalls: snapshot.provider_attempts,
            };
          }
        }
        const memorySession = deps.state?.sessions?.find(item => item.id === sessionId);
        if (memorySession && typeof routeSvc?.recordRouteMemory === 'function'
            && completed?.operationType && completed?.routeDecision) {
          memorySession.routeMemory = routeSvc.recordRouteMemory(memorySession, {
            input: String(input || ''),
            operation: completed.operationType,
            relation: completed.relation,
            task_shape: completed.taskShape,
            confidence: completed.routeDecision.confidence,
            source: completed.routeDecision.source,
          });
        }
        const operation = completed?.operationType || completed?.dispatchContract?.operation || '';
        // A multi-task plan must outlive the pending-clarification lifecycle so
        // a later selector turn ("做任务1") can still resolve to its task goal.
        if (completed?.multiTaskPlan) {
          const session = deps.state?.sessions?.find(item => item.id === sessionId);
          if (session) session.multiTaskPlan = completed.multiTaskPlan;
        }
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
          descriptor.requestPurpose || 'intent_recognition',
          descriptor,
        );
      });
      let config = {};
      let understandingShape = null;
      let understandingEvidence = null;

      try {
        intentDeadline.assertActive();
        emitStage('reading_context');
        try {
          context = routeContextOverride ? compactRouteContextForIntent(routeContextOverride) : buildRouteContext(sessionId);
          const memorySession = deps.state?.sessions?.find(item => item.id === sessionId);
          if (memorySession && typeof routeSvc?.routeMemoryContext === 'function') {
            const routeMemory = routeSvc.routeMemoryContext(memorySession);
            if (routeMemory.length) context = { ...context, route_memory: routeMemory };
          }
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
        // A retained multi-task plan makes a later selector turn ("做任务1")
        // resolvable to the concrete task goal. The plan is delivered through
        // clarification_context so it survives wire compaction and stays the
        // primary evidence while the selector dominates the turn.
        if (typeof routeSvc.isTaskSelectionInput === 'function' && routeSvc.isTaskSelectionInput(input)) {
          const session = deps.state?.sessions?.find(item => item.id === sessionId);
          if (session?.multiTaskPlan && Array.isArray(session.multiTaskPlan.tasks) && session.multiTaskPlan.tasks.length) {
            context = {
              ...context,
              clarification_context: {
                ...(context?.clarification_context || {}),
                multi_task_plan: session.multiTaskPlan,
              },
            };
          }
        }

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

        async function materializeImageInstruction(route, source = '') {
          if (!route
              || typeof routeSvc.requiresImageInstructionMaterialization !== 'function'
              || !routeSvc.requiresImageInstructionMaterialization(route)) return route;
          if (typeof routeSvc.buildImageInstructionPayload !== 'function'
              || typeof routeSvc.inspectImageInstructionResult !== 'function'
              || typeof routeSvc.applyMaterializedImageInstruction !== 'function'
              || typeof routeSvc.clarifyImageInstructionRoute !== 'function') {
            return routeFailureRoute(
              route,
              'image_instruction_materializer_unavailable',
              '本次未执行：图片执行指令物化模块不可用，请重试。',
            );
          }
          emitStage('materializing_image_instruction', { modelRole: 'primary', operation: route.operationType });
          const payload = routeSvc.buildImageInstructionPayload({
            model: primaryModel,
            input,
            route,
            attachments: attachmentMeta,
            context,
            currentTurn: routeOptions?.currentTurn || null,
          });
          try {
            intentDeadline.assertActive();
            const response = await requestWithinDeadline(payload, {
              phase: 'instruction_materialization',
              modelRole: 'primary',
              requestPurpose: 'image_instruction_materialization',
            });
            intentDeadline.assertActive();
            const raw = routeSvc.extractRouteText(response);
            const inspectionOptions = {
              userRequestEvidence: input,
              resolvedTask: route.userGoal || route.executionPrompt || route.dispatchContract?.arguments?.prompt || '',
            };
            let inspected = routeSvc.inspectImageInstructionResult(raw, inspectionOptions);
            // A structurally invalid echo is recoverable: make one model-driven
            // repair round with the rejected output as data, rather than editing
            // the provider instruction locally or asking the user to retry.
            if (!inspected?.materialization && inspected?.reason === 'image_instruction_echoed_source_request') {
              const repairPayload = routeSvc.buildImageInstructionPayload({
                model: primaryModel,
                input,
                route,
                attachments: attachmentMeta,
                context,
                currentTurn: routeOptions?.currentTurn || null,
                repair: {
                  reason: inspected.reason,
                  instruction: inspected.rejectedInstruction || '',
                },
              });
              const repairResponse = await requestWithinDeadline(repairPayload, {
                phase: 'instruction_materialization_repair',
                modelRole: 'primary',
                requestPurpose: 'image_instruction_materialization',
              });
              intentDeadline.assertActive();
              inspected = routeSvc.inspectImageInstructionResult(
                routeSvc.extractRouteText(repairResponse),
                inspectionOptions,
              );
            }
            if (!inspected?.materialization) {
              return routeFailureRoute(
                route,
                inspected?.reason || 'image_instruction_invalid',
                '本次未执行：无法得到有效的完整图片执行指令，请重试。',
              );
            }
            if (inspected.materialization.status === 'needs_clarification') {
              return routeSvc.clarifyImageInstructionRoute(route, inspected.materialization.clarification, {
                input, attachments: attachmentMeta, context,
              });
            }
            return routeSvc.applyMaterializedImageInstruction(route, inspected.materialization.instruction, { context });
          } catch (error) {
            if (isRouteCancellation(error, parentSignal, intentDeadline)) throw cancellationError(error);
            if (isRouteTimeout(error, intentDeadline)) return failRoute('route_model_timeout');
            if (error?.code === 'MODEL_CALL_BUDGET_EXCEEDED') return failRoute('model_calls_exceeded', 'model_call_budget');
            console.warn('[route] image instruction materialization failed', {
              name: String(error?.name || 'Error'),
              code: String(error?.code || 'IMAGE_INSTRUCTION_MATERIALIZATION_FAILED'),
            });
            return routeFailureRoute(
              route,
              routeErrorReason(error),
              '本次未执行：无法整理完整的图片执行指令，请重试。',
            );
          }
        }

        // Stage 2: materialize the provider-facing instruction for every ready
        // image route before either direct execution or multi-image decomposition.
        // The image provider never receives a raw conversational reference such as
        // “按方案A/照你说的/上述内容”.
        async function finalizeRoute(route, source = '') {
          const materializedRoute = await materializeImageInstruction(route, source);
          // Mixed multi-intent (understanding branch = multi_task_plan) must stay on
          // the multi-task path even when the route model labelled the operation as
          // an image op; otherwise non-image actions are dropped by the image plan.
          const forceMultiTaskPlan = understandingShape?.branch === 'multi_task_plan';
          const multiTaskRoute = forceMultiTaskPlan
            ? { ...materializedRoute, taskShape: 'multi', multiTask: true, needClarification: true, readiness: 'needs_clarification', dispatchContract: null, executionResources: null }
            : materializedRoute;
          if (forceMultiTaskPlan || (typeof routeSvc.shouldRequestMultiTaskPlan === 'function' && routeSvc.shouldRequestMultiTaskPlan(multiTaskRoute))) {
            emitStage('planning_multi_tasks', { modelRole: 'primary' });
            const goal = forceMultiTaskPlan ? String(input).trim() : String(materializedRoute.userGoal || input || '').trim();
            const planPayload = routeSvc.buildMultiTaskPlanPayload({
              model: primaryModel,
              input,
              goal,
              attachments: attachmentMeta,
              context,
              currentTurn: routeOptions?.currentTurn || null,
            });
            try {
              intentDeadline.assertActive();
              const response = await requestWithinDeadline(planPayload, { phase: 'planning', modelRole: 'primary', requestPurpose: 'multi_task_planning' });
              intentDeadline.assertActive();
              const raw = routeSvc.extractRouteText(response);
              let inspected = routeSvc.inspectMultiTaskPlan(raw);
              let planDisclaimer = '';
              // Model-offered plan issues are surfaced as selectable choices,
              // never as a hard rejection: the user asked for a task, so give them
              // the options (or ask them to restate) instead of "请重试".
              const restateQuestion = (q) => (
                typeof q === 'string' && q.length ? q : '请换一种表述，或明确本次要执行哪一步。'
              );
              const fallbackClarification = (baseRoute, question) => completeRoute({
                ...baseRoute,
                mode: 'chat', api: 'clarify', target: 'none', intent: 'clarify',
                needClarification: true, dispatchAuthorized: false, readiness: 'needs_clarification',
                dispatchContract: null, executionResources: null,
                clarificationQuestion: restateQuestion(question),
                clarificationSlots: [],
                multiTaskPlan: null, multiTaskPlanCompiled: null,
              }, source);
              if (!inspected?.plan && understandingShape && Array.isArray(understandingShape.actions) && understandingShape.actions.length && typeof routeSvc.buildFallbackMultiTaskPlan === 'function') {
                inspected = { plan: routeSvc.buildFallbackMultiTaskPlan(understandingShape.actions, { input }) };
                planDisclaimer = '未能从模型得到完整拆解，已根据理解到的步骤生成任务：\n';
              } else if (!inspected?.plan) {
                return fallbackClarification(materializedRoute, '无法将请求拆分为可执行任务，请换一种表述，或明确要执行的步骤（例如：总结这个文件 / 画一张图）。');
              }
              const disjunctionNote = /(?:或者|或|还是|要么)/.test(String(input))
                ? '请求包含“或/或者”，请选择你要执行的那一项。\n'
                : '';
              if (understandingShape && Array.isArray(understandingShape.actions) && understandingShape.actions.length
                  && typeof routeSvc.planCoversExpected === 'function'
                  && typeof routeSvc.expectedPlanTasks === 'function') {
                const expectedTasks = routeSvc.expectedPlanTasks(understandingShape.actions);
                if (!routeSvc.planCoversExpected(inspected.plan, expectedTasks)) {
                  if (typeof routeSvc.buildMultiTaskPlanRepairPayload === 'function') {
                    emitStage('repairing_route', { modelRole: 'primary' });
                    const repairPayload = routeSvc.buildMultiTaskPlanRepairPayload({
                      model: primaryModel, input, goal, attachments: attachmentMeta, context,
                      currentTurn: routeOptions?.currentTurn || null,
                      rejectedPlan: inspected.plan,
                      expectedSummary: expectedTasks,
                    });
                    const repairResponse = await requestWithinDeadline(repairPayload, { phase: 'planning_repair', modelRole: 'primary', requestPurpose: 'multi_task_planning' });
                    intentDeadline.assertActive();
                    const repairRaw = routeSvc.extractRouteText(repairResponse);
                    const repaired = routeSvc.inspectMultiTaskPlan(repairRaw);
                    if (repaired?.plan && routeSvc.planCoversExpected(repaired.plan, expectedTasks)) {
                      inspected = repaired;
                    }
                  }
                  if (!routeSvc.planCoversExpected(inspected.plan, expectedTasks) && understandingShape && Array.isArray(understandingShape.actions) && understandingShape.actions.length && typeof routeSvc.buildFallbackMultiTaskPlan === 'function') {
                    const fallback = routeSvc.buildFallbackMultiTaskPlan(understandingShape.actions, { input });
                    if (fallback && Array.isArray(fallback.tasks) && fallback.tasks.length >= 2) {
                      inspected = { plan: fallback };
                      planDisclaimer = '模型拆解与请求未完全对齐，已按理解到的步骤生成可选任务：\n';
                    } else {
                      planDisclaimer = '任务拆解与请求未完全对齐，以下为识别到的任务，请确认后再选择。\n';
                    }
                  } else if (!routeSvc.planCoversExpected(inspected.plan, expectedTasks)) {
                    planDisclaimer = '任务拆解与请求未完全对齐，以下为识别到的任务，请确认后再选择。\n';
                  }
                }
              }
              const compiled = routeSvc.compileMultiTaskPlan(inspected.plan, {
                input, attachments: attachmentMeta, context,
                ...routeCompilationOptions(config, deps.state?.mode || 'chat', deps.state?.autoMode !== false),
                relation: materializedRoute.relation,
                currentTurn: routeOptions?.currentTurn || null,
              });
              if (!compiled.ok) {
                return fallbackClarification(materializedRoute, '识别到多个任务但无法安全执行。请明确本次要执行哪一项，或换一种表述。');
              }
              const tasksSummary = inspected.plan.tasks.map((task, index) => `${index + 1}. ${String(task.description || '').trim()}`).join('\n');
              return completeRoute({
                ...materializedRoute,
                multiTaskPlan: inspected.plan,
                multiTaskPlanCompiled: compiled.items,
                clarificationQuestion: `${planDisclaimer}${disjunctionNote}识别到 ${inspected.plan.tasks.length} 个独立任务：\n${tasksSummary}\n请回复要执行的编号（一次只执行一个任务）。`.trim(),
                needClarification: true,
              }, source);
            } catch (error) {
              if (isRouteCancellation(error, parentSignal, intentDeadline)) throw cancellationError(error);
              if (isRouteTimeout(error, intentDeadline)) return failRoute('route_model_timeout');
              if (error?.code === 'MODEL_CALL_BUDGET_EXCEEDED') return failRoute('model_calls_exceeded', 'model_call_budget');
              console.warn('[route] multi-task plan model failed', {
                name: String(error?.name || 'Error'),
                code: String(error?.code || ''),
              });
              const reason = routeErrorReason(error);
              return completeRoute(routeFailureRoute(materializedRoute, reason, '多任务规划失败，请重试。'), source);
            }
          }

          if (forceMultiTaskPlan) {
            return completeRoute(materializedRoute, source);
          }
          if (!materializedRoute || materializedRoute.needClarification) {
            return completeRoute(materializedRoute, source);
          }
          if (typeof routeSvc.shouldRequestImagePlan !== 'function' || !routeSvc.shouldRequestImagePlan(materializedRoute)) {
            return completeRoute(materializedRoute, source);
          }
          emitStage('planning_image_tasks', { modelRole: 'primary' });
          const multiImageGoal = understandingShape && Array.isArray(understandingShape.actions) && understandingShape.actions.length > 1
            && !(typeof routeSvc.hasUnresolvedImageInstructionReference === 'function' && routeSvc.hasUnresolvedImageInstructionReference(String(input)));
          const goal = multiImageGoal
            ? String(input).trim()
            : String(materializedRoute.userGoal || materializedRoute.dispatchContract?.arguments?.prompt || input || '').trim();
          const singleActionTarget = understandingShape?.actions?.length === 1
            ? String(understandingShape.actions[0]?.target || '')
            : '';
          const expectedTaskCount = typeof routeSvc.maxExplicitImageResultCount === 'function'
            ? routeSvc.maxExplicitImageResultCount(input, '', singleActionTarget)
            : (typeof routeSvc.explicitImageResultCount === 'function'
              ? routeSvc.explicitImageResultCount(input)
              : 0);
          const planPayload = routeSvc.buildImagePlanPayload({
            model: primaryModel,
            input,
            goal,
            attachments: attachmentMeta,
            context,
            currentTurn: routeOptions?.currentTurn || null,
            expectedTaskCount: expectedTaskCount,
          });
          try {
            intentDeadline.assertActive();
            const response = await requestWithinDeadline(planPayload, { phase: 'planning', modelRole: 'primary', requestPurpose: 'image_planning' });
            intentDeadline.assertActive();
            const raw = routeSvc.extractRouteText(response);
            let inspected = routeSvc.inspectImagePlanResult(raw);
            if (!inspected?.plan) {
              return completeRoute(routeFailureRoute(
                materializedRoute,
                'image_plan_invalid',
                '本次未执行：多图任务规划模型返回了无效结构，请重试。',
              ), source);
            }
            if (expectedTaskCount >= 2
                && Array.isArray(inspected.plan.tasks)
                && inspected.plan.tasks.length !== expectedTaskCount
                && typeof routeSvc.buildImagePlanRepairPayload === 'function') {
              emitStage('repairing_route', { modelRole: 'primary' });
              const repairPayload = routeSvc.buildImagePlanRepairPayload({
                model: primaryModel,
                input,
                goal,
                attachments: attachmentMeta,
                context,
                currentTurn: routeOptions?.currentTurn || null,
                expectedTaskCount: expectedTaskCount,
                rejectedPlan: inspected.plan,
              });
              const repairResponse = await requestWithinDeadline(repairPayload, { phase: 'planning_repair', modelRole: 'primary', requestPurpose: 'image_planning' });
              intentDeadline.assertActive();
              const repairRaw = routeSvc.extractRouteText(repairResponse);
              const repaired = routeSvc.inspectImagePlanResult(repairRaw);
              if (repaired?.plan && Array.isArray(repaired.plan.tasks) && repaired.plan.tasks.length === expectedTaskCount) {
                inspected = repaired;
              }
            }
            if (expectedTaskCount >= 2
                && Array.isArray(inspected.plan.tasks)
                && inspected.plan.tasks.length !== expectedTaskCount) {
              return completeRoute(routeFailureRoute(
                materializedRoute,
                'image_plan_not_faithful',
                '本次未执行：多图任务规划数量与请求不一致，请重试。',
              ), source);
            }
            const compiled = routeSvc.compileImagePlan(inspected.plan, {
              input,
              attachments: attachmentMeta,
              context,
              ...routeCompilationOptions(config, deps.state?.mode || 'chat', deps.state?.autoMode !== false),
              relation: materializedRoute.relation,
              currentTurn: routeOptions?.currentTurn || null,
            });
            if (!compiled.ok) {
              return completeRoute(imagePlanFailureRoute(materializedRoute, compiled.question || '多图任务无法执行，请调整后重试。'), source);
            }
            if (compiled.kind === 'single') {
              return completeRoute({
                ...(compiled.item.route || materializedRoute),
                taskShape: 'single',
                imagePlan: null,
                imagePlanCompiled: null,
              }, source);
            }
            return completeRoute({
              ...materializedRoute,
              // The planning envelope deliberately has no parent dispatch contract
              // and therefore is not authorized. Once every child has been compiled
              // and validated, the batch itself is the executable route. Keep the
              // parent contract empty, but mark the route authorized so the generic
              // outcome normalizer does not misclassify this valid batch as an
              // invalid model result before the submit workflow can hand it off.
              dispatchAuthorized: true,
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
            return completeRoute(routeFailureRoute(materializedRoute, reason, imagePlanRequestFailureQuestion(error)), source);
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
              taskShapeOverride: understandingShape?.taskShape,
              understandingBranch: understandingShape?.branch,
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

        const deterministicEmptyAttachmentSet = typeof routeSvc.compileEmptyCurrentAttachmentSetRoute === 'function'
          ? routeSvc.compileEmptyCurrentAttachmentSetRoute({
            input, attachments: attachmentMeta, context,
            ...routeCompilationOptions(config, deps.state?.mode || 'chat', deps.state?.autoMode !== false),
            currentTurn: routeOptions?.currentTurn || null,
          })
          : null;
        if (deterministicEmptyAttachmentSet?.route) {
          emitStage('recognizing_intent', { modelRole: 'deterministic' });
          return finalizeRoute(deterministicEmptyAttachmentSet.route, 'empty_current_attachment_set');
        }

        // Empty submission with no usable resource and no quoted anchor is a
        // clarification, not a plain_chat fallback: there is nothing to execute.
        if (!String(input).trim()
            && !(Array.isArray(attachmentMeta) && attachmentMeta.length)
            && !(typeof routeSvc.hasQuotedEvidence === 'function' && routeSvc.hasQuotedEvidence(context))) {
          emitStage('recognizing_intent', { modelRole: 'deterministic' });
          return completeRoute({
            mode: 'chat', api: 'clarify', intent: 'clarify', target: 'none',
            operationType: 'plain_chat', operationApi: 'chat', operationMode: 'chat',
            relation: 'new', goalMode: 'replace',
            needClarification: true, dispatchAuthorized: false, readiness: 'needs_clarification',
            dispatchContract: null, executionResources: null,
            clarificationQuestion: '请输入要执行的内容，或上传图片/文件后再试。',
            clarificationSlots: [],
            resources: [],
          }, 'empty_no_resources');
        }

        // A task selector ("2", "任务二", "第2个任务") is a deterministic lookup
        // into the already-generated multi-task plan. The intent model is
        // unreliable at mapping a number to its task (it can answer task 1 for
        // "2"), so resolve the selected task locally and skip the model call.
        const selectorSession = deps.state?.sessions?.find(item => item.id === sessionId);
        const selectorPlan = (typeof routeSvc.isTaskSelectionInput === 'function' && routeSvc.isTaskSelectionInput(input))
          ? (selectorSession?.multiTaskPlan
              || context?.multi_task_plan
              || context?.clarification_context?.multi_task_plan)
          : null;
        if (selectorPlan && Array.isArray(selectorPlan.tasks) && selectorPlan.tasks.length) {
          const selectorIndex = typeof routeSvc.selectedMultiTaskIndex === 'function'
            ? routeSvc.selectedMultiTaskIndex(input)
            : 0;
          if (selectorIndex >= 1 && selectorIndex <= selectorPlan.tasks.length) {
            emitStage('recognizing_intent', { modelRole: 'deterministic' });
            const compiled = typeof routeSvc.compileSelectedPlanTask === 'function'
              ? routeSvc.compileSelectedPlanTask(selectorPlan, selectorIndex, {
                  input,
                  attachments: attachmentMeta,
                  context,
                  ...routeCompilationOptions(config, deps.state?.mode || 'chat', deps.state?.autoMode !== false),
                  relation: routeContextOverride?.relation || 'new',
                  currentTurn: routeOptions?.currentTurn || null,
                })
              : null;
            if (compiled?.ok && compiled.route) {
              return finalizeRoute(compiled.route, 'multi_task_selector');
            }
            return completeRoute(routeFailureRoute(
              { operationType: String(selectorPlan.tasks[selectorIndex - 1]?.operation || ''), taskShape: 'single' },
              'multi_task_selector_compile_failed',
              '所选任务无法安全执行，请重试。',
            ), 'multi_task_selector');
          }
          return completeRoute({
            operationType: String(selectorPlan.tasks[0]?.operation || ''),
            taskShape: 'single',
            needClarification: true,
            readiness: 'needs_clarification',
            dispatchAuthorized: false,
            clarificationQuestion: '编号无效。请输入 1 到 ' + selectorPlan.tasks.length + ' 之间的编号（一次只执行一个任务）。',
          }, 'multi_task_selector');
        }

        // Phase 1: run the understand thinking node for inputs that need
        // deictic resolution or may contain several ordered actions. Its
        // deterministic Shape Compiler result overrides the route model's
        // task_shape so multi-intent requests split reliably.
        const shouldUnderstand = typeof routeSvc.shouldRunUnderstanding === 'function' && routeSvc.shouldRunUnderstanding(input, attachments, context);
        if (shouldUnderstand) {
          emitStage('understanding');
          try {
            intentDeadline.assertActive();
            const understandingPayload = routeSvc.buildUnderstandingPayload({
              model: primaryModel,
              input,
              attachments: attachmentMeta,
              context,
              currentTurn: routeOptions?.currentTurn || null,
            });
            const understandingResponse = await requestWithinDeadline(understandingPayload, {
              phase: 'understanding', modelRole: 'primary', requestPurpose: 'intent_understanding',
            });
            intentDeadline.assertActive();
            const understandingRaw = routeSvc.extractRouteText(understandingResponse);
            let inspected = typeof routeSvc.inspectUnderstandingResult === 'function'
              ? routeSvc.inspectUnderstandingResult(understandingRaw, {
        input,
        attachments: attachmentMeta,
        context,
        currentTurn: routeOptions?.currentTurn || null,
      })
              : null;
            if (!inspected?.understanding && typeof routeSvc.buildUnderstandingRepairPayload === 'function') {
              emitStage('repairing_route', { modelRole: 'primary' });
              const repairPayload = routeSvc.buildUnderstandingRepairPayload({
                model: primaryModel,
                input,
                attachments: attachmentMeta,
                context,
                currentTurn: routeOptions?.currentTurn || null,
                rejectedOutput: understandingRaw,
                reasons: [inspected?.reason || 'intent_understanding_invalid'],
              });
              const repairResponse = await requestWithinDeadline(repairPayload, {
                phase: 'understanding_repair', modelRole: 'primary', requestPurpose: 'intent_understanding',
              });
              intentDeadline.assertActive();
              const repairRaw = routeSvc.extractRouteText(repairResponse);
              const repaired = routeSvc.inspectUnderstandingResult(repairRaw, {
                input,
                attachments: attachmentMeta,
                context,
                currentTurn: routeOptions?.currentTurn || null,
              });
              if (repaired?.understanding) inspected = repaired;
            }
            if (inspected?.understanding && typeof routeSvc.compileUnderstandingShape === 'function') {
              const compiled = routeSvc.compileUnderstandingShape(inspected.understanding.actions, input);
              if (compiled && Array.isArray(compiled.actions) && compiled.actions.length) {
                emitStage('compiling_shape');
                understandingShape = compiled;
                understandingEvidence = inspected.understanding;
              }
            }
          } catch (error) {
            if (isRouteCancellation(error, parentSignal, intentDeadline)) throw cancellationError(error);
            if (isRouteTimeout(error, intentDeadline)) return failRoute('route_model_timeout');
            // Understanding is best-effort evidence; the route node still runs.
            console.warn('[route] understanding node failed', {
              name: String(error?.name || 'Error'),
              code: String(error?.code || 'INTENT_UNDERSTANDING_FAILED'),
            });
          }
        }

        const routeSystemPrompt = understandingShape
          ? routeSvc.ROUTE_NODE_SYSTEM_PROMPT_COMPACT
          : (shouldUnderstand ? null : routeSvc.ROUTE_NODE_SYSTEM_PROMPT_SIMPLE);
        const routeUnderstandingEvidence = understandingShape ? understandingEvidence : null;
        emitStage('recognizing_intent', { modelRole: 'primary' });
        const semanticIssuesFor = candidate => (candidate && typeof routeSvc.routeIntentSemanticIssues === 'function')
          ? routeSvc.routeIntentSemanticIssues(candidate, {
            input, attachments: attachmentMeta, context, understandingShape,
          })
          : [];
        const rawIntentIssuesFor = raw => (raw && typeof routeSvc.routeIntentSemanticIssuesForIntent === 'function')
          ? routeSvc.routeIntentSemanticIssuesForIntent(raw, { input, attachments: attachmentMeta, context, understandingShape })
          : [];
        const issuesFor = (route, raw) => [...semanticIssuesFor(route), ...rawIntentIssuesFor(raw)];


        // One route attempt with bounded targeted repair, shared by the primary
        // and fallback models so no model can bypass semantic consistency checks.
        async function requestRouteWithRepair(model, modelRole) {
          const payload = routeSvc.buildRoutePayload({
            model, input, attachments: attachmentMeta, context,
            currentMode: deps.state?.mode || 'chat',
            autoMode: deps.state?.autoMode !== false,
            currentTurn: routeOptions?.currentTurn || null,
            ...(routeSystemPrompt ? { systemPrompt: routeSystemPrompt } : {}),
            ...(routeUnderstandingEvidence ? { understanding: routeUnderstandingEvidence } : {}),
          });
          const response = await requestWithinDeadline(payload, { phase: 'routing', modelRole, requestPurpose: modelRole === 'primary' ? 'intent_recognition' : 'route_fallback' });
          const raw = response ? routeSvc.extractRouteText(response) : '';
          let route = raw ? inspectResponse(response, modelRole) : null;
          intentDeadline.assertActive();
          if (route && !issuesFor(route, raw).length) {
            return { route, source: modelRole + '_model' };
          }
          // At most two targeted repair rounds. A structurally invalid output
          // starts with route_intent_invalid; a structurally valid output that
          // contradicts local evidence starts with its field-specific issues.
          let rejectedOutput = raw;
          for (let repairRound = 0;
               repairRound < 2 && rejectedOutput && typeof routeSvc.buildRouteRepairPayload === 'function';
               repairRound += 1) {
            const repairReasons = route ? issuesFor(route, rejectedOutput) : ['route_intent_invalid'];
            if (!repairReasons.length) break;
            emitStage('repairing_route', { modelRole });
            const repairPayload = routeSvc.buildRouteRepairPayload({
              model, input, attachments: attachmentMeta, context,
              currentMode: deps.state?.mode || 'chat',
              autoMode: deps.state?.autoMode !== false,
              currentTurn: routeOptions?.currentTurn || null,
              rejectedOutput,
              reasons: repairReasons,
              ...(routeSystemPrompt ? { systemPrompt: routeSystemPrompt } : {}),
              ...(routeUnderstandingEvidence ? { understanding: routeUnderstandingEvidence } : {}),
            });
            const repairResponse = await requestWithinDeadline(repairPayload, { phase: 'routing_repair', modelRole, requestPurpose: 'route_repair', repairReasons });
            intentDeadline.assertActive();
            rejectedOutput = repairResponse ? routeSvc.extractRouteText(repairResponse) : '';
            route = rejectedOutput ? inspectResponse(repairResponse, modelRole) : null;
            if (route && !issuesFor(route, rejectedOutput).length) {
              return { route, source: modelRole + '_repair' };
            }
          }
          return { route: null, source: null };
        }

        let primaryError = null;
        let invalidModelOutput = false;
        try {
          const result = await requestRouteWithRepair(primaryModel, 'primary');
          if (result.route) return finalizeRoute(result.route, result.source);
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
          try {
            const result = await requestRouteWithRepair(fallbackModel, 'fallback');
            if (result.route) return finalizeRoute(result.route, result.source);
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


    // Intent recognition, instruction materialization, and image-plan calls are
    // one-shot JSON requests. Their transport is Responses-only; compatibility
    // negotiation may adjust rejected request parameters, but never changes API.
    async function requestRouteIntent(payload, config, headers, signal, routeOptions = null, beforeAttempt = null, requestPurpose = 'intent_recognition', controlMetadata = {}) {
      const baseUrl = String(config?.baseUrl || '').replace(/\/+$/, '');
      const compatibilityProfile = compatibilityProfileFor(baseUrl, payload?.model || config?.routeModel || config?.chatModel);
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
            requestPurpose,
            submissionId: routeOptions?.submissionId || '',
            ...(Array.isArray(controlMetadata.repairReasons) && controlMetadata.repairReasons.length
              ? { repairReasons: controlMetadata.repairReasons } : {}),
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
          attempt = body => requestJsonWithReasoningParamFallback(inner, body, compatibilityProfile);
        }
        if (typeof requestJsonWithToolChoiceParamFallback === 'function') {
          const inner = attempt;
          attempt = body => requestJsonWithToolChoiceParamFallback(inner, body, compatibilityProfile);
        }
        if (typeof requestJsonWithStructuredOutputFallback === 'function') {
          const inner = attempt;
          attempt = body => requestJsonWithStructuredOutputFallback(inner, body, compatibilityProfile, { modelId: body?.model });
        }
        return attempt(nextPayload);
      };

      // Control-model routing is deliberately Responses-only. A successful
      // route must never be retried through Chat Completions merely because a
      // gateway has a transport-specific defect; surface that Responses error
      // instead and keep duplicate-request analysis tied to one API family.
      return requestWithCompatibility(`${baseUrl}/responses`, payload, { transportApi: 'responses' });
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
