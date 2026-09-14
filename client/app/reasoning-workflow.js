(function initChatUIAppReasoningWorkflow(root) {
  // Reasoning bodies migrated from app.js resolve deps dependencies explicitly.
  const window = root?.window || root || {};

  const REASONING_TYPES = Object.freeze(['none', 'low', 'medium', 'high', 'xhigh', 'max']);
  const REASONING_EFFORTS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);

  function getReasoningText(node) {
    return String(node?.__chatuiReasoningText ?? node?.dataset?.reasoningText ?? '');
  }

  function setReasoningText(node, value, { persistDataset = false } = {}) {
    if (!node) return;
    const reasoning = String(value || '');
    node.__chatuiReasoningText = reasoning;
    if (persistDataset && node.dataset && node.dataset.reasoningText !== reasoning) node.dataset.reasoningText = reasoning;
  }

  function normalizeReasoningType(value = 'none') {
    const type = String(value || '').trim().toLowerCase();
    return REASONING_TYPES.includes(type) ? type : 'none';
  }

  function createReasoningWorkflow(deps = {}) {
    if (!deps.state) throw new Error('state is required');

    const configuredReasoningModeKey = typeof REASONING_MODE_KEY === "string" ? REASONING_MODE_KEY : "";
    const configuredReasoningTypeKey = typeof REASONING_TYPE_KEY === "string" ? REASONING_TYPE_KEY : "";
    const configuredReasoningPersistKey = typeof REASONING_PERSIST_KEY === "string" ? REASONING_PERSIST_KEY : "";
    const reasoningModeKey = configuredReasoningModeKey || deps.reasoningModeKey || "openapi-chat-reasoning-mode-v1";
    const reasoningTypeKey = configuredReasoningTypeKey || deps.reasoningTypeKey || "openapi-chat-reasoning-type-v1";
    const reasoningPersistKey = configuredReasoningPersistKey || deps.reasoningPersistKey || "openapi-chat-reasoning-persist-v1";

    function reasoningStreamingRendererFor(o) {
      if (!o) return null;
      let renderer = o.__reasoningStreamingRenderer;
      if (renderer) return renderer;
      const renderMarkdownFn = typeof deps.renderMarkdown === 'function'
        ? deps.renderMarkdown
        : (value => window.ChatUIApp?.markdown?.renderMarkdown?.(value) || '');
      const createRenderer = window.ChatUIApp?.markdown?.createStreamingRenderer;
      const bindCopy = typeof deps.bindInlineCopyButtons === 'function' ? deps.bindInlineCopyButtons : () => {};
      const onLayoutChange = () => {
        const messageNode = o.closest?.('.message') || o;
        const sessionId = messageNode?.dataset?.sessionId || deps.state.activeSessionId;
        deps.commitStreamingOutput?.(messageNode, {
          margin: 72,
          sessionId,
          requireActive: true,
          requireFollow: true,
        });
      };
      if (typeof createRenderer === 'function') {
        renderer = createRenderer({
          renderMarkdown: renderMarkdownFn,
          onLayoutChange,
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

    function isPendingDisplayItemNode(node) {
      const item = node?.__displayItem;
      return item?.pending === '1' || item?.pending === true;
    }

    function setReasoningPanelExpanded(panel, expanded) {
      if (!panel) return;
      panel.dataset.collapsed = expanded ? '0' : '1';
      const toggle = panel.querySelector('.reasoning-toggle');
      if (toggle) toggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    }

    function updateReasoning(e,t,s={}) {
      { 
        if(!e)return;
        if(!deps.state.reasoningMode&&!s.restoreHistory&&!s.forceDisplay){forceRemoveReasoning(e); return;}
        const n=String(t||"");
        const done=s.done===!0&&!isPendingDisplayItemNode(e);
        if(!done&&!s.forceDisplay&&getReasoningText(e)===n&&e.querySelector(".reasoning-panel"))return;
        e.querySelectorAll(".reasoning-live").forEach(live=>live.remove());
        const content=e.querySelector(".content");
        const panelHost=e.querySelector(".bubble")||content;
        content?.querySelector?.(".pending-feedback")?.remove();
        if(!n){
          // Empty reasoning is not a display phase. Remove both a synthetic
          // panel and any previously rendered panel instead of leaving an
          // empty “正在思考” surface behind.
          forceRemoveReasoning(e);
          return;
        }
        if(n){
          setReasoningText(e,n,{persistDataset:done});
          e.dataset.keepReasoning="1";
        }
        if(panelHost){
          let panel=e.querySelector(".reasoning-panel");
          if(!panel){
            panel=deps.document.createElement("section");
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
              if(done){renderer.final(body,n);try{typeof deps.bindInlineCopyButtons==="function"&&deps.bindInlineCopyButtons(panel)}catch(err){}}
              else renderer.set(n,body);
            }else{
              try{renderer.reset(body)}catch(err){}
            }
          }
          const completed=done;
          panel.classList.toggle("reasoning-done",completed);
          const label=panel.querySelector(".reasoning-label");
          if(label) label.textContent=completed?"思考完成":"正在思考";
          const dots=panel.querySelector(".reasoning-dots");
          if(dots) dots.hidden=completed;
          // Completed reasoning defaults closed; callers may explicitly request expansion.
          setReasoningPanelExpanded(panel,completed?s.expanded===!0:s.expanded!==!1);
        }
        const ownsLiveOutput = e?.dataset?.streaming === "1" && (deps.state.activeOutputNode === e || s.followActive === !0);
        if (ownsLiveOutput) {
          (deps.commitStreamingOutput || deps.scrollToActiveOutput)(e,{force:s.followActive===!0,active:!0,margin:72,tailLock:s.tailLock===!0,sessionId:e.dataset.sessionId||deps.state.activeSessionId});
        } else deps.scrollToActiveOutput(e,{force:s.forceScroll??!1,active:!0===s.followActive});
       }
    }

    function finishReasoning(e,t,s={}) {
      { 
        const reasoning=String(t||getReasoningText(e)||"");
        if(reasoning) updateReasoning(e,reasoning,{done:!0,restoreHistory:!0,expanded:s.expanded});
        else forceRemoveReasoning(e);
       }
    }

    function showReasoningUnavailable(e) {
      { 
        forceRemoveReasoning(e);
       }
    }

    function clearAllReasoningDisplays() {
      { 
        deps.document.querySelectorAll(".message").forEach(e=>forceRemoveReasoning(e));
       }
    }

    function clearReasoning(e) {
      { 
        updateReasoning(e,"")
       }
    }

    function forceRemoveReasoning(e) {
      { 
        e&&(e.querySelectorAll(".reasoning-panel,.reasoning-live").forEach(e=>e.remove()),delete e.__chatuiReasoningText,delete e.dataset.reasoningText,delete e.dataset.keepReasoning)
       }
    }

    function isEmptyReasoningPanel(e) {
      { 
        return !1
       }
    }

    function isGpt5ReasoningModel(model = '') {
      return /^gpt-5(?:$|[-_.])/i.test(String(model || '').trim());
    }

    function reasoningPayloadOptions(options = {}) {
      { 
        const reasoningEnabled = options.reasoning === undefined ? !!deps.state.reasoningMode : !!options.reasoning;
        if (!reasoningEnabled || !isGpt5ReasoningModel(options.model)) return {};
        const effort = normalizeReasoningType(options.reasoningEffort || deps.state.reasoningType);
        return REASONING_EFFORTS.includes(effort) ? { reasoning: { effort, summary: 'auto' } } : {};
       }
    }

    function extractStreamDelta(e) {
      { 
        if(window.ChatUICore?.reasoning?.extractStreamDelta)return window.ChatUICore.reasoning.extractStreamDelta(e);const t=e?.choices?.[0],s=t?.delta||{},n=t?.message||{},a=normalizeReasoningText(s.reasoning_content||s.reasoning||s.delta||n.reasoning_content||n.reasoning||n.delta||e?.reasoning_content||e?.reasoning||e?.reasoning_delta||"");let i=normalizeContentText(s.content||s.text||s.output_text||n.content||n.text||n.output_text||e?.output_text||("string"==typeof e?.delta?e.delta:"")||e?.content||e?.text||"");!i&&Array.isArray(e?.output)&&(i=e.output.filter(e=>!/reason/i.test(String(e?.type||e?.role||""))).map(e=>normalizeContentText(e?.content||e?.text||e?.output_text||"")).join(""));const o=!a&&Array.isArray(e?.output)?normalizeReasoningText(e.output.filter(e=>/reason/i.test(String(e?.type||e?.role||""))||e?.summary||e?.summary_text||e?.reasoning)):"";return{content:i,reasoning:a||o}
       }
    }

    function extractResponsesStreamDelta(e) {
      { 
        if(e&&"object"==typeof e&&("d"in e||"r"in e))return{content:normalizeContentText(e.d||""),reasoning:normalizeReasoningText(e.r||"")};const t=String(e?.type||"");if(/\.done$/i.test(t)||"response.completed"===t)return{content:"",reasoning:""};const s=/reasoning/i.test(t),n=/summary/i.test(t),a=s&&n?e?.delta||e?.text||e?.content||e?.output_text||"":"";return{content:normalizeContentText((s?"":e?.delta)||(s?"":e?.text)||(s?"":e?.output_text_delta)||(s?"":e?.response?.output_text?.delta)||""),reasoning:normalizeReasoningText(e?.summary_text_delta||e?.reasoning_summary_text_delta||e?.delta_text||e?.summary_text||e?.reasoning_summary_text||e?.summary||e?.reasoning_summary||a||"")}
       }
    }

    function normalizeContentText(e) {
      { 
        if(window.ChatUICore?.reasoning?.normalizeContentText)return window.ChatUICore.reasoning.normalizeContentText(e);if(!e)return"";if("string"==typeof e)return e;if(Array.isArray(e))return e.map(e=>normalizeContentText(e?.text||e?.content||e?.output_text||e?.message||e?.delta||e)).filter(Boolean).join("");if("object"==typeof e){const t=Array.isArray(e.output)?e.output.filter(e=>!/reason/i.test(String(e?.type||e?.role||""))):"";return normalizeContentText(e.text||e.content||e.output_text||e.message||e.delta||e.response||t||"")}return String(e||"")
       }
    }

    function normalizeReasoningText(e) {
      { 
        return window.ChatUICore?.reasoning?.normalizeReasoningText?window.ChatUICore.reasoning.normalizeReasoningText(e):e?"string"==typeof e?e:Array.isArray(e)?e.map(e=>normalizeReasoningText(e?.text||e?.content||e?.summary||e?.summary_text||e?.reasoning||e?.reasoning_content||e?.output_text||e?.delta||e)).filter(Boolean).join("\n"):"object"==typeof e?normalizeReasoningText(e.text||e.content||e.summary||e.summary_text||e.reasoning||e.reasoning_content||e.output_text||e.delta||""):String(e||""):""
       }
    }

    function renderReasoningMarkdown(e) {
      { 
        return deps.renderMarkdown(deps.protectReasoningMarkdownText(e))
       }
    }

    const REASONING_EFFORT_LABELS = Object.freeze({
      none: "不思考",
      low: "低",
      medium: "中",
      high: "高",
      xhigh: "超高",
      max: "最高",
    });

    function selectedReasoningEffortText(value = "none") {
      const effort = normalizeReasoningType(value);
      return REASONING_EFFORT_LABELS[effort] || REASONING_EFFORT_LABELS.none;
    }

    function updateReasoningControls() {
      { 
        const toggle = deps.$("reasoningToggle");
        const menuButton = deps.$("reasoningMenuBtn");
        const locked = isReasoningControlLocked();
        const enabled = !!deps.state.reasoningMode;
        const selectedType = enabled ? normalizeReasoningType(deps.state.reasoningType) : "none";
        const selectedLabel = selectedReasoningEffortText(selectedType);
        if (toggle) {
          toggle.classList.toggle("active", enabled);
          toggle.classList.toggle("locked", locked);
          toggle.disabled = locked;
          toggle.setAttribute("aria-disabled", String(locked));
          toggle.setAttribute("aria-pressed", String(enabled));
          toggle.title = locked ? "输出过程中不能修改思考设置" : enabled ? "关闭思考" : "开启思考";
          toggle.setAttribute("aria-label", toggle.title);
        }
        if (menuButton) {
          menuButton.classList.toggle("show", true);
          menuButton.classList.toggle("active", enabled);
          menuButton.classList.toggle("disabled", locked);
          menuButton.disabled = locked;
          menuButton.setAttribute("aria-disabled", String(locked));
          menuButton.title = locked
            ? "输出过程中不能修改思考设置"
            : `思考强度：${selectedLabel}${selectedType === "none" ? "" : ` (${selectedType})`}`;
          menuButton.setAttribute("aria-label", menuButton.title);
        }
        if (locked) closeReasoningMenu();
        const typeLabel = deps.$("reasoningTypeLabel");
        if (typeLabel) typeLabel.textContent = selectedLabel;
        deps.document.querySelectorAll("[data-reasoning-type]")?.forEach(item => {
          const selected = item.dataset.reasoningType === selectedType;
          item.classList.toggle("selected", selected);
          item.disabled = locked;
          item.classList.toggle("disabled", locked);
          item.setAttribute("aria-disabled", String(locked));
          item.setAttribute("aria-checked", String(selected));
        });
       }
    }

    function isReasoningControlLocked() {
      { 
        return (deps.isSessionBusy ?? isSessionBusy)(deps.state.activeSessionId);
       }
    }

    function loadReasoningPreference() {
      { 
        const session = typeof deps.getActiveSession === "function" ? deps.getActiveSession() : null;
        const hasSessionMode = session && session.reasoningMode !== undefined && session.reasoningMode !== null;
        const savedType = session?.reasoningType ?? deps.localStorage.getItem(reasoningTypeKey) ?? deps.state.reasoningType;
        const savedMode = hasSessionMode ? !!session.reasoningMode : deps.localStorage.getItem(reasoningModeKey) === "1";
        const normalizedType = normalizeReasoningType(savedType);
        deps.state.reasoningMode = savedMode && REASONING_EFFORTS.includes(normalizedType);
        deps.state.reasoningType = deps.state.reasoningMode ? normalizedType : "none";
        deps.state.reasoningPersist = "0" !== deps.localStorage.getItem(reasoningPersistKey);
        if (session) {
          session.reasoningMode = deps.state.reasoningMode;
          session.reasoningType = deps.state.reasoningType;
          typeof deps.saveSessionsMeta === "function" && deps.saveSessionsMeta();
        }
        updateReasoningControls();
       }
    }

    function saveActiveReasoningPreference() {
      { 
        const normalizedType = normalizeReasoningType(deps.state.reasoningType);
        deps.state.reasoningMode = !!deps.state.reasoningMode && REASONING_EFFORTS.includes(normalizedType);
        deps.state.reasoningType = deps.state.reasoningMode ? normalizedType : "none";
        const session = typeof deps.getActiveSession === "function" ? deps.getActiveSession() : null;
        if (session) {
          session.reasoningMode = deps.state.reasoningMode;
          session.reasoningType = deps.state.reasoningType;
          typeof deps.saveSessionsMeta === "function" && deps.saveSessionsMeta();
        }
        deps.localStorage.setItem(reasoningModeKey, deps.state.reasoningMode ? "1" : "0");
        deps.localStorage.setItem(reasoningTypeKey, deps.state.reasoningType);
       }
    }

    function setReasoningMode(enabled) {
      { 
        if (isReasoningControlLocked()) return deps.toast("输出过程中不能修改思考设置，请在当前回答结束后再试");
        deps.state.reasoningMode = !!enabled;
        deps.state.reasoningType = deps.state.reasoningMode && REASONING_EFFORTS.includes(normalizeReasoningType(deps.state.reasoningType))
          ? normalizeReasoningType(deps.state.reasoningType)
          : deps.state.reasoningMode ? "low" : "none";
        saveActiveReasoningPreference();
        // This preference applies to subsequent requests only. Completed response
        // reasoning remains visible and durable regardless of the next-request mode.
        updateReasoningControls();
       }
    }

    function setReasoningType(value = "none") {
      { 
        if (isReasoningControlLocked()) return deps.toast("输出过程中不能修改思考设置，请在当前回答结束后再试");
        deps.state.reasoningType = normalizeReasoningType(value);
        deps.state.reasoningMode = REASONING_EFFORTS.includes(deps.state.reasoningType);
        saveActiveReasoningPreference();
        // This preference applies to subsequent requests only. Completed response
        // reasoning remains visible and durable regardless of the next-request mode.
        updateReasoningControls();
       }
    }

    function openReasoningMenu() {
      { 
        if (isReasoningControlLocked()) return deps.toast("输出过程中不能修改思考设置，请在当前回答结束后再试");
        const menu = deps.$("reasoningMenu");
        const menuButton = deps.$("reasoningMenuBtn");
        if (menu) {
          menu.classList.add("show");
          menu.setAttribute("aria-hidden", "false");
          menuButton?.setAttribute("aria-expanded", "true");
        }
       }
    }

    function closeReasoningMenu() {
      { 
        const menu = deps.$("reasoningMenu");
        const menuButton = deps.$("reasoningMenuBtn");
        if (menu) {
          const active = deps.document?.activeElement;
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
      { 
        const menu = deps.$("reasoningMenu");
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
