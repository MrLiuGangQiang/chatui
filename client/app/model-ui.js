(function initChatUIAppModelUi(root) {
  'use strict';

  function modelOptionHtml(model, { modelMeta = {}, escapeHtml = value => String(value || '') } = {}) {
    const meta = modelMeta?.[model] || {};
    const unrecognized = !!meta.unrecognized;
    const inferred = !!meta.inferred;
    const label = unrecognized ? `${model}（未知类型）` : inferred ? `${model}（按名称识别）` : model;
    return `<option value="${escapeHtml(model)}" data-unrecognized="${unrecognized ? '1' : '0'}">${escapeHtml(label)}</option>`;
  }

  function setSelectValue(select, value, updateCustomSelect = () => {}) {
    if (!select) return;
    const exists = [...select.options].some(option => option.value === value);
    select.value = exists ? value : '';
    updateCustomSelect(select);
  }

  function renderModelOptions({
    models = [],
    modelMeta = {},
    values = {},
    getElement = () => null,
    isModelAllowedFor = () => true,
    escapeHtml = value => String(value || ''),
    updateCustomSelect = () => {},
    refreshCustomSelectOptions = () => {},
  } = {}) {
    const uniqueModels = [...new Set(models)].filter(Boolean);
    const chatModels = uniqueModels.filter(model => isModelAllowedFor(model, 'chat'));
    const imageModels = uniqueModels.filter(model => isModelAllowedFor(model, 'image'));
    const option = model => modelOptionHtml(model, { modelMeta, escapeHtml });
    const chatSelect = getElement('chatModel');
    const routeSelect = getElement('routeModel');
    const imageSelect = getElement('imageModel');
    const placeholder = '<option value="">请选择模型</option>';
    if (chatSelect) chatSelect.innerHTML = placeholder + chatModels.map(option).join('');
    if (routeSelect) routeSelect.innerHTML = '<option value="">跟随聊天模型</option>' + chatModels.map(option).join('');
    if (imageSelect) imageSelect.innerHTML = placeholder + imageModels.map(option).join('');
    setSelectValue(chatSelect, values.chatModel || '', updateCustomSelect);
    setSelectValue(routeSelect, values.routeModel || '', updateCustomSelect);
    setSelectValue(imageSelect, values.imageModel || '', updateCustomSelect);
    [chatSelect, routeSelect, imageSelect].forEach(select => select && refreshCustomSelectOptions(select));
    return { chatModels, imageModels };
  }

  function createModelUiController(deps = {}) {
    const getState = deps.getState || (() => ({}));
    const getElement = deps.getElement || (() => null);
    const escapeHtml = deps.escapeHtml || (value => String(value || ''));
    const isModelAllowedFor = deps.isModelAllowedFor || (() => true);
    const updateCustomSelect = deps.updateCustomSelect || (() => {});
    const refreshCustomSelectOptions = deps.refreshCustomSelectOptions || (() => {});
    const requestModels = deps.requestModels;
    const extractModels = deps.extractModels;
    const renderSessionModelArea = deps.renderSessionModelArea || (() => {});
    const saveConfig = deps.saveConfig || (() => {});

    function renderOptions(chatModel = getElement('chatModel')?.value || '', imageModel = getElement('imageModel')?.value || '', routeModel = getElement('routeModel')?.value || '') {
      const state = getState();
      return renderModelOptions({
        models: state.models || [],
        modelMeta: state.modelMeta || {},
        values: { chatModel, imageModel, routeModel },
        getElement,
        isModelAllowedFor,
        escapeHtml,
        updateCustomSelect,
        refreshCustomSelectOptions,
      });
    }

    async function loadModels() {
      const button = getElement('loadModelsBtn');
      const status = getElement('modelLoadStatus');
      if (button) button.disabled = true;
      if (status) status.textContent = '加载中…';
      try {
        const payload = await requestModels();
        const { models, meta } = extractModels(payload);
        if (!models.length) throw new Error('未从 /models 返回中识别到模型列表');
        const state = getState();
        state.models = models;
        state.modelMeta = meta;
        renderOptions(getElement('chatModel')?.value || '', getElement('imageModel')?.value || '', getElement('routeModel')?.value || '');
        renderSessionModelArea();
        saveConfig(true);
        const unknown = models.filter(model => state.modelMeta?.[model]?.unrecognized).length;
        if (status) status.textContent = unknown ? `已加载 ${models.length} 个，${unknown} 个未知类型` : `已加载 ${models.length} 个`;
      } catch (err) {
        if (status) status.textContent = err?.message || String(err);
      } finally {
        if (button) button.disabled = false;
      }
    }

    return Object.freeze({ renderModelOptions: renderOptions, loadModels });
  }

  const api = Object.freeze({ modelOptionHtml, setSelectValue, renderModelOptions, createModelUiController });

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.ChatUIAppModelUi = api;
  if (root?.window) root.window.ChatUIAppModelUi = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
