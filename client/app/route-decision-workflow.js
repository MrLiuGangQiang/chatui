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

    function shouldReviewRoute(routeSvc, route, context) {
      if (!route) return false;
      return !!routeSvc?.needsIntentReview?.(route, context);
    }

    async function requestRouteDecision(payload, config, headers, signal) {
      with (deps) {
        return await requestJson(`${config.baseUrl}/chat/completions`, payload, config.apiKey, { headers, signal });
      }
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
        clarificationQuestion: '我需要确认你的目标：你希望我处理这段内容、生成图片/PPT，还是进行其他操作？',
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

    function requiresVerifiedReview(route = {}) {
      const operation = String(route.operationType || route.taskContract?.operation || '');
      return ['edit_image', 'image_reference_gen', 'image_compare'].includes(operation);
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
        await loadPublicContext?.();
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
            const request = createLinkedAbortController(parentSignal);
            const controller = request.controller;
            let timedOut = false;
            let slowNotified = false;
            const trace = {
              input,
              model: primaryModel,
              context: compactTraceValue(context),
              attachments: attachmentMeta,
              firstPayload: compactTraceValue(firstPayload),
            };
            const slowTimer = setTimeout(() => {
              slowNotified = true;
              try { routeOptions?.onSlow?.('\u6b63\u5728\u6267\u884c\uff1a\u8def\u7531\u6a21\u578b\u610f\u56fe\u8bc6\u522b'); } catch (err) { console.warn('route slow callback failed:', err); }
            }, 10000);
            const timeout = setTimeout(() => {
              timedOut = true;
              controller?.abort?.();
            }, 60000);
            let firstResponse;
            try {
              throwIfRouteCancelled(parentSignal);
              firstResponse = await requestRouteDecision(firstPayload, config, requestHeaders, controller?.signal);
              throwIfRouteCancelled(parentSignal);
            } catch (err) {
              if (isRouteCancelled(err, parentSignal)) throw createRouteCancelledError();
              if (timedOut || err?.name === 'AbortError') {
                const timeoutError = new Error('ROUTE_INTENT_TIMEOUT');
                timeoutError.code = 'ROUTE_INTENT_TIMEOUT';
                timeoutError.routeTimedOut = true;
                timeoutError.timeoutMs = 60000;
                timeoutError.slowNotified = slowNotified;
                throw timeoutError;
              }
              throw err;
            } finally {
              clearTimeout(slowTimer);
              clearTimeout(timeout);
              request.dispose();
            }

            trace.firstRaw = extractRouteText(routeSvc, firstResponse);
            let route = parseRouteResult(trace.firstRaw, { input, attachments: attachmentMeta, context });
            if (!route) throw invalidRouteError('primary');
            trace.firstRoute = route;
            let reviewed = false;
            if (shouldReviewRoute(routeSvc, route, context, attachmentMeta) && routeSvc?.buildIntentReviewPayload) {
              try {
                try { routeOptions?.onStage?.('\u6b63\u5728\u6267\u884c\uff1aAI \u590d\u5ba1\u8def\u7531\u5224\u65ad'); } catch (err) { console.warn('route stage callback failed:', err); }
                const reviewPayload = routeSvc.buildIntentReviewPayload({ model: primaryModel, input, attachments: attachmentMeta, context, firstRoute: route });
                trace.reviewPayload = compactTraceValue(reviewPayload);
                const reviewRequest = createLinkedAbortController(parentSignal);
                const reviewController = reviewRequest.controller;
                let reviewTimedOut = false;
                const reviewTimeout = setTimeout(() => {
                  reviewTimedOut = true;
                  reviewController?.abort?.();
                }, 60000);
                let reviewResponse;
                try {
                  throwIfRouteCancelled(parentSignal);
                  reviewResponse = await requestRouteDecision(reviewPayload, config, requestHeaders, reviewController?.signal);
                  throwIfRouteCancelled(parentSignal);
                } catch (err) {
                  if (isRouteCancelled(err, parentSignal)) throw createRouteCancelledError();
                  if (reviewTimedOut || err?.name === 'AbortError') {
                    const timeoutError = new Error('ROUTE_REVIEW_TIMEOUT');
                    timeoutError.code = 'ROUTE_REVIEW_TIMEOUT';
                    throw timeoutError;
                  }
                  throw err;
                } finally {
                  clearTimeout(reviewTimeout);
                  reviewRequest.dispose();
                }
                trace.reviewRaw = extractRouteText(routeSvc, reviewResponse);
                const reviewRoute = parseRouteResult(trace.reviewRaw, { input, attachments: attachmentMeta, context });
                if (!reviewRoute) throw invalidRouteError('review');
                trace.reviewRoute = reviewRoute;
                route = reviewRoute;
                reviewed = true;
              } catch (err) {
                if (isRouteCancelled(err, parentSignal)) throw createRouteCancelledError();
                trace.reviewError = String(err?.message || err);
                if (requiresVerifiedReview(route)) {
                  const reviewError = new Error('ROUTE_REVIEW_REQUIRED');
                  reviewError.code = 'ROUTE_REVIEW_REQUIRED';
                  reviewError.causeCode = err?.code || '';
                  throw reviewError;
                }
                console.warn('intent review failed, keeping safe primary route:', err);
              }
            }
            throwIfRouteCancelled(parentSignal);
            trace.reviewed = reviewed;
            trace.finalRoute = route;
            trace.finalTaskContract = route.taskContract || null;
            trace.finalApi = route.api;
            trace.finalPrompt = route.contextualImagePrompt || route.editInstruction || input;
            setIntentTrace(trace);
            return route;
          } catch (err) {
            if (isRouteCancelled(err, parentSignal)) throw createRouteCancelledError();
            primaryFailure = err;
            console.warn(err?.routeTimedOut ? 'route model timed out, trying chat model fallback' : 'route model failed, trying chat model fallback', err);
            try { routeOptions?.onStage?.('\u6b63\u5728\u6267\u884c\uff1achat \u6a21\u578b\u5907\u7528\u8def\u7531\u5224\u65ad'); } catch (stageErr) { console.warn('route stage callback failed:', stageErr); }
            if (config.baseUrl && sessionChatModel && sessionChatModel !== primaryModel) {
              try {
                throwIfRouteCancelled(parentSignal);
                const fallbackPayload = routeSvc.buildRoutePayload({ model: sessionChatModel, input, attachments: attachmentMeta, context, currentMode: state.mode, autoMode: state.autoMode });
                const fallbackRequest = createLinkedAbortController(parentSignal);
                const fallbackController = fallbackRequest.controller;
                let fallbackTimedOut = false;
                const fallbackTimeout = setTimeout(() => {
                  fallbackTimedOut = true;
                  fallbackController?.abort?.();
                }, 30000);
                let fallbackResponse;
                try {
                  fallbackResponse = await requestRouteDecision(fallbackPayload, config, requestHeaders, fallbackController?.signal);
                  throwIfRouteCancelled(parentSignal);
                } catch (fallbackErr) {
                  if (isRouteCancelled(fallbackErr, parentSignal)) throw createRouteCancelledError();
                  if (fallbackTimedOut || fallbackErr?.name === 'AbortError') {
                    const timeoutError = new Error('ROUTE_FALLBACK_TIMEOUT');
                    timeoutError.code = 'ROUTE_FALLBACK_TIMEOUT';
                    throw timeoutError;
                  }
                  throw fallbackErr;
                } finally {
                  clearTimeout(fallbackTimeout);
                  fallbackRequest.dispose();
                }
                const fallbackRaw = extractRouteText(routeSvc, fallbackResponse);
                const fallbackRoute = parseRouteResult(fallbackRaw, { input, attachments: attachmentMeta, context });
                if (!fallbackRoute) throw invalidRouteError('fallback');
                if (requiresVerifiedReview(fallbackRoute) && shouldReviewRoute(routeSvc, fallbackRoute, context, attachmentMeta)) {
                  const reviewError = new Error('ROUTE_FALLBACK_REVIEW_REQUIRED');
                  reviewError.code = 'ROUTE_FALLBACK_REVIEW_REQUIRED';
                  throw reviewError;
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
      }
    }

    return Object.freeze({ buildRouteContext, getEffectiveRoute, setIntentTrace, summarizeIntentTrace });
  }

  const api = Object.freeze({ createRouteDecisionWorkflow });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.ChatUIAppRouteDecisionWorkflow = api;
  if (root?.window) root.window.ChatUIAppRouteDecisionWorkflow = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
