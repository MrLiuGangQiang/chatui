(function initChatUIAppCustomSelectWorkflow(root) {
  'use strict';

  function createCustomSelectWorkflow(deps = {}) {
    const { getElement, document, window } = deps;

    function restoreCustomSelectMenu(menu) {
      if (!menu) return;
      const owner = menu.closest?.('.custom-select') || menu.__ownerSelect;
      if (owner?.__menuPlaceholder && menu.parentNode !== owner) {
        owner.__menuPlaceholder.replaceWith(menu);
        owner.__menuPlaceholder = null;
      } else if (menu.parentNode === document.body && menu.__ownerSelect) {
        menu.__ownerSelect.appendChild(menu);
      }
      menu.removeAttribute('style');
      menu.classList.remove('portal-menu');
    }

    function closeAllCustomSelects(except = null) {
      document.querySelectorAll('.custom-select.open').forEach(select => {
        if (select === except) return;
        select.classList.remove('open');
        restoreCustomSelectMenu(select.querySelector('.custom-select-menu')
          || document.querySelector(`body > .custom-select-menu.portal-menu[data-owner-id="${select.dataset.selectId || ''}"]`));
      });
      if (!except) document.querySelectorAll('body > .custom-select-menu.portal-menu').forEach(restoreCustomSelectMenu);
    }

    function renderCustomSelectLabel(target, option) {
      if (!target) return;
      target.innerHTML = '';
      const text = document.createElement('span');
      text.className = 'custom-select-main-text';
      const unrecognized = option?.dataset?.unrecognized === '1';
      text.textContent = unrecognized
        ? (option.textContent || '').replace(/（未知类型）$/, '')
        : option?.textContent || '请选择';
      target.appendChild(text);
      if (unrecognized) {
        const badge = document.createElement('span');
        badge.className = 'model-unrecognized-badge';
        badge.textContent = '未知类型';
        target.appendChild(badge);
      }
    }

    function updateCustomSelect(selectElement) {
      const select = selectElement?.closest('.custom-select');
      const value = select?.querySelector('.custom-select-value');
      if (value) renderCustomSelectLabel(value, selectElement.selectedOptions?.[0]);
      select?.querySelectorAll('.custom-select-option').forEach(option => {
        option.classList.toggle('selected', option.dataset.value === selectElement.value);
      });
    }

    function refreshCustomSelectOptions(selectElement) {
      const select = selectElement?.closest('.custom-select');
      const menu = select?.querySelector('.custom-select-menu');
      if (!select || !menu) return;
      menu.innerHTML = '';
      [...selectElement.options].forEach(option => {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'custom-select-option';
        item.dataset.value = option.value;
        item.dataset.unrecognized = option.dataset.unrecognized || '0';
        item.setAttribute('role', 'option');
        renderCustomSelectLabel(item, option);

        const choose = event => {
          event.preventDefault();
          event.stopPropagation();
          selectElement.value = option.value;
          selectElement.dispatchEvent(new Event('change', { bubbles: true }));
          updateCustomSelect(selectElement);
          closeAllCustomSelects();
        };
        // Do not cancel pointerdown: mobile browsers need the default gesture
        // to remain available for vertical scrolling through long model lists.
        item.addEventListener('pointerdown', event => event.stopPropagation());
        item.addEventListener('pointerup', choose);
        item.addEventListener('mousedown', event => event.stopPropagation());
        item.addEventListener('click', event => event.stopPropagation());
        menu.appendChild(item);
      });
      updateCustomSelect(selectElement);
    }

    function enhanceConfigSelects(ids = ['chatModel', 'routeModel', 'imageModel', 'sessionChatModel']) {
      ids.forEach(id => {
        const selectElement = typeof id === 'string' ? getElement(id) : id;
        if (!selectElement || selectElement.closest('.custom-select')) return;
        const wrapper = document.createElement('div');
        wrapper.className = 'custom-select';
        const trigger = document.createElement('button');
        trigger.type = 'button';
        trigger.className = 'custom-select-trigger';
        trigger.innerHTML = '<span class="custom-select-value"></span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"></path></svg>';
        const menu = document.createElement('div');
        menu.className = 'custom-select-menu';
        menu.setAttribute('role', 'listbox');
        selectElement.parentNode.insertBefore(wrapper, selectElement);
        wrapper.append(selectElement, trigger, menu);
        trigger.addEventListener('pointerdown', event => {
          event.preventDefault();
          event.stopPropagation();
          const open = !wrapper.classList.contains('open');
          closeAllCustomSelects(wrapper);
          wrapper.classList.toggle('open', open);
        });
        trigger.addEventListener('click', event => {
          event.preventDefault();
          event.stopPropagation();
        });
        selectElement.addEventListener('change', () => updateCustomSelect(selectElement));
        refreshCustomSelectOptions(selectElement);
      });
    }

    return Object.freeze({ restoreCustomSelectMenu, closeAllCustomSelects, renderCustomSelectLabel, updateCustomSelect, refreshCustomSelectOptions, enhanceConfigSelects });
  }

  const api = Object.freeze({ createCustomSelectWorkflow });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.ChatUIAppCustomSelectWorkflow = api;
  if (root?.window) root.window.ChatUIAppCustomSelectWorkflow = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
