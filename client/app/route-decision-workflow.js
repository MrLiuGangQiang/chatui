(function initChatUIAppRouteDecisionWorkflow(root) {
  // Intentionally not strict: route decision bodies are migrated from app.js and resolved through a deps scope.

  function createRouteDecisionWorkflow(deps = {}) {
    if (!deps.state) throw new Error('state is required');

    function buildRouteContext(t=state.activeSessionId) {
      with (deps) {
        const s=state.sessions.find(e=>e.id===t),n=t===state.activeSessionId?state.messages:s?.messages||[],a=t===state.activeSessionId?state.lastGeneratedImage:s?.lastGeneratedImage,i=getLatestUploadedImageContext(t),o=latestImageReferenceMeta(t),r=a?{reference_id:makeImageReferenceId("latest"),prompt:String(a.prompt||"").slice(0,300),updated_at:a.updatedAt||null,count:Array.isArray(a.images)?a.images.length:a.src?1:0,candidates:(a.images||[]).map((e,t)=>({index:t+1,image_id:makeImageItemId(makeImageReferenceId("latest"),t+1),filename:e.filename||"",prompt:String(e.prompt||a.prompt||"").slice(0,80),labels:e.labels||[]}))}:null,l=i?{prompt:String(i.prompt||"").slice(0,300),count:i.attachments?.length||0,target:i.target||"uploaded",updated_at:i.updatedAt||null}:null,d=collectRecentImageReferences(t,6),config=getConfig(),contextWindowTokens=config?.context?.windowTokens,maxChars=Math.max(12000,Math.min(256*1024,Number(contextWindowTokens||0)*4||12000)),context=window.ChatUICore?.imageRouteContext?.buildRouteContext?window.ChatUICore.imageRouteContext.buildRouteContext({messages:n,lastGeneratedImage:r,latestUploadedImage:l,latestImageReference:o,recentImageReferences:d,maxChars,contextWindowTokens}):{recent_messages:n.map((e,t)=>({index:t+1,role:e.role,content:String(Array.isArray(e.content)?e.rawText||"[非文本消息]":e.content||e.rawText||"").slice(0,600)})),last_generated_image:r,latest_uploaded_image:l,latest_image_reference:o.target!=="none"?o:null,recent_image_references:d};return context;
      }
    }

    function compactTraceValue(value, max = 12000) {
      try {
        const json = JSON.stringify(value);
        if (json.length <= max) return value;
        return JSON.parse(json.slice(0, max));
      } catch {
        const text = String(value || '');
        return text.length > max ? `${text.slice(0, max)}…` : value;
      }
    }

    function summarizeIntentTrace(trace = {}) {
      const route = trace.finalRoute || trace.reviewRoute || trace.firstRoute || {};
      const contract = route.taskContract || trace.finalTaskContract || null;
      return {
        timestamp: new Date().toISOString(),
        mode: String(route.mode || ''),
        operationType: String(route.operationType || ''),
        confidence: Number.isFinite(Number(route.confidence)) ? Number(route.confidence) : null,
        api: String(trace.finalApi || route.api || ''),
        model: String(trace.model || ''),
        reviewed: !!trace.reviewed,
        fallbackAi: !!trace.fallbackAi,
        reviewErrorCode: trace.reviewError ? String(trace.reviewError).slice(0, 120) : '',
      };
    }

    function setIntentTrace(trace = {}) {
      const safe = summarizeIntentTrace(trace);
      try { root.__CHATUI_LAST_INTENT_TRACE__ = safe; } catch {}
      try { root.window && (root.window.__CHATUI_LAST_INTENT_TRACE__ = safe); } catch {}
      try { root.localStorage?.removeItem?.('chatui:lastIntentTrace'); } catch {}
      return safe;
    }

    function extractRouteText(routeSvc, response) {
      return routeSvc?.extractRouteText ? routeSvc.extractRouteText(response) : response?.choices?.[0]?.message?.content || response?.output_text || '';
    }

    function structuredOutputUnsupported(error) {
      const text = String(error?.message || error || '').toLowerCase();
      return /response_format|json_schema|structured.?output/.test(text)
        && /unsupported|not support|unknown|invalid parameter|unrecognized/.test(text);
    }

    async function requestRouteDecision(payload, config, headers, signal) {
      with (deps) {
        try {
          return await requestJson(`${config.baseUrl}/chat/completions`, payload, config.apiKey, { headers, signal });
        } catch (error) {
          // Strict structured output is the primary path. Some OpenAI-compatible
          // gateways do not implement it, so retain a bounded legacy path rather
          // than making an otherwise healthy route model unavailable.
          if (!payload?.response_format || !structuredOutputUnsupported(error)) throw error;
          const legacyPayload = { ...payload };
          delete legacyPayload.response_format;
          return await requestJson(`${config.baseUrl}/chat/completions`, legacyPayload, config.apiKey, { headers, signal });
        }
      }
    }

    function inspectRoute(routeSvc, raw, options) {
      if (typeof routeSvc?.inspectRouteResult === 'function') return routeSvc.inspectRouteResult(raw, options);
      const route = parseRouteResult(raw, options);
      return { route, reason: route ? '' : 'contract_shape' };
    }

    async function parseOrRepairRoute(routeSvc, { model, input, attachments, context, raw, config, headers, signal, requiredReadiness = '' }) {
      const options = { input, attachments, context };
      const mergeReadiness = (...values) => typeof routeSvc?.mergeRouteReadinessRequirement === 'function'
        ? routeSvc.mergeRouteReadinessRequirement(...values)
        : values.includes('needs_clarification') ? 'needs_clarification' : values.includes('ready') ? 'ready' : '';
      const satisfiesReadiness = route => typeof routeSvc?.routeSatisfiesReadiness === 'function'
        ? routeSvc.routeSatisfiesReadiness(route, readinessRequirement)
        : readinessRequirement !== 'needs_clarification' || route?.needClarification === true;
      let readinessRequirement = mergeReadiness(requiredReadiness, routeSvc?.readRouteReadiness?.(raw) || '');
      const initial = inspectRoute(routeSvc, raw, options);
      if (readinessRequirement === 'needs_clarification') {
        const terminalRoute = initial.route
          || routeSvc?.terminalClarificationRouteFromResult?.(raw, options)
          || invalidContractClarificationRoute();
        return {
          route: terminalRoute,
          reason: '',
          repaired: false,
          repairRaw: '',
          requiredReadiness: readinessRequirement,
          clarificationTerminal: true,
        };
      }
      if (initial.route && satisfiesReadiness(initial.route)) {
        return { ...initial, repaired: false, repairRaw: '', requiredReadiness: readinessRequirement };
      }
      const initialReason = initial.route ? 'readiness_transition_forbidden' : initial.reason;
      if (typeof routeSvc?.buildIntentRepairPayload !== 'function') {
        return { route: null, reason: initialReason, repaired: false, repairRaw: '', requiredReadiness: readinessRequirement };
      }
      const repairInvariants = routeSvc?.repairInvariantSnapshot?.(raw) || null;
      if (!repairInvariants) {
        return { route: null, reason: 'repair_invariants_unavailable', initialReason, repaired: false, repairRaw: '', requiredReadiness: readinessRequirement };
      }
      const repairPayload = routeSvc.buildIntentRepairPayload({
        model,
        input,
        attachments,
        context,
        previousOutput: raw,
        validationReason: initialReason,
        expectedReadiness: readinessRequirement,
      });
      const repairResponse = await requestRouteDecision(repairPayload, config, headers, signal);
      const repairRaw = extractRouteText(routeSvc, repairResponse);
      readinessRequirement = mergeReadiness(readinessRequirement, routeSvc?.readRouteReadiness?.(repairRaw) || '');
      const repaired = inspectRoute(routeSvc, repairRaw, options);
      if (repaired.route && routeSvc?.repairPreservesInvariants?.(repairInvariants, repaired.route) !== true) {
        return { route: null, reason: 'repair_semantic_drift', repaired: true, initialReason, repairRaw, requiredReadiness: readinessRequirement };
      }
      if (repaired.route && !satisfiesReadiness(repaired.route)) {
        return { route: null, reason: 'readiness_transition_forbidden', repaired: true, initialReason, repairRaw, requiredReadiness: readinessRequirement };
      }
      return { ...repaired, repaired: true, initialReason, repairRaw, requiredReadiness: readinessRequirement };
    }

    function createRouteCancelledError() {
      const error = new Error('ROUTE_CANCELLED');
      error.code = 'ROUTE_CANCELLED';
      error.name = 'AbortError';
      return error;
    }

    function throwIfRouteCancelled(signal) {
      if (signal?.aborted) throw createRouteCancelledError();
    }

    function isRouteCancelled(error, signal) {
      return !!signal?.aborted || error?.code === 'ROUTE_CANCELLED';
    }

    function createLinkedAbortController(signal = null) {
      const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
      if (!controller || !signal?.addEventListener) return { controller, dispose: () => {} };
      const abort = () => controller.abort();
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort, { once: true });
      return {
        controller,
        dispose: () => signal.removeEventListener?.('abort', abort),
      };
    }

    const DEFAULT_INTENT_DEADLINE_MS = 60000;

    function createIntentDeadline(parentSignal = null, timeoutMs = DEFAULT_INTENT_DEADLINE_MS) {
      const linked = createLinkedAbortController(parentSignal);
      const duration = Math.max(1, Number(timeoutMs) || DEFAULT_INTENT_DEADLINE_MS);
      const startedAt = Date.now();
      let timedOut = false;
      let disposed = false;
      let rejectTerminal = null;
      const timeoutError = () => {
        const error = new Error('ROUTE_INTENT_TIMEOUT');
        error.code = 'ROUTE_INTENT_TIMEOUT';
        error.routeTimedOut = true;
        error.timeoutMs = duration;
        return error;
      };
      const terminal = new Promise((resolve, reject) => {
        rejectTerminal = reject;
      });
      terminal.catch(() => {});
      const cancel = () => {
        if (!disposed) rejectTerminal?.(createRouteCancelledError());
      };
      if (parentSignal?.aborted) cancel();
      else parentSignal?.addEventListener?.('abort', cancel, { once: true });
      const timer = setTimeout(() => {
        if (disposed) return;
        timedOut = true;
        linked.controller?.abort?.();
        rejectTerminal?.(timeoutError());
      }, duration);
      return {
        signal: linked.controller?.signal || parentSignal || null,
        get timedOut() { return timedOut; },
        get elapsedMs() { return Math.max(0, Date.now() - startedAt); },
        get remainingMs() { return Math.max(0, duration - (Date.now() - startedAt)); },
        race: promise => Promise.race([Promise.resolve(promise), terminal]),
        timeoutError,
        dispose() {
          if (disposed) return;
          disposed = true;
          clearTimeout(timer);
          parentSignal?.removeEventListener?.('abort', cancel);
          linked.dispose();
        },
      };
    }

    function invalidRouteError(stage = 'primary') {
      const error = new Error('ROUTE_INVALID_CONTRACT');
      error.code = 'ROUTE_INVALID_CONTRACT';
      error.stage = stage;
      return error;
    }

    function invalidContractClarificationRoute() {
      // This route is deliberately local and non-executing.  An invalid model
      // response must never be repaired into a guessed operation or resource.
      return {
        mode: 'chat',
        api: 'clarify',
        target: 'none',
        intent: 'clarify',
        needClarification: true,
        clarificationQuestion: '本次未执行：意图模型返回了无效的任务结构。请重试；若持续出现，请更换意图模型。',
        confidence: 0,
        selectedIndexes: [],
        selectedImageIndexes: [],
        selectedFileIndexes: [],
        selectedImageIds: [],
        selectedReferenceId: '',
        imageRefs: [],
        fileRefs: [],
        taskContract: null,
        localClarification: true,
      };
    }

    function resolveRouteModels(sessionId, config = {}) {
      const sessionChatModel = typeof deps.getSessionChatModel === 'function'
        ? String(deps.getSessionChatModel(sessionId, config) || '').trim()
        : String(config.chatModel || '').trim();
      const primaryModel = typeof deps.getSessionRouteModel === 'function'
        ? String(deps.getSessionRouteModel(sessionId, config) || '').trim()
        : String(config.routeModel || '').trim() || sessionChatModel;
      return { primaryModel, sessionChatModel };
    }

    async function getEffectiveRoute(input, attachments = state.attachments, sessionId = state.activeSessionId, headers = null, routeContextOverride = null, routeOptions = null) {
      with (deps) {
        const parentSignal = routeOptions?.signal || null;
        throwIfRouteCancelled(parentSignal);
        const absoluteDeadlineAt = Number(routeOptions?.deadlineAt);
        const remainingDeadlineMs = Number.isFinite(absoluteDeadlineAt) && absoluteDeadlineAt > 0
          ? Math.max(1, absoluteDeadlineAt - Date.now())
          : routeOptions?.deadlineMs || DEFAULT_INTENT_DEADLINE_MS;
        const intentDeadline = createIntentDeadline(parentSignal, remainingDeadlineMs);
        let slowNotified = false;
        const slowTimer = setTimeout(() => {
          slowNotified = true;
          try { routeOptions?.onSlow?.('\u6b63\u5728\u6267\u884c\uff1a\u8def\u7531\u6a21\u578b\u610f\u56fe\u8bc6\u522b'); } catch (err) { console.warn('route slow callback failed:', err); }
        }, 10000);
        try {
          await intentDeadline.race(loadPublicContext?.());
          throwIfRouteCancelled(parentSignal);
          const config = getConfig();
          const requestHeaders = headers || buildRequestHeaders('message', sessionId);
          const { primaryModel, sessionChatModel } = resolveRouteModels(sessionId, config);
          const routeSvc = window.ChatUIServices?.route || window.ChatUIRouteService;
          const attachmentMeta = buildRouteAttachmentMetadata(attachments);
          const context = routeContextOverride || buildRouteContext(sessionId);
          let primaryFailure = null;
          let fallbackFailure = null;

        if (config.baseUrl && primaryModel) {
          try {
            const firstPayload = routeSvc?.buildRoutePayload
              ? routeSvc.buildRoutePayload({ model: primaryModel, input, attachments: attachmentMeta, context, currentMode: state.mode, autoMode: state.autoMode })
              : { model: primaryModel, temperature: 0, messages: [] };
            const trace = {
              input,
              model: primaryModel,
              context: compactTraceValue(context),
              attachments: attachmentMeta,
              firstPayload: compactTraceValue(firstPayload),
            };
            let firstResponse;
            try {
              throwIfRouteCancelled(parentSignal);
              firstResponse = await intentDeadline.race(requestRouteDecision(firstPayload, config, requestHeaders, intentDeadline.signal));
              throwIfRouteCancelled(parentSignal);
            } catch (err) {
              if (isRouteCancelled(err, parentSignal)) throw createRouteCancelledError();
              if (intentDeadline.timedOut || err?.code === 'ROUTE_INTENT_TIMEOUT' || err?.name === 'AbortError') {
                const deadlineError = intentDeadline.timeoutError();
                deadlineError.slowNotified = slowNotified;
                throw deadlineError;
              }
              throw err;
            }

            trace.firstRaw = extractRouteText(routeSvc, firstResponse);
            const primaryParsed = await intentDeadline.race(parseOrRepairRoute(routeSvc, {
              model: primaryModel, input, attachments: attachmentMeta, context, raw: trace.firstRaw,
              config, headers: requestHeaders, signal: intentDeadline.signal,
            }));
            let route = primaryParsed.route;
            trace.firstValidationReason = primaryParsed.initialReason || primaryParsed.reason || '';
            trace.repairRaw = primaryParsed.repairRaw || '';
            trace.repaired = !!primaryParsed.repaired;
            if (!route) {
              const invalid = invalidRouteError('primary');
              invalid.validationReason = primaryParsed.reason || 'contract_shape';
              throw invalid;
            }
            trace.firstRoute = route;
            throwIfRouteCancelled(parentSignal);
            trace.reviewed = false;
            trace.finalRoute = route;
            trace.finalTaskContract = route.taskContract || null;
            trace.finalApi = route.api;
            trace.finalPrompt = route.contextualImagePrompt || route.editInstruction || input;
            setIntentTrace(trace);
            return route;
          } catch (err) {
            if (isRouteCancelled(err, parentSignal)) throw createRouteCancelledError();
            primaryFailure = err;
            const deadlineExpired = intentDeadline.timedOut || err?.code === 'ROUTE_INTENT_TIMEOUT';
            console.warn(deadlineExpired ? 'intent recognition deadline exhausted' : 'route model failed, trying chat model fallback', err);
            if (!deadlineExpired) try {
              routeOptions?.onStage?.('\u6b63\u5728\u6267\u884c\uff1achat \u6a21\u578b\u5907\u7528\u8def\u7531\u5224\u65ad');
            } catch (stageErr) { console.warn('route stage callback failed:', stageErr); }
            if (!deadlineExpired && config.baseUrl && sessionChatModel && sessionChatModel !== primaryModel) {
              try {
                throwIfRouteCancelled(parentSignal);
                const fallbackPayload = routeSvc.buildRoutePayload({ model: sessionChatModel, input, attachments: attachmentMeta, context, currentMode: state.mode, autoMode: state.autoMode });
                let fallbackResponse;
                try {
                  fallbackResponse = await intentDeadline.race(requestRouteDecision(fallbackPayload, config, requestHeaders, intentDeadline.signal));
                  throwIfRouteCancelled(parentSignal);
                } catch (fallbackErr) {
                  if (isRouteCancelled(fallbackErr, parentSignal)) throw createRouteCancelledError();
                  if (intentDeadline.timedOut || fallbackErr?.code === 'ROUTE_INTENT_TIMEOUT' || fallbackErr?.name === 'AbortError') {
                    const deadlineError = intentDeadline.timeoutError();
                    deadlineError.slowNotified = slowNotified;
                    throw deadlineError;
                  }
                  throw fallbackErr;
                }
                const fallbackRaw = extractRouteText(routeSvc, fallbackResponse);
                const fallbackParsed = await intentDeadline.race(parseOrRepairRoute(routeSvc, {
                  model: sessionChatModel, input, attachments: attachmentMeta, context, raw: fallbackRaw,
                  config, headers: requestHeaders, signal: intentDeadline.signal,
                }));
                const fallbackRoute = fallbackParsed.route;
                if (!fallbackRoute) {
                  const invalid = invalidRouteError('fallback');
                  invalid.validationReason = fallbackParsed.reason || 'contract_shape';
                  throw invalid;
                }
                setIntentTrace({ input, model: sessionChatModel, context: compactTraceValue(context), attachments: attachmentMeta, finalRoute: fallbackRoute, finalApi: fallbackRoute.api, fallbackAi: true });
                return fallbackRoute;
              } catch (fallbackErr) {
                if (isRouteCancelled(fallbackErr, parentSignal)) throw createRouteCancelledError();
                fallbackFailure = fallbackErr;
                console.warn('chat model fallback route also failed:', fallbackErr);
              }
            }
          }
        }
        throwIfRouteCancelled(parentSignal);
        if (intentDeadline.timedOut || primaryFailure?.code === 'ROUTE_INTENT_TIMEOUT' || fallbackFailure?.code === 'ROUTE_INTENT_TIMEOUT') {
          const deadlineError = intentDeadline.timeoutError();
          deadlineError.slowNotified = slowNotified;
          throw deadlineError;
        }
        const invalidContract = primaryFailure?.code === 'ROUTE_INVALID_CONTRACT' || fallbackFailure?.code === 'ROUTE_INVALID_CONTRACT';
        if (invalidContract) {
          const clarificationRoute = invalidContractClarificationRoute();
          setIntentTrace({
            input,
            model: primaryModel,
            context: compactTraceValue(context),
            attachments: attachmentMeta,
            finalRoute: clarificationRoute,
            finalApi: 'clarify',
            fallbackAi: !!fallbackFailure,
            invalidContractFallback: true,
          });
          return clarificationRoute;
        }
        const routeError = new Error(invalidContract
          ? '\u610f\u56fe\u8bc6\u522b\u7ed3\u679c\u672a\u80fd\u901a\u8fc7\u5b89\u5168\u6821\u9a8c\uff0c\u8bf7\u66f4\u6362\u610f\u56fe\u6a21\u578b\u6216\u7a0d\u540e\u91cd\u8bd5'
          : '\u610f\u56fe\u8bc6\u522b\u5931\u8d25\uff1a\u8def\u7531\u6a21\u578b\u548c\u5907\u7528\u6a21\u578b\u5747\u4e0d\u53ef\u7528\uff0c\u8bf7\u68c0\u67e5\u6a21\u578b\u914d\u7f6e\u6216\u7a0d\u540e\u91cd\u8bd5');
        routeError.code = 'ROUTE_COMPLETE_FAILURE';
        routeError.primaryCode = primaryFailure?.code || '';
        routeError.fallbackCode = fallbackFailure?.code || '';
        throw routeError;
        } finally {
          clearTimeout(slowTimer);
          intentDeadline.dispose();
        }
      }
    }

    return Object.freeze({ buildRouteContext, getEffectiveRoute, setIntentTrace, summarizeIntentTrace });
  }

  const api = Object.freeze({ createRouteDecisionWorkflow });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.ChatUIAppRouteDecisionWorkflow = api;
  if (root?.window) root.window.ChatUIAppRouteDecisionWorkflow = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
