(function initChatUIAppReasoningWorkflow(root) {
  // Intentionally not strict: reasoning bodies are migrated from app.js and resolved through a deps scope.
  const window = root?.window || root || {};

  function createReasoningWorkflow(deps = {}) {
    if (!deps.state) throw new Error('state is required');

    function updateReasoning(e,t,s={}) {
      with (deps) {
        if(!e)return;const n=String(t||"");let a=e.querySelector(".reasoning-panel");if(!n&&!s.keepEmpty)return a?.remove(),delete e.dataset.reasoningText,void(e.isConnected&&saveDisplayHistory());n&&(e.dataset.reasoningText=n),s.keepReasoning&&(e.dataset.keepReasoning="1"),a||(a=document.createElement("div"),a.className="reasoning-panel",a.innerHTML=`
              <div class="reasoning-head">
                <div class="reasoning-title">思考中…</div>
                <button class="reasoning-copy-btn" type="button" title="复制思考内容" aria-label="复制思考内容">
                  ${COPY_ICON_SVG}
                </button>
              </div>
              <div class="reasoning-content markdown-body"></div>`,a.querySelector(".reasoning-copy-btn")?.addEventListener("click",async()=>{await copyText(e.dataset.reasoningText||a.querySelector(".reasoning-content")?.innerText||""),showCopySuccess(a.querySelector(".reasoning-copy-btn"))}),e.querySelector(".bubble")?.prepend(a)),a.classList.toggle("reasoning-done",!0===s.done),a.querySelector(".reasoning-title").textContent=s.title||s.unavailable?"未返回思考内容":s.done?"思考完成":"思考中…";const i=a.querySelector(".reasoning-copy-btn");i&&(i.hidden=!n);const o=a.querySelector(".reasoning-content");if(o){const e=!0===s.done||!0===s.renderMarkdown;if(e){const e=renderReasoningMarkdown(n);o.innerHTML!==e&&(o.innerHTML=e,bindInlineCopyButtons(a)),delete o.dataset.streamingText}else o.dataset.streamingText!==n&&(o.textContent=n,o.dataset.streamingText=n);o.hidden=!n}scrollToActiveOutput(e,{force:s.forceScroll??!1,active:!0===s.followActive}),s.persistSave&&e.isConnected&&saveDisplayHistory()
      }
    }

    function finishReasoning(e,t) {
      with (deps) {
        if(!state.reasoningMode)return void clearReasoning(e);const s=String(t||e?.dataset.reasoningText||"").trim();s?updateReasoning(e,s,{done:!0,persistSave:!0,keepReasoning:!0}):showReasoningUnavailable(e)
      }
    }

    function showReasoningUnavailable(e) {
      with (deps) {
        e&&(updateReasoning(e,"当前模型或接口没有返回可展示的思考内容；已完成回答，但只能展示最终结果。",{done:!0,persistSave:!0,keepReasoning:!0,unavailable:!0}),e.querySelector(".reasoning-panel")?.classList.add("reasoning-empty"))
      }
    }

    function clearAllReasoningDisplays() {
      with (deps) {
        document.querySelectorAll(".message").forEach(e=>clearReasoning(e));const e=getActiveSession();e?.display?.length&&(e.display.forEach(e=>{delete e.reasoningText,e.keepReasoning=!1}),persistSessionDisplay(e.id))
      }
    }

    function clearReasoning(e) {
      with (deps) {
        updateReasoning(e,"")
      }
    }

    function forceRemoveReasoning(e) {
      with (deps) {
        e&&(e.querySelectorAll(".reasoning-panel").forEach(e=>e.remove()),delete e.dataset.reasoningText,delete e.dataset.keepReasoning)
      }
    }

    function isEmptyReasoningPanel(e) {
      with (deps) {
        const t=e?.querySelector(".reasoning-panel");if(!t)return!1;return!String(t.querySelector(".reasoning-content")?.innerText||"").trim()
      }
    }

    function reasoningModelProfile(e="",t="auto") {
      with (deps) {
        const s=normalizeReasoningProvider(t);if("auto"!==s)return{provider:s,reasoningKey:"openai"===s?"reasoning_effort":"anthropic"===s?"thinking":"google"===s?"thinkingConfig":"qwen"===s||"kimi"===s?"thinking_budget":"glm"===s?"thinking":"deepseek"===s?"none":"generic",reasoningFields:["reasoning_content","reasoning","thinking","reasoning_details","thinking_content","delta","reasoning_delta","thinking_delta"]};const n=String(e||"").toLowerCase();let a="openai";return/gemini|google|learnlm/.test(n)?a="google":/claude|anthropic/.test(n)&&(a="anthropic"),{provider:a,reasoningKey:"google"===a?"thinkingConfig":"anthropic"===a?"thinking":"reasoning_effort",reasoningFields:["reasoning_content","reasoning","thinking","reasoning_details","thinking_content","delta","reasoning_delta","thinking_delta"]}
      }
    }

    function reasoningPayloadOptions(e={}) {
      with (deps) {
        if(!1===e.reasoning)return{};const t=e.reasoningEffort||state.reasoningType;if(!state.reasoningMode&&!e.reasoningEffort)return{};if(!["low","medium","high","xhigh"].includes(t))return{};const s=reasoningModelProfile(e.model||"",e.reasoningProvider||state.reasoningProvider||"auto"),n=t;return"anthropic"===s.provider?{thinking:{type:"enabled",budget_tokens:reasoningBudgetTokens(t)}}:["qwen","kimi"].includes(s.provider)?{enable_thinking:!0,thinking_budget:reasoningBudgetTokens(t)}:"glm"===s.provider?{thinking:{type:"enabled"}}:"deepseek"===s.provider?{}:"generic"===s.provider?{reasoning:{enabled:!0,effort:n}}:"google"===s.provider?{thinkingConfig:{thinkingBudget:reasoningBudgetTokens(t)}}:{reasoning_effort:n}
      }
    }

    function extractStreamDelta(e) {
      with (deps) {
        if(window.ChatUICore?.reasoning?.extractStreamDelta)return window.ChatUICore.reasoning.extractStreamDelta(e);const t=e?.choices?.[0],s=t?.delta||{},n=t?.message||{},a=normalizeReasoningText(s.reasoning_content||s.reasoning||s.thinking||s.reasoning_details||s.thinking_content||n.reasoning_content||n.reasoning||n.thinking||n.reasoning_details||n.thinking_content||e?.reasoning_content||e?.reasoning||e?.thinking||e?.reasoning_details||e?.thinking_content||"");let i=normalizeContentText(s.content||s.text||s.output_text||n.content||n.text||n.output_text||e?.output_text||("string"==typeof e?.delta?e.delta:"")||e?.content||e?.text||"");!i&&Array.isArray(e?.output)&&(i=e.output.filter(e=>!/reason/i.test(String(e?.type||e?.role||""))).map(e=>normalizeContentText(e?.content||e?.text||e?.output_text||"")).join(""));const o=!a&&Array.isArray(e?.output)?normalizeReasoningText(e.output.filter(e=>/reason/i.test(String(e?.type||e?.role||""))||e?.summary||e?.reasoning||e?.thinking)):"";return{content:i,reasoning:a||o}
      }
    }

    function extractResponsesStreamDelta(e) {
      with (deps) {
        if(e&&"object"==typeof e&&("d"in e||"r"in e))return{content:normalizeContentText(e.d||""),reasoning:normalizeReasoningText(e.r||"")};const t=String(e?.type||"");if(/\.done$/i.test(t)||"response.completed"===t)return{content:"",reasoning:""};const s=/reasoning/i.test(t),n=/summary/i.test(t),a=s&&n?e?.delta||e?.text||e?.content||e?.output_text||"":"";return{content:normalizeContentText((s?"":e?.delta)||(s?"":e?.text)||(s?"":e?.output_text_delta)||(s?"":e?.response?.output_text?.delta)||""),reasoning:normalizeReasoningText(e?.summary_text_delta||e?.reasoning_summary_text_delta||e?.delta_text||e?.summary_text||e?.reasoning_summary_text||e?.summary||e?.reasoning_summary||a||"")}
      }
    }

    function normalizeContentText(e) {
      with (deps) {
        if(window.ChatUICore?.reasoning?.normalizeContentText)return window.ChatUICore.reasoning.normalizeContentText(e);if(!e)return"";if("string"==typeof e)return e;if(Array.isArray(e))return e.map(e=>normalizeContentText(e?.text||e?.content||e?.output_text||e?.message||e?.delta||e)).filter(Boolean).join("");if("object"==typeof e){const t=Array.isArray(e.output)?e.output.filter(e=>!/reason/i.test(String(e?.type||e?.role||""))):"";return normalizeContentText(e.text||e.content||e.output_text||e.message||e.delta||e.response||t||"")}return String(e||"")
      }
    }

    function normalizeReasoningText(e) {
      with (deps) {
        return window.ChatUICore?.reasoning?.normalizeReasoningText?window.ChatUICore.reasoning.normalizeReasoningText(e):e?"string"==typeof e?e:Array.isArray(e)?e.map(e=>normalizeReasoningText(e?.text||e?.content||e?.summary||e?.reasoning||e?.thinking||e)).filter(Boolean).join("\n"):"object"==typeof e?normalizeReasoningText(e.text||e.content||e.summary||e.reasoning||e.thinking||e.reasoning_content||e.thinking_content||e.reasoning_details||e.output_text||""):String(e||""):""
      }
    }

    function renderReasoningMarkdown(e) {
      with (deps) {
        return renderMarkdown(protectReasoningMarkdownText(e))
      }
    }

    function updateReasoningControls() {
      with (deps) {
        const e=$("reasoningToggle"),t=$("reasoningMenuBtn"),s=isReasoningControlLocked(),n=!!state.reasoningMode;e&&(e.classList.toggle("active",n),e.classList.toggle("locked",s),e.disabled=s,e.setAttribute("aria-disabled",String(s)),e.setAttribute("aria-pressed",String(n)),e.title=s?"输出过程中不能切换思考模式":n?"关闭思考模式":"开启思考模式",e.setAttribute("aria-label",e.title)),t&&(t.classList.toggle("show",n),t.classList.toggle("disabled",!n||s),t.disabled=!n||s,t.setAttribute("aria-disabled",String(!n||s)),t.title=s?"输出过程中不能修改思考设置":n?"思考设置":"请先开启思考模式"),(!n||s)&&closeReasoningMenu(),$("reasoningTypeLabel")&&($("reasoningTypeLabel").textContent=reasoningTypeText()),$("reasoningProviderLabel")&&($("reasoningProviderLabel").textContent=reasoningProviderText()),document.querySelectorAll("[data-reasoning-type]")?.forEach(e=>{const t=e.dataset.reasoningType===state.reasoningType;e.classList.toggle("selected",t),e.disabled=!n||s,e.classList.toggle("disabled",!n||s),e.setAttribute("aria-disabled",String(!n||s)),e.setAttribute("aria-checked",String(t))}),document.querySelectorAll("[data-reasoning-provider]")?.forEach(e=>{const t=e.dataset.reasoningProvider===state.reasoningProvider;e.classList.toggle("selected",t),e.disabled=!n||s,e.classList.toggle("disabled",!n||s),e.setAttribute("aria-disabled",String(!n||s)),e.setAttribute("aria-checked",String(t))})
      }
    }

    function isReasoningControlLocked() {
      with (deps) {
        return isSessionBusy(state.activeSessionId)
      }
    }

    function loadReasoningPreference() {
      with (deps) {
        state.reasoningMode="1"===localStorage.getItem(REASONING_MODE_KEY),state.reasoningType=localStorage.getItem(REASONING_TYPE_KEY)||state.reasoningType||"medium",state.reasoningProvider=normalizeReasoningProvider(localStorage.getItem(REASONING_PROVIDER_KEY)||state.reasoningProvider||"auto"),state.reasoningPersist="0"!==localStorage.getItem(REASONING_PERSIST_KEY),updateReasoningControls()
      }
    }

    function setReasoningMode(e) {
      with (deps) {
        if(isReasoningControlLocked())return toast("输出过程中不能切换思考模式");state.reasoningMode=!!e,localStorage.setItem(REASONING_MODE_KEY,state.reasoningMode?"1":"0"),updateReasoningControls()
      }
    }

    function setReasoningType(e="medium") {
      with (deps) {
        if(isReasoningControlLocked())return toast("输出过程中不能修改思考设置");if(!state.reasoningMode)return toast("请先开启思考模式");state.reasoningType=["low","medium","high","xhigh"].includes(e)?e:"medium",localStorage.setItem(REASONING_TYPE_KEY,state.reasoningType),updateReasoningControls()
      }
    }

    function setReasoningProvider(e="auto") {
      with (deps) {
        if(isReasoningControlLocked())return toast("输出过程中不能修改思考设置");if(!state.reasoningMode)return toast("请先开启思考模式");state.reasoningProvider=normalizeReasoningProvider(e),localStorage.setItem(REASONING_PROVIDER_KEY,state.reasoningProvider),updateReasoningControls()
      }
    }

    function openReasoningMenu() {
      with (deps) {
        if(isReasoningControlLocked())return toast("输出过程中不能修改思考设置");if(!state.reasoningMode)return toast("请先开启思考模式");const e=$("reasoningMenu"),t=$("reasoningMenuBtn");e&&(e.classList.add("show"),e.setAttribute("aria-hidden","false"),t?.setAttribute("aria-expanded","true"))
      }
    }

    function closeReasoningMenu() {
      with (deps) {
        const e=$("reasoningMenu"),t=$("reasoningMenuBtn");e&&(e.classList.remove("show"),e.setAttribute("aria-hidden","true"),t?.setAttribute("aria-expanded","false"))
      }
    }

    function toggleReasoningMenu() {
      with (deps) {
        const e=$("reasoningMenu");e?.classList.contains("show")?closeReasoningMenu():openReasoningMenu()
      }
    }

    return Object.freeze({ updateReasoning, finishReasoning, showReasoningUnavailable, clearAllReasoningDisplays, clearReasoning, forceRemoveReasoning, isEmptyReasoningPanel, reasoningModelProfile, reasoningPayloadOptions, extractStreamDelta, extractResponsesStreamDelta, normalizeContentText, normalizeReasoningText, renderReasoningMarkdown, updateReasoningControls, isReasoningControlLocked, loadReasoningPreference, setReasoningMode, setReasoningType, setReasoningProvider, openReasoningMenu, closeReasoningMenu, toggleReasoningMenu });
  }

  const api = Object.freeze({ createReasoningWorkflow });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.ChatUIAppReasoningWorkflow = api;
  if (root?.window) root.window.ChatUIAppReasoningWorkflow = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
