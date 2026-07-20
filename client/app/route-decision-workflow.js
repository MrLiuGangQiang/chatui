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
        await loadPublicContext?.();
        const config = getConfig();
        const requestHeaders = headers || buildRequestHeaders('message', sessionId);
        const { primaryModel, sessionChatModel } = resolveRouteModels(sessionId, config);
        const routeSvc = window.ChatUIServices?.route || window.ChatUIRouteService;
        const attachmentMeta = buildRouteAttachmentMetadata(attachments);
        const context = routeContextOverride || buildRouteContext(sessionId);

        if (config.baseUrl && primaryModel) {
          try {
            const firstPayload = routeSvc?.buildRoutePayload
              ? routeSvc.buildRoutePayload({ model: primaryModel, input, attachments: attachmentMeta, context, currentMode: state.mode, autoMode: state.autoMode })
              : { model: primaryModel, temperature: 0, messages: [] };
            const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
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
              firstResponse = await requestRouteDecision(firstPayload, config, requestHeaders, controller?.signal);
            } catch (err) {
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
            }

            trace.firstRaw = extractRouteText(routeSvc, firstResponse);
            let route = parseRouteResult(trace.firstRaw, { input, attachments: attachmentMeta, context });
            trace.firstRoute = route;
            let reviewed = false;
            if (route && shouldReviewRoute(routeSvc, route, context, attachmentMeta) && routeSvc?.buildIntentReviewPayload) {
              try {
                try { routeOptions?.onStage?.('\u6b63\u5728\u6267\u884c\uff1aAI \u590d\u5ba1\u8def\u7531\u5224\u65ad'); } catch (err) { console.warn('route stage callback failed:', err); }
                const reviewPayload = routeSvc.buildIntentReviewPayload({ model: primaryModel, input, attachments: attachmentMeta, context, firstRoute: route });
                trace.reviewPayload = compactTraceValue(reviewPayload);
                const reviewController = typeof AbortController !== 'undefined' ? new AbortController() : null;
                let reviewTimedOut = false;
                const reviewTimeout = setTimeout(() => {
                  reviewTimedOut = true;
                  reviewController?.abort?.();
                }, 60000);
                let reviewResponse;
                try {
                  reviewResponse = await requestRouteDecision(reviewPayload, config, requestHeaders, reviewController?.signal);
                } catch (err) {
                  if (reviewTimedOut || err?.name === 'AbortError') {
                    const timeoutError = new Error('ROUTE_REVIEW_TIMEOUT');
                    timeoutError.code = 'ROUTE_REVIEW_TIMEOUT';
                    throw timeoutError;
                  }
                  throw err;
                } finally {
                  clearTimeout(reviewTimeout);
                }
                trace.reviewRaw = extractRouteText(routeSvc, reviewResponse);
                const reviewRoute = parseRouteResult(trace.reviewRaw, { input, attachments: attachmentMeta, context });
                trace.reviewRoute = reviewRoute;
                if (reviewRoute) {
                  route = reviewRoute;
                  reviewed = true;
                }
              } catch (err) {
                trace.reviewError = String(err?.message || err);
                console.warn('intent review failed, keep primary route:', err);
              }
            }
            if (route) {
              trace.reviewed = reviewed;
              trace.finalRoute = route;
              trace.finalTaskContract = route.taskContract || null;
              trace.finalApi = route.api;
              trace.finalPrompt = route.contextualImagePrompt || route.editInstruction || input;
              setIntentTrace(trace);
              return route;
            }
          } catch (err) {
            console.warn(err?.routeTimedOut ? 'route model timed out, trying chat model fallback' : 'route model failed, trying chat model fallback', err);
            try { routeOptions?.onStage?.('\u6b63\u5728\u6267\u884c\uff1achat \u6a21\u578b\u5907\u7528\u8def\u7531\u5224\u65ad'); } catch (stageErr) { console.warn('route stage callback failed:', stageErr); }
            if (config.baseUrl && sessionChatModel && sessionChatModel !== primaryModel) {
              try {
                const fallbackPayload = routeSvc.buildRoutePayload({ model: sessionChatModel, input, attachments: attachmentMeta, context, currentMode: state.mode, autoMode: state.autoMode });
                const fallbackController = typeof AbortController !== 'undefined' ? new AbortController() : null;
                const fallbackTimeout = setTimeout(() => fallbackController?.abort?.(), 30000);
                let fallbackResponse;
                try {
                  fallbackResponse = await requestRouteDecision(fallbackPayload, config, requestHeaders, fallbackController?.signal);
                } finally {
                  clearTimeout(fallbackTimeout);
                }
                const fallbackRaw = extractRouteText(routeSvc, fallbackResponse);
                const fallbackRoute = parseRouteResult(fallbackRaw, { input, attachments: attachmentMeta, context });
                if (fallbackRoute) {
                  setIntentTrace({ input, model: sessionChatModel, context: compactTraceValue(context), attachments: attachmentMeta, finalRoute: fallbackRoute, finalApi: fallbackRoute.api, fallbackAi: true });
                  return fallbackRoute;
                }
              } catch (fallbackErr) {
                console.warn('chat model fallback route also failed:', fallbackErr);
              }
            }
          }
        }
        const routeError = new Error('\u610f\u56fe\u8bc6\u522b\u5931\u8d25\uff1a\u8def\u7531\u6a21\u578b\u548c\u5907\u7528\u6a21\u578b\u5747\u4e0d\u53ef\u7528\uff0c\u8bf7\u68c0\u67e5\u6a21\u578b\u914d\u7f6e\u6216\u7a0d\u540e\u91cd\u8bd5');
        routeError.code = 'ROUTE_COMPLETE_FAILURE';
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
