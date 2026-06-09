(function initChatUIAppCustomSelectWorkflow(root) {
  'use strict';

  function createCustomSelectWorkflow(deps = {}) {
    const { getElement, document, window } = deps;

    function restoreCustomSelectMenu(e){if(!e)return;const t=e.closest?.(".custom-select")||e.__ownerSelect;if(t?.__menuPlaceholder&&e.parentNode!==t){t.__menuPlaceholder.replaceWith(e),t.__menuPlaceholder=null}else e.parentNode===document.body&&e.__ownerSelect&&e.__ownerSelect.appendChild(e);e.removeAttribute("style"),e.classList.remove("portal-menu")}

    function closeAllCustomSelects(e=null){document.querySelectorAll(".custom-select.open").forEach(t=>{t!==e&&(t.classList.remove("open"),restoreCustomSelectMenu(t.querySelector(".custom-select-menu")||document.querySelector(`body > .custom-select-menu.portal-menu[data-owner-id="${t.dataset.selectId||""}"]`)))}),e||document.querySelectorAll("body > .custom-select-menu.portal-menu").forEach(restoreCustomSelectMenu)}

    function renderCustomSelectLabel(e,t){if(!e)return;e.innerHTML="";const s=document.createElement("span");s.className="custom-select-main-text";const n="1"===t?.dataset?.unrecognized;if(s.textContent=n?(t.textContent||"").replace(/（未知类型）$/,""):t?.textContent||"请选择",e.appendChild(s),n){const t=document.createElement("span");t.className="model-unrecognized-badge",t.textContent="未知类型",e.appendChild(t)}}

    function updateCustomSelect(e){const t=e?.closest(".custom-select"),s=t?.querySelector(".custom-select-value");s&&renderCustomSelectLabel(s,e?.selectedOptions?.[0]),t?.querySelectorAll(".custom-select-option").forEach(t=>{t.classList.toggle("selected",t.dataset.value===e.value)})}

    function refreshCustomSelectOptions(e){const t=e?.closest(".custom-select"),s=t?.querySelector(".custom-select-menu");t&&s&&(s.innerHTML="",[...e.options].forEach(n=>{const a=document.createElement("button");a.type="button",a.className="custom-select-option",a.dataset.value=n.value,a.dataset.unrecognized=n.dataset.unrecognized||"0",a.setAttribute("role","option"),renderCustomSelectLabel(a,n),a.addEventListener("pointerdown",t=>{t.preventDefault(),t.stopPropagation(),e.value=n.value,e.dispatchEvent(new Event("change",{bubbles:!0})),updateCustomSelect(e),closeAllCustomSelects()}),a.addEventListener("mousedown",e=>{e.preventDefault(),e.stopPropagation()}),a.addEventListener("click",e=>{e.preventDefault(),e.stopPropagation()}),s.appendChild(a)}),updateCustomSelect(e))}

    function enhanceConfigSelects(e=["chatModel","routeModel","imageModel","imageSize","sessionChatModel"]){e.forEach(e=>{const t="string"==typeof e?getElement(e):e;if(!t||t.closest(".custom-select"))return;const s=document.createElement("div");s.className="custom-select";const n=document.createElement("button");n.type="button",n.className="custom-select-trigger",n.innerHTML='<span class="custom-select-value"></span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"></path></svg>';const a=document.createElement("div");a.className="custom-select-menu",a.setAttribute("role","listbox"),t.parentNode.insertBefore(s,t),s.appendChild(t),s.appendChild(n),s.appendChild(a),n.addEventListener("pointerdown",e=>{e.preventDefault(),e.stopPropagation();const t=!s.classList.contains("open");closeAllCustomSelects(s),s.classList.toggle("open",t)}),n.addEventListener("click",e=>{e.preventDefault(),e.stopPropagation()}),t.addEventListener("change",()=>updateCustomSelect(t)),refreshCustomSelectOptions(t)})}

    return Object.freeze({ restoreCustomSelectMenu, closeAllCustomSelects, renderCustomSelectLabel, updateCustomSelect, refreshCustomSelectOptions, enhanceConfigSelects });
  }

  const api = Object.freeze({ createCustomSelectWorkflow });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.ChatUIAppCustomSelectWorkflow = api;
  if (root?.window) root.window.ChatUIAppCustomSelectWorkflow = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
