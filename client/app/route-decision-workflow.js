(function initChatUIAppRouteDecisionWorkflow(root) {
  // Intentionally not strict: route decision bodies are migrated from app.js and resolved through a deps scope.

  function createRouteDecisionWorkflow(deps = {}) {
    if (!deps.state) throw new Error('state is required');

    function buildRouteContext(e=8,t=state.activeSessionId) {
      with (deps) {
        const s=state.sessions.find(e=>e.id===t),n=t===state.activeSessionId?state.messages:s?.messages||[],a=t===state.activeSessionId?state.lastGeneratedImage:s?.lastGeneratedImage,i=getLatestUploadedImageContext(t),o=latestImageReferenceMeta(t),r=a?{reference_id:makeImageReferenceId("latest"),prompt:String(a.prompt||"").slice(0,800),updated_at:a.updatedAt||null,count:Array.isArray(a.images)?a.images.length:a.src?1:0,candidates:(a.images||[]).map((e,t)=>({index:t+1,image_id:makeImageItemId(makeImageReferenceId("latest"),t+1),filename:e.filename||"",prompt:String(e.prompt||a.prompt||"").slice(0,200),labels:e.labels||[]}))}:null,l=i?{prompt:String(i.prompt||"").slice(0,800),count:i.attachments?.length||0,target:i.target||"uploaded",updated_at:i.updatedAt||null}:null,d=collectRecentImageReferences(t,Number.MAX_SAFE_INTEGER),context=window.ChatUICore?.imageRouteContext?.buildRouteContext?window.ChatUICore.imageRouteContext.buildRouteContext({messages:n,lastGeneratedImage:r,latestUploadedImage:l,latestImageReference:o,recentImageReferences:d,maxChars:262144}):{recent_messages:n.map((e,t)=>({index:t+1,role:e.role,content:String(Array.isArray(e.content)?e.rawText||"[非文本消息]":e.content||e.rawText||"").slice(0,600)})),last_generated_image:r,latest_uploaded_image:l,latest_image_reference:o.target!=="none"?o:null,recent_image_references:d};return context;
      }
    }

    async function getEffectiveRoute(e,t=state.attachments,s=state.activeSessionId,h=null,routeContextOverride=null) {
      with (deps) {
        const n=getConfig(),r=h||buildRequestHeaders("message",s),a=n.routeModel||n.chatModel,context=routeContextOverride||buildRouteContext(8,s);if(n.baseUrl&&a)try{const h=window.ChatUIServices?.route?.buildRoutePayload?window.ChatUIServices.route.buildRoutePayload({model:a,input:e,attachments:buildRouteAttachmentMetadata(t),context,currentMode:state.mode,autoMode:state.autoMode}):{model:a,temperature:0,messages:[]},i=await requestJson(`${n.baseUrl}/chat/completions`,h,n.apiKey,{headers:r}),o=parseRouteResult(window.ChatUIServices?.route?.extractRouteText?window.ChatUIServices.route.extractRouteText(i):i?.choices?.[0]?.message?.content||i?.output_text||"",{input:e,attachments:buildRouteAttachmentMetadata(t)});if(o){const prompt=String(context?.suggested_contextual_image_prompt||"").trim();return"image"===o.mode&&prompt&&!o.contextualImagePrompt?{...o,contextualImagePrompt:prompt}:o}}catch(e){console.warn("model route failed, fallback to chat:",e)}return normalizeRoute({mode:"chat",target:"none",use_previous_image:!1,confidence:0,evidence:"意图识别模型不可用，默认走聊天模型"},"chat")
      }
    }

    return Object.freeze({ buildRouteContext, getEffectiveRoute });
  }

  const api = Object.freeze({ createRouteDecisionWorkflow });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.ChatUIAppRouteDecisionWorkflow = api;
  if (root?.window) root.window.ChatUIAppRouteDecisionWorkflow = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
