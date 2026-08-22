'use strict';

(function initChatUIImageBatchWorkflow(root) {
  const moduleRegistry = root?.[Symbol.for('chatui.module-registry.v1')];
  const dispatchContract = moduleRegistry?.get('dispatchContract')
    || root?.ChatUIDispatchContract
    || (typeof require === 'function' ? require('../../shared/dispatch-contract') : {});
  const imageExecutionModule = moduleRegistry?.get('imageExecution')
    || root?.ChatUICoreImageExecution
    || (typeof require === 'function' ? require('../core/image-execution') : {});
  const submitHelpers = root?.ChatUISubmitWorkflowHelpers
    || (typeof require === 'function' ? require('./submit-workflow.helpers') : {});
  const storageCore = root?.ChatUICoreStorage
    || (typeof require === 'function' ? require('../core/storage') : {});
  const jobsService = root?.ChatUIServices?.jobs
    || (typeof require === 'function' ? require('../services/job-service') : {});
  const imagesService = root?.ChatUIServices?.images
    || (typeof require === 'function' ? require('../services/image-generation-service') : {});
  const jobWorkflow = root?.ChatUIAppJobWorkflow
    || (typeof require === 'function' ? require('./job-workflow') : {});
  const imageTaskPreparation = moduleRegistry?.get('imageTaskPreparation')
    || (typeof require === 'function' ? require('./image-task-preparation') : {});
  const { requireCanonicalImageExecution } = imageExecutionModule.createImageExecutionPolicy?.({ dispatchContract }) || {};
  const buildImageRoleGuide = imageExecutionModule.buildImageRoleGuide || (() => '');
  const buildImageRoleMap = imageExecutionModule.buildImageRoleMap || (() => []);

  const BATCH_STATUS_TEXT = Object.freeze({
    preparing: '\u6b63\u5728\u51c6\u5907\u56fe\u7247\u4efb\u52a1',
    waiting: '\u6b63\u5728\u751f\u6210\u56fe\u7247',
    failed: '\u751f\u6210\u5931\u8d25',
    done: '\u5df2\u5b8c\u6210',
  });

  function makeClientBatchJobId(now = Date.now, random = Math.random) {
    return `imgbatch-${now().toString(36).slice(-6)}${random().toString(36).slice(2, 6)}`;
  }

  function makeTerminalJobError(message) {
    return jobsService.makeTerminalJobError
      ? jobsService.makeTerminalJobError(message)
      : jobWorkflow.makeTerminalJobError?.(message);
  }

  function createImageBatchWorkflow(deps = {}) {
    if (!deps.state) throw new Error('state is required');
    const {
      state,
      getConfig,
      ensureActiveRun,
      addActiveRunJob,
      setActiveOutputForSession,
      shouldSuppressRunUi,
      pendingFeedbackHtml,
      renderImageBatchResult,
      patchImageBatchDisplayNode,
      renderImageResultContext,
      updateSessionDisplayItem,
      persistSessionDisplay,
      findMessageNodeByDisplayItem,
      updateMessage,
      setImageContext,
      clearPendingFeedback,
      clearReasoning,
      normalizeImageContextForStorage,
      mergeImageResultContexts,
      imageResultToHtml,
      formatElapsed,
      jobDurationMs,
      saveSessionMessages,
      cloneMessageList,
      playDoneSound,
      getEffectiveImageStylePrompt,
      buildImagePromptWithStylePrompt,
      persistImageAttachmentRefs: persistImageAttachmentRefsDep,
      imageFilesToJobPayload,
      restoreImageAttachmentsFromContext,
      makeImageItemId,
      makeClientImageJobId,
      startImageBatchJob,
      getImageBatchJob,
      disposeImageBatchJob,
    } = deps;

    const persistImageAttachmentRefs = persistImageAttachmentRefsDep
      || root?.persistImageAttachmentRefs
      || root?.ChatUIAppImageContextWorkflow?.persistImageAttachmentRefs;
    const taskPreparation = imageTaskPreparation.createImageTaskPreparation?.({
      imageExecutionPolicy: { requireCanonicalImageExecution },
      buildImageRoleGuide,
      buildImageRoleMap,
      ...deps,
      persistImageAttachmentRefs,
    });

    function renderBatchStatus(aggregate) {
      const statuses = Array.isArray(aggregate.statuses) ? aggregate.statuses : [];
      const text = statuses
        .map((status, index) => `\u4efb\u52a1 ${index + 1}/${Number(aggregate.total || 1)}\uff1a${status || BATCH_STATUS_TEXT.waiting}`)
        .join('\n');
      return typeof pendingFeedbackHtml === 'function' ? pendingFeedbackHtml(text) : text;
    }

    function renderBatchCard(aggregate, complete = false) {
      return typeof renderImageBatchResult === 'function'
        ? renderImageBatchResult(aggregate.imageContext || {}, {
            total: Number(aggregate.total || 0),
            childContexts: Array.isArray(aggregate.childImageContexts) ? aggregate.childImageContexts : [],
            slotStatuses: Array.isArray(aggregate.statuses) ? aggregate.statuses : [],
            slotSizes: Array.isArray(aggregate.slotSizes) ? aggregate.slotSizes : [],
            slotSize: aggregate.slotSize || 'auto',
            statusHtml: renderBatchStatus(aggregate),
            complete,
          })
        : renderBatchStatus(aggregate);
    }

    function patchBatchCard(node, aggregate, complete = false) {
      if (typeof patchImageBatchDisplayNode !== 'function') return false;
      return patchImageBatchDisplayNode(node, {
        total: Number(aggregate.total || 0),
        childContexts: Array.isArray(aggregate.childImageContexts) ? aggregate.childImageContexts : [],
        imageContext: aggregate.imageContext || {},
        slotStatuses: Array.isArray(aggregate.statuses) ? aggregate.statuses : [],
        slotSizes: Array.isArray(aggregate.slotSizes) ? aggregate.slotSizes : [],
        slotSize: aggregate.slotSize || 'auto',
        statusHtml: renderBatchStatus(aggregate),
        complete,
      });
    }

    function refreshBatchDisplay(sessionId, item, aggregate, complete, rawText = '', metaText = '') {
      const html = renderBatchCard(aggregate, complete);
      updateSessionDisplayItem(sessionId, item, 'assistant', html, {
        html: true,
        rawText,
        metaText,
        pending: !complete,
        imageContext: aggregate.imageContext ? JSON.stringify(aggregate.imageContext) : undefined,
        responseIndex: item.responseIndex,
      });
      if (sessionId === state.activeSessionId) {
        const node = findMessageNodeByDisplayItem(item);
        if (node) patchBatchCard(node, aggregate, complete);
      }
      return html;
    }

    async function prepareChildTask(item, context = {}) {
      const prepared = await taskPreparation.prepareImageExecutionRequest({
        contract: item.dispatchContract,
        executionMedia: item.executionMedia,
        sessionId: context.sessionId,
        config: context.config,
        promptFallback: item.prompt,
        routePrompt: item.prompt,
        originalPrompt: item.prompt,
        taskState: item.taskState || null,
        childJobId: context.childJobId,
        submissionId: context.submissionId,
      });
      return {
        ...prepared,
        label: String(item.label || item.task?.label || '').trim(),
        imageContextText: prepared.imageContextText,
        durableJob: {
          id: prepared.jobId,
          prompt: prepared.styledPrompt,
          payload: prepared.payload,
          mode: prepared.mode,
          requestPurpose: 'final_execution',
          dispatchContract: prepared.dispatchContract,
          bindingEvidence: prepared.bindingEvidence,
          imageContext: prepared.imageContext,
          startedAt: Date.now(),
          displayItemId: context.displayItemId || '',
          responseIndex: context.responseIndex ?? null,
          liveItemRawText: '',
          submissionId: context.submissionId || '',
          batchId: context.batchId || '',
          label: String(item.label || item.task?.label || '').trim(),
        },
      };
    }

    async function waitImageBatchJob(batchId, { signal, onUpdate = () => {}, pollIntervalMs = 2500 } = {}) {
      const pollJob = async () => {
        const job = await getImageBatchJob({ batchId, signal });
        if (!job || typeof job !== 'object') {
          const error = new Error('多图任务状态响应无效，无法继续等待任务结果');
          error.code = 'IMAGE_BATCH_STATUS_INVALID';
          error.statusCode = 502;
          throw error;
        }
        return job;
      };
      let lastJob = null;
      let updateQueue = Promise.resolve();
      let updateError = null;
      const update = job => {
        lastJob = job;
        updateQueue = updateQueue.then(async () => {
          if (updateError) return;
          try {
            await onUpdate(job);
          } catch (error) {
            updateError = error;
          }
        });
        return updateQueue;
      };
      const drainUpdates = async () => {
        await updateQueue;
        if (updateError) throw updateError;
      };
      const sseAvailable = typeof root?.document !== 'undefined'
        && typeof (root?.EventSource || root?.window?.EventSource || globalThis?.EventSource) === 'function'
        && typeof jobWorkflow.waitJobEvent === 'function';
      if (sseAvailable) {
        let data;
        let eventError = null;
        try {
          data = await jobWorkflow.waitJobEvent(
            `/api/image-batches/${encodeURIComponent(batchId)}/events`,
            update,
            {
              pollJob,
              signal,
              isPageUnloading: () => false,
            },
          );
        } catch (error) {
          eventError = error;
        }
        await drainUpdates();
        if (eventError) throw eventError;
        if (lastJob) return { ...lastJob, data };
        const job = await pollJob();
        await update(job);
        await drainUpdates();
        return job;
      }
      const delay = () => new Promise(resolve => setTimeout(resolve, Math.max(0, Number(pollIntervalMs) || 0)));
      while (true) {
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        const job = await pollJob();
        await update(job);
        await drainUpdates();
        if (job.status === 'done' || job.status === 'error') return job;
        await delay();
      }
    }

    async function runImageBatch(sessionId = state.activeSessionId, options = {}) {
      const {
        items = [],
        batchJobId = makeClientBatchJobId(),
        submissionId = '',
        batchParent,
        responseIndex = '',
        userMessageId = '',
        turnId = '',
        clarificationReplay = null,
        onDurableHandoff,
        onInterfaceCompleted,
        pollIntervalMs = 2500,
      } = options;
      const config = getConfig();
      if (!config.baseUrl || !config.imageModel) {
        throw new Error('\u8bf7\u5148\u914d\u7f6e Endpoint Base URL \u548c\u751f\u56fe\u6a21\u578b');
      }
      const run = ensureActiveRun(sessionId);
      setActiveOutputForSession?.(sessionId, null);
      if (run.stopped || run.abortController?.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const session = state.sessions.find(entry => entry.id === sessionId);
      if (!session) {
        const error = new Error('\u56fe\u7247\u4efb\u52a1\u6240\u5c5e\u4f1a\u8bdd\u4e0d\u5b58\u5728\uff0c\u5df2\u505c\u6b62\u6267\u884c');
        error.code = 'IMAGE_SESSION_NOT_FOUND';
        throw error;
      }
      if (!batchParent?.id) {
        const error = new Error('\u591a\u56fe\u4efb\u52a1\u7f3a\u5c11\u53ef\u6062\u590d\u7684\u663e\u793a\u8bb0\u5f55\uff0c\u5df2\u505c\u6b62\u53d1\u9001');
        error.code = 'IMAGE_BATCH_DISPLAY_ITEM_MISSING';
        throw error;
      }

      const aggregate = {
        total: items.length,
        completed: 0,
        failed: 0,
        statuses: items.map(() => BATCH_STATUS_TEXT.preparing),
        slotSizes: items.map(item => String(item?.dispatchContract?.arguments?.size || 'auto').trim() || 'auto'),
        slotSize: 'auto',
        imageContext: null,
        childImageContexts: Array(items.length).fill(null),
      };
      const childContexts = Array(items.length).fill(null);
      const prepared = [];
      for (let index = 0; index < items.length; index += 1) {
        const item = items[index];
        const childJobId = typeof makeClientImageJobId === 'function'
          ? makeClientImageJobId()
          : `imgjob-${Date.now().toString(36).slice(-6)}${Math.random().toString(36).slice(2, 6)}`;
        prepared.push(await prepareChildTask(item, {
          sessionId,
          config,
          childJobId,
          displayItemId: batchParent.id,
          responseIndex: batchParent.responseIndex || responseIndex,
          submissionId,
          batchId: batchJobId,
        }));
      }

      aggregate.slotSizes = prepared.map(child => String(child?.dispatchContract?.arguments?.size || child?.size || 'auto').trim() || 'auto');
      const commonSlotSize = aggregate.slotSizes.length && aggregate.slotSizes.every(size => size === aggregate.slotSizes[0])
        ? aggregate.slotSizes[0] : 'auto';
      aggregate.slotSize = commonSlotSize;

      const previousIndex = submitHelpers.loadImageBatchIndex?.(root.localStorage, sessionId);
      if (previousIndex) {
        previousIndex.children.forEach(child => submitHelpers.clearImageBatchChild?.(root.localStorage, sessionId, child.jobId));
      }
      const batchIndexRecord = {
        schema_version: submitHelpers.IMAGE_BATCH_VERSION,
        batchId: batchJobId,
        submissionId,
        sessionId,
        startedAt: Date.now(),
        children: prepared.map((child, index) => ({
          jobId: child.jobId,
          prompt: child.prompt,
          label: child.label || '',
          displayItemId: batchParent.id,
          responseIndex: String(batchParent.responseIndex || responseIndex),
          mode: child.mode,
          status: 'running',
        })),
      };
      if (!submitHelpers.saveImageBatchIndex?.(root.localStorage, sessionId, batchIndexRecord)) {
        throw new Error('\u65e0\u6cd5\u4fdd\u5b58\u591a\u56fe\u4efb\u52a1\u6062\u590d\u72b6\u6001\uff0c\u8bf7\u6e05\u7406\u6d4f\u89c8\u5668\u5b58\u50a8\u7a7a\u95f4\u540e\u91cd\u8bd5');
      }
      for (const child of prepared) {
        const key = submitHelpers.imageBatchChildKey(sessionId, child.jobId);
        const saved = storageCore.safeSetJsonStorage?.(root.localStorage, key, child.durableJob) ? child.durableJob : null;
        if (!saved || !saved.payload) {
          submitHelpers.clearImageBatchIndex?.(root.localStorage, sessionId);
          for (const writtenChild of prepared) {
            submitHelpers.clearImageBatchChild?.(root.localStorage, sessionId, writtenChild.jobId);
          }
          throw new Error('\u65e0\u6cd5\u4fdd\u5b58\u5b8c\u6574\u7684\u56fe\u7247\u4efb\u52a1\u6062\u590d\u6570\u636e\uff0c\u672a\u5411\u4e0a\u6e38\u53d1\u9001\u8bf7\u6c42');
        }
      }

      const clearBatchRecoveryState = () => {
        submitHelpers.clearImageBatchIndex?.(root.localStorage, sessionId);
        prepared.forEach(child => submitHelpers.clearImageBatchChild?.(root.localStorage, sessionId, child.jobId));
      };
      const disposeServerBatch = async () => {
        if (typeof disposeImageBatchJob !== 'function') return;
        try { await disposeImageBatchJob({ batchId: batchJobId }); } catch {}
      };
      const cleanupTerminalBatch = async () => {
        clearBatchRecoveryState();
        await disposeServerBatch();
      };

      const started = await startImageBatchJob({
        config,
        batchId: batchJobId,
        submissionId,
        tasks: prepared.map(child => ({
          jobId: child.jobId,
          requestPurpose: 'final_execution',
          mode: child.mode,
          payload: child.payload,
          dispatchContract: child.dispatchContract,
          bindingEvidence: child.bindingEvidence,
          files: child.files,
          masks: child.masks,
        })),
        signal: run.abortController.signal,
      });
      batchParent.jobId = batchJobId;
      batchParent.pending = '1';
      persistSessionDisplay(sessionId);
      if (typeof addActiveRunJob === 'function') addActiveRunJob(sessionId, 'image_batch', batchJobId);
      onDurableHandoff?.(batchJobId, 'image_batch');

      let parentJob = null;
      const startedAt = Number(batchIndexRecord.startedAt) || Date.now();
      const processedTasks = new Set();
      const processCompletedTask = async (task, index) => {
        if (!task || task.status !== 'done' || processedTasks.has(index)) return false;
        const child = prepared[index];
        if (!child) return false;
        const elapsed = formatElapsed(jobDurationMs({ metrics: task.data?.metrics, ...task.data }) ?? Date.now() - startedAt);
        const rendered = await imageResultToHtml(task.data, elapsed, { prompt: child.prompt || '', taskState: child.imageContext?.taskState || null, label: child.label || '', sessionId });
        const completedMode = child.mode === 'edit_image' ? 'edit_image' : 'image';
        const childContext = rendered.imageContext
          ? normalizeImageContextForStorage({ ...rendered.imageContext, mode: completedMode, target: 'previous', usePreviousImage: true })
          : normalizeImageContextForStorage(child.imageContext || {});
        // Keep the object URL only in the transient live slot context. The
        // canonical persisted imageContext remains durable and URL-free.
        const liveChildContext = rendered.imageContext?.attachments
          ? {
              ...childContext,
              attachments: childContext.attachments.map((attachment, attachmentIndex) => ({
                ...attachment,
                displaySrc: rendered.imageContext.attachments[attachmentIndex]?.displaySrc || '',
              })),
            }
          : childContext;
        childContexts[index] = childContext;
        aggregate.childImageContexts[index] = liveChildContext;
        processedTasks.add(index);
        aggregate.statuses[index] = BATCH_STATUS_TEXT.done;
        aggregate.completed = processedTasks.size;
        let liveMerged = {};
        if (typeof mergeImageResultContexts === 'function') {
          for (const context of childContexts) {
            if (context && typeof context === 'object') liveMerged = mergeImageResultContexts(liveMerged, context);
          }
        }
        aggregate.imageContext = normalizeImageContextForStorage(liveMerged);
        refreshBatchDisplay(
          sessionId,
          batchParent,
          aggregate,
          false,
          `已完成 ${aggregate.completed}/${aggregate.total} 张图片`,
          `已完成 ${aggregate.completed}/${aggregate.total} 张图片`,
        );
        return true;
      };
      try {
        parentJob = await waitImageBatchJob(batchJobId, {
          signal: run.abortController.signal,
          pollIntervalMs,
          onUpdate: async parent => {
            const tasks = Array.isArray(parent?.data?.tasks) ? parent.data.tasks : [];
            const previousStatuses = aggregate.statuses.slice();
            const previousFailed = aggregate.failed;
            tasks.forEach((task, index) => {
              if (!task) return;
              if (task.status === 'error') aggregate.statuses[index] = BATCH_STATUS_TEXT.failed;
              else if (task.status !== 'done') aggregate.statuses[index] = BATCH_STATUS_TEXT.waiting;
            });
            aggregate.failed = tasks.filter(task => task?.status === 'error').length;
            let completedThisUpdate = false;
            for (let index = 0; index < tasks.length; index += 1) {
              completedThisUpdate = (await processCompletedTask(tasks[index], index)) || completedThisUpdate;
            }
            // Persist only on a real state transition; completion processing
            // above already refreshed the shared card when an image arrived.
            const statusChanged = previousStatuses.some((status, index) => status !== aggregate.statuses[index])
              || previousFailed !== aggregate.failed;
            if (!completedThisUpdate && statusChanged) {
              refreshBatchDisplay(
                sessionId,
                batchParent,
                aggregate,
                false,
                `正在生成 ${aggregate.completed}/${aggregate.total} 张图片`,
                `正在生成 ${aggregate.completed}/${aggregate.total} 张图片`,
              );
            }
          },
        });
      } catch (error) {
        if (error?.terminalJob === true) await cleanupTerminalBatch();
        throw error;
      }

      // The terminal snapshot can contain a completion that was delivered in
      // the same response as the terminal parent status; process it as well.
      const tasks = Array.isArray(parentJob?.data?.tasks) ? parentJob.data.tasks : [];
      for (let index = 0; index < tasks.length; index += 1) {
        await processCompletedTask(tasks[index], index);
      }
      let mergedContext = {};
      if (typeof mergeImageResultContexts === 'function') {
        for (const context of childContexts) {
          if (context && typeof context === 'object') mergedContext = mergeImageResultContexts(mergedContext, context);
        }
      }
      mergedContext = normalizeImageContextForStorage(mergedContext);
      aggregate.imageContext = mergedContext;
      const complete = aggregate.completed >= aggregate.total && aggregate.failed === 0;
      const metaText = complete
        ? `\u5df2\u5b8c\u6210 ${aggregate.total}/${aggregate.total} \u5f20`
        : `\u5df2\u5b8c\u6210 ${aggregate.completed}/${aggregate.total} \u5f20`;
      const rawText = complete
        ? '\u56fe\u7247\u751f\u6210\u5b8c\u6210'
        : `\u56fe\u7247\u751f\u6210\u7ed3\u675f\uff0c\u5df2\u5b8c\u6210 ${aggregate.completed}/${aggregate.total} \u5f20`;
      const resultHtml = refreshBatchDisplay(sessionId, batchParent, aggregate, complete, rawText, metaText);
      if (complete) {
        const userMessage = (sessionId === state.activeSessionId ? state.messages : session.messages || [])
          .find(entry => entry?.role === 'user' && String(entry?.id || '') === String(userMessageId || ''))
          || null;
        const identityApi = root?.ChatUIAppSessionPersistence || {};
        const batchIdentity = identityApi.createMessageTurnIdentity?.({
          sessionId,
          submissionId: submissionId || batchJobId,
          role: 'assistant',
          sequence: batchParent.responseIndex || responseIndex,
        }) || { id: `message:${sessionId}:${submissionId || batchJobId}:assistant`, turnId: turnId || userMessage?.turnId || `turn:${sessionId}:${submissionId || batchJobId}` };
        const message = {
          role: 'assistant',
          ...batchIdentity,
          ...(userMessageId || userMessage?.id ? { replyToMessageId: userMessageId || userMessage.id } : {}),
          content: `[\u56fe\u7247\u751f\u6210\u5b8c\u6210] ${prepared.map(child => child.prompt).filter(Boolean).join('\u3001')}`,
          html: resultHtml,
          rawText,
          metaText,
          responseIndex: batchParent.responseIndex || responseIndex,
          imageContext: JSON.stringify(mergedContext),
          kind: 'image',
          imageJobId: batchJobId,
          displayItemId: batchParent.id || '',
          ...(clarificationReplay ? { clarificationReplay } : {}),
        };
        const sessionMessages = sessionId === state.activeSessionId
          ? state.messages
          : (Array.isArray(session.messages) ? session.messages : []);
        const existingIndex = sessionMessages.findIndex(entry => entry?.role === 'assistant' && (message.displayItemId && String(entry.displayItemId || '') === String(message.displayItemId)));
        if (existingIndex >= 0) sessionMessages[existingIndex] = { ...sessionMessages[existingIndex], ...message };
        else sessionMessages.push(message);
        session.messages = cloneMessageList(sessionMessages);
        if (sessionId === state.activeSessionId) state.messages = cloneMessageList(session.messages);
        await saveSessionMessages(sessionId, session.messages);
        clearBatchRecoveryState();
        await disposeServerBatch();
        playDoneSound?.();
        onInterfaceCompleted?.({ sessionId, submissionId, jobId: batchJobId, jobKind: 'image_batch' });
      } else {
        const failedTask = tasks.find(task => task?.status === 'error');
        const error = makeTerminalJobError(failedTask?.error?.message || parentJob?.error?.message || '\u591a\u56fe\u4efb\u52a1\u5931\u8d25');
        await cleanupTerminalBatch();
        throw error;
      }
      return { batchJobId, parentJob, resultHtml, mergedContext };
    }

    return Object.freeze({ runImageBatch, prepareChildTask, waitImageBatchJob });
  }

  const api = Object.freeze({ createImageBatchWorkflow });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.ChatUIAppImageBatchWorkflow = api;
  if (root?.window) root.window.ChatUIAppImageBatchWorkflow = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
