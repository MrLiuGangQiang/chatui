(function initChatUIAppImageWorkflow(root) {
  // Intentionally not strict: sendImage body is migrated from app.js and resolved through a deps scope.

  const imageExecutionModule = root?.[Symbol.for('chatui.module-registry.v1')]?.get('imageExecution')
    || (typeof require === 'function' ? require('../core/image-execution') : {});
  const {
    buildImageRoleGuide,
    buildImageRoleMap,
  } = imageExecutionModule;
  const executionStatus = root?.[Symbol.for('chatui.module-registry.v1')]?.get('executionStatus')
    || (typeof require === 'function' ? require('./execution-status') : {});
  const storageCore = root?.ChatUICoreStorage
    || (typeof require === 'function' ? require('../core/storage') : {});

  function createImageWorkflow(deps = {}) {
    if (!deps.state) throw new Error("state is required");
    const dispatchContract = root?.[Symbol.for("chatui.module-registry.v1")]?.get("dispatchContract")
      || root?.ChatUIDispatchContract
      || (typeof require === "function" ? require("../../shared/dispatch-contract") : {});

    const imageExecutionPolicy = imageExecutionModule.createImageExecutionPolicy({ dispatchContract });
    const { requireCanonicalImageExecution } = imageExecutionPolicy;

    function isRecoverableJobSnapshot(savedJob, expectedJob) {
      const validator = root?.ChatUIAppJobWorkflow?.isRecoverableJobSnapshot;
      return validator
        ? validator(savedJob, expectedJob)
        : !!savedJob?.payload && savedJob.id === expectedJob?.id;
    }

    async function sendImage(e, t = {}) {
      with (deps) {
        const s = getConfig();
        // Execution bindings stay in the dispatch contract and media payload.
        // They are not user-facing result metadata.
        const pendingImageFeedback = status => pendingFeedbackHtml(status);
        if (!s.baseUrl || !s.imageModel)
          throw new Error("请先配置 Endpoint Base URL 和生图模型");
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
          if (t.batchAggregate && Number.isInteger(t.batchIndex)) {
            const statuses = Array.isArray(t.batchAggregate.statuses) ? t.batchAggregate.statuses : [];
            statuses[t.batchIndex] = String(value || '').trim();
            return statuses.map((status, index) => `任务 ${index + 1}/${Number(t.batchAggregate.total || statuses.length || 1)}：${status || '等待开始'}`).join('\n');
          }
          return prefix ? `${prefix} ${value}` : value;
        };
        // Both storage paths return the durable snapshot object. The batch
        // path must not leak safeSetJsonStorage's boolean status because the
        // recoverability gate validates the actual persisted contract.
        const saveDurableImageJob = job => {
          if (t.batchChildKey && typeof storageCore.safeSetJsonStorage === 'function') {
            return storageCore.safeSetJsonStorage(root.localStorage, t.batchChildKey, job) ? job : null;
          }
          return saveImageJob(n, job);
        };
        const clearDurableImageJob = () => {
          if (t.batchChildKey && typeof storageCore.safeSetJsonStorage === 'function') {
            try { root.localStorage.removeItem(t.batchChildKey); } catch {}
            return;
          }
          clearImageJob(n);
        };
        const canonicalExecution = requireCanonicalImageExecution(executionContract, t.executionMedia),
          executionBindingEvidence = dispatchContract.bindingEvidenceFromMedia(t.executionMedia || {}),
          n = t.sessionId || state.activeSessionId,
          a = ensureActiveRun(n);
        dispatchContract.assertBindingEvidence(executionContract, executionBindingEvidence);
        setActiveOutputForSession(n, null);
        if (a.stopped || a.abortController?.signal?.aborted)
          throw new DOMException("已停止", "AbortError");
        const i = state.sessions.find((e) => e.id === n) || getActiveSession(),
          o =
            n === state.activeSessionId
              ? state.messages
              : [...(i.messages || [])];
        let r = 0,
          l = null,
          T = 0;
        let d =
          n === state.activeSessionId
            ? t.loadingNode ||
              addMessage(
                "assistant",
                pendingImageFeedback(statusText(preparationStatus)),
                { html: !0, rawText: statusText(preparationStatus), skipSave: !0 },
              )
            : null;
        const c =
          t.liveItem ||
          appendSessionDisplayMessage(
            n,
            "assistant",
            pendingImageFeedback(statusText(preparationStatus)),
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
        if (d?.isConnected) {
          clearReasoning?.(d);
          updateMessage(d, pendingImageFeedback(statusText(preparationStatus)), {
            html: !0,
            rawText: statusText(preparationStatus),
            skipSave: !0,
          });
        }
        if (c) {
          delete c.reasoningText;
          c.keepReasoning = !1;
          updateLiveDisplay(n, c, 'assistant', pendingImageFeedback(statusText(preparationStatus)), {
            html: !0,
            rawText: statusText(preparationStatus),
            pending: !0,
          });
          persistSessionDisplay(n);
        }
        const m = canonicalExecution.imageInputs,
          P = String(t.originalPrompt || e || "").trim(),
          executionPrompt = String(executionContract.arguments?.prompt || e || P || "").trim();
        const routeFallbackPrompt = String(
            t.editInstruction || t.routePrompt || t.originalPrompt || P || "",
          ).trim(),
          E = executionPrompt || routeFallbackPrompt || P,
          referenceRoleGuide = buildImageRoleGuide(canonicalExecution.imageInputs, t.dispatchContract),
          roleAwarePrompt = [E, referenceRoleGuide].filter(Boolean).join("\n\n"),
          stylePrompt = canonicalExecution.operation === "edit_image" ? "" : getEffectiveImageStylePrompt(n, s),
          g = buildImagePromptWithStylePrompt(roleAwarePrompt, stylePrompt),
          planArguments = executionContract.arguments || {},
          requestedSize = String(planArguments.size || '').trim() && planArguments.size !== 'auto'
            ? planArguments.size
            : s.imageSize,
          q = {},
          u = window.ChatUIServices?.images?.buildImageRequestPayload
            ? window.ChatUIServices.images.buildImageRequestPayload({
                model: s.imageModel,
                prompt: g,
                size: requestedSize,
                quality: planArguments.quality,
                background: planArguments.background,
                output_format: planArguments.output_format,
              })
            : { model: s.imageModel, prompt: g };
        if (Number(planArguments.count) > 1) u.n = Number(planArguments.count);
        if (canonicalExecution.imageInputs.length > 1) {
          u.image_role_map = JSON.stringify(buildImageRoleMap(canonicalExecution.imageInputs));
        }
        if (!String(u.prompt || "").trim()) {
          const error = new Error("图片任务缺少明确的执行指令，已停止发送；请重新描述要生成或修改的内容");
          error.code = "IMAGE_EXECUTION_PROMPT_MISSING";
          throw error;
        }
        s.imageSize &&
          "auto" !== s.imageSize &&
          !u.size &&
          (u.size = s.imageSize);
        const materializedDispatchContract = dispatchContract.withArguments(executionContract, {
          prompt: String(u.prompt || '').trim(),
          size: u.size || 'auto',
          quality: u.quality || 'auto',
          background: u.background || 'auto',
          output_format: u.output_format || 'auto',
          count: Number(u.n) || Number(planArguments.count) || 1,
        });
        let p = "",
          completionJobId = "",
          A = new Set(),
          batchResultRelease = null,
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
          let f = [...canonicalExecution.imageInputs],
            maskAttachments = [...canonicalExecution.masks];
          const isRefGen = canonicalExecution.operation === "image_reference_gen",
            requiresImageEdit = canonicalExecution.api === "image_edit",
            productMode = requiresImageEdit ? "edit_image" : "image",
            h = !isRefGen && canonicalExecution.targets.some((item) =>
              ["history", "context"].includes(String(item?.routeSource || "")),
            );
          if (requiresImageEdit && !f.length) {
            throw new Error("路由合同没有提供可执行的图片输入，已停止发送");
          }
          const selectedBindings = [...canonicalExecution.imageInputs],
            selectedReferenceId = String(selectedBindings.find((item) => item?.routeReferenceId)?.routeReferenceId || ""),
            selectedIndexes = selectedBindings.map((item) => Number(item?.routeIndex)).filter((index) => Number.isInteger(index) && index >= 1),
            selectedImageIds = selectedBindings.map((item) => String(item?.routeId || "")).filter(Boolean),
            usesPriorInput = selectedBindings.some((item) => ["quoted", "history", "context"].includes(String(item?.routeSource || ""))),
            executionTarget = requiresImageEdit ? (usesPriorInput ? "previous" : "uploaded") : "new",
            y = await persistImageAttachmentRefs(f),
            z = await persistImageAttachmentRefs(
              maskAttachments.map((item) => ({ ...item, routeRole: "mask" })),
            ),
            I = window.ChatUIServices?.images?.createImageContext
              ? window.ChatUIServices.images.createImageContext({
                  prompt: E,
                  routePrompt: t.originalPrompt || t.routePrompt || "",
                  mode: productMode,
                  target: executionTarget,
                  usePreviousImage: h,
                  selectedReferenceId,
                  selectedIndexes,
                  selectedImageIds,
                  attachments: y,
                  masks: z,
                  makeImageItemId,
                })
              : {
                  prompt: E,
                  routePrompt: t.originalPrompt || t.routePrompt || "",
                  mode: productMode,
                  target: executionTarget,
                  usePreviousImage: h,
                  selectedReferenceId,
                  selectedIndexes,
                  selectedImageIds,
                  attachments: y,
                  masks: z,
                },
            S = JSON.stringify(normalizeImageContextForStorage(I));
          let x;
          const R = t.replaceAssistantIndex,
            clientImageJobId = t.clientJobId || makeClientImageJobId();
          completionJobId = clientImageJobId;
          if (
            (c &&
              ((c.imageContext = S),
              (c.jobId = clientImageJobId),
              persistSessionDisplay(n)),
            d?.isConnected &&
              !shouldSuppressRunUi(n, a.token) &&
              (clearPendingFeedback?.(d),
              clearReasoning?.(d),
              (d.dataset.jobId = clientImageJobId),
              setImageContext(d, I)),
            ((e = "正在生成图片") => {
              ((r = performance.now()),
                shouldSuppressRunUi(n, a.token) ||
                  (d?.isConnected &&
                    (clearPendingFeedback(d),
                    updateMessage(d, pendingImageFeedback(statusText(`${e} 已等待 0 秒`)), {
                      html: !0,
                      rawText: statusText(`${e}… 已等待 0 秒`),
                      skipSave: !0,
                    })),
                  updateLiveDisplay(
                    n,
                    c,
                    "assistant",
                    pendingImageFeedback(statusText(`${e} 已等待 0 秒`)),
                    {
                      html: !0,
                      rawText: statusText(`${e}… 已等待 0 秒`),
                      pending: !0,
                      runToken: a.token,
                    },
                  ),
                  (l = setInterval(() => {
                    if (shouldSuppressRunUi(n, a.token)) return;
                    const t = Math.floor((performance.now() - r) / 1e3),
                      s = statusText(`${e}… 已等待 ${t} 秒`),
                      u = pendingImageFeedback(statusText(`${e} 已等待 ${t} 秒`));
                    (d?.isConnected &&
                      updateMessage(d, u, {
                        html: !0,
                        rawText: s,
                        skipSave: !0,
                      }),
                      updateLiveDisplay(n, c, "assistant", u, {
                        html: !0,
                        rawText: s,
                        pending: !0,
                        runToken: a.token,
                        noScroll: !shouldFollowScroll(),
                      }));
                  }, 1e3))));
            })(executionWaitStatus),
            requiresImageEdit)
          ) {
            const e = clientImageJobId;
            (addActiveRunJob(n, "image", e),
              A.add(e),
              state.followingImageJobs.add(e));
            let F = await imageFilesToJobPayload(f);
            let M = await imageFilesToJobPayload(maskAttachments);
            if (f.length && F.length !== f.length) {
              const e = await restoreImageAttachmentsFromContext(I);
              e.length === f.length && ((f = e), (F = await imageFilesToJobPayload(f)));
            }
            if (F.length !== f.length)
              throw new Error(
                "图片编辑任务有部分图片数据无法恢复，请重新上传全部目标图和参考图后再修改",
              );
            if (maskAttachments.length && M.length !== maskAttachments.length) {
              const restoredMasks = await restoreImageAttachmentsFromContext(I, {
                role: "mask",
              });
              if (restoredMasks.length === maskAttachments.length) {
                maskAttachments = restoredMasks;
                M = await imageFilesToJobPayload(maskAttachments);
              }
            }
            if (M.length !== maskAttachments.length) {
              throw new Error(
                "图片编辑任务的 mask 数据无法恢复，请重新上传 mask 后再修改",
              );
            }
            dispatchContract.assertPayloadMatchesDispatchContract(materializedDispatchContract, {
              payload: u,
              mode: "edit_image",
              files: F,
              masks: M,
              bindingEvidence: executionBindingEvidence,
            });
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
                (d?.isConnected &&
                  updateMessage(d, pendingImageFeedback(t), {
                    html: !0,
                    rawText: t,
                    skipSave: !0,
                  }),
                  updateLiveDisplay(n, c, "assistant", pendingImageFeedback(t), {
                    html: !0,
                    rawText: t,
                    pending: !0,
                    runToken: a.token,
                    noScroll: !shouldFollowScroll(),
                  }));
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
          if (typeof t.acquireResultCommit === "function") batchResultRelease = await t.acquireResultCommit();
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
              : I,
            isBatchChild = !!t.batchAggregate,
            priorBatchImageContext = (() => { try { return c?.imageContext ? JSON.parse(c.imageContext) : {}; } catch { return {}; } })(),
            resultImageContext = isBatchChild && typeof mergeImageResultContexts === "function"
              ? normalizeImageContextForStorage(mergeImageResultContexts(priorBatchImageContext, childResultImageContext))
              : childResultImageContext,
            resultHtml = isBatchChild && typeof renderImageResultContext === "function"
              ? renderImageResultContext(resultImageContext)
              : b.html,
            resultRaw = isBatchChild ? `${b.raw}
任务 ${Number(t.batchIndex || 0) + 1}/${Number(t.batchAggregate?.total || 1)} 完成` : b.raw,
            resultMetaText = isBatchChild ? `已完成 ${Number(t.batchAggregate?.completed || 0) + 1}/${Number(t.batchAggregate?.total || 1)} 张` : (b.metaText || `RT ${v}`),
            resultImageContextText = JSON.stringify(resultImageContext),
            clarificationReplay = t.clarificationReplay || null;
          if (isBatchChild) {
            t.batchAggregate.completed = Number(t.batchAggregate.completed || 0) + 1;
            const complete = t.batchAggregate.completed >= t.batchAggregate.total;
            updateSessionDisplayItem(n, c, "assistant", resultHtml, {
              html: !0,
              rawText: resultRaw,
              pending: !complete,
              responseIndex: c.responseIndex,
              imageContext: resultImageContextText,
              metaText: complete ? resultMetaText : `正在生成 ${t.batchAggregate.completed}/${t.batchAggregate.total} 张图片`,
            });
            updateLiveDisplay(n, c, "assistant", resultHtml, {
              html: !0,
              rawText: resultRaw,
              pending: !complete,
              responseIndex: c.responseIndex,
              imageContext: resultImageContextText,
              metaText: complete ? resultMetaText : `正在生成 ${t.batchAggregate.completed}/${t.batchAggregate.total} 张图片`,
              noScroll: !0,
              preserveLiveMedia: !0,
            });
            if (complete) {
              const batchMessage = {
                role: "assistant", content: w, html: resultHtml, rawText: resultRaw,
                responseIndex: c.responseIndex, imageContext: resultImageContextText,
                kind: "image", imageJobId: p || "", displayItemId: c.id || "",
                ...(clarificationReplay ? { clarificationReplay } : {}), metaText: resultMetaText,
              };
              const existingIndex = state.messages.findIndex(message => message?.displayItemId === c.id);
              if (existingIndex >= 0) state.messages[existingIndex] = { ...state.messages[existingIndex], ...batchMessage };
              else state.messages.push(batchMessage);
              i.messages = cloneMessageList(state.messages);
              await saveSessionMessages(n, i.messages);
              reconcileSuccessfulImageResult(n, c, { id: p, displayItemId: c.id || "", responseIndex: Number(c.responseIndex) }, Number(c.responseIndex));
            }
          } else if (n === state.activeSessionId) {
            const s = Number.isFinite(t.replaceAssistantIndex)
              ? t.replaceAssistantIndex
              : state.messages.length;
            (c &&
              updateSessionDisplayItem(n, c, "assistant", b.html, {
                html: !0,
                rawText: `${b.raw}\n耗时：${v}`,
                pending: !1,
                responseIndex: s,
                imageContext: resultImageContextText,
                metaText: b.metaText || `RT ${v}`,
              }),
              d?.isConnected
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
                state.messages.push({
                  role: "user",
                  content: t.originalPrompt || e,
                  rawText: t.originalPrompt || e,
                  messageIndex: state.messages.length,
                }),
              Number.isFinite(t.replaceAssistantIndex) &&
              "assistant" === state.messages[t.replaceAssistantIndex]?.role
                ? (state.messages[t.replaceAssistantIndex] = {
                    ...state.messages[t.replaceAssistantIndex],
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
                  ? state.messages.splice(t.replaceAssistantIndex, 0, {
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
                  : state.messages.push({
                      role: "assistant",
                      content: w,
                      html: b.html,
                      rawText: `${b.raw}\n耗时：${v}`,
                      responseIndex: Number.isFinite(t.replaceAssistantIndex)
                        ? t.replaceAssistantIndex
                        : state.messages.length,
                      imageContext: resultImageContextText,
                      kind: I.mode,
                      imageJobId: p || "",
                      displayItemId: c?.id || "",
                      ...(clarificationReplay ? { clarificationReplay } : {}),
                      metaText: b.metaText || `RT ${v}`,
                    }),
              (i.messages = cloneMessageList(state.messages)),
              await saveSessionMessages(n, i.messages),
              n === state.activeSessionId &&
                (state.messages = cloneMessageList(i.messages)),
              c &&
                updateSessionDisplayItem(n, c, "assistant", b.html, {
                  html: !0,
                  rawText: `${b.raw}\n耗时：${v}`,
                  pending: !1,
                  responseIndex: Number.isFinite(t.replaceAssistantIndex)
                    ? t.replaceAssistantIndex
                    : state.messages.length - 1,
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
                    : state.messages.length - 1,
                  imageContext: resultImageContextText,
                  metaText: b.metaText || `RT ${v}`,
                  noScroll: !0,
                  preserveLiveMedia: !0,
                }));
          } else
            (t.userAlreadyAdded ||
              o.push({
                role: "user",
                content: t.originalPrompt || e,
                rawText: t.originalPrompt || e,
                messageIndex: o.length,
              }),
              o.push({
                role: "assistant",
                content: w,
                html: b.html,
                rawText: `${b.raw}\n耗时：${v}`,
                responseIndex: Number.isFinite(t.replaceAssistantIndex)
                  ? t.replaceAssistantIndex
                  : o.length,
                imageContext: resultImageContextText,
                kind: I.mode,
                ...(clarificationReplay ? { clarificationReplay } : {}),
                metaText: b.metaText || `RT ${v}`,
              }),
              await saveSessionMessages(n, o),
              replaceLastSessionDisplayMessage(n, "assistant", b.html, {
                html: !0,
                rawText: `${b.raw}\n耗时：${v}`,
                imageContext: resultImageContextText,
                metaText: b.metaText || `RT ${v}`,
              }));
          if (!isBatchChild) {
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
          }
          (batchResultRelease && (batchResultRelease(), batchResultRelease = null));
          (t.skipDurableSnapshot || clearDurableImageJob(), t.deferBatchCompletion || (notifyInterfaceCompleted(), playDoneSound()));
        } catch (e) {
          if (batchResultRelease) { batchResultRelease(); batchResultRelease = null; }
          if (e?.terminalJob && !t.skipDurableSnapshot) clearDurableImageJob();
          throw e;
        } finally {
          if (batchResultRelease) { batchResultRelease(); batchResultRelease = null; }
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
