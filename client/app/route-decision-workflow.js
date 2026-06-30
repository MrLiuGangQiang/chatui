(function initChatUIAppRouteDecisionWorkflow(root) {
  // Intentionally not strict: route decision bodies are migrated from app.js and resolved through a deps scope.

  function createRouteDecisionWorkflow(deps = {}) {
    if (!deps.state) throw new Error('state is required');

    function buildRouteContext(e=8,t=state.activeSessionId) {
      with (deps) {
        const s=state.sessions.find(e=>e.id===t),n=t===state.activeSessionId?state.messages:s?.messages||[],a=t===state.activeSessionId?state.lastGeneratedImage:s?.lastGeneratedImage,i=getLatestUploadedImageContext(t),o=latestImageReferenceMeta(t),r=a?{reference_id:makeImageReferenceId("latest"),prompt:String(a.prompt||"").slice(0,300),updated_at:a.updatedAt||null,count:Array.isArray(a.images)?a.images.length:a.src?1:0,candidates:(a.images||[]).map((e,t)=>({index:t+1,image_id:makeImageItemId(makeImageReferenceId("latest"),t+1),filename:e.filename||"",prompt:String(e.prompt||a.prompt||"").slice(0,80),labels:e.labels||[]}))}:null,l=i?{prompt:String(i.prompt||"").slice(0,300),count:i.attachments?.length||0,target:i.target||"uploaded",updated_at:i.updatedAt||null}:null,d=collectRecentImageReferences(t,6),context=window.ChatUICore?.imageRouteContext?.buildRouteContext?window.ChatUICore.imageRouteContext.buildRouteContext({messages:n,lastGeneratedImage:r,latestUploadedImage:l,latestImageReference:o,recentImageReferences:d,maxChars:12000}):{recent_messages:n.slice(-8).map((e,t)=>({index:t+1,role:e.role,content:String(Array.isArray(e.content)?e.rawText||"[非文本消息]":e.content||e.rawText||"").slice(0,300)})),last_generated_image:r,latest_uploaded_image:l,latest_image_reference:o.target!=="none"?o:null,recent_image_references:d};return context;
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

    function setIntentTrace(trace = {}) {
      const safe = { ...trace, timestamp: new Date().toISOString() };
      try { root.__CHATUI_LAST_INTENT_TRACE__ = safe; } catch {}
      try { root.window && (root.window.__CHATUI_LAST_INTENT_TRACE__ = safe); } catch {}
      try { root.localStorage?.setItem?.('chatui:lastIntentTrace', JSON.stringify(compactTraceValue(safe, 50000))); } catch {}
      return safe;
    }

    function extractRouteText(routeSvc, response) {
      return routeSvc?.extractRouteText ? routeSvc.extractRouteText(response) : response?.choices?.[0]?.message?.content || response?.output_text || '';
    }

    function shouldReviewRoute(routeSvc, route, context, attachments = []) {
      if (!route) return false;
      if (routeSvc?.needsIntentReview?.(route, context)) return true;
      const hasToolContext = !!(context?.last_generated_image || context?.latest_assistant_image_result || context?.latest_image_reference || (Array.isArray(context?.image_candidates) && context.image_candidates.length) || (Array.isArray(context?.file_candidates) && context.file_candidates.length));
      if (route.confidence > 0 && route.confidence < 0.62) return true;
      if (route.mode === 'chat' && hasToolContext && !attachments.length) return true;
      return false;
    }

    async function requestRouteDecision(payload, config, headers, signal) {
      with (deps) {
        return await requestJson(`${config.baseUrl}/chat/completions`, payload, config.apiKey, { headers, signal });
      }
    }

    async function getEffectiveRoute(e,t=state.attachments,s=state.activeSessionId,h=null,routeContextOverride=null,routeOptions=null) {
      with (deps) {
        const n=getConfig(),r=h||buildRequestHeaders("message",s),a=n.routeModel||n.chatModel,routeSvc=window.ChatUIServices?.route||window.ChatUIRouteService,attachmentMeta=buildRouteAttachmentMetadata(t),context=routeContextOverride||buildRouteContext(8,s);if(n.baseUrl&&a)try{const firstPayload=routeSvc?.buildRoutePayload?routeSvc.buildRoutePayload({model:a,input:e,attachments:attachmentMeta,context,currentMode:state.mode,autoMode:state.autoMode}):{model:a,temperature:0,messages:[]},controller=typeof AbortController!=="undefined"?new AbortController:null;let timedOut=!1,slowNotified=!1;const trace={input:e,context:compactTraceValue(context),attachments:attachmentMeta,firstPayload:compactTraceValue(firstPayload)};const slowTimer=setTimeout(()=>{slowNotified=!0;try{routeOptions?.onSlow?.()}catch(e){console.warn("route slow callback failed:",e)}},10000),timeout=setTimeout(()=>{timedOut=!0;controller?.abort?.()},60000);let firstResponse;try{firstResponse=await requestRouteDecision(firstPayload,n,r,controller?.signal)}catch(err){if(timedOut||"AbortError"===err?.name){const timeoutError=new Error("ROUTE_INTENT_TIMEOUT");timeoutError.code="ROUTE_INTENT_TIMEOUT";timeoutError.routeTimedOut=!0;timeoutError.timeoutMs=60000;timeoutError.slowNotified=slowNotified;throw timeoutError}throw err}finally{clearTimeout(slowTimer),clearTimeout(timeout)}trace.firstRaw=extractRouteText(routeSvc,firstResponse);let route=parseRouteResult(trace.firstRaw,{input:e,attachments:attachmentMeta,context});trace.firstRoute=route;let reviewed=false;if(route&&shouldReviewRoute(routeSvc,route,context,attachmentMeta)&&routeSvc?.buildIntentReviewPayload){try{const reviewPayload=routeSvc.buildIntentReviewPayload({model:a,input:e,attachments:attachmentMeta,context,firstRoute:route});trace.reviewPayload=compactTraceValue(reviewPayload);const reviewResponse=await requestRouteDecision(reviewPayload,n,r,controller?.signal);trace.reviewRaw=extractRouteText(routeSvc,reviewResponse);const reviewRoute=parseRouteResult(trace.reviewRaw,{input:e,attachments:attachmentMeta,context});trace.reviewRoute=reviewRoute;if(reviewRoute&&reviewRoute.confidence>=Math.max(route.confidence||0,.62)&&!(reviewRoute.mode==='chat'&&route.mode!=='chat')){route=reviewRoute;reviewed=true}}catch(err){trace.reviewError=String(err?.message||err);console.warn("intent review failed, keep primary route:",err)}}if(route){const prompt=String(context?.suggested_contextual_image_prompt||"").trim();const finalRoute="image"===route.mode&&prompt&&!route.contextualImagePrompt?{...route,contextualImagePrompt:prompt}:route;trace.reviewed=reviewed;trace.finalRoute=finalRoute;trace.finalTaskContract=finalRoute.taskContract||null;trace.finalApi=finalRoute.taskContract?.execution?.api||("image"===finalRoute.mode?"image_generation":"edit_image"===finalRoute.mode?"image_edit":"chat");trace.finalPrompt=finalRoute.contextualImagePrompt||finalRoute.editInstruction||e;setIntentTrace(trace);return finalRoute}}catch(e){if(e?.routeTimedOut||"ROUTE_INTENT_TIMEOUT"===e?.code)throw e;console.warn("model route failed, fallback to chat:",e)}const fallback=normalizeRoute({mode:"chat",target:"none",use_previous_image:!1,confidence:0,evidence:"意图识别模型不可用，默认走聊天模型"},"chat");setIntentTrace({input:e,context:compactTraceValue(context),attachments:attachmentMeta,finalRoute:fallback,finalApi:"chat",fallback:true});return fallback
      }
    }

    return Object.freeze({ buildRouteContext, getEffectiveRoute, setIntentTrace });
  }

  const api = Object.freeze({ createRouteDecisionWorkflow });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.ChatUIAppRouteDecisionWorkflow = api;
  if (root?.window) root.window.ChatUIAppRouteDecisionWorkflow = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
