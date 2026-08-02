(function initChatUIRouteDiagramWorkflow(root) {
  'use strict';

  const ROUTE_STATE_MESSAGE = 'chatui:route-task-state';
  const ROUTE_STATE_INTERVAL_MS = 250;
  const ROUTE_STEP_BY_PHASE = Object.freeze({
    accepted: '02',
    capturing: '03',
    routing: '07',
    handoff: '12',
    running: '12',
    recovering: '12',
    stopping: '12',
    completed: '12',
    failed: '12',
    stopped: '12',
    busy: '12',
  });

  function normalizeRouteStep(value) {
    const raw = String(value ?? '').trim();
    if (!raw) return '';
    const normalized = /^\d+$/.test(raw) ? raw.padStart(2, '0') : raw;
    return /^(0[1-9]|1[0-2])$/.test(normalized) ? normalized : '';
  }

  function phaseFromPendingStage(stage = '') {
    switch (String(stage || '').toLowerCase()) {
      case 'accepted': return 'accepted';
      case 'captured':
      case 'routing': return 'routing';
      case 'handoff': return 'handoff';
      default: return '';
    }
  }

  function deriveRouteActiveStep(detail = {}) {
    if (detail.pendingClarification) return '10';
    const explicitStep = normalizeRouteStep(detail.activeStep || detail.routeStep || detail.progressStep);
    if (explicitStep) return explicitStep;
    const phase = String(detail.phase || '').toLowerCase();
    const pendingStage = String(detail.pendingStage || '').toLowerCase();
    if (phase === 'routing' && pendingStage === 'captured') return '04';
    return ROUTE_STEP_BY_PHASE[phase] || '';
  }

  function createPageViewerWorkflow(deps = {}) {
    const documentRef = deps.document || root?.document;
    const windowRef = deps.window || documentRef?.defaultView || root;
    const launchers = Object.freeze({
      route: Object.freeze({
        triggerId: 'routeDiagramFab',
        url: deps.routeUrl || './pages/route.html?v=2.7.0-s-track-progress',
        title: '意图识别流程图',
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
    const getActiveSession = deps.getActiveSession || (() => root?.getActiveSession?.() || null);
    const getTaskState = deps.getTaskState || (sessionId => root?.getTaskLifecycleController?.()?.getTaskState?.(sessionId) || null);
    const isSessionBusy = deps.isSessionBusy || (sessionId => !!root?.isSessionBusy?.(sessionId));
    const loadPendingSubmit = deps.loadPendingSubmit || (sessionId => root?.getSubmitWorkflow?.()?.loadPendingSubmit?.(sessionId) || null);
    const setIntervalRef = deps.setInterval || windowRef?.setInterval?.bind?.(windowRef);
    const clearIntervalRef = deps.clearInterval || windowRef?.clearInterval?.bind?.(windowRef);
    let initialized = false;
    let lastFocused = null;
    let activeLauncherKey = '';
    let routeStateTimer = null;
    let routeStateSequence = 0;

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

    function readRouteTaskState() {
      let session = null;
      let task = null;
      let pendingSubmit = null;
      try { session = getActiveSession() || null; } catch {}
      const sessionId = String(session?.id || '');
      try { task = sessionId ? getTaskState(sessionId) || null : null; } catch {}
      try { pendingSubmit = sessionId ? loadPendingSubmit(sessionId) || null : null; } catch {}
      let fallbackBusy = false;
      try { fallbackBusy = !!(sessionId && isSessionBusy(sessionId)); } catch {}

      const taskSubmissionId = String(task?.submissionId || '');
      const pendingSubmissionId = String(pendingSubmit?.submissionId || '');
      const pendingMatchesTask = !taskSubmissionId || !pendingSubmissionId || taskSubmissionId === pendingSubmissionId;
      const pendingStage = pendingMatchesTask ? String(pendingSubmit?.stage || '') : '';
      const phase = String(task?.phase || phaseFromPendingStage(pendingStage) || (fallbackBusy ? 'busy' : 'idle')).toLowerCase();
      const pendingClarification = !!session?.pendingClarification;
      const activeStep = deriveRouteActiveStep({
        phase,
        pendingStage,
        pendingClarification,
        progressStep: pendingMatchesTask ? pendingSubmit?.progressStep || pendingSubmit?.routeStep : '',
      });

      return {
        type: ROUTE_STATE_MESSAGE,
        phase,
        owner: String(task?.owner || ''),
        sessionId,
        sessionTitle: String(session?.customTitle || session?.title || '当前会话'),
        taskId: String(task?.taskId || ''),
        submissionId: taskSubmissionId || (pendingMatchesTask ? pendingSubmissionId : ''),
        jobId: String(task?.jobId || (pendingMatchesTask ? pendingSubmit?.jobId : '') || ''),
        jobKind: String(task?.jobKind || (pendingMatchesTask ? pendingSubmit?.jobKind : '') || ''),
        pendingStage,
        pendingClarification,
        activeStep,
        taskRevision: Math.max(0, Number(task?.revision || 0) || 0),
      };
    }

    function targetOrigin() {
      const origin = String(deps.targetOrigin || windowRef?.location?.origin || '');
      return origin && origin !== 'null' ? origin : '*';
    }

    function publishRouteTaskState() {
      const { frame } = elements();
      if (activeLauncherKey !== 'route' || !frame?.contentWindow) return false;
      try {
        frame.contentWindow.postMessage({
          ...readRouteTaskState(),
          syncSequence: ++routeStateSequence,
        }, targetOrigin());
        return true;
      } catch {
        return false;
      }
    }

    function startRouteStateSync() {
      if (activeLauncherKey !== 'route' || routeStateTimer !== null) return;
      publishRouteTaskState();
      if (typeof setIntervalRef !== 'function') return;
      const timer = setIntervalRef(publishRouteTaskState, ROUTE_STATE_INTERVAL_MS);
      routeStateTimer = timer === undefined ? null : timer;
    }

    function stopRouteStateSync() {
      if (routeStateTimer === null) return;
      try { clearIntervalRef?.(routeStateTimer); } catch {}
      routeStateTimer = null;
    }

    function open(key = 'route') {
      const launcherKey = key in launchers ? key : 'route';
      const launcher = launchers[launcherKey];
      const trigger = triggerFor(launcherKey);
      const { modal, dialog, frame, close } = elements();
      if (!trigger || !modal || !frame) return false;
      lastFocused = documentRef.activeElement === trigger ? trigger : documentRef.activeElement;
      activeLauncherKey = launcherKey;
      if (activeLauncherKey !== 'route') stopRouteStateSync();
      Object.keys(launchers).forEach(itemKey => triggerFor(itemKey)?.setAttribute('aria-expanded', 'false'));
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
      startRouteStateSync();
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
      stopRouteStateSync();
      return true;
    }

    function init() {
      if (initialized || !documentRef) return;
      const { modal, frame } = elements();
      const availableLaunchers = Object.keys(launchers).filter(key => triggerFor(key));
      if (!availableLaunchers.length || !modal) return;
      initialized = true;
      frame?.addEventListener('load', publishRouteTaskState);
      availableLaunchers.forEach(key => triggerFor(key).addEventListener('click', () => open(key)));
      modal.querySelectorAll('[data-route-diagram-close]').forEach(node => node.addEventListener('click', close));
      documentRef.addEventListener('keydown', event => {
        if (event.key === 'Escape' && isOpen()) {
          event.preventDefault();
          close();
        }
      });
    }

    return Object.freeze({ init, open, close, isOpen, readRouteTaskState, publishRouteTaskState });
  }

  const createRouteDiagramWorkflow = createPageViewerWorkflow;
  const api = Object.freeze({ createPageViewerWorkflow, createRouteDiagramWorkflow, deriveRouteActiveStep, normalizeRouteStep });
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
