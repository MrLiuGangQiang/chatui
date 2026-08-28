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

    function reasoningStreamingRendererFor(o) {
      if (!o) return null;
      let renderer = o.__reasoningStreamingRenderer;
      if (renderer) return renderer;
      const renderMarkdownFn = typeof deps.renderMarkdown === 'function'
        ? deps.renderMarkdown
        : (value => window.ChatUIApp?.markdown?.renderMarkdown?.(value) || '');
      const createRenderer = window.ChatUIApp?.markdown?.createStreamingRenderer;
      const bindCopy = typeof deps.bindInlineCopyButtons === 'function' ? deps.bindInlineCopyButtons : () => {};
      if (typeof createRenderer === 'function') {
        renderer = createRenderer({
          renderMarkdown: renderMarkdownFn,
          enhance(scopeRoot, phase = {}) {
            try { bindCopy(scopeRoot); } catch (e) {}
            try {
              window.ChatUIApp?.markdown?.enhanceRenderedMarkdown?.(scopeRoot, {
                streaming: !!phase.streaming,
                deferMermaid: true,
                allowResourceLoad: !!phase.final,
                autoRenderMermaid: !!phase.final,
                forceMermaid: !!phase.final,
              });
            } catch (e) {}
          },
        });
      } else {
        renderer = {
          set(value, container) { if (container) container.innerHTML = renderMarkdownFn(value || ''); },
          final(value, container) { if (container) container.innerHTML = renderMarkdownFn(value || ''); },
          reset(container) { if (container) container.innerHTML = ''; },
        };
      }
      o.__reasoningStreamingRenderer = renderer;
      return renderer;
    }

    function setReasoningPanelExpanded(panel, expanded) {
      if (!panel) return;
      panel.dataset.collapsed = expanded ? '0' : '1';
      const toggle = panel.querySelector('.reasoning-toggle');
      if (toggle) toggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    }

    function updateReasoning(e,t,s={}) {
      with (deps) {
        if(!e)return;
        if(!state.reasoningMode&&!s.restoreHistory){forceRemoveReasoning(e); return;}
        const n=String(t||"");
        e.querySelectorAll(".reasoning-live").forEach(live=>live.remove());
        const content=e.querySelector(".content");
        const panelHost=e.querySelector(".bubble")||content;
        content?.querySelector?.(".pending-feedback")?.remove();
        if(!n&&!s.keepEmpty){
          forceRemoveReasoning(e);
          return;
        }
        if(n){
          e.dataset.reasoningText=n;
          e.dataset.keepReasoning="1";
        }
        if(panelHost){
          let panel=e.querySelector(".reasoning-panel");
          if(!panel){
            panel=document.createElement("section");
            panel.className="reasoning-panel reasoning-live-panel";
            panel.innerHTML=`<button class="reasoning-head reasoning-toggle" type="button" aria-expanded="true"><span class="reasoning-title"><span class="reasoning-spark" aria-hidden="true"></span><span class="reasoning-label">正在思考</span><span class="reasoning-dots" aria-hidden="true"><i></i><i></i><i></i></span><span class="reasoning-chevron" aria-hidden="true"></span></span></button><div class="reasoning-content markdown-body"></div>`;
            const toggle=panel.querySelector(".reasoning-toggle");
            toggle?.addEventListener("click",()=>setReasoningPanelExpanded(panel,panel.dataset.collapsed==="1"));
            panelHost.prepend(panel);
          }
          const body=panel.querySelector(".reasoning-content");
          if(body){
            const renderer=reasoningStreamingRendererFor(body);
            if(n){
              if(s.done) renderer.final(body,n);
              else renderer.set(n,body);
              try{typeof bindInlineCopyButtons==="function"&&bindInlineCopyButtons(panel)}catch(err){}
            }else{
              try{renderer.reset(body)}catch(err){}
            }
          }
          const completed=!0===s.done;
          panel.classList.toggle("reasoning-done",completed);
          const label=panel.querySelector(".reasoning-label");
          if(label) label.textContent=completed?"思考完成":"正在思考";
          const dots=panel.querySelector(".reasoning-dots");
          if(dots) dots.hidden=completed;
          setReasoningPanelExpanded(panel,!1!==s.expanded);
        }
        const ownsLiveOutput = e?.dataset?.streaming === "1" && (state.activeOutputNode === e || s.followActive === !0);
        if (ownsLiveOutput) {
          (deps.commitStreamingOutput || scrollToActiveOutput)(e,{force:!0,active:!0,margin:72,tailLock:s.tailLock===!0,sessionId:e.dataset.sessionId||state.activeSessionId});
        } else scrollToActiveOutput(e,{force:s.forceScroll??!1,active:!0===s.followActive});
      }
    }

    function finishReasoning(e,t,s={}) {
      with (deps) {
        const reasoning=String(t||e?.dataset.reasoningText||"");
        if(reasoning) updateReasoning(e,reasoning,{done:!0,restoreHistory:!0,expanded:s.expanded});
        else forceRemoveReasoning(e);
      }
    }

    function showReasoningUnavailable(e) {
      with (deps) {
        forceRemoveReasoning(e);
      }
    }

    function clearAllReasoningDisplays() {
      with (deps) {
        document.querySelectorAll(".message").forEach(e=>forceRemoveReasoning(e));
      }
    }

    function clearReasoning(e) {
      with (deps) {
        updateReasoning(e,"")
      }
    }

    function forceRemoveReasoning(e) {
      with (deps) {
        e&&(e.querySelectorAll(".reasoning-panel,.reasoning-live").forEach(e=>e.remove()),delete e.dataset.reasoningText,delete e.dataset.keepReasoning)
      }
    }

    function isEmptyReasoningPanel(e) {
      with (deps) {
        return !1
      }
    }

    function isGpt5ReasoningModel(model = '') {
      return /^gpt-5(?:$|[-_.])/i.test(String(model || '').trim());
    }

    function reasoningPayloadOptions(options = {}) {
      with (deps) {
        const reasoningEnabled = options.reasoning === undefined ? !!state.reasoningMode : !!options.reasoning;
        if (!reasoningEnabled || !isGpt5ReasoningModel(options.model)) return {};
        const effort = normalizeReasoningType(options.reasoningEffort || state.reasoningType);
        return REASONING_EFFORTS.includes(effort) ? { reasoning: { effort, summary: 'auto' } } : {};
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
