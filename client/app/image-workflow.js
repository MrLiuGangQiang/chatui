(function initChatUIAppImageWorkflow(root) {
  // Intentionally not strict: sendImage body is migrated from app.js and resolved through a deps scope.

  const moduleRegistry = root?.[Symbol.for('chatui.module-registry.v1')];
  const imageExecutionModule = moduleRegistry?.get('imageExecution')
    || (typeof require === 'function' ? require('../core/image-execution') : {});
  const {
    buildImageRoleGuide,
    buildImageRoleMap,
  } = imageExecutionModule;
  const executionStatus = root?.[Symbol.for('chatui.module-registry.v1')]?.get('executionStatus')
    || (typeof require === 'function' ? require('./execution-status') : {});
  const storageCore = root?.ChatUICoreStorage
    || (typeof require === 'function' ? require('../core/storage') : {});
  const imageTaskPreparation = moduleRegistry?.get('imageTaskPreparation')
    || (typeof require === 'function' ? require('./image-task-preparation') : {});

  function createImageWorkflow(deps = {}) {
    if (!deps.state) throw new Error("state is required");
    const dispatchContract = root?.[Symbol.for("chatui.module-registry.v1")]?.get("dispatchContract")
      || root?.ChatUIDispatchContract
      || (typeof require === "function" ? require("../../shared/dispatch-contract") : {});

    const imageExecutionPolicy = imageExecutionModule.createImageExecutionPolicy({ dispatchContract });
    const { requireCanonicalImageExecution } = imageExecutionPolicy;

    const taskPreparation = imageTaskPreparation.createImageTaskPreparation?.({
      imageExecutionPolicy: { requireCanonicalImageExecution },
      buildImageRoleGuide,
      buildImageRoleMap,
      ...deps,
    });

    function isRecoverableJobSnapshot(savedJob, expectedJob) {
      const validator = root?.ChatUIAppJobWorkflow?.isRecoverableJobSnapshot;
      return validator
        ? validator(savedJob, expectedJob)
        : !!savedJob?.payload && savedJob.id === expectedJob?.id;
    }

    async function sendImage(e, t = {}) {
      with (deps) {
        const s = getConfig();
        if (!s.baseUrl || !s.imageModel)
          throw new Error('请先配置 Endpoint Base URL 和生图模型');
        const executionContract = t.dispatchContract;
        if (typeof dispatchContract?.hasExactDispatchContract !== 'function'
            || !dispatchContract.hasExactDispatchContract(executionContract)
            || !['image_generation', 'image_edit'].includes(String(executionContract.api || ''))) {
          const error = new TypeError('A validated image dispatch_contract.v1 is required before dispatch');
          error.code = 'IMAGE_DISPATCH_CONTRACT_REQUIRED';
          error.statusCode = 400;
          throw error;
        }
        const preparationStatus = executionStatus.operationStatusText?.(executionContract, 'prepare') || '正在准备图片任务';
        const executionWaitStatus = executionStatus.operationStatusText?.(executionContract, 'execute') || '正在生成图片';
        const statusText = value => {
          const prefix = String(t.statusPrefix || '').trim();
          return prefix ? `${prefix} ${value}` : value;
        };
        // Execution bindings stay in the dispatch contract and media payload.
        // They are not user-facing result metadata.
        const pendingImageFeedback = status => pendingFeedbackHtml(status);
        const pendingImageCard = status => typeof renderImageBatchResult === 'function'
          ? renderImageBatchResult({}, { total: 1, childContexts: [null], slotStatuses: [String(status || '正在生成图片')] })
          : pendingImageFeedback(status);
        const saveDurableImageJob = job => saveImageJob(n, job);
        const clearDurableImageJob = () => clearImageJob(n);
        const canonicalExecution = requireCanonicalImageExecution(executionContract, t.executionMedia),
          executionBindingEvidence = dispatchContract.bindingEvidenceFromMedia(t.executionMedia || {}),
          n = t.sessionId || state.activeSessionId,
          a = ensureActiveRun(n);
        dispatchContract.assertBindingEvidence(executionContract, executionBindingEvidence);
        setActiveOutputForSession(n, null);
        if (a.stopped || a.abortController?.signal?.aborted)
          throw new DOMException("已停止", "AbortError");
        const i = state.sessions.find((e) => e.id === n);
        if (!i) {
          const error = new Error("图片任务所属会话不存在，已停止执行");
          error.code = "IMAGE_SESSION_NOT_FOUND";
          throw error;
        }
        let r = 0,
          l = null,
          T = 0;
        let d =
          n === state.activeSessionId
            ? t.loadingNode ||
              addMessage(
                "assistant",
                pendingImageCard(statusText(preparationStatus)),
                { html: !0, rawText: statusText(preparationStatus), skipSave: !0 },
              )
            : null;
        const c =
          t.liveItem ||
          appendSessionDisplayMessage(
            n,
            "assistant",
            pendingImageCard(statusText(preparationStatus)),
            { html: !0, rawText: statusText(preparationStatus), pending: !0 },
          );
        if (!c?.id) {
          const error = new Error("图片任务缺少可恢复的显示记录，已停止发送");
          error.code = "IMAGE_DISPLAY_ITEM_MISSING";
          throw error;
        }
        // Batch children without a DOM node must remain display-only. Never
        // treat a synthetic/inert loading-node placeholder as a message node:
        // it has no dataset and would fail while binding displayItemId.
        if (d?.dataset && c) {
          const e = d.dataset.displayItemId || "",
            t = d.dataset?.responseIndex || "",
            s = c.id || "",
            a = "" !== c.responseIndex ? String(c.responseIndex) : "";
          if ((e && s && e !== s) || (t && a && t !== a)) d = null;
          else
            (d.__displayItem || (d.__displayItem = c),
              s && (d.dataset.displayItemId = s),
              a && (d.dataset.responseIndex = a));
        }
        if (n === state.activeSessionId && d?.isConnected) {
          clearReasoning?.(d);
          updateMessage(d, pendingImageCard(statusText(preparationStatus)), {
            html: !0,
            rawText: statusText(preparationStatus),
            skipSave: !0,
          });
        }
        if (c) {
          delete c.reasoningText;
          c.keepReasoning = !1;
          updateLiveDisplay(n, c, 'assistant', pendingImageCard(statusText(preparationStatus)), {
            html: !0,
            rawText: statusText(preparationStatus),
            pending: !0,
          });
          persistSessionDisplay(n);
        }
        const prepared = await taskPreparation.prepareImageExecutionRequest({
          contract: executionContract,
          executionMedia: t.executionMedia,
          sessionId: n,
          config: s,
          promptFallback: String(t.originalPrompt || e || '').trim(),
          editInstruction: t.editInstruction,
          routePrompt: t.routePrompt,
          originalPrompt: t.originalPrompt,
          childJobId: t.clientJobId,
          submissionId: t.submissionId || '',
        });
        const E = prepared.prompt,
          g = prepared.styledPrompt,
          u = prepared.payload,
          materializedDispatchContract = prepared.dispatchContract;
        const planArguments = executionContract.arguments || {},
          q = {};
        let p = "",
          completionJobId = "",
          A = new Set(),
          durableHandoffDone = !1;
        const completeDurableHandoff = () => {
          if (durableHandoffDone) return;
          durableHandoffDone = !0;
          try {
            t.onDurableHandoff?.();
          } catch (e) {
            console.warn("durable image handoff callback failed", e);
          }
        };
        let interfaceCompleted = !1;
        const notifyInterfaceCompleted = () => {
          if (interfaceCompleted) return;
          interfaceCompleted = !0;
          try {
            t.onInterfaceCompleted?.({
              sessionId: n,
              submissionId: t.submissionId || "",
              jobId: completionJobId || p,
              managedJobId: p,
              jobKind: "image",
            });
          } catch (e) {
            console.warn("durable image completion callback failed", e);
          }
        };
        try {
          const {
            mode: productMode,
            files: F,
            masks: M,
            imageContext: I,
            imageContextText: S,
            usesPriorInput: h,
            isReferenceGeneration: isRefGen,
          } = prepared;
          const requiresImageEdit = productMode === 'edit_image';

          let x;
          const R = t.replaceAssistantIndex,
            clientImageJobId = prepared.jobId || t.clientJobId || makeClientImageJobId();
          completionJobId = clientImageJobId;
          if (
            (c &&
              ((c.imageContext = S),
              (c.jobId = clientImageJobId),
              persistSessionDisplay(n)),
            n === state.activeSessionId && d?.isConnected &&
              !shouldSuppressRunUi(n, a.token) &&
              (clearPendingFeedback?.(d),
              clearReasoning?.(d),
              (d.dataset.jobId = clientImageJobId),
              setImageContext(d, I)),
            ((e = "正在生成图片") => {
              r = performance.now();
              shouldSuppressRunUi(n, a.token) || (
                n === state.activeSessionId && d?.isConnected && (
                  clearPendingFeedback(d),
                  updateMessage(d, pendingImageCard(statusText(`${e} 已等待 0 秒`)), {
                    html: !0,
                    rawText: statusText(`${e}… 已等待 0 秒`),
                    skipSave: !0,
                  })
                ),
                updateLiveDisplay(n, c, "assistant", pendingImageCard(statusText(`${e} 已等待 0 秒`)), {
                  html: !0,
                  rawText: statusText(`${e}… 已等待 0 秒`),
                  pending: !0,
                  runToken: a.token,
                })
              );
              l = setInterval(() => {
                if (shouldSuppressRunUi(n, a.token)) return;
                const seconds = Math.floor((performance.now() - r) / 1e3);
                const status = statusText(`${e}… 已等待 ${seconds} 秒`);
                const html = pendingImageCard(statusText(`${e} 已等待 ${seconds} 秒`));
                n === state.activeSessionId && d?.isConnected && updateMessage(d, html, {
                  html: !0,
                  rawText: status,
                  skipSave: !0,
                });
                updateLiveDisplay(n, c, "assistant", html, {
                  html: !0,
                  rawText: status,
                  pending: !0,
                  runToken: a.token,
                  noScroll: !shouldFollowScroll(),
                });
              }, 1e3);
            })(),

            requiresImageEdit)
          ) {
            const e = clientImageJobId;
            (addActiveRunJob(n, "image", e),
              A.add(e),
              state.followingImageJobs.add(e));
            const durableImageJob = {
                id: e,
                prompt: g,
                payload: u,
                mode: "edit_image",
                requestPurpose: "final_execution",
                dispatchContract: materializedDispatchContract,
                bindingEvidence: executionBindingEvidence,
                imageContext: I,
                startedAt: Date.now(),
                displayItemId: c?.id || "",
                responseIndex:
                  "" !== c?.responseIndex && void 0 !== c?.responseIndex
                    ? c.responseIndex
                    : R,
                liveItemRawText: c?.rawText || "",
                submissionId: t.submissionId || "",
              },
              savedImageJob = t.skipDurableSnapshot ? durableImageJob : saveDurableImageJob(durableImageJob);
            if (!t.skipDurableSnapshot && !isRecoverableJobSnapshot(savedImageJob, durableImageJob)) {
              clearDurableImageJob();
              throw new Error(
                "\u65e0\u6cd5\u4fdd\u5b58\u5b8c\u6574\u7684\u56fe\u7247\u4efb\u52a1\u6062\u590d\u6570\u636e\uff0c\u672a\u5411\u4e0a\u6e38\u53d1\u9001\u8bf7\u6c42\u3002\u8bf7\u6e05\u7406\u6d4f\u89c8\u5668\u5b58\u50a8\u7a7a\u95f4\u540e\u91cd\u8bd5",
              );
            }
            completeDurableHandoff();
            T = performance.now();
            const i = await startImageGenerationJob(u, s, e, {
              mode: "edit_image",
              requestPurpose: "final_execution",
              dispatchContract: materializedDispatchContract,
              bindingEvidence: executionBindingEvidence,
              submissionId: t.submissionId || "",
              files: F,
              masks: M,
              signal: a.abortController.signal,
              headers: q,
              sessionId: n,
              onUploadProgress: (e) => {
                if (shouldSuppressRunUi(n, a.token)) return;
                const t = statusText(`正在上传图片… ${e}%`);
                n === state.activeSessionId && d?.isConnected &&
                  updateMessage(d, pendingImageCard(t), {
                    html: !0,
                    rawText: t,
                    skipSave: !0,
                  });
                updateLiveDisplay(n, c, "assistant", pendingImageCard(t), {
                  html: !0,
                  rawText: t,
                  pending: !0,
                  runToken: a.token,
                  noScroll: !shouldFollowScroll(),
                });
              },
            });
            (t.skipDurableSnapshot || saveDurableImageJob({
              id: i.id,
              prompt: g,
              payload: u,
              mode: "edit_image",
              requestPurpose: "final_execution",
              dispatchContract: materializedDispatchContract,
              bindingEvidence: executionBindingEvidence,
              imageContext: I,
              startedAt: i.createdAt || Date.now(),
              displayItemId: c?.id || "",
              responseIndex:
                "" !== c?.responseIndex && void 0 !== c?.responseIndex
                  ? c.responseIndex
                  : R,
              liveItemRawText: c?.rawText || "",
              submissionId: t.submissionId || "",
            }),
              (p = i.id),
              addActiveRunJob(n, "image", i.id),
              A.add(i.id),
              state.followingImageJobs.add(i.id),
              (x = await waitImageGenerationJob(i.id, () => {}, {
                signal: a.abortController.signal,
              })));
          } else {
            const e = clientImageJobId;
            (addActiveRunJob(n, "image", e),
              A.add(e),
              state.followingImageJobs.add(e));
            dispatchContract.assertPayloadMatchesDispatchContract(materializedDispatchContract, {
               payload: u,
               mode: "image",
               files: [],
               masks: [],
               bindingEvidence: executionBindingEvidence,
             });
             const durableImageJob = {
                id: e,
                prompt: g,
                payload: u,
                mode: "image",
                requestPurpose: "final_execution",
                dispatchContract: materializedDispatchContract,
                bindingEvidence: executionBindingEvidence,
                imageContext: I,
                startedAt: Date.now(),
                displayItemId: c?.id || "",
                responseIndex:
                  "" !== c?.responseIndex && void 0 !== c?.responseIndex
                    ? c.responseIndex
                    : R,
                liveItemRawText: c?.rawText || "",
                submissionId: t.submissionId || "",
              },
              savedImageJob = t.skipDurableSnapshot ? durableImageJob : saveDurableImageJob(durableImageJob);
            if (!t.skipDurableSnapshot && !isRecoverableJobSnapshot(savedImageJob, durableImageJob)) {
              clearDurableImageJob();
              throw new Error(
                "\u65e0\u6cd5\u4fdd\u5b58\u5b8c\u6574\u7684\u56fe\u7247\u4efb\u52a1\u6062\u590d\u6570\u636e\uff0c\u672a\u5411\u4e0a\u6e38\u53d1\u9001\u8bf7\u6c42\u3002\u8bf7\u6e05\u7406\u6d4f\u89c8\u5668\u5b58\u50a8\u7a7a\u95f4\u540e\u91cd\u8bd5",
              );
            }
            completeDurableHandoff();
            T = performance.now();
            const imageJob = await startImageGenerationJob(u, s, e, {
              requestPurpose: "final_execution",
              dispatchContract: materializedDispatchContract,
              bindingEvidence: executionBindingEvidence,
              submissionId: t.submissionId || "",
              signal: a.abortController.signal,
              headers: q,
              sessionId: n,
            });
            (t.skipDurableSnapshot || saveDurableImageJob({
              id: imageJob.id,
              prompt: g,
              payload: u,
              mode: "image",
              requestPurpose: "final_execution",
              dispatchContract: materializedDispatchContract,
              bindingEvidence: executionBindingEvidence,
              imageContext: I,
              startedAt: imageJob.createdAt || Date.now(),
              displayItemId: c?.id || "",
              responseIndex:
                "" !== c?.responseIndex && void 0 !== c?.responseIndex
                  ? c.responseIndex
                  : R,
              liveItemRawText: c?.rawText || "",
              submissionId: durableImageJob.submissionId || "",
            }),
              (p = imageJob.id),
              addActiveRunJob(n, "image", imageJob.id),
              A.add(imageJob.id),
              state.followingImageJobs.add(imageJob.id),
              (x = await waitImageGenerationJob(imageJob.id, () => {}, {
                signal: a.abortController.signal,
              })));
          }
          const C =
              h && selectedIndexes.length
                ? normalizeLastGeneratedImage(i.lastGeneratedImage)
                : null,
            v = formatElapsed(jobDurationMs(x) ?? performance.now() - (T || r)),
            b = await imageResultToHtml(x, v, {
              prompt: E,
              routePrompt: t.originalPrompt || I.routePrompt || "",
              sessionId: n,
              headers: q,
            });
          if (h && selectedIndexes.length)
            mergeSelectedGeneratedImages(n, selectedIndexes, E, C);
          (h || (!isRefGen && "edit_image" === I.mode)) &&
            (b.html = b.html.replace(
              "生成完成",
              h ? "基于上一张图修改完成" : "图片修改完成",
            ));
          const w = window.ChatUIServices?.images?.buildImageCompletionMessage
            ? window.ChatUIServices.images.buildImageCompletionMessage({
                prompt: E,
                mode: h || (!isRefGen && "edit_image" === I.mode) ? "edit_image" : "image",
              })
            : h
              ? `[图片编辑完成] ${E}`
              : `[图片生成完成] ${E}`;
          const childResultImageContext = b.imageContext
              ? normalizeImageContextForStorage({
                  ...b.imageContext,
                  mode: h || (!isRefGen && "edit_image" === I.mode) ? "edit_image" : "image",
                  target: "previous",
                  usePreviousImage: !0,
                })
              : I;
          const resultImageContext = childResultImageContext;
          const resultHtml = b.html;
          const resultRaw = b.raw;
          const resultMetaText = b.metaText || `RT ${v}`;
          const resultImageContextText = JSON.stringify(resultImageContext);
          const clarificationReplay = t.clarificationReplay || null;
          // Image generation can outlive a session checkpoint or switch. Build
          // the completion from the array that owns the session at completion
          // time, never from the working array captured before the upstream job.
          const completionMessages = cloneMessageList(
            n === state.activeSessionId ? state.messages : (i.messages || []),
          );
          if (n === state.activeSessionId) {
            const s = Number.isFinite(t.replaceAssistantIndex)
              ? t.replaceAssistantIndex
              : completionMessages.length;
            (c &&
              updateSessionDisplayItem(n, c, "assistant", b.html, {
                html: !0,
                rawText: `${b.raw}\n耗时：${v}`,
                pending: !1,
                responseIndex: s,
                imageContext: resultImageContextText,
                metaText: b.metaText || `RT ${v}`,
              }),
              n === state.activeSessionId && d?.isConnected
                ? (updateMessage(d, b.html, {
                    html: !0,
                    preserveLiveMedia: !0,
                    rawText: `${b.raw}\n耗时：${v}`,
                    responseIndex: s,
                    metaText: b.metaText || `RT ${v}`,
                  }),
                  setImageContext(d, resultImageContext))
                : c ||
                  appendSessionDisplayMessage(n, "assistant", b.html, {
                    html: !0,
                    rawText: `${b.raw}\n耗时：${v}`,
                    pending: !1,
                    responseIndex: s,
                    imageContext: resultImageContextText,
                    metaText: b.metaText || `RT ${v}`,
                  }),
              t.userAlreadyAdded ||
                completionMessages.push({
                  role: "user",
                  content: t.originalPrompt || e,
                  rawText: t.originalPrompt || e,
                  messageIndex: completionMessages.length,
                }),
              Number.isFinite(t.replaceAssistantIndex) &&
              "assistant" === completionMessages[t.replaceAssistantIndex]?.role
                ? (completionMessages[t.replaceAssistantIndex] = {
                    ...completionMessages[t.replaceAssistantIndex],
                    role: "assistant",
                    content: w,
                    html: b.html,
                    rawText: `${b.raw}\n耗时：${v}`,
                    responseIndex: t.replaceAssistantIndex,
                    imageContext: resultImageContextText,
                    kind: I.mode,
                    imageJobId: p || "",
                    displayItemId: c?.id || "",
                    ...(clarificationReplay ? { clarificationReplay } : {}),
                    metaText: b.metaText || `RT ${v}`,
                  })
                : Number.isFinite(t.replaceAssistantIndex)
                  ? completionMessages.splice(t.replaceAssistantIndex, 0, {
                      role: "assistant",
                      content: w,
                      html: b.html,
                      rawText: `${b.raw}\n耗时：${v}`,
                      responseIndex: t.replaceAssistantIndex,
                      imageContext: resultImageContextText,
                      kind: I.mode,
                      imageJobId: p || "",
                      displayItemId: c?.id || "",
                      ...(clarificationReplay ? { clarificationReplay } : {}),
                      metaText: b.metaText || `RT ${v}`,
                    })
                  : completionMessages.push({
                      role: "assistant",
                      content: w,
                      html: b.html,
                      rawText: `${b.raw}\n耗时：${v}`,
                      responseIndex: Number.isFinite(t.replaceAssistantIndex)
                        ? t.replaceAssistantIndex
                        : completionMessages.length,
                      imageContext: resultImageContextText,
                      kind: I.mode,
                      imageJobId: p || "",
                      displayItemId: c?.id || "",
                      ...(clarificationReplay ? { clarificationReplay } : {}),
                      metaText: b.metaText || `RT ${v}`,
                    }),
              await saveSessionMessages(n, completionMessages),
              c &&
                updateSessionDisplayItem(n, c, "assistant", b.html, {
                  html: !0,
                  rawText: `${b.raw}\n耗时：${v}`,
                  pending: !1,
                  responseIndex: Number.isFinite(t.replaceAssistantIndex)
                    ? t.replaceAssistantIndex
                    : s,
                  imageContext: resultImageContextText,
                  metaText: b.metaText || `RT ${v}`,
                }),
              c &&
                updateLiveDisplay(n, c, "assistant", b.html, {
                  html: !0,
                  rawText: `${b.raw}\n耗时：${v}`,
                  pending: !1,
                  responseIndex: Number.isFinite(t.replaceAssistantIndex)
                    ? t.replaceAssistantIndex
                    : s,
                  imageContext: resultImageContextText,
                  metaText: b.metaText || `RT ${v}`,
                  noScroll: !0,
                  preserveLiveMedia: !0,
                }));
          } else
            (t.userAlreadyAdded ||
              completionMessages.push({
                role: "user",
                content: t.originalPrompt || e,
                rawText: t.originalPrompt || e,
                messageIndex: completionMessages.length,
              }),
              completionMessages.push({
                role: "assistant",
                content: w,
                html: b.html,
                rawText: `${b.raw}\n耗时：${v}`,
                responseIndex: Number.isFinite(t.replaceAssistantIndex)
                  ? t.replaceAssistantIndex
                  : completionMessages.length,
                imageContext: resultImageContextText,
                kind: I.mode,
                ...(clarificationReplay ? { clarificationReplay } : {}),
                metaText: b.metaText || `RT ${v}`,
              }),
              await saveSessionMessages(n, completionMessages),
              replaceLastSessionDisplayMessage(n, "assistant", b.html, {
                html: !0,
                rawText: `${b.raw}\n耗时：${v}`,
                imageContext: resultImageContextText,
                metaText: b.metaText || `RT ${v}`,
              }));
          const completedIndex = Number.isFinite(t.replaceAssistantIndex)
            ? t.replaceAssistantIndex
            : Number(c?.responseIndex);
          reconcileSuccessfulImageResult(
            n,
            c,
            {
              id: p,
              displayItemId: c?.id || "",
              responseIndex: Number.isFinite(completedIndex)
                ? completedIndex
                : void 0,
            },
            completedIndex,
          );
          await saveSessionMessages(n, i.messages || []);
          (t.skipDurableSnapshot || clearDurableImageJob(), notifyInterfaceCompleted(), playDoneSound());
        } catch (e) {
          if (e?.terminalJob && !t.skipDurableSnapshot) clearDurableImageJob();
          throw e;
        } finally {
          (A.forEach((e) => state.followingImageJobs.delete(e)),
            p && state.followingImageJobs.delete(p),
            l && clearInterval(l));
        }
      }
    }

    return Object.freeze({ sendImage });
  }

  const api = Object.freeze({ createImageWorkflow, buildImageRoleGuide, buildImageRoleMap });
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.ChatUIAppImageWorkflow = api;
  if (root?.window) root.window.ChatUIAppImageWorkflow = api;
})(
  typeof globalThis !== "undefined"
    ? globalThis
    : typeof window !== "undefined"
      ? window
      : this,
);
