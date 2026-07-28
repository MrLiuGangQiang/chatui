(function initChatUIAppSessionPanelWorkflow(root) {
  // Intentionally not strict: migrated current-session prompt/model panel glue from legacy app.js.

  function createSessionPanelWorkflow(deps = {}) {
    const {
      $,
      getActiveSession,
      getConfig,
      getSessionUiWorkflow,
      renderSessionPromptArea,
      saveSessionsMeta,
      setSessionChatModel,
      window,
    } = deps;

    function renderSessionModelArea() { return getSessionUiWorkflow().renderSessionModelArea(); }
    function saveSessionPrompt() { const element = $("sessionPromptInput"); if (!element) return; const session = getActiveSession(); session && (session.systemPrompt = element.value.trim(), session.hasSystemPromptOverride = true, saveSessionsMeta(), renderSessionPromptArea(), closeSessionPromptPanel()); }
    function saveSessionImageStyle() { const element = $("sessionImageStyleInput"); if (!element) return; const session = getActiveSession(); session && (session.imageStylePrompt = element.value.trim(), session.hasImageStylePromptOverride = true, saveSessionsMeta(), renderSessionPromptArea(), closeSessionImageStylePanel()); }
    function saveSessionModel() { setSessionChatModel(""); }
    function loadGlobalPromptToSessionInput() { const element = $("sessionPromptInput"); if (!element) return; const config = getConfig(); element.value = config.systemPrompt || ""; element.focus(); }
    function loadGlobalImageStyleToSessionInput() { const element = $("sessionImageStyleInput"); if (!element) return; const config = getConfig(); element.value = config.imageStylePrompt || ""; element.focus(); }
    function clearSessionPromptInput() { const element = $("sessionPromptInput"); element && (element.value = "", element.focus()); }
    function clearSessionImageStyleInput() { const element = $("sessionImageStyleInput"); element && (element.value = "", element.focus()); }
    function openPanel(panel, closeOtherPanels, render, focusElement, delay) { closeOtherPanels(); if (!panel) return; render(); panel.classList.add("show"); panel.setAttribute("aria-hidden", "false"); focusElement && window.setTimeout.call(window, () => focusElement.focus(), delay || 60); }
    function closePanel(panel, render) { panel && (panel.classList.remove("show"), panel.setAttribute("aria-hidden", "true"), render()); }
    function openSessionPromptPanel() { openPanel($("sessionPromptPanel"), () => { closeSessionModelPanel(), closeSessionImageStylePanel(); }, renderSessionPromptArea, $("sessionPromptInput"), 60); }
    function openSessionImageStylePanel() { openPanel($("sessionImageStylePanel"), () => { closeSessionModelPanel(), closeSessionPromptPanel(); }, renderSessionPromptArea, $("sessionImageStyleInput"), 60); }
    function openSessionModelPanel() { openPanel($("sessionModelPanel"), () => { closeSessionPromptPanel(), closeSessionImageStylePanel(); }, renderSessionModelArea, null, 0); const element = $("sessionModelBtn"); element?.setAttribute("aria-expanded", "true"); }
    function closeSessionModelPanel() { closePanel($("sessionModelPanel"), renderSessionModelArea); const element = $("sessionModelBtn"); element?.setAttribute("aria-expanded", "false"); }
    function closeSessionPromptPanel() { closePanel($("sessionPromptPanel"), renderSessionPromptArea); }
    function closeSessionImageStylePanel() { closePanel($("sessionImageStylePanel"), renderSessionPromptArea); }

    return Object.freeze({ renderSessionModelArea, saveSessionPrompt, saveSessionImageStyle, saveSessionModel, loadGlobalPromptToSessionInput, loadGlobalImageStyleToSessionInput, clearSessionPromptInput, clearSessionImageStyleInput, openSessionPromptPanel, openSessionImageStylePanel, openSessionModelPanel, closeSessionModelPanel, closeSessionPromptPanel, closeSessionImageStylePanel });
  }

  const api = Object.freeze({ createSessionPanelWorkflow });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.ChatUIAppSessionPanelWorkflow = api;
  if (root?.window) root.window.ChatUIAppSessionPanelWorkflow = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
