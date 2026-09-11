'use strict';
(function initChatUIAppImageEditorWorkflow(root) {
  'use strict';

  function createImageEditorWorkflow(deps = {}) {
    const {
      state,
      toast,
      isSessionBusy,
      sendImage,
      makeClientImageJobId,
      ensureActiveRun,
      dispatchTaskEvent,
      finishSessionTask,
      addMessage,
      appendSessionDisplayMessage,
      persistSessionDisplay,
      saveChatHistory,
      saveSessionMessages,
      escapeHtml,
    } = deps;
    const routeUtils = root?.ChatUIRouteService
      || (typeof require === 'function' ? require('../services/route-service') : {});
    const taskState = root?.ChatUICore?.taskState
      || (typeof require === 'function' ? require('../core/task-state') : {});
    const taskEvents = taskState.TASK_EVENTS || {};
    const submitHelpers = root?.ChatUISubmitWorkflowHelpers
      || (typeof require === 'function' ? require('./submit-workflow.helpers') : {});

    function isImageEntry(item = {}) {
      return String(item?.type || '').startsWith('image/');
    }

﻿    function escapeText(value = '') {
      if (typeof escapeHtml === 'function') return escapeHtml(String(value));
      return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }

    // The chat transcript must show the edit the user asked for, exactly like
    // every other turn. Image edits bypass intent routing, so this workflow
    // owns the user-facing message instead of relying on submit to create it.
    function editLabelForEdit(edit = {}) {
      const explicit = String(edit.label || '').trim();
      if (explicit) return explicit;
      switch (String(edit.mode || '')) {
        case 'erase': return '\u64e6\u9664\u56fe\u7247\u4e2d\u7684\u9009\u533a';
        case 'remove_background': return '移除此图像的背景。保持所有前景主体不变且完整无损，边缘干净平滑。将背景设为透明。';
        case 'comment': return '\u6309\u8bc4\u8bba\u4fee\u6539\u56fe\u7247';
        default: return '\u7f16\u8f91\u56fe\u7247';
      }
    }

    async function appendUserEditMessage({ sessionId, label, edit } = {}) {
      const text = String(label || '').trim() || editLabelForEdit(edit);
      const session = Array.isArray(state?.sessions)
        ? state.sessions.find(item => item?.id === sessionId)
        : null;
      const isActive = sessionId === String(state?.activeSessionId || '');
      const messages = isActive ? (state.messages || []) : (session?.messages || []);
      const sequence = messages.length;
      const identityApi = root?.ChatUIAppSessionPersistence || {};
      const generatedIdentity = typeof identityApi.createMessageTurnIdentity === 'function'
        ? identityApi.createMessageTurnIdentity({
          sessionId,
          submissionId: 'image-edit-' + Date.now().toString(36),
          role: 'user',
          sequence,
        }) || {}
        : {};
      const message = {
        role: 'user',
        content: text,
        rawText: text,
        messageIndex: String(sequence),
        ...generatedIdentity,
      };
      if (isActive) {
        messages.push(message);
        if (session) session.messages = messages.slice();
      } else if (session) {
        session.messages = [...messages, message];
      }
      const html = escapeText(text).replace(/\n/g, '<br>');
      let node = null;
      if (isActive && typeof addMessage === 'function') {
        node = addMessage('user', html, {
          html: true,
          rawText: text,
          messageIndex: sequence,
          ...(generatedIdentity.id ? { messageId: generatedIdentity.id } : {}),
          ...(generatedIdentity.turnId ? { turnId: generatedIdentity.turnId } : {}),
        });
      }
      if (typeof appendSessionDisplayMessage === 'function') {
        const displayItem = appendSessionDisplayMessage(sessionId, 'user', html, {
          html: true,
          rawText: text,
          messageIndex: sequence,
          ...(generatedIdentity.id ? { messageId: generatedIdentity.id } : {}),
          ...(generatedIdentity.turnId ? { turnId: generatedIdentity.turnId } : {}),
        });
        if (node && displayItem) {
          node.__displayItem = displayItem;
          if (displayItem.id) node.dataset.displayItemId = displayItem.id;
        }
      }
      if (typeof persistSessionDisplay === 'function') persistSessionDisplay(sessionId);
      if (isActive) {
        if (typeof saveChatHistory === 'function') await saveChatHistory();
      } else if (typeof saveSessionMessages === 'function' && session) {
        await saveSessionMessages(sessionId, session.messages);
      }
      return { messageId: generatedIdentity.id || '', turnId: generatedIdentity.turnId || '' };
    }

    function blobToDataUrl(blob) {
      return new Promise((resolve, reject) => {
        if (!blob) { reject(new Error('\u56fe\u7247\u6570\u636e\u7f3a\u5931')); return; }
        const FileReaderCtor = root?.FileReader || (typeof FileReader === 'function' ? FileReader : null);
        if (!FileReaderCtor) { reject(new Error('\u5f53\u524d\u6d4f\u89c8\u5668\u4e0d\u652f\u6301\u8bfb\u53d6\u56fe\u7247')); return; }
        const reader = new FileReaderCtor();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = () => reject(new Error('\u56fe\u7247\u8bfb\u53d6\u5931\u8d25\uff0c\u8bf7\u91cd\u8bd5'));
        reader.readAsDataURL(blob);
      });
    }

    // The image editor produces a deterministic edit_image request. It never
    // goes through intent routing: the user already chose the operation, the
    // target image and (for erase) the mask, so the platform only has to
    // compile the same dispatch_contract.v1 the router would have produced.
    async function applyImageEdit({ sessionId, imageBlob, filename = 'image.png', edit = null } = {}) {
      const targetSessionId = String(sessionId || state?.activeSessionId || '');
      if (!targetSessionId) throw new Error('\u672a\u627e\u5230\u4f1a\u8bdd\uff0c\u65e0\u6cd5\u5e94\u7528\u7f16\u8f91');
      if (!imageBlob) throw new Error('\u56fe\u7247\u6570\u636e\u7f3a\u5931\uff0c\u65e0\u6cd5\u7f16\u8f91');
      if (typeof isSessionBusy === 'function' && isSessionBusy(targetSessionId)) {
        toast?.('\u5f53\u524d\u4f1a\u8bdd\u6b63\u5728\u6267\u884c\u4efb\u52a1\uff0c\u8bf7\u7a0d\u540e\u518d\u8bd5');
        return false;
      }
      if (!edit || !edit.mode) throw new Error('\u7f16\u8f91\u64cd\u4f5c\u65e0\u6548');
      if (typeof sendImage !== 'function') throw new Error('\u56fe\u7247\u5de5\u4f5c\u6d41\u4e0d\u53ef\u7528\uff0c\u8bf7\u5237\u65b0\u9875\u9762\u540e\u91cd\u8bd5');

      const stamp = Date.now().toString(36);
      const targetId = `edit-target-${stamp}`;
      const maskId = `edit-mask-${stamp}`;
      // The clean original is always the target. Comments travel as a
      // generated edit mask plus a coordinate-based numbered prompt.
      const targetBlob = imageBlob;
      const targetSrc = await blobToDataUrl(targetBlob);
      const entries = [{
        id: targetId,
        imageId: targetId,
        attachmentId: targetId,
        name: filename || 'image.png',
        type: targetBlob.type || 'image/png',
        src: targetSrc,
        routeRole: 'target',
        routeSource: 'current',
      }];
      let maskEntry = null;
      if (edit.mode === 'erase' || edit.mode === 'comment') {
        if (!edit.maskBlob) throw new Error('\u906e\u7f69\u6570\u636e\u7f3a\u5931\uff0c\u8bf7\u91cd\u65b0\u6d82\u62b9\u6216\u8bc4\u8bba');
        const maskSrc = await blobToDataUrl(edit.maskBlob);
        maskEntry = {
          id: maskId,
          imageId: maskId,
          attachmentId: maskId,
          name: 'mask.png',
          type: 'image/png',
          src: maskSrc,
          routeRole: 'mask',
          routeSource: 'current',
        };
        entries.push(maskEntry);
      }

      const prompt = String(edit.prompt || '').trim();
      if (!prompt) throw new Error('\u7f3a\u5c11\u7f16\u8f91\u6307\u4ee4');

      // The transcript entry appears before the image job starts so users see
      // the edit immediately; sendImage then appends the assistant result
      // right after it instead of silently creating an orphaned image turn.
      const userTurn = await appendUserEditMessage({ sessionId: targetSessionId, label: edit.label, edit });

      const candidates = entries.map((entry, index) => ({
        index: index + 1,
        source: 'current',
        target: 'uploaded',
        image_id: entry.id,
        resource_id: `res:image:${entry.id}`,
        reference_id: '',
      }));
      const bindings = [{
        key: 'r1',
        type: 'image',
        role: 'target',
        resource_id: `res:image:${targetId}`,
        source: 'current',
      }];
      if (maskEntry) {
        bindings.push({
          key: 'r2',
          type: 'image',
          role: 'mask',
          resource_id: `res:image:${maskId}`,
          source: 'current',
        });
      }

      const overrides = {};
      if (edit.size && edit.size !== 'auto') overrides.size = edit.size;
      if (edit.background) overrides.background = edit.background;
      if (edit.output_format) overrides.output_format = edit.output_format;

      const route = routeUtils.compileLocalRoute?.({
        operation: 'edit_image',
        relation: 'followup',
        arguments: { prompt },
        bindings,
        constraints: [],
      }, {
        input: prompt,
        attachments: entries,
        overrides,
        context: { recent_messages: [], image_candidates: candidates, file_candidates: [] },
        semanticAuthority: 'route_intent.v3',
        skipLocalRouteGates: true,
      });
      if (!route?.dispatchContract) {
        const error = new Error(route?.clarificationQuestion || '\u56fe\u7247\u7f16\u8f91\u8bf7\u6c42\u672a\u80fd\u5b89\u5168\u6267\u884c\uff0c\u8bf7\u8c03\u6574\u540e\u91cd\u8bd5');
        error.code = 'IMAGE_EDIT_ROUTE_NOT_READY';
        throw error;
      }

      const session = Array.isArray(state?.sessions)
        ? state.sessions.find(item => item?.id === targetSessionId)
        : null;
      const pools = submitHelpers.buildExecutionResourcePools?.(
        { current: entries, quoted: [], history: [], context: [] },
        { isImageFile: isImageEntry, messages: session?.messages || state?.messages || [] },
      );
      const executionMedia = submitHelpers.projectRouteExecutionMediaForDispatch?.(route, pools);
      if (!executionMedia) throw new Error('\u7f16\u8f91\u8d44\u6e90\u6295\u5f71\u5931\u8d25\uff0c\u8bf7\u91cd\u8bd5');

      // The editor is a first-class task: it owns one managed image job so the
      // composer shows stop mode while editing and always returns to send mode
      // when the result commits (or the dispatch fails). Without this ownership
      // a focus/session resume could mark the session busy forever.
      const submissionId = `image-edit-${Date.now().toString(36)}`;
      const editJobId = typeof makeClientImageJobId === 'function'
        ? makeClientImageJobId()
        : `imgjob-${Date.now().toString(36)}`;
      const run = typeof ensureActiveRun === 'function' ? ensureActiveRun(targetSessionId) : null;
      let taskSettled = false;
      const settleEditorTask = () => {
        if (taskSettled) return;
        taskSettled = true;
        dispatchTaskEvent?.(targetSessionId, {
          type: taskEvents.JOB_COMPLETED_COMMITTED,
          submissionId,
          jobId: editJobId,
          jobKind: 'image',
        });
        finishSessionTask?.(targetSessionId, { run, jobId: editJobId, followingKind: 'image' });
      };
      const failEditorTask = error => {
        if (taskSettled) return;
        taskSettled = true;
        dispatchTaskEvent?.(targetSessionId, {
          type: taskEvents.JOB_FAILED,
          submissionId,
          jobId: editJobId,
          jobKind: 'image',
          error,
        });
        finishSessionTask?.(targetSessionId, { run, jobId: editJobId, followingKind: 'image' });
      };
      dispatchTaskEvent?.(targetSessionId, { type: taskEvents.TASK_ACCEPTED, submissionId });
      dispatchTaskEvent?.(targetSessionId, {
        type: taskEvents.JOB_RECOVERY_STARTED,
        submissionId,
        jobId: editJobId,
        jobKind: 'image',
      });
      try {
        await sendImage(prompt, {
          sessionId: targetSessionId,
          attachments: executionMedia.imageInputs,
          maskAttachments: executionMedia.masks,
          executionMedia,
          dispatchContract: route.dispatchContract,
          originalPrompt: prompt,
          routePrompt: prompt,
          userAlreadyAdded: true,
          submissionId,
          clientJobId: editJobId,
          onInterfaceCompleted: settleEditorTask,
          ...(userTurn.messageId ? { userMessageId: userTurn.messageId } : {}),
        });
        settleEditorTask();
      } catch (error) {
        failEditorTask(error);
        throw error;
      }
      return true;
    }

    return Object.freeze({ applyImageEdit });
  }

  const api = Object.freeze({ createImageEditorWorkflow });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root?.[Symbol.for('chatui.module-registry.v1')]?.get('moduleRegistry')?.register('imageEditorWorkflow', api);
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
