(function initChatUIAppJobResumeWorkflow(root) {
  // Intentionally not strict: resume bodies are migrated from app.js and resolved through a deps scope.

  function buildChatResumeOffsets(item = {}, isStatusText = () => false) {
    if (item?.streamCheckpointRecovered) {
      return {
        baseContent: '',
        baseReasoning: '',
        contentLength: 0,
        reasoningLength: 0,
      };
    }
    const rawText = String(item?.rawText || '');
    const content = isStatusText(rawText) ? '' : rawText;
    const reasoning = String(item?.reasoningText || '');
    return {
      baseContent: content,
      baseReasoning: reasoning,
      contentLength: content.length,
      reasoningLength: reasoning.length,
    };
  }

  function createJobResumeWorkflow(deps = {}) {
    if (!deps.state) throw new Error("state is required");
    const finishSessionTask =
      deps.finishSessionTask ||
      ((sessionId, options = {}) => {
        if (options.timer !== null && options.timer !== undefined)
          clearInterval(options.timer);
        if (options.resumeKey)
          deps.state.resumingJobs?.delete?.(options.resumeKey);
        if (options.jobId && options.followingKind === "chat")
          deps.state.followingChatJobs?.delete?.(options.jobId);
        if (options.jobId && options.followingKind === "image")
          deps.state.followingImageJobs?.delete?.(options.jobId);
        deps.setSessionBusy?.(sessionId, false);
        deps.updateSendAvailability?.();
      });
    const settleSessionTask =
      deps.settleSessionTask ||
      ((sessionId, options = {}) => finishSessionTask(sessionId, options));

    const liveDisplayDrainMs = Math.max(0, Number(deps.liveDisplayDrainMs ?? 32) || 0);
    const pendingLiveDisplayUpdates = new Map();
    let liveDisplayDrainTimer = null;
    const scheduleLiveDisplayDrain =
      deps.scheduleLiveDisplayDrain ||
      (callback => (root?.setTimeout || setTimeout)(callback, liveDisplayDrainMs));
    const cancelLiveDisplayDrain =
      deps.cancelLiveDisplayDrain ||
      (handle => (root?.clearTimeout || clearTimeout)(handle));

    function flushLiveDisplayUpdates(sessionId = '') {
      if (sessionId) {
        const apply = pendingLiveDisplayUpdates.get(sessionId);
        pendingLiveDisplayUpdates.delete(sessionId);
        try { apply?.(); } catch (error) { console.warn('chat live display update failed', error); }
        if (!pendingLiveDisplayUpdates.size && liveDisplayDrainTimer != null) {
          cancelLiveDisplayDrain(liveDisplayDrainTimer);
          liveDisplayDrainTimer = null;
        }
        return;
      }
      for (const apply of [...pendingLiveDisplayUpdates.values()]) {
        try { apply(); } catch (error) { console.warn('chat live display update failed', error); }
      }
      pendingLiveDisplayUpdates.clear();
    }

    function queueLiveDisplayUpdate(sessionId, apply) {
      pendingLiveDisplayUpdates.set(String(sessionId || ''), apply);
      if (liveDisplayDrainTimer != null) return;
      liveDisplayDrainTimer = scheduleLiveDisplayDrain(() => {
        liveDisplayDrainTimer = null;
        flushLiveDisplayUpdates();
      });
    }

    // A persisted job that cannot be reconciled with its dispatch contract is
    // internal stale state, not a user error. Silently discard it and remove the
    // pending placeholder so the user can simply re-issue a fresh request.
    function discardInvalidImageJob(sessionId = '') {
      try { deps.clearImageJob?.(sessionId); } catch {}
      try { root?.ChatUIAppJobWorkflow?.clearPendingSubmit?.(sessionId, { storage: root.localStorage }); } catch {}
      const session = deps.state?.sessions?.find(item => item?.id === sessionId);
      if (session?.display?.length) {
        const reversedIndex = [...session.display].reverse().findIndex(item => item?.pending
          && /正在生成图片|正在修改图片|正在恢复图片生成任务|正在恢复图片修改任务|已收到/.test(item?.rawText || ''));
        if (reversedIndex >= 0) {
          session.display.splice(session.display.length - 1 - reversedIndex, 1);
          try { deps.persistSessionDisplay?.(sessionId); } catch {}
        }
      }
      deps.finishSessionTask?.(sessionId, { resumeKey: `image:${sessionId}` });
    }
    const dispatchContractContract =
      root?.[Symbol.for("chatui.module-registry.v1")]?.get("dispatchContract") ||
      root?.ChatUIDispatchContract ||
      (typeof require === "function" ? require("../../shared/dispatch-contract") : {});
  const submitHelpers =
      root?.ChatUISubmitWorkflowHelpers ||
      (typeof require === "function" ? require("./submit-workflow.helpers") : {});
  const appendIntentStatusHtml = root?.ChatUIAppFormatting?.appendIntentStatusHtml
    || root?.ChatUIApp?.formatting?.appendIntentStatusHtml
    || (typeof require === "function" ? require("./formatting").appendIntentStatusHtml : null);

    const clearPendingFeedback = typeof deps.clearPendingFeedback === 'function'
      ? deps.clearPendingFeedback
      : node => root?.clearPendingFeedback?.(node);
    const dismissIntentReasoningTrace = typeof deps.dismissIntentReasoningTrace === 'function'
      ? deps.dismissIntentReasoningTrace
      : node => root?.ChatUIAppFormatting?.dismissIntentReasoningTrace?.(node);

    function markResumedOutputStarted(sessionId, item) {
      if (!item) return;
      item.outputStarted = true;
      item.metaText = '';
      if (typeof deps.isChatStatusText === 'function' && deps.isChatStatusText(item.rawText)) item.rawText = '';
      const staleWaitingHtml = String(item.html || '');
      if (staleWaitingHtml.includes('pending-feedback') || staleWaitingHtml.includes('intent-reasoning-trace')) item.html = '';
      if (sessionId !== deps.state.activeSessionId) return;
      const node = deps.findMessageNodeByDisplayItem?.(item);
      if (!node) return;
      node.querySelector?.('.pending-feedback')?.remove();
      if (node.dataset) delete node.dataset.pendingFeedback;
      clearPendingFeedback?.(node);
      dismissIntentReasoningTrace?.(node);
      if (node.dataset) node.dataset.outputStarted = '1';
    }

    function renderResumedChatState(sessionId, item, options = {}) {
      if (!item) return false;
      const rawText = String(item.rawText || '');
      const reasoning = String(item.reasoningText || '');
      const statusText = typeof deps.isChatStatusText === 'function' ? deps.isChatStatusText : (() => false);
      const started = !!item.outputStarted || !!reasoning || (!!rawText.trim() && !statusText(rawText));
      if (started) {
        markResumedOutputStarted(sessionId, item);
        const visibleRawText = String(item.rawText || '');
        deps.updateLiveDisplay?.(sessionId, item, 'assistant', visibleRawText, {
          rawText: visibleRawText,
          pending: true,
          reasoning,
          keepReasoning: !!reasoning,
          forceDisplay: true,
          streamKind: 'chat',
          sessionId,
          noScroll: true,
          runToken: options.runToken || '',
        });
        return true;
      }
      const statusHtml = String(item.html || '')
        || (typeof deps.pendingFeedbackHtml === 'function' ? deps.pendingFeedbackHtml(rawText) : rawText);
      if (!statusHtml) return false;
      deps.updateLiveDisplay?.(sessionId, item, 'assistant', statusHtml, {
        html: true,
        rawText,
        pending: true,
        reasoning,
        keepReasoning: !!reasoning,
        forceDisplay: true,
        streamKind: 'chat',
        sessionId,
        noScroll: true,
        runToken: options.runToken || '',
      });
      return false;
    }
    function loadImageBatch(sessionId = deps.state?.activeSessionId || '') {
      const stored = submitHelpers.loadImageBatchIndex?.(root.localStorage, sessionId) || null;
      if (stored) return stored;

      // A batch parent card is persisted together with the session snapshot.
      // If its compact index was lost during a refresh, rebuild the index from
      // the session-scoped child snapshots instead of falling through to one
      // arbitrary child image job.
      const session = deps.state?.sessions?.find(item => item?.id === sessionId);
      const parent = (session?.display || []).find(item => {
        const batchId = String(item?.jobId || '').trim();
        return batchId.startsWith('imgbatch-') && (String(item?.pending || '') === '1' || !!item?.id);
      });
      if (!parent?.id) return null;
      return submitHelpers.recoverImageBatchIndex?.(root.localStorage, sessionId, {
        batchId: String(parent.jobId || ''),
        displayItemId: String(parent.id || ''),
      }) || null;
    }

    function invalidResumeContract(message) {
      const error = makeTerminalJobError(message);
      error.code = "RESUME_EXECUTION_CONTRACT_INVALID";
      error.statusCode = 400;
      return error;
    }

    function assertResumableExecutionContract(snapshot = {}, kind = "") {
      const plan = snapshot?.dispatchContract;
      if (String(snapshot?.requestPurpose || "").trim() !== "final_execution"
          || typeof dispatchContractContract?.hasExactDispatchContract !== "function"
          || !dispatchContractContract.hasExactDispatchContract(plan)) {
        throw invalidResumeContract("恢复任务缺少合法的 final_execution dispatch_contract.v1，已停止恢复并清理任务");
      }
      if (kind === "chat") {
        if (plan.api !== "chat" || !Array.isArray(snapshot.bindingEvidence)) {
          throw invalidResumeContract("恢复聊天任务的 dispatch_contract 或 binding evidence 不合法，已停止恢复并清理任务");
        }
        try {
          dispatchContractContract.assertBindingEvidence(plan, snapshot.bindingEvidence);
        } catch {
          throw invalidResumeContract("恢复聊天任务的 binding evidence 与 dispatch_contract 不一致，已停止恢复并清理任务");
        }
        return plan;
      }
      const expectedApi = snapshot?.mode === "edit_image" ? "image_edit" : "image_generation";
      if (plan.api !== expectedApi || !Array.isArray(snapshot.bindingEvidence)) {
        throw invalidResumeContract("恢复图片任务的 dispatch_contract 与模式不一致，已停止恢复并清理任务");
      }
      try {
        dispatchContractContract.assertBindingEvidence(plan, snapshot.bindingEvidence);
      } catch {
        throw invalidResumeContract("恢复图片任务的 binding evidence 与 dispatch_contract 不一致，已停止恢复并清理任务");
      }
      return plan;
    }

    function makeTerminalJobError(message) {
      const factory = root?.ChatUIAppJobWorkflow?.makeTerminalJobError;
      if (typeof factory === "function") return factory(message);
      const error = new Error(message || "Managed job failed");
      error.name = "JobTerminalError";
      error.terminalJob = true;
      return error;
    }

    function completedJobData(job) {
      if (job?.status === "error")
        throw makeTerminalJobError(job.error?.message || job.error);
      return job?.data && typeof job.data === "object"
        ? { ...job.data, metrics: job.metrics || {} }
        : job?.data;
    }

    function placeCompletedImageNode(node, responseIndex) {
      if (!node || !Number.isFinite(Number(responseIndex))) return node || null;
      if (typeof deps.insertMessageNodeAtDisplayPosition === "function") {
        return deps.insertMessageNodeAtDisplayPosition(node, {
          role: "assistant",
          responseIndex,
        });
      }
      const sharedInsert = root?.ChatUIAppDisplayItems?.insertMessageNodeAtDisplayPosition;
      return typeof sharedInsert === "function" && node.parentNode
        ? sharedInsert(node.parentNode, node, {
            role: "assistant",
            responseIndex,
          })
        : node;
    }

    async function resumeImageJob(sessionId = deps.state.activeSessionId) {
      const e = sessionId;
      with (deps) {
        const resumeKey = `image:${e}`;
        if (state.resumingJobs.has(resumeKey)) return;
        state.resumingJobs.add(resumeKey);
        let outerJob = null,
          ownsFollower = !1;
        try {
          const s = (outerJob = loadImageJob(e));
          if (!s?.id)
            return void finishSessionTask(e, { resumeKey });
          const n = state.sessions.find((t) => t.id === e);
          if (!n)
            return (
              clearImageJob(e),
              void finishSessionTask(e, { resumeKey })
            );
          if (
            hasSuccessfulImageResult(
              e,
              null,
              s,
              Number.isFinite(Number(s.responseIndex))
                ? Number(s.responseIndex)
                : -1,
            )
          )
            return (
              clearImageJob(e),
              void settleSessionTask(e, {
                outcome: "completed",
                submissionId: s.submissionId || "",
                jobId: s.id,
                jobKind: "image",
                resumeKey,
              })
            );
          const activeRun = state.activeRuns?.get(e),
            hasLiveRun = !!(
              activeRun &&
              !activeRun.stopped &&
              activeRun.abortController?.signal?.aborted !== !0 &&
              activeRun.jobIds?.has(`image:${s.id}`)
            );
          // The in-memory run is the authoritative follower owner. The legacy
          // Set is only a projection and may be temporarily stale while a
          // session is detached/rebound. Starting recovery in that window
          // creates a second timer and a second job follower for the same UI.
          if (isFollowingImageJob(s.id) || hasLiveRun) {
            window.ChatUIApp?.runs?.bindFollowingRun
              ? window.ChatUIApp.runs.bindFollowingRun(state, e, s.id, "image")
              : addActiveRunJob(e, "image", s.id);
            const displayItem =
              (s.displayItemId &&
                (n.display || []).find((e) => e.id === s.displayItemId)) ||
              findImageDisplayItemByJob(n, s) ||
              null;
            if (
              (displayItem &&
                ((displayItem.jobId = s.id || displayItem.jobId || ""),
                void 0 !== s.responseIndex &&
                  null !== s.responseIndex &&
                  (displayItem.responseIndex = String(s.responseIndex)),
                persistSessionDisplay(e)),
              setSessionBusy(e, !0),
              e === state.activeSessionId)
            ) {
              const n = findMessageNodeByDisplayItem(displayItem);
              n &&
                ((n.dataset.streaming = "1"),
                (n.dataset.streamKind = "image"),
                (n.dataset.sessionId = e),
                s.id && (n.dataset.jobId = s.id),
                armStreamingOutputFocus(e, n, {
                  margin: 72,
                  clearStaleFocus: !0,
                  tailLock: !1,
                }),
                updateResumeStreamButton());
            }
            return void state.resumingJobs.delete(resumeKey);
          }
          state.followingImageJobs.add(s.id);
          ownsFollower = !0;
          const a =
            "edit_image" === s.mode ||
            "edit_image" === s.imageContext?.mode ||
            (Array.isArray(s.imageContext?.attachments) &&
              s.imageContext.attachments.length > 0) ||
            (Array.isArray(s.imageContext?.masks) &&
              s.imageContext.masks.length > 0);
          let i =
            (s.displayItemId &&
              (n.display || []).find((e) => e.id === s.displayItemId)) ||
            null;
          (i ||
            (i = takePendingLiveItem(
              e,
              a ? "正在恢复图片修改任务" : "正在恢复图片生成任务",
              /正在生成图片|正在修改图片|正在恢复图片生成任务|正在恢复图片修改任务|已收到/,
            )),
            i &&
              s.imageContext &&
              ((i.imageContext = JSON.stringify(
                normalizeImageContextForStorage(s.imageContext),
              )),
              (i.jobId = s.id || i.jobId || ""),
              void 0 !== s.responseIndex &&
                null !== s.responseIndex &&
                (i.responseIndex = String(s.responseIndex)),
              persistSessionDisplay(e)),
              setSessionBusy(e, !0));
          const o = s.startedAt || Date.now(),
            r = a ? "正在修改图片" : "正在生成图片",
            l = () => {
              const t = Math.max(0, Math.floor((Date.now() - o) / 1e3));
              const status = `${r} 已等待 ${t} 秒`;
              const currentHtml = String(i?.html || '');
              const statusHtml = currentHtml && typeof appendIntentStatusHtml === 'function'
                ? appendIntentStatusHtml(currentHtml, status) || pendingFeedbackHtml(status)
                : pendingFeedbackHtml(status);
              updateLiveDisplay(
                e,
                i,
                "assistant",
                statusHtml,
                {
                  html: !0,
                  rawText: `${r} 已等待 ${t} 秒`,
                  pending: !0,
                  noScroll: !shouldFollowScroll(),
                },
              );
            },
            d = setInterval(l, 1e3);
          let taskOutcome = "",
            taskError = null;
          l();
          try {
            assertResumableExecutionContract(s, "image");
            const t = getConfig();
            let n;
            if (a) {
              let missingImageJob = false;
              try {
                const existingJob = await getImageGenerationJob(s.id);
                n = completedJobData(existingJob);
                // A reload joins an existing queued/running edit job instead of
                // POSTing the same client job id again.
                if (!n) n = await waitImageGenerationJob(s.id, l);
              } catch (e) {
                if (isMissingJobError(e)) missingImageJob = true;
                else throw e;
              }
              if (!n && missingImageJob)
                throw makeTerminalJobError("恢复任务不存在或已失效，已停止恢复，请重新发送");
            } else {
              let missingImageJob = false;
              try {
                const existingJob = await getImageGenerationJob(s.id);
                n = completedJobData(existingJob);
                // An existing queued/running generation must be followed, never
                // recreated with the same id after a refresh.
                if (!n) n = await waitImageGenerationJob(s.id, l);
              } catch (e) {
                if (isMissingJobError(e)) missingImageJob = true;
                else throw e;
              }
              if (!n && missingImageJob)
                throw makeTerminalJobError("恢复任务不存在或已失效，已停止恢复，请重新发送");
            }
            const r = formatElapsed(
                jobDurationMs({ metrics: n?.metrics, ...n }) ?? Date.now() - o,
              ),
              d = await imageResultToHtml(n, r, {
                prompt: s.prompt || "",
                sessionId: e,
              });
            // The managed-job context describes the image submitted to the
            // provider (A1).  Once the provider returns, the completed
            // message must instead own the newly persisted result (A2).
            // Reusing s.imageContext here made a resumed edit look correct in
            // the live DOM but restore the input image after a refresh.
            const resultImageContext = d.imageContext
              ? normalizeImageContextForStorage({
                  ...d.imageContext,
                  mode: a ? "edit_image" : "image",
                  target: "previous",
                  usePreviousImage: !0,
                })
              : normalizeImageContextForStorage(s.imageContext || {}),
              resultImageContextText = JSON.stringify(resultImageContext);
            if (
              (a &&
                (d.html = d.html.replace(
                  "生成完成",
                  s.imageContext?.usePreviousImage
                    ? "基于上一张图修改完成"
                    : "图片修改完成",
                )),
              updateSessionDisplayItem(e, i, "assistant", d.html, {
                html: !0,
                rawText: `${d.raw}
        耗时：${r}`,
                metaText: d.metaText || `RT ${r}`,
                pending: !1,
                imageContext: resultImageContextText,
              }),
              e === state.activeSessionId)
            ) {
              const e = findMessageNodeByDisplayItem(i);
              e &&
                (updateMessage(e, d.html, {
                  html: !0,
                  rawText: `${d.raw}
        耗时：${r}`,
                  metaText: d.metaText || `RT ${r}`,
                }),
                setImageContext(e, resultImageContext));
            }
            const c = `${a ? "[图片编辑完成]" : "[图片生成完成]"} ${s.prompt || ""}`,
              m = upsertImageAssistantMessage(
                e,
                {
                  role: "assistant",
                  content: c,
                  html: d.html,
                  rawText: `${d.raw}
        耗时：${r}`,
                  responseIndex:
                    "" !== i?.responseIndex && void 0 !== i?.responseIndex
                      ? i.responseIndex
                      : void 0,
                  imageContext: resultImageContextText,
                  kind: a ? "edit_image" : "image",
                  metaText: d.metaText || `RT ${r}`,
                },
                s,
                i,
              );
            if (m >= 0 && i) {
              ((i.responseIndex = String(m)),
                (i.jobId = s.id || i.jobId || ""),
                persistSessionDisplay(e));
              if (e === state.activeSessionId) {
                const t = findMessageNodeByDisplayItem(i);
                t &&
                  ((t.dataset.responseIndex = String(m)),
                  placeCompletedImageNode(t, m));
              }
            }
            reconcileSuccessfulImageResult(e, i, s, m);
            const completedSession = state.sessions.find((t) => t.id === e);
            completedSession &&
              (await saveSessionMessages(e, completedSession.messages || []));
            (clearImageJob(e), playDoneSound(), (taskOutcome = "completed"));
          } catch (t) {
            const terminal = isMissingJobError(t) || t?.terminalJob;
            terminal &&
              (clearImageJob(e), (taskOutcome = "failed"), (taskError = t));
            const s = isMissingJobError(t)
              ? "恢复任务不存在或已失效，已停止恢复，请重新发送"
              : t?.message || String(t);
            const staleInvalid = t?.code === 'IMAGE_MASK_CARDINALITY_EXCEEDED'
              || t?.code === 'IMAGE_RESUME_BINDING_MISMATCH';
            (isMissingJobError(t) || staleInvalid
              ? cleanupStalePendingDisplay(
                  e,
                  /正在生成图片|正在修改图片|正在恢复图片生成任务|正在恢复图片修改任务|已收到/,
                  s,
                )
              : showRunError(e, t, i, findMessageNodeByDisplayItem(i)),
              isMissingJobError(t) &&
                e === state.activeSessionId &&
                !findMessageNodeByDisplayItem(i) &&
                addMessage("error", s, { rawText: s }));
          } finally {
            const options = {
              resumeKey,
              followingKind: "image",
              jobId: s?.id || "",
              timer: d,
            };
            taskOutcome
              ? settleSessionTask(e, {
                  ...options,
                  outcome: taskOutcome,
                  error: taskError,
                  submissionId: s?.submissionId || "",
                  jobKind: "image",
                })
              : finishSessionTask(e, options);
          }
        } finally {
          const orphanedResume = state.resumingJobs.has(resumeKey),
            orphanedFollower = !!(
              ownsFollower &&
              outerJob?.id &&
              state.followingImageJobs.has(outerJob.id)
            );
          (orphanedResume || orphanedFollower) &&
            finishSessionTask(e, {
              resumeKey,
              followingKind: "image",
              jobId: outerJob?.id || "",
            });
        }
      }
    }

    async function resumeImageBatch(sessionId = deps.state.activeSessionId) {
      const e = sessionId;
      const {
        state, setSessionBusy, finishSessionTask,
        resumePendingSubmit = deps.resumePendingSubmit,
        loadPendingSubmit = deps.loadPendingSubmit,
        findImageDisplayItemByJob, takePendingLiveItem, persistSessionDisplay,
        getImageGenerationJob, isMissingJobError, disposeImageBatchJob, waitImageGenerationJob, getConfig,
        imageResultToHtml, normalizeImageContextForStorage, mergeImageResultContexts, renderImageResultContext,
        renderImageBatchResult, patchImageBatchDisplayNode, pendingFeedbackHtml,
        updateSessionDisplayItem, findMessageNodeByDisplayItem, updateMessage, setImageContext,
        reconcileSuccessfulImageResult, saveSessionMessages,
        cleanupStalePendingDisplay, showRunError, formatElapsed, jobDurationMs,
      } = deps;
      const resumeKey = `image_batch:${e}`;
      if (state.resumingJobs.has(resumeKey)) return;
      const index = loadImageBatch(e);
      if (!index || !Array.isArray(index.children) || !index.children.length) {
        return void finishSessionTask(e, { resumeKey });
      }
      const session = state.sessions.find(item => item?.id === e);
      if (!session) {
        submitHelpers.clearImageBatchIndex?.(root.localStorage, e);
        return void finishSessionTask(e, { resumeKey });
      }
      const hasPendingChildren = index.children.some(child => child.status !== 'done');
      const missingDurableChild = hasPendingChildren && index.children.some(child => (
        child.status !== 'done'
        && !submitHelpers.loadImageBatchChild?.(root.localStorage, e, child.jobId)
      ));
      if (missingDurableChild && typeof resumePendingSubmit === 'function' && typeof loadPendingSubmit === 'function') {
        const pending = loadPendingSubmit(e);
        if (pending
            && String(pending.stage || '') === 'handoff'
            && String(pending.jobKind || '') === 'image_batch'
            && String(pending.jobId || '') === String(index.batchId || '')) {
          return await resumePendingSubmit(e);
        }
      }
      state.resumingJobs.add(resumeKey);
      let batchOutcome = '';
      let batchError = null;
      try {
        setSessionBusy(e, true);
        const parentId = String(index.children.find(child => child.displayItemId)?.displayItemId || '');
        const parent = (parentId && (session.display || []).find(item => item?.id === parentId))
          || (session.display || []).find(item => item?.batchId === index.batchId)
          || (hasPendingChildren && typeof takePendingLiveItem === 'function'
            ? takePendingLiveItem(e, '正在恢复图片生成任务', /正在生成图片|正在修改图片|正在恢复图片生成任务|正在恢复图片修改任务|已收到/)
            : null)
          || (!hasPendingChildren && parentId
            ? (() => {
                const message = (session.messages || []).find(item => item?.role === 'assistant' && String(item.displayItemId || '') === parentId);
                return message ? { id: parentId, role: 'assistant', responseIndex: message.responseIndex, imageContext: message.imageContext || '', pending: '' } : null;
              })()
            : null);
        if (parent && parentId && !parent.id) parent.id = parentId;
        const aggregate = {
          total: index.children.length,
          completed: index.children.filter(child => child.status === 'done').length,
          statuses: index.children.map(child => child.status === 'done' ? '已完成' : '等待恢复'),
        };
        const commitQueue = typeof submitHelpers.createSerialCommitQueue === 'function'
          ? submitHelpers.createSerialCommitQueue()
          : null;
        const parseContext = value => {
          try { return value && typeof value === 'string' ? JSON.parse(value) : (value || {}); } catch { return {}; }
        };
        // The batch index—not the transient parent card—is the durable source
        // of truth. Rebuild already finished children before continuing siblings.
        // The batch index—not the transient parent card—is the durable source
        // of truth. Keep one context per plan position, so neither reload timing
        // nor provider completion order can discard a completed sibling.
        const childContexts = index.children.map(child => (
          child.status === 'done' && child.imageContext ? parseContext(child.imageContext) : null
        ));
        const aggregateChildContexts = () => {
          let aggregateContext = {};
          if (typeof mergeImageResultContexts !== 'function') {
            return childContexts.find(context => context && typeof context === 'object') || {};
          }
          for (const context of childContexts) {
            if (context && typeof context === 'object') {
              aggregateContext = mergeImageResultContexts(aggregateContext, context);
            }
          }
          return normalizeImageContextForStorage(aggregateContext);
        };
        let recoveredAggregateContext = aggregateChildContexts();
        const renderBatchStatus = () => typeof pendingFeedbackHtml === 'function'
          ? pendingFeedbackHtml(aggregate.statuses.map((status, childIndex) => `任务 ${childIndex + 1}/${aggregate.total}：${status || '等待恢复'}`).join('\n'))
          : '';
        const renderRecoveredBatch = complete => typeof renderImageBatchResult === 'function'
          ? renderImageBatchResult(recoveredAggregateContext || {}, {
              total: aggregate.total,
              childContexts,
              statusHtml: renderBatchStatus(),
              complete,
            })
          : (typeof renderImageResultContext === 'function' ? renderImageResultContext(recoveredAggregateContext || {}) : '');
        const patchRecoveredBatch = (node, complete) => typeof patchImageBatchDisplayNode === 'function'
          && patchImageBatchDisplayNode(node, {
            total: aggregate.total,
            childContexts,
            imageContext: recoveredAggregateContext || {},
            statusHtml: renderBatchStatus(),
            complete,
          });
        const currentParentContext = () => recoveredAggregateContext;
        const setBatchIndexStatus = (jobId, status, imageContext) => {
          index.children = index.children.map((child, childIndex) => {
            if (child.jobId !== jobId) return child;
            if (imageContext) childContexts[childIndex] = parseContext(imageContext);
            return { ...child, status, ...(imageContext ? { imageContext } : {}) };
          });
          recoveredAggregateContext = aggregateChildContexts();
          const current = submitHelpers.loadImageBatchIndex?.(root.localStorage, e) || index;
          current.children = index.children.map(child => ({ ...child }));
          submitHelpers.saveImageBatchIndex?.(root.localStorage, e, current);
        };
        const commitRecoveredAggregate = async (context, complete) => {
          const safeContext = context || normalizeImageContextForStorage({});
          const resultImageContextText = JSON.stringify(safeContext);
          const resultHtml = renderRecoveredBatch(complete);
          const rawText = complete ? '图片生成完成' : '正在恢复图片生成任务';
          const metaText = complete ? `已完成 ${index.children.length}/${index.children.length} 张` : `正在生成 ${index.children.filter(item => item.status === 'done').length}/${index.children.length} 张图片`;
          if (parent) {
            updateSessionDisplayItem(e, parent, 'assistant', resultHtml, {
              html: true, rawText, metaText, pending: !complete,
              imageContext: resultImageContextText, responseIndex: parent.responseIndex,
            });
            const node = findMessageNodeByDisplayItem(parent);
            if (e === state.activeSessionId && node) {
              if (node.querySelector?.('.generated-image-batch-grid')) patchRecoveredBatch(node, complete);
              else updateMessage(node, resultHtml, { html: true, rawText, metaText, preserveLiveMedia: true });
              setImageContext(node, safeContext);
              if (complete) { delete node.dataset.jobId; delete node.dataset.pendingFeedback; }
            }
            persistSessionDisplay(e);
          }
          if (complete) {
            const messages = Array.isArray(session.messages) ? session.messages : [];
            const displayItemId = parent?.id || parentId;
            const responseIndex = parent?.responseIndex || index.children.find(child => child.responseIndex)?.responseIndex || '';
            const message = {
              role: 'assistant', content: '[图片生成完成]', html: resultHtml, rawText, metaText,
              responseIndex, imageContext: resultImageContextText, kind: 'image',
              imageJobId: index.batchId, displayItemId,
            };
            const existing = messages.findIndex(item => item?.role === 'assistant' && (
              (displayItemId && String(item.displayItemId || '') === String(displayItemId))
              || (responseIndex !== '' && String(item.responseIndex || '') === String(responseIndex))
            ));
            if (existing >= 0) messages[existing] = { ...messages[existing], ...message };
            else messages.push(message);
            session.messages = messages;
            if (e === state.activeSessionId) state.messages = messages.map(item => ({ ...item }));
            await saveSessionMessages(e, messages);
          }
        };
        if (parent) {
          await commitRecoveredAggregate(recoveredAggregateContext, !hasPendingChildren && aggregate.completed >= aggregate.total);
        }
        const resumeImageBatchChild = async (child, childIndex) => {
          if (child.status === 'done') return;
          const responseIndex = Number.isFinite(Number(child.responseIndex)) ? Number(child.responseIndex) : -1;
          const snapshot = submitHelpers.loadImageBatchChild?.(root.localStorage, e, child.jobId);
          if (!snapshot?.id) {
            const error = makeTerminalJobError('恢复任务不存在或已失效，已停止恢复，请重新发送');
            cleanupStalePendingDisplay?.(e, /正在生成图片|正在修改图片|正在恢复图片生成任务|正在恢复图片修改任务|已收到/, error.message);
            throw error;
          }
          const i = parent || findImageDisplayItemByJob(session, snapshot) || null;
          if (i) {
            i.jobId = snapshot.id || i.jobId || '';
            i.pending = '1';
            persistSessionDisplay(e);
          }
          let release = null;
          try {
            if (commitQueue) release = await commitQueue.acquire();
            let data = null;
            let missingImageJob = false;
            try {
              const existingJob = await getImageGenerationJob(snapshot.id);
              data = completedJobData(existingJob);
              // A status-only response still represents a live provider job.
              if (!data) data = await waitImageGenerationJob(snapshot.id, () => {});
            } catch (error) {
              if (isMissingJobError(error)) missingImageJob = true;
              else throw error;
            }
            if (!data) throw makeTerminalJobError('恢复任务不存在或已失效，已停止恢复，请重新发送');
            const elapsed = formatElapsed(jobDurationMs({ metrics: data?.metrics, ...data }) ?? Date.now() - (Number(snapshot.startedAt) || Date.now()));
            const rendered = await imageResultToHtml(data, elapsed, { prompt: snapshot.prompt || child.prompt || '', label: child.label || '', sessionId: e });
            const completedMode = snapshot.mode === 'edit_image' ? 'edit_image' : 'image';
            const childContext = rendered.imageContext
              ? normalizeImageContextForStorage({ ...rendered.imageContext, mode: completedMode, target: 'previous', usePreviousImage: true })
              : normalizeImageContextForStorage(snapshot.imageContext || {});
            childContexts[childIndex] = childContext;
            const mergedContext = aggregateChildContexts();
            const resultImageContextText = JSON.stringify(mergedContext);
            aggregate.completed += 1;
            aggregate.statuses[childIndex] = '已完成';
            const complete = aggregate.completed >= aggregate.total;
            const rawText = `${rendered.raw}\n任务 ${childIndex + 1}/${aggregate.total} 完成`;
            const metaText = complete ? `已完成 ${aggregate.total}/${aggregate.total} 张` : `正在生成 ${aggregate.completed}/${aggregate.total} 张`;
            recoveredAggregateContext = mergedContext;
            const resultHtml = renderRecoveredBatch(complete) || rendered.html;
            if (i) {
              updateSessionDisplayItem(e, i, 'assistant', resultHtml, {
                html: true, rawText, metaText, pending: !complete,
                imageContext: resultImageContextText, responseIndex: child.responseIndex || i.responseIndex,
              });
              const node = findMessageNodeByDisplayItem(i);
              if (e === state.activeSessionId && node) {
                if (node.querySelector?.('.generated-image-batch-grid')) patchRecoveredBatch(node, complete);
                else updateMessage(node, resultHtml, { html: true, rawText, metaText, preserveLiveMedia: true });
                setImageContext(node, mergedContext);
                if (complete) { delete node.dataset.jobId; delete node.dataset.pendingFeedback; }
              }
              persistSessionDisplay(e);
            }
            setBatchIndexStatus(child.jobId, 'done', childContext);
            submitHelpers.clearImageBatchChild?.(root.localStorage, e, child.jobId);
            if (complete) {
              const content = `[图片生成完成] ${index.children.map(item => item.prompt).filter(Boolean).join('、')}`;
              const message = {
                role: 'assistant', content, html: resultHtml, rawText, metaText,
                responseIndex: parent?.responseIndex || child.responseIndex,
                imageContext: resultImageContextText, kind: 'image',
                imageJobId: snapshot.id || '', displayItemId: i?.id || parentId || '',
              };
              const messages = Array.isArray(session.messages) ? session.messages : [];
              const existing = messages.findIndex(item => item?.role === 'assistant' && item?.displayItemId === message.displayItemId);
              if (existing >= 0) messages[existing] = { ...messages[existing], ...message };
              else messages.push(message);
              session.messages = messages;
              if (e === state.activeSessionId) state.messages = messages.map(item => ({ ...item }));
              // All children share one parent response index. Reconciliation is
              // intentionally skipped: it is a single-job deduper and can retain
              // a stale one-image record instead of this merged batch result.
              await saveSessionMessages(e, messages);
            }
          } catch (error) {
            const missing = isMissingJobError(error) || error?.terminalJob;
            if (missing) submitHelpers.clearImageBatchChild?.(root.localStorage, e, child.jobId);
            const message = missing ? '恢复任务不存在或已失效，已停止恢复，请重新发送' : error?.message || String(error);
            if (missing) cleanupStalePendingDisplay(e, /正在生成图片|正在修改图片|正在恢复图片生成任务|正在恢复图片修改任务|已收到/, message);
            else showRunError(e, error, parent, findMessageNodeByDisplayItem(parent));
            throw error;
          } finally {
            if (release) { release(); release = null; }
          }
        };
        const pendingChildren = index.children
          .map((child, childIndex) => ({ child, childIndex }))
          .filter(item => item.child.status !== 'done');
        const settled = await Promise.allSettled(pendingChildren.map(item => resumeImageBatchChild(item.child, item.childIndex)));
        const terminalFailure = settled.find(result => result.status === 'rejected' && (
          result.reason?.terminalJob === true
          || (typeof isMissingJobError === 'function' && isMissingJobError(result.reason))
        ));
        if (aggregate.completed >= aggregate.total && settled.every(result => result.status === 'fulfilled')) {
          batchOutcome = 'completed';
          submitHelpers.clearImageBatchIndex?.(root.localStorage, e);
          index.children.forEach(child => submitHelpers.clearImageBatchChild?.(root.localStorage, e, child.jobId));
        } else if (terminalFailure) {
          batchOutcome = 'failed';
          batchError = terminalFailure.reason || null;
          submitHelpers.clearImageBatchIndex?.(root.localStorage, e);
          index.children.forEach(child => submitHelpers.clearImageBatchChild?.(root.localStorage, e, child.jobId));
          if (typeof disposeImageBatchJob === 'function') {
            try { await disposeImageBatchJob({ batchId: index.batchId }); } catch {}
          }
        }
      } finally {
        state.resumingJobs.delete(resumeKey);
        if (batchOutcome) {
          // A recovered image result is already committed, so the task must
          // settle to a terminal phase; otherwise the composer stays in stop
          // mode even though every image is visible.
          settleSessionTask(e, {
            resumeKey,
            outcome: batchOutcome,
            error: batchError,
            submissionId: String(index.submissionId || ''),
            jobId: String(index.batchId || ''),
            jobKind: 'image_batch',
          });
        } else {
          finishSessionTask(e, { resumeKey });
        }
      }
    }

    async function resumeChatJob(sessionId = deps.state.activeSessionId) {
      const e = sessionId;
      with (deps) {
        const t = `chat:${e}`;
        if (state.resumingJobs.has(t)) return;
        state.resumingJobs.add(t);
        let outerJob = null;
        try {
          const s = (outerJob = loadLatestChatJob(e));
          if (!s?.id) return void finishSessionTask(e, { resumeKey: t });
          const n = state.sessions.find((t) => t.id === e);
          if (!n)
            return (
              clearChatJob(e),
              void finishSessionTask(e, { resumeKey: t })
            );
          const activeRun = state.activeRuns?.get(e),
            hasLiveRun = !!(
              activeRun &&
              !activeRun.stopped &&
              activeRun.jobIds?.has(`chat:${s.id}`)
            );
          if (state.followingChatJobs.has(s.id) || hasLiveRun) {
            window.ChatUIApp?.runs?.bindFollowingRun
              ? window.ChatUIApp.runs.bindFollowingRun(state, e, s.id, "chat")
              : addActiveRunJob(e, "chat", s.id);
            let a = takeChatJobLiveItem(
              e,
              s,
              "正在恢复聊天任务",
              /正在处理|正在思考|正在恢复聊天任务|已收到/,
            );
            (a &&
              (s.id && !a.jobId && (a.jobId = s.id),
              void 0 !== s.responseIndex &&
                null !== s.responseIndex &&
                "" === a.responseIndex &&
                (a.responseIndex = String(s.responseIndex))),
              setSessionBusy(e, !0));
            if (e === state.activeSessionId) {
              const t = findMessageNodeByDisplayItem(a);
              t &&
                ((t.dataset.streaming = "1"),
                (t.dataset.streamKind = "chat"),
                (t.dataset.sessionId = e),
                a?.jobId && (t.dataset.jobId = a.jobId),
                armStreamingOutputFocus(e, t, {
                  margin: 72,
                  clearStaleFocus: !0,
                  tailLock: !1,
                }),
                updateResumeStreamButton());
            }
            renderResumedChatState(e, a, { runToken: activeRun?.token || "" });
            return void state.resumingJobs.delete(t);
          }
          if (sessionHasCompletedAssistantForResponse(n, s.responseIndex))
            return (
              clearChatJob(e),
              void settleSessionTask(e, {
                outcome: "completed",
                submissionId: s.submissionId || "",
                jobId: s.id,
                jobKind: "chat",
                resumeKey: t,
              })
            );
          let resumeRun = root?.ChatUIApp?.runs?.bindFollowingRun
            ? root.ChatUIApp.runs.bindFollowingRun(state, e, s.id, "chat")
            : null;
          if (!resumeRun && typeof ensureActiveRun === "function") {
            resumeRun = ensureActiveRun(e);
            addActiveRunJob(e, "chat", s.id);
          }
          let a = takeChatJobLiveItem(
            e,
            s,
            "正在恢复聊天任务",
            /正在处理|正在思考|正在恢复聊天任务|已收到/,
          );
          (a &&
            (s.id && !a.jobId && (a.jobId = s.id),
            void 0 !== s.responseIndex &&
              null !== s.responseIndex &&
              "" === a.responseIndex &&
              (a.responseIndex = String(s.responseIndex))),
            setSessionBusy(e, !0));
          if (e === state.activeSessionId) {
            const t = findMessageNodeByDisplayItem(a);
            t &&
              ((t.dataset.streaming = "1"),
              (t.dataset.streamKind = "chat"),
              (t.dataset.sessionId = e),
              a?.jobId && (t.dataset.jobId = a.jobId),
              armStreamingOutputFocus(e, t, {
                margin: 72,
                clearStaleFocus: !0,
                tailLock: !1,
              }),
              updateResumeStreamButton());
          }
          const i = s.startedAt || Date.now();
          let taskOutcome = "",
            taskError = null;
          const R = () => buildChatResumeOffsets(a, isChatStatusText);
          let o = renderResumedChatState(e, a, { runToken: resumeRun?.token || '' });
          const r = () => {
              if (o || a?.outputStarted) return;
              const t = Math.max(0, Math.floor((Date.now() - i) / 1e3)),
                s = shouldFollowScroll();
              const status = `正在处理 已等待 ${t} 秒`;
              const currentHtml = String(a?.html || '');
              const statusHtml = currentHtml && typeof appendIntentStatusHtml === 'function'
                ? appendIntentStatusHtml(currentHtml, status) || pendingFeedbackHtml(status)
                : pendingFeedbackHtml(status);
              updateLiveDisplay(
                e,
                a,
                "assistant",
                statusHtml,
                {
                  html: !0,
                  rawText: `正在处理 已等待 ${t} 秒`,
                  pending: !0,
                  noScroll: !s,
                  forceScroll: s,
                  followActive: s,
                  runToken: resumeRun?.token || '',
                },
              );
            },
            l = setInterval(r, 1e3);
          r();
          try {
            // A display-only refresh pointer has no local dispatch payload, but
            // it can still safely follow the server-owned Job. Contract validation
            // remains mandatory before any local snapshot can restart execution.
            if (s?.payload || s?.dispatchContract || s?.requestPurpose || s?.bindingEvidence)
              assertResumableExecutionContract(s, "chat");
            const t = getConfig(),
              i = (t) => {
                const s = extractChatJobText(t.data);
                if (s.content || s.reasoning) {
                  o = !(!s.content && !s.reasoning) || o;
                  if (a?.streamCheckpointRecovered) {
                    delete a.streamCheckpointRecovered;
                    delete a.streamCheckpointTailOnly;
                  }
                  markResumedOutputStarted(e, a);
                  const contentText = s.content || "",
                    n = shouldFollowScroll();
                  const applyLiveDisplayUpdate = () => deps.updateLiveDisplay?.(e, a, "assistant", contentText, {
                    rawText: contentText,
                    pending: !0,
                    reasoning: s.reasoning || "",
                    keepReasoning: !!s.reasoning,
                    forceDisplay: true,
                    forceScroll: n,
                    followActive: n,
                    noScroll: !n,
                    streamKind: 'chat',
                    sessionId: e,
                    runToken: resumeRun?.token || '',
                  });
                  const terminalFrame = t?.status === "done" || t?.status === "error" || !!t?.done || t?.e !== undefined;
                  if (terminalFrame) {
                    const hadQueuedLiveDisplay = pendingLiveDisplayUpdates.has(String(e || ''));
                    flushLiveDisplayUpdates(e);
                    if (!hadQueuedLiveDisplay) applyLiveDisplayUpdate();
                  } else queueLiveDisplayUpdate(e, applyLiveDisplayUpdate);
                } else o || r();
              },
              l = (e) => {
                if (!e) return null;
                if ((i(e), "done" === e.status)) return e.data;
                if ("error" === e.status)
                  throw makeTerminalJobError(e.error?.message);
                // GET already found the managed job in a non-terminal state.
                // Follow that exact job; do not POST the same client job id
                // again merely because the snapshot has not reached a terminal state.
                existingJobFound = true;
                return null;
              };
            let d = null,
              c = null,
              existingJobFound = false;
            try {
              const resumeOffsets = R();
              d = l(await getChatJob(s.id, { resumeOffsets }));
            } catch (e) {
              c = e;
            }
            if (!d && c && isMissingJobError(c)) throw c;
            if (!d) {
              // Apply the first GET snapshot before deriving SSE offsets. A
              // tail-only checkpoint must never become the resume prefix.
              flushLiveDisplayUpdates(e);
              const resumeOffsets = R();
              d = await waitChatJob(s.id, i, {
                resumeOffsets,
                sessionId: e,
                signal: resumeRun?.abortController?.signal,
                runToken: resumeRun?.token || '',
              });
            }
            flushLiveDisplayUpdates(e);
            let m = extractChatJobText(d);
            if (!m.content && !m.reasoning) {
              try {
                const e = l(await getChatJob(s.id, { resumeOffsets: R() }));
                e && ((d = e), (m = extractChatJobText(d)));
              } catch {}
            }
            const g = m.content || "没有返回内容",
              u = m.reasoning || "",
              M = window.ChatUIApp?.formatting?.responseMetricsText
                ? window.ChatUIApp.formatting.responseMetricsText({
                    firstTokenMs: m.firstTokenMs,
                    durationMs: m.durationMs ?? Date.now() - i,
                  })
                : firstTokenTimeText(m.firstTokenMs);
            if (
              (updateSessionDisplayItem(e, a, "assistant", g, {
                rawText: g,
                pending: !1,
                reasoning: u,
                keepReasoning: !!u,
                metaText: M,
              }),
              e === state.activeSessionId)
            ) {
              const e = findMessageNodeByDisplayItem(a);
              e &&
                updateMessage(e, g, { rawText: g, noScroll: !0, metaText: M });
                u && finishReasoning(e, u, { expanded: false });
            }
            const p =
                null != s.responseIndex && "" !== s.responseIndex
                  ? s.responseIndex
                  : "" !== a?.responseIndex && void 0 !== a?.responseIndex
                    ? a.responseIndex
                    : null,
              f = null != p && "" !== p ? Number(p) : NaN;
            if (Number.isFinite(f) && !Number.isNaN(f)) {
              replaceAssistantMessageAt(e, f, g, { reasoning: u, metaText: M });
              const t = state.sessions.find((t) => t.id === e);
              t &&
                ((t.messages = compactAdjacentDuplicateMessages(
                  t.messages || [],
                )),
                e === state.activeSessionId &&
                  (state.messages = cloneMessageList(t.messages)),
                await saveSessionMessages(e, t.messages));
            } else {
              const t = trimAssistantTailDuplicate(
                [
                  ...(n.messages || []),
                  {
                    role: "assistant",
                    content: g,
                    reasoning_content: u,
                    metaText: M,

                  },
                ],
                g,
              );
              await saveSessionMessages(e, t);
            }
            (clearChatJob(e), playDoneSound(), (taskOutcome = "completed"));
          } catch (t) {
            flushLiveDisplayUpdates(e);
            const terminal = isMissingJobError(t) || t?.terminalJob;
            terminal &&
              (clearChatJob(e), (taskOutcome = "failed"), (taskError = t));
            const s = isMissingJobError(t)
              ? "恢复任务不存在或已失效，已停止恢复，请重新发送"
              : t?.message || String(t);
            (isMissingJobError(t)
              ? cleanupStalePendingDisplay(
                  e,
                  /正在处理|正在思考|正在恢复聊天任务|已收到/,
                  s,
                )
              : showRunError(e, t, a, findMessageNodeByDisplayItem(a)),
              isMissingJobError(t) &&
                e === state.activeSessionId &&
                !findMessageNodeByDisplayItem(a) &&
                addMessage("error", s, { rawText: s }));
          } finally {
            const options = {
              run: resumeRun,
              resumeKey: t,
              followingKind: "chat",
              jobId: s?.id || "",
              timer: l,
            };
            taskOutcome
              ? settleSessionTask(e, {
                  ...options,
                  outcome: taskOutcome,
                  error: taskError,
                  submissionId: s?.submissionId || "",
                  jobKind: "chat",
                })
              : finishSessionTask(e, options);
          }
        } finally {
          state.resumingJobs.has(t) &&
            finishSessionTask(e, {
              resumeKey: t,
              followingKind: "chat",
              jobId: outerJob?.id || "",
            });
        }
      }
    }

    return Object.freeze({ resumeImageJob, resumeImageBatch, resumeChatJob, loadImageBatch });
  }

  const api = Object.freeze({ createJobResumeWorkflow, buildChatResumeOffsets });
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.ChatUIAppJobResumeWorkflow = api;
  if (root?.window) root.window.ChatUIAppJobResumeWorkflow = api;
})(
  typeof globalThis !== "undefined"
    ? globalThis
    : typeof window !== "undefined"
      ? window
      : this,
);
