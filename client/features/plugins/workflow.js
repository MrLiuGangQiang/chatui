(function initChatUIPluginWorkflow(root) {
  'use strict';

  function pluginService(deps = {}) {
    return deps.pluginService
      || root?.[Symbol.for('chatui.module-registry.v1')]?.get?.('pluginService')
      || (typeof require === 'function' ? require('../services/plugin-service') : null);
  }

  function createPluginWorkflow(deps = {}) {
    const service = pluginService(deps);
    const documentRef = deps.document || root?.document;
    const button = deps.button || documentRef?.getElementById?.('pluginBtn');
    const panel = deps.panel || documentRef?.getElementById?.('pluginPanel');
    const list = deps.list || documentRef?.getElementById?.('pluginList');
    const close = deps.closeButton || documentRef?.getElementById?.('pluginPanelClose');
    const save = deps.saveButton || documentRef?.getElementById?.('pluginPanelSave');
    if (!service) return Object.freeze({ selectedToolIds: () => [], runPluginChat: async () => { throw new Error('插件服务未加载'); }, initPanel: () => {} });

    function selectedToolIds() { return service.selectedToolIds(); }

    function toolId(plugin = {}, tool = {}) { return `${plugin.id}:${tool.name}`; }

    function label(plugin = {}) {
      const type = plugin.type === 'mcp' ? 'MCP' : 'HTTP';
      return `${plugin.label || plugin.id} · ${type}`;
    }

    function updateButton(count = 0) {
      if (!button) return;
      button.classList.toggle('has-plugins', count > 0);
      button.title = count > 0 ? `插件：已启用 ${count} 个工具` : '插件';
      const countEl = button.querySelector('.plugin-count');
      if (countEl) {
        countEl.textContent = count > 0 ? String(count) : '';
        countEl.setAttribute('aria-hidden', count > 0 ? 'false' : 'true');
      }
    }

    function render(plugins = []) {
      if (!list || !panel) return;
      const selected = new Set(selectedToolIds());
      list.replaceChildren();
      if (!plugins.length) {
        const empty = documentRef.createElement('div');
        empty.className = 'plugin-empty';
        empty.textContent = '服务端尚未配置 HTTP 或 MCP 插件。';
        list.append(empty);
      }
      for (const plugin of plugins) {
        const group = documentRef.createElement('div');
        group.className = 'plugin-group';
        const title = documentRef.createElement('div');
        title.className = 'plugin-group-title';
        title.textContent = label(plugin);
        group.append(title);
        for (const tool of plugin.tools || []) {
          const option = documentRef.createElement('label');
          option.className = 'plugin-option';
          const input = documentRef.createElement('input');
          input.type = 'checkbox';
          input.value = toolId(plugin, tool);
          const locked = tool.requiresApproval === true;
          input.disabled = locked;
          input.checked = !locked && selected.has(input.value);
          const copy = documentRef.createElement('span');
          copy.className = 'plugin-option-copy';
          const name = documentRef.createElement('strong');
          name.textContent = tool.name;
          const desc = documentRef.createElement('small');
          desc.textContent = locked ? `${tool.description || ''}（需逐次确认，暂不自动调用）` : (tool.description || '未提供工具说明');
          copy.append(name, desc);
          option.append(input, copy);
          group.append(option);
        }
        list.append(group);
      }
      panel.dataset.loaded = '1';
    }

    async function loadPlugins() {
      try {
        const plugins = await service.listPlugins();
        render(plugins);
      } catch (error) {
        if (list) {
          list.replaceChildren();
          const item = documentRef.createElement('div');
          item.className = 'plugin-empty plugin-error';
          item.textContent = error?.message || '插件配置暂时不可用，请稍后重试。';
          list.append(item);
        }
      }
    }

    function togglePanel(open) {
      if (!panel || !button) return;
      const next = open === undefined ? panel.getAttribute('aria-hidden') === 'true' : !!open;
      panel.setAttribute('aria-hidden', next ? 'false' : 'true');
      button.setAttribute('aria-expanded', next ? 'true' : 'false');
      if (next && panel.dataset.loaded !== '1') void loadPlugins();
      if (next) list?.querySelector?.('input:not(:disabled)')?.focus?.();
    }

    function persistSelection() {
      const inputs = list?.querySelectorAll?.('input[type="checkbox"]:checked') || [];
      const ids = [...inputs].map(input => input.value);
      const saved = service.saveSelectedToolIds(ids);
      updateButton(saved.length);
      togglePanel(false);
    }

    function initPanel() {
      if (!button || !panel || button.dataset.pluginBound === '1') return;
      button.dataset.pluginBound = '1';
      button.addEventListener('click', () => togglePanel());
      close?.addEventListener('click', () => togglePanel(false));
      save?.addEventListener('click', persistSelection);
      documentRef?.addEventListener?.('click', event => {
        if (panel.getAttribute('aria-hidden') !== 'false') return;
        const target = event.target;
        if (panel.contains(target) || button.contains(target)) return;
        togglePanel(false);
      });
      updateButton(selectedToolIds().length);
    }

    async function runPluginChat(options = {}) { return service.runPluginChat(options); }

    return Object.freeze({ selectedToolIds, runPluginChat, initPanel, loadPlugins });
  }

  const api = Object.freeze({ createPluginWorkflow });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root?.[Symbol.for('chatui.module-registry.v1')]?.get?.('moduleRegistry')?.register('pluginWorkflow', api);
  if (root?.document?.getElementById?.('pluginBtn')) {
    createPluginWorkflow().initPanel();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
