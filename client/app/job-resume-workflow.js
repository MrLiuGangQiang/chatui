(function initChatUIAppJobResumeWorkflow(root) {
  // Intentionally not strict: resume bodies are migrated from app.js and resolved through a deps scope.

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
    const dispatchContractContract =
      root?.[Symbol.for("chatui.module-registry.v1")]?.get("dispatchContract") ||
      root?.ChatUIDispatchContract ||
      (typeof require === "function" ? require("../../shared/dispatch-contract") : {});
  const submitHelpers =
      root?.ChatUISubmitWorkflowHelpers ||
      (typeof require === "function" ? require("./submit-workflow.helpers") : {});

    function loadImageBatch(sessionId = deps.state?.activeSessionId || '') {
      return submitHelpers.loadImageBatchIndex?.(root.localStorage, sessionId) || null;
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
              a ? "正在恢复图片修改任务…" : "正在恢复图片生成任务…",
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
              updateLiveDisplay(
                e,
                i,
                "assistant",
                pendingFeedbackHtml(`${r} 已等待 ${t} 秒`),
                {
                  html: !0,
                  rawText: `${r}… 已等待 ${t} 秒`,
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
              try {
                const t = await getImageGenerationJob(s.id);
                n = completedJobData(t);
              } catch (e) {
                if (!isMissingJobError(e)) throw e;
              }
              if (!n) {
                const restoredFiles = await restoreImageAttachmentsFromContext(
                  s.imageContext || {},
                );
                if (!restoredFiles.length)
                  throw new Error(
                    "恢复图片修改任务失败：附件信息已丢失，请重新上传图片",
                  );
                const uploadFiles = await imageFilesToJobPayload(restoredFiles);
                const restoredMasks = await restoreImageAttachmentsFromContext(
                  s.imageContext || {},
                  { role: "mask" },
                );
                const uploadMasks = await imageFilesToJobPayload(restoredMasks);
                if (
                  uploadFiles.length !== restoredFiles.length ||
                  uploadMasks.length !== restoredMasks.length
                )
                  throw new Error(
                    "恢复图片编辑任务失败：额外附件数据已丢失，请重新上传图片",
                  );
                (await startImageGenerationJob(s.payload, t, s.id, {
                  mode: "edit_image",
                  requestPurpose: s.requestPurpose || "final_execution",
                  dispatchContract: s.dispatchContract,
                  bindingEvidence: s.bindingEvidence || [],
                  submissionId: s.submissionId || "",
                  files: uploadFiles,
                  masks: uploadMasks,
                  headers: {},
                  sessionId: e,
                }),
                  (n = await waitImageGenerationJob(s.id, l)));
              }
            } else {
              let a = !1;
              try {
                const e = await getImageGenerationJob(s.id);
                n = completedJobData(e);
              } catch (e) {
                if (isMissingJobError(e)) a = !0;
                else throw e;
              }
              if (!n) {
                if (!a && s.payload && t.baseUrl) {
                }
                (s.payload &&
                  t.baseUrl &&
                  (await startImageGenerationJob(s.payload, t, s.id, {
                    mode: "image",
                    requestPurpose: s.requestPurpose || "final_execution",
                    dispatchContract: s.dispatchContract,
                    bindingEvidence: s.bindingEvidence || [],
                    submissionId: s.submissionId || "",
                    headers: {},
                    sessionId: e,
                  })),
                  (n = await waitImageGenerationJob(s.id, l)));
              }
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
              const t = findMessageNodeByDisplayItem(i);
              t &&
                ((t.dataset.responseIndex = String(m)),
                placeCompletedImageNode(t, m));
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
            (isMissingJobError(t)
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
        findImageDisplayItemByJob, takePendingLiveItem, persistSessionDisplay,
        getImageGenerationJob, isMissingJobError, startImageGenerationJob, waitImageGenerationJob, getConfig,
        imageResultToHtml, normalizeImageContextForStorage, mergeImageResultContexts, renderImageResultContext,
        updateSessionDisplayItem, findMessageNodeByDisplayItem, updateMessage, setImageContext,
        reconcileSuccessfulImageResult, saveSessionMessages,
        cleanupStalePendingDisplay, showRunError, formatElapsed, jobDurationMs,
      } = deps;
      const resumeKey = `image_batch:${e}`;
      if (state.resumingJobs.has(resumeKey)) return;
      state.resumingJobs.add(resumeKey);
      try {
        const index = submitHelpers.loadImageBatchIndex?.(root.localStorage, e);
        if (!index || !Array.isArray(index.children) || !index.children.length) return;
        const session = state.sessions.find(item => item?.id === e);
        if (!session) {
          submitHelpers.clearImageBatchIndex?.(root.localStorage, e);
          return;
        }
        setSessionBusy(e, true);
        const parentId = String(index.children.find(child => child.displayItemId)?.displayItemId || '');
        const hasPendingChildren = index.children.some(child => child.status !== 'done');
        const parent = (parentId && (session.display || []).find(item => item?.id === parentId))
          || (session.display || []).find(item => item?.batchId === index.batchId)
          || (hasPendingChildren && typeof takePendingLiveItem === 'function'
            ? takePendingLiveItem(e, '正在恢复图片生成任务…', /正在生成图片|正在修改图片|正在恢复图片生成任务|正在恢复图片修改任务|已收到/)
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
        const currentParentContext = () => parseContext(parent?.imageContext);
        const setBatchIndexStatus = (jobId, status) => {
          const current = submitHelpers.loadImageBatchIndex?.(root.localStorage, e) || index;
          current.children = current.children.map(child => child.jobId === jobId ? { ...child, status } : child);
          submitHelpers.saveImageBatchIndex?.(root.localStorage, e, current);
        };
        const resumeImageBatchChild = async (child, childIndex) => {
          if (child.status === 'done') return;
          const responseIndex = Number.isFinite(Number(child.responseIndex)) ? Number(child.responseIndex) : -1;
          const snapshot = submitHelpers.loadImageBatchChild?.(root.localStorage, e, child.jobId);
          if (!snapshot?.id) throw makeTerminalJobError('恢复任务不存在或已失效，已停止恢复，请重新发送');
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
            try { data = completedJobData(await getImageGenerationJob(snapshot.id)); }
            catch (error) { if (!isMissingJobError(error)) throw error; }
            if (!data && snapshot.payload && snapshot.mode !== 'edit_image') {
              await startImageGenerationJob(snapshot.payload, getConfig(), snapshot.id, {
                mode: 'image', requestPurpose: snapshot.requestPurpose || 'final_execution',
                dispatchContract: snapshot.dispatchContract, bindingEvidence: snapshot.bindingEvidence || [],
                submissionId: snapshot.submissionId || '', headers: {}, sessionId: e,
              });
              data = await waitImageGenerationJob(snapshot.id, () => {});
            }
            if (!data) throw makeTerminalJobError('恢复任务不存在或已失效，已停止恢复，请重新发送');
            const elapsed = formatElapsed(jobDurationMs({ metrics: data?.metrics, ...data }) ?? Date.now() - (Number(snapshot.startedAt) || Date.now()));
            const rendered = await imageResultToHtml(data, elapsed, { prompt: snapshot.prompt || child.prompt || '', sessionId: e });
            const completedMode = snapshot.mode === 'edit_image' ? 'edit_image' : 'image';
            const childContext = rendered.imageContext
              ? normalizeImageContextForStorage({ ...rendered.imageContext, mode: completedMode, target: 'previous', usePreviousImage: true })
              : normalizeImageContextForStorage(snapshot.imageContext || {});
            const mergedContext = typeof mergeImageResultContexts === 'function'
              ? normalizeImageContextForStorage(mergeImageResultContexts(currentParentContext(), childContext))
              : childContext;
            const resultImageContextText = JSON.stringify(mergedContext);
            const resultHtml = typeof renderImageResultContext === 'function'
              ? renderImageResultContext(mergedContext)
              : rendered.html;
            aggregate.completed += 1;
            aggregate.statuses[childIndex] = '已完成';
            const complete = aggregate.completed >= aggregate.total;
            const rawText = `${rendered.raw}\n任务 ${childIndex + 1}/${aggregate.total} 完成`;
            const metaText = complete ? `已完成 ${aggregate.total}/${aggregate.total} 张` : `正在生成 ${aggregate.completed}/${aggregate.total} 张`;
            if (i) {
              updateSessionDisplayItem(e, i, 'assistant', resultHtml, {
                html: true, rawText, metaText, pending: !complete,
                imageContext: resultImageContextText, responseIndex: child.responseIndex || i.responseIndex,
              });
              const node = findMessageNodeByDisplayItem(i);
              if (e === state.activeSessionId && node) {
                updateMessage(node, resultHtml, { html: true, rawText, metaText, preserveLiveMedia: true });
                setImageContext(node, mergedContext);
              }
              persistSessionDisplay(e);
            }
            setBatchIndexStatus(child.jobId, 'done');
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
              await saveSessionMessages(e, messages);
              reconcileSuccessfulImageResult(e, i, { id: snapshot.id, displayItemId: message.displayItemId, responseIndex: Number(message.responseIndex) }, Number(message.responseIndex));
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
        if (aggregate.completed >= aggregate.total && settled.every(result => result.status === 'fulfilled')) {
          submitHelpers.clearImageBatchIndex?.(root.localStorage, e);
        }
      } finally {
        state.resumingJobs.delete(resumeKey);
        finishSessionTask(e, { resumeKey });
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
              "正在恢复聊天任务…",
              /正在处理|正在思考|正在恢复聊天任务|已收到/,
            );
            (a &&
              (s.id && !a.jobId && (a.jobId = s.id),
              void 0 !== s.responseIndex &&
                null !== s.responseIndex &&
                "" === a.responseIndex &&
                (a.responseIndex = String(s.responseIndex)),
              persistSessionDisplay(e)),
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
                }),
                updateResumeStreamButton());
            }
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
          let a = takeChatJobLiveItem(
            e,
            s,
            "正在恢复聊天任务…",
            /正在处理|正在思考|正在恢复聊天任务|已收到/,
          );
          (a &&
            (s.id && !a.jobId && (a.jobId = s.id),
            void 0 !== s.responseIndex &&
              null !== s.responseIndex &&
              "" === a.responseIndex &&
              (a.responseIndex = String(s.responseIndex)),
            persistSessionDisplay(e)),
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
              }),
              updateResumeStreamButton());
          }
          const i = s.startedAt || Date.now();
          let taskOutcome = "",
            taskError = null;
          const R = () => {
            const e = String(a?.rawText || ""),
              t = isChatStatusText(e) ? "" : e,
              s = String(a?.reasoningText || "");
            return {
              baseContent: t,
              baseReasoning: s,
              contentLength: t.length,
              reasoningLength: s.length,
            };
          };
          let o =
            !!String(a?.rawText || "").trim() &&
            !isChatStatusText(a.rawText || "");
          const r = () => {
              if (o) return;
              const t = Math.max(0, Math.floor((Date.now() - i) / 1e3)),
                s = shouldFollowScroll();
              updateLiveDisplay(
                e,
                a,
                "assistant",
                pendingFeedbackHtml(`正在处理 已等待 ${t} 秒`),
                {
                  html: !0,
                  rawText: `正在处理… 已等待 ${t} 秒`,
                  pending: !0,
                  noScroll: !s,
                  forceScroll: s,
                  followActive: s,
                },
              );
            },
            l = setInterval(r, 1e3);
          r();
          try {
            assertResumableExecutionContract(s, "chat");
            const t = getConfig(),
              i = (t) => {
                const s = extractChatJobText(t.data);
                if (s.content || s.reasoning) {
                  o = !(!s.content && !s.reasoning) || o;
                  const t = s.content || "正在等待响应",
                    n = shouldFollowScroll();
                  updateLiveDisplay(e, a, "assistant", t, {
                    rawText: t,
                    pending: !0,
                    reasoning: s.reasoning || "",
                    keepReasoning: !!s.reasoning,
                    forceScroll: n,
                    followActive: n,
                    noScroll: !n,
                  });
                  const node = findMessageNodeByDisplayItem(a);
                  if (node && s.reasoning) updateReasoning(node, s.reasoning, { done: false, keepEmpty: true, forceScroll: n, followActive: n });
                } else o || r();
              },
              l = (e) => {
                if (!e) return null;
                if ((i(e), "done" === e.status)) return e.data;
                if ("error" === e.status)
                  throw makeTerminalJobError(e.error?.message);
                return null;
              };
            let d = null,
              c = null;
            try {
              const resumeOffsets = R();
              d = l(await getChatJob(s.id, { resumeOffsets }));
            } catch (e) {
              c = e;
            }
            let h = s.payload || null;
            if (!h && typeof buildResumeChatPayload === "function")
              h = buildResumeChatPayload(e, s, n, t);
            if (!d && h && t.baseUrl) {
              const restoredPayload = await restoreJobPayloadMedia(h);
              ((d = l(
                await registerChatStreamJob(restoredPayload, t, s.id, {
                  start: !0,
                  api: s.api || "chat",
                  requestPurpose: s.requestPurpose || "final_execution",
                  dispatchContract: s.dispatchContract,
                  bindingEvidence: s.bindingEvidence || [],
                  submissionId: s.submissionId || "",
                  headers: {},
                  sessionId: e,
                }),
              )),
                (c = null));
            }
            if (!d && c && isMissingJobError(c)) throw c;
            if (!d) {
              const resumeOffsets = R();
              d = await waitChatJob(s.id, i, { resumeOffsets });
            }
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

  const api = Object.freeze({ createJobResumeWorkflow });
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
