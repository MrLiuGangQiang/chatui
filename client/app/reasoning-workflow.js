(function initChatUIAppReasoningWorkflow(root) {
  // Intentionally not strict: reasoning bodies are migrated from app.js and resolved through a deps scope.
  const window = root?.window || root || {};

  const REASONING_TYPES = Object.freeze(['none', 'low', 'medium', 'high', 'xhigh', 'max']);
  const REASONING_EFFORTS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);

  function normalizeReasoningType(value = 'none') {
    const type = String(value || '').trim().toLowerCase();
    return REASONING_TYPES.includes(type) ? type : 'none';
  }

  function createReasoningWorkflow(deps = {}) {
    if (!deps.state) throw new Error('state is required');

    function updateReasoning(e,t,s={}) {
      with (deps) {
        if(!e)return;
        if(!state.reasoningMode&&!s.restoreHistory){forceRemoveReasoning(e); return;}
        const n=String(t||"");
        const done=!0===s.done;
        const unavailable=!0===s.unavailable;
        let a=e.querySelector(".reasoning-panel");
        if(!n&&!s.keepEmpty&&!done&&!unavailable){
          a?.remove();
          delete e.dataset.reasoningText;
          delete e.dataset.keepReasoning;
          e.isConnected&&saveDisplayHistory();
          return;
        }
        n&&(e.dataset.reasoningText=n);
        s.keepReasoning&&(e.dataset.keepReasoning="1");
        if(!a){
          a=document.createElement("div");
          a.className="reasoning-panel";
          a.innerHTML=`
              <div class="reasoning-head">
                <div class="reasoning-title"><span>思考中</span><span class="reasoning-dots" aria-hidden="true"><i></i><i></i><i></i></span></div>
              </div>
              <div class="reasoning-content markdown-body"></div>`;
          e.querySelector(".bubble")?.prepend(a);
        }
        const body=e.querySelector(".content");
        if(body?.querySelector?.(".pending-feedback")) body.textContent="";
        a.classList.toggle("reasoning-done",done);
        a.classList.toggle("reasoning-empty",unavailable);
        const title=a.querySelector(".reasoning-title");
        if(title){
          const text=s.title||(unavailable?"未返回思考内容":done?"思考完成":"思考中");
          if(done||unavailable||s.title) title.textContent=text;
          else title.innerHTML=`<span>思考中</span><span class="reasoning-dots" aria-hidden="true"><i></i><i></i><i></i></span>`;
        }
        const o=a.querySelector(".reasoning-content");
        if(o){
          const shouldRenderMarkdown=done||!0===s.renderMarkdown;
          if(shouldRenderMarkdown){
            const rendered=renderReasoningMarkdown(n);
            (s.forceRenderMarkdown||o.innerHTML!==rendered)&&(o.innerHTML=rendered,bindInlineCopyButtons(a));
            delete o.dataset.streamingText;
          }else o.dataset.streamingText!==n&&(o.textContent=n,o.dataset.streamingText=n);
        }
        o&&(o.hidden=!n);
        scrollToActiveOutput(e,{force:s.forceScroll??!1,active:!0===s.followActive});
        s.persistSave&&e.isConnected&&saveDisplayHistory()
      }
    }

    function finishReasoning(e,t) {
      with (deps) {
        if(!state.reasoningMode)return void clearReasoning(e);const s=String(t||e?.dataset.reasoningText||"").trim();s?updateReasoning(e,s,{done:!0,persistSave:!0,keepReasoning:!0,renderMarkdown:!0,forceRenderMarkdown:!0}):showReasoningUnavailable(e)
      }
    }

    function showReasoningUnavailable(e) {
      with (deps) {
        if(!state.reasoningMode)return void clearReasoning(e); e&&(updateReasoning(e,"",{done:!0,persistSave:!0,keepReasoning:!0,keepEmpty:!0,unavailable:!0}),e.querySelector(".reasoning-panel")?.classList.add("reasoning-empty"))
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

    function isGpt5ReasoningModel(model = '') {
      return /^gpt-5(?:$|[-_.])/i.test(String(model || '').trim());
    }

    function reasoningPayloadOptions(options = {}) {
      with (deps) {
        if (options.reasoning === false || !state.reasoningMode || !isGpt5ReasoningModel(options.model)) return {};
        const effort = normalizeReasoningType(options.reasoningEffort || state.reasoningType);
        return REASONING_EFFORTS.includes(effort) ? { reasoning_effort: effort } : {};
      }
    }

    function extractStreamDelta(e) {
      with (deps) {
        if(window.ChatUICore?.reasoning?.extractStreamDelta)return window.ChatUICore.reasoning.extractStreamDelta(e);const t=e?.choices?.[0],s=t?.delta||{},n=t?.message||{},a=normalizeReasoningText(s.reasoning_content||s.reasoning||s.delta||n.reasoning_content||n.reasoning||n.delta||e?.reasoning_content||e?.reasoning||e?.reasoning_delta||"");let i=normalizeContentText(s.content||s.text||s.output_text||n.content||n.text||n.output_text||e?.output_text||("string"==typeof e?.delta?e.delta:"")||e?.content||e?.text||"");!i&&Array.isArray(e?.output)&&(i=e.output.filter(e=>!/reason/i.test(String(e?.type||e?.role||""))).map(e=>normalizeContentText(e?.content||e?.text||e?.output_text||"")).join(""));const o=!a&&Array.isArray(e?.output)?normalizeReasoningText(e.output.filter(e=>/reason/i.test(String(e?.type||e?.role||""))||e?.summary||e?.summary_text||e?.reasoning)):"";return{content:i,reasoning:a||o}
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
        return window.ChatUICore?.reasoning?.normalizeReasoningText?window.ChatUICore.reasoning.normalizeReasoningText(e):e?"string"==typeof e?e:Array.isArray(e)?e.map(e=>normalizeReasoningText(e?.text||e?.content||e?.summary||e?.summary_text||e?.reasoning||e?.reasoning_content||e?.output_text||e?.delta||e)).filter(Boolean).join("\n"):"object"==typeof e?normalizeReasoningText(e.text||e.content||e.summary||e.summary_text||e.reasoning||e.reasoning_content||e.output_text||e.delta||""):String(e||""):""
      }
    }

    function renderReasoningMarkdown(e) {
      with (deps) {
        return renderMarkdown(protectReasoningMarkdownText(e))
      }
    }

    function selectedReasoningEffortText(value = "none") {
      const effort = normalizeReasoningType(value);
      return REASONING_EFFORTS.includes(effort) ? effort : "low";
    }

    function updateReasoningControls() {
      with (deps) {
        const toggle = $("reasoningToggle");
        const menuButton = $("reasoningMenuBtn");
        const locked = isReasoningControlLocked();
        const enabled = !!state.reasoningMode;
        if (toggle) {
          toggle.classList.toggle("active", enabled);
          toggle.classList.toggle("locked", locked);
          toggle.disabled = locked;
          toggle.setAttribute("aria-disabled", String(locked));
          toggle.setAttribute("aria-pressed", String(enabled));
          toggle.title = locked ? "Reasoning settings cannot be changed while output is streaming" : enabled ? "Disable reasoning" : "Enable reasoning";
          toggle.setAttribute("aria-label", toggle.title);
        }
        if (menuButton) {
          menuButton.classList.toggle("show", enabled);
          menuButton.classList.toggle("disabled", !enabled || locked);
          menuButton.disabled = !enabled || locked;
          menuButton.setAttribute("aria-disabled", String(!enabled || locked));
          menuButton.title = locked ? "\u8f93\u51fa\u8fc7\u7a0b\u4e2d\u4e0d\u80fd\u4fee\u6539\u601d\u8003\u8bbe\u7f6e" : "\u601d\u8003\u5f3a\u5ea6";
        }
        if (!enabled || locked) closeReasoningMenu();
        const typeLabel = $("reasoningTypeLabel");
        if (typeLabel) typeLabel.textContent = selectedReasoningEffortText(state.reasoningType);
        document.querySelectorAll("[data-reasoning-type]")?.forEach(item => {
          const selected = item.dataset.reasoningType === state.reasoningType;
          item.classList.toggle("selected", selected);
          item.disabled = !enabled || locked;
          item.classList.toggle("disabled", !enabled || locked);
          item.setAttribute("aria-disabled", String(!enabled || locked));
          item.setAttribute("aria-checked", String(selected));
        });
      }
    }

    function isReasoningControlLocked() {
      with (deps) {
        return isSessionBusy(state.activeSessionId);
      }
    }

    function loadReasoningPreference() {
      with (deps) {
        const session = typeof getActiveSession === "function" ? getActiveSession() : null;
        const hasSessionMode = session && session.reasoningMode !== undefined && session.reasoningMode !== null;
        const savedType = session?.reasoningType ?? localStorage.getItem(REASONING_TYPE_KEY) ?? state.reasoningType;
        const savedMode = hasSessionMode ? !!session.reasoningMode : localStorage.getItem(REASONING_MODE_KEY) === "1";
        const normalizedType = normalizeReasoningType(savedType);
        state.reasoningMode = savedMode && REASONING_EFFORTS.includes(normalizedType);
        state.reasoningType = state.reasoningMode ? normalizedType : "none";
        state.reasoningPersist = "0" !== localStorage.getItem(REASONING_PERSIST_KEY);
        if (session) {
          session.reasoningMode = state.reasoningMode;
          session.reasoningType = state.reasoningType;
          typeof saveSessionsMeta === "function" && saveSessionsMeta();
        }
        updateReasoningControls();
      }
    }

    function saveActiveReasoningPreference() {
      with (deps) {
        const normalizedType = normalizeReasoningType(state.reasoningType);
        state.reasoningMode = !!state.reasoningMode && REASONING_EFFORTS.includes(normalizedType);
        state.reasoningType = state.reasoningMode ? normalizedType : "none";
        const session = typeof getActiveSession === "function" ? getActiveSession() : null;
        if (session) {
          session.reasoningMode = state.reasoningMode;
          session.reasoningType = state.reasoningType;
          typeof saveSessionsMeta === "function" && saveSessionsMeta();
        }
        localStorage.setItem(REASONING_MODE_KEY, state.reasoningMode ? "1" : "0");
        localStorage.setItem(REASONING_TYPE_KEY, state.reasoningType);
      }
    }

    function setReasoningMode(enabled) {
      with (deps) {
        if (isReasoningControlLocked()) return toast("Reasoning settings cannot be changed while output is streaming");
        state.reasoningMode = !!enabled;
        state.reasoningType = state.reasoningMode && REASONING_EFFORTS.includes(normalizeReasoningType(state.reasoningType))
          ? normalizeReasoningType(state.reasoningType)
          : state.reasoningMode ? "low" : "none";
        saveActiveReasoningPreference();
        // This preference applies to subsequent requests only. Completed response
        // reasoning remains visible and durable regardless of the next-request mode.
        updateReasoningControls();
      }
    }

    function setReasoningType(value = "none") {
      with (deps) {
        if (isReasoningControlLocked()) return toast("Reasoning settings cannot be changed while output is streaming");
        state.reasoningType = normalizeReasoningType(value);
        state.reasoningMode = REASONING_EFFORTS.includes(state.reasoningType);
        saveActiveReasoningPreference();
        // This preference applies to subsequent requests only. Completed response
        // reasoning remains visible and durable regardless of the next-request mode.
        updateReasoningControls();
      }
    }

    function openReasoningMenu() {
      with (deps) {
        if (isReasoningControlLocked()) return toast("Reasoning settings cannot be changed while output is streaming");
        if (!state.reasoningMode) return;
        const menu = $("reasoningMenu");
        const menuButton = $("reasoningMenuBtn");
        if (menu) {
          menu.classList.add("show");
          menu.setAttribute("aria-hidden", "false");
          menuButton?.setAttribute("aria-expanded", "true");
        }
      }
    }

    function closeReasoningMenu() {
      with (deps) {
        const menu = $("reasoningMenu");
        const menuButton = $("reasoningMenuBtn");
        if (menu) {
          const active = document?.activeElement;
          if (active && menu.contains?.(active)) {
            if (menuButton && !menuButton.disabled) menuButton.focus?.({ preventScroll: true });
            else active.blur?.();
          }
          menu.classList.remove("show");
          menu.setAttribute("aria-hidden", "true");
          menuButton?.setAttribute("aria-expanded", "false");
        }
      }
    }

    function toggleReasoningMenu() {
      with (deps) {
        const menu = $("reasoningMenu");
        if (menu?.classList.contains("show")) closeReasoningMenu();
        else openReasoningMenu();
      }
    }

    return Object.freeze({ updateReasoning, finishReasoning, showReasoningUnavailable, clearAllReasoningDisplays, clearReasoning, forceRemoveReasoning, isEmptyReasoningPanel, isGpt5ReasoningModel, reasoningPayloadOptions, extractStreamDelta, extractResponsesStreamDelta, normalizeContentText, normalizeReasoningText, renderReasoningMarkdown, updateReasoningControls, isReasoningControlLocked, loadReasoningPreference, setReasoningMode, setReasoningType, openReasoningMenu, closeReasoningMenu, toggleReasoningMenu });
  }

  const api = Object.freeze({ createReasoningWorkflow });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.ChatUIAppReasoningWorkflow = api;
  if (root?.window) root.window.ChatUIAppReasoningWorkflow = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
