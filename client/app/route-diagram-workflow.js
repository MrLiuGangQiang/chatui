(function initChatUIRouteDiagramWorkflow(root) {
  'use strict';

  function createPageViewerWorkflow(deps = {}) {
    const documentRef = deps.document || root?.document;
    const launchers = Object.freeze({
      route: Object.freeze({
        triggerId: 'routeDiagramFab',
        url: deps.routeUrl || './pages/route.html?v=1.3.2-stage3-centered',
        title: '任务路由执行地图',
        aspectRatio: '1672 / 941',
        maxWidth: '1672px',
      }),
      files: Object.freeze({
        triggerId: 'supportedFilesFab',
        url: deps.filesUrl || './pages/files.html?v=1.0.0-aligned-layout',
        title: '支持的文件格式',
        aspectRatio: '1536 / 1024',
        maxWidth: '1536px',
      }),
    });
    let initialized = false;
    let lastFocused = null;
    let activeLauncherKey = '';

    function elements() {
      return {
        modal: documentRef?.getElementById('routeDiagramModal'),
        dialog: documentRef?.querySelector('#routeDiagramModal .route-diagram-dialog'),
        frame: documentRef?.getElementById('routeDiagramFrame'),
        close: documentRef?.getElementById('closeRouteDiagramBtn'),
      };
    }

    function triggerFor(key) {
      return documentRef?.getElementById(launchers[key]?.triggerId);
    }

    function isOpen() {
      return elements().modal?.classList.contains('show') || false;
    }

    function open(key = 'route') {
      const launcher = launchers[key] || launchers.route;
      const trigger = triggerFor(key in launchers ? key : 'route');
      const { modal, dialog, frame, close } = elements();
      if (!trigger || !modal || !frame) return false;
      lastFocused = documentRef.activeElement === trigger ? trigger : documentRef.activeElement;
      activeLauncherKey = key in launchers ? key : 'route';
      Object.keys(launchers).forEach(launcherKey => triggerFor(launcherKey)?.setAttribute('aria-expanded', 'false'));
      if (frame.getAttribute('src') !== launcher.url) frame.setAttribute('src', launcher.url);
      frame.setAttribute('title', launcher.title);
      dialog?.style?.setProperty('--page-viewer-aspect', launcher.aspectRatio);
      dialog?.style?.setProperty('--page-viewer-max-width', launcher.maxWidth);
      close?.setAttribute('aria-label', `关闭${launcher.title}`);
      close?.setAttribute('title', `关闭${launcher.title}`);
      modal.classList.add('show');
      modal.setAttribute('aria-hidden', 'false');
      trigger.setAttribute('aria-expanded', 'true');
      close?.focus?.();
      return true;
    }

    function close() {
      const { modal } = elements();
      const trigger = triggerFor(activeLauncherKey || 'route');
      if (!modal || !isOpen()) return false;
      modal.classList.remove('show');
      modal.setAttribute('aria-hidden', 'true');
      trigger?.setAttribute('aria-expanded', 'false');
      const focusTarget = lastFocused?.focus ? lastFocused : trigger;
      focusTarget?.focus?.();
      lastFocused = null;
      activeLauncherKey = '';
      return true;
    }

    function init() {
      if (initialized || !documentRef) return;
      const { modal } = elements();
      const availableLaunchers = Object.keys(launchers).filter(key => triggerFor(key));
      if (!availableLaunchers.length || !modal) return;
      initialized = true;
      availableLaunchers.forEach(key => triggerFor(key).addEventListener('click', () => open(key)));
      modal.querySelectorAll('[data-route-diagram-close]').forEach(node => node.addEventListener('click', close));
      documentRef.addEventListener('keydown', event => {
        if (event.key === 'Escape' && isOpen()) {
          event.preventDefault();
          close();
        }
      });
    }

    return Object.freeze({ init, open, close, isOpen });
  }

  const createRouteDiagramWorkflow = createPageViewerWorkflow;
  const api = Object.freeze({ createPageViewerWorkflow, createRouteDiagramWorkflow });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  const appContext = root?.ChatUIApp?.appContext || (() => {
    try { return typeof require === 'function' ? require('./app-context') : null; } catch { return null; }
  })();
  if (appContext?.registerWorkflowModule) appContext.registerWorkflowModule('routeDiagram', api);
  if (root?.document) {
    const controller = createPageViewerWorkflow();
    if (root.document.readyState === 'loading') root.document.addEventListener('DOMContentLoaded', () => controller.init(), { once: true });
    else controller.init();
  }
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
