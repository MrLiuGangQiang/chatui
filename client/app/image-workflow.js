(function initChatUIAppImageWorkflow(root) {
  // Intentionally not strict: sendImage body is migrated from app.js and resolved through a deps scope.

  function imageRoleLabel(role = "") {
    return role === "target"
      ? "作为编辑目标图"
      : role === "style_reference"
        ? "仅作为风格参考"
        : "作为内容参考";
  }

  function buildImageRoleGuide(imageInputs = []) {
    if (!Array.isArray(imageInputs) || imageInputs.length <= 1) return "";
    return [
      "随附图片角色（按上传顺序）：",
      ...imageInputs.map((item, index) => `- 图片${index + 1}：${imageRoleLabel(item?.routeRole)}`),
      "请严格按上述角色使用各图片。",
    ].join("\n");
  }

  function buildImageRoleMap(imageInputs = []) {
    if (!Array.isArray(imageInputs) || imageInputs.length <= 1) return [];
    return imageInputs.map((item, index) => ({
      position: index + 1,
      role: String(item?.routeRole || ""),
      resource_key: String(item?.routeResourceKey || ""),
      id: String(item?.routeId || ""),
      reference_id: String(item?.routeReferenceId || ""),
    }));
  }

  function createImageWorkflow(deps = {}) {
    if (!deps.state) throw new Error("state is required");
    const intentContract = root?.ChatUICoreIntentContract
      || root?.ChatUICore?.intentContract
      || (typeof require === "function" ? require("../core/intent-contract") : {});

    function routeResourceKeys(resources = []) {
      return Array.isArray(resources)
        ? resources.map((resource) => String(resource?.routeResourceKey || ""))
        : null;
    }

    function sameRouteResourceKeys(actual = [], expected = []) {
      const actualKeys = routeResourceKeys(actual);
      const expectedKeys = Array.isArray(expected)
        ? expected.map((resource) => String(resource?.key || ""))
        : null;
      return !!actualKeys
        && !!expectedKeys
        && actualKeys.length === expectedKeys.length
        && actualKeys.every((key, index) => key && key === expectedKeys[index]);
    }

    function requireCanonicalImageExecution(taskContract = {}, executionMedia = {}) {
      if (taskContract?.schema_version !== "task_contract.v5"
          || taskContract.readiness !== "ready"
          || !intentContract?.hasExactContractShape?.(taskContract)) {
        throw new TypeError("A ready task_contract.v5 is required for image execution");
      }
      const api = intentContract?.contractApi?.(taskContract) || "";
      if (!['image_generation', 'image_edit'].includes(api)) {
        throw new TypeError("The task contract does not authorize an image request");
      }
      if (executionMedia?.version !== "execution_resources.v1"
          || executionMedia.operation !== taskContract.operation) {
        throw new TypeError("A matching execution_resources.v1 projection is required");
      }
      const images = executionMedia.images;
      const files = executionMedia.files;
      const imageInputs = executionMedia.imageInputs;
      const masks = executionMedia.masks;
      const targets = executionMedia.targets;
      const references = executionMedia.references;
      if (![images, files, imageInputs, masks, targets, references].every(Array.isArray)) {
        throw new TypeError("The image execution projection is incomplete");
      }
      const expectedImages = taskContract.resources.filter((resource) => resource.type === "image");
      const expectedFiles = taskContract.resources.filter((resource) => resource.type === "file");
      const expectedInputs = expectedImages.filter((resource) => ["target", "reference", "style_reference"].includes(resource.role));
      const expectedMasks = expectedImages.filter((resource) => resource.role === "mask");
      const expectedTargets = expectedImages.filter((resource) => resource.role === "target");
      const expectedReferences = expectedImages.filter((resource) => ["reference", "style_reference"].includes(resource.role));
      if (!sameRouteResourceKeys(images, expectedImages)
          || !sameRouteResourceKeys(files, expectedFiles)
          || !sameRouteResourceKeys(imageInputs, expectedInputs)
          || !sameRouteResourceKeys(masks, expectedMasks)
          || !sameRouteResourceKeys(targets, expectedTargets)
          || !sameRouteResourceKeys(references, expectedReferences)) {
        throw new TypeError("The image execution projection does not match its task contract");
      }
      for (let index = 0; index < images.length; index += 1) {
        const actual = images[index];
        const expected = expectedImages[index];
        if (actual?.routeRole !== expected.role
            || actual?.routeSource !== expected.source
            || String(actual?.routeId || "") !== String(expected.id || "")
            || String(actual?.routeReferenceId || "") !== String(expected.reference_id || "")) {
          throw new TypeError("An image execution binding no longer matches its task contract");
        }
      }
      if (files.length || masks.length > 1) {
        throw new TypeError("The image execution projection contains unsupported media");
      }
      return Object.freeze({
        operation: taskContract.operation,
        api,
        imageInputs: [...imageInputs],
        masks: [...masks],
        targets: [...targets],
        references: [...references],
      });
    }

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
          throw new Error("请先配置 Endpoint Base URL 和生图模型");
        const canonicalExecution = requireCanonicalImageExecution(t.taskContract, t.executionMedia),
          n = t.sessionId || state.activeSessionId,
          a = ensureActiveRun(n);
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
                pendingFeedbackHtml("正在处理中 请稍后"),
                { html: !0, rawText: "正在处理中 请稍后", skipSave: !0 },
              )
            : null;
        const c =
          t.liveItem ||
          appendSessionDisplayMessage(
            n,
            "assistant",
            pendingFeedbackHtml("正在处理中 请稍后"),
            { html: !0, rawText: "正在处理中 请稍后", pending: !0 },
          );
        if (d && c) {
          const e = d.dataset?.displayItemId || "",
            t = d.dataset?.responseIndex || "",
            s = c.id || "",
            a = "" !== c.responseIndex ? String(c.responseIndex) : "";
          if ((e && s && e !== s) || (t && a && t !== a)) d = null;
          else
            (d.__displayItem || (d.__displayItem = c),
              s && (d.dataset.displayItemId = s),
              a && (d.dataset.responseIndex = a));
        }
        d?.isConnected && clearReasoning?.(d);
        if (c) {
          delete c.reasoningText;
          c.keepReasoning = !1;
          persistSessionDisplay(n);
        }
        const m = canonicalExecution.imageInputs,
          P = String(t.originalPrompt || e || "").trim(),
          executionPrompt = String(e || P || "").trim();
        const routeFallbackPrompt = String(
            t.editInstruction || t.routePrompt || t.originalPrompt || P || "",
          ).trim(),
          E = executionPrompt || routeFallbackPrompt || P,
          referenceRoleGuide = buildImageRoleGuide(canonicalExecution.imageInputs),
          roleAwarePrompt = [E, referenceRoleGuide].filter(Boolean).join("\n\n"),
          stylePrompt = canonicalExecution.operation === "edit_image" ? "" : getEffectiveImageStylePrompt(n, s),
          g = buildImagePromptWithStylePrompt(roleAwarePrompt, stylePrompt),
          q = buildRequestHeaders("message", n),
          u = window.ChatUIServices?.images?.buildImageRequestPayload
            ? window.ChatUIServices.images.buildImageRequestPayload({
                model: s.imageModel,
                prompt: g,
                size: s.imageSize,
              })
            : { model: s.imageModel, prompt: g };
        if (canonicalExecution.imageInputs.length > 1) {
          u.image_role_map = JSON.stringify(buildImageRoleMap(canonicalExecution.imageInputs));
        }
        if (
          canonicalExecution.api === "image_edit" &&
          !String(u.prompt || "").trim()
        )
          u.prompt = routeFallbackPrompt || P || "请根据用户要求编辑图片";
        s.imageSize &&
          "auto" !== s.imageSize &&
          !u.size &&
          (u.size = s.imageSize);
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
          let f = [...canonicalExecution.imageInputs],
            maskAttachments = [...canonicalExecution.masks];
          const isRefGen = canonicalExecution.operation === "image_reference_gen",
            requiresImageEdit = canonicalExecution.api === "image_edit",
            productMode = isRefGen ? "image" : requiresImageEdit ? "edit_image" : "image",
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
                    updateMessage(d, pendingFeedbackHtml(`${e} 已等待 0 秒`), {
                      html: !0,
                      rawText: `${e}… 已等待 0 秒`,
                      skipSave: !0,
                    })),
                  updateLiveDisplay(
                    n,
                    c,
                    "assistant",
                    pendingFeedbackHtml(`${e} 已等待 0 秒`),
                    {
                      html: !0,
                      rawText: `${e}… 已等待 0 秒`,
                      pending: !0,
                      runToken: a.token,
                    },
                  ),
                  (l = setInterval(() => {
                    if (shouldSuppressRunUi(n, a.token)) return;
                    const t = Math.floor((performance.now() - r) / 1e3),
                      s = `${e}… 已等待 ${t} 秒`,
                      u = pendingFeedbackHtml(`${e} 已等待 ${t} 秒`);
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
            })(f.length && !isRefGen ? "正在修改图片" : "正在生成图片"),
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
            const durableImageJob = {
                id: e,
                prompt: g,
                payload: u,
                mode: "edit_image",
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
              savedImageJob = saveImageJob(n, durableImageJob);
            if (!isRecoverableJobSnapshot(savedImageJob, durableImageJob)) {
              clearImageJob(n);
              throw new Error(
                "\u65e0\u6cd5\u4fdd\u5b58\u5b8c\u6574\u7684\u56fe\u7247\u4efb\u52a1\u6062\u590d\u6570\u636e\uff0c\u672a\u5411\u4e0a\u6e38\u53d1\u9001\u8bf7\u6c42\u3002\u8bf7\u6e05\u7406\u6d4f\u89c8\u5668\u5b58\u50a8\u7a7a\u95f4\u540e\u91cd\u8bd5",
              );
            }
            completeDurableHandoff();
            T = performance.now();
            const i = await startImageGenerationJob(u, s, e, {
              mode: "edit_image",
              files: F,
              masks: M,
              signal: a.abortController.signal,
              headers: q,
              sessionId: n,
              onUploadProgress: (e) => {
                if (shouldSuppressRunUi(n, a.token)) return;
                const t = `正在上传图片… ${e}%`;
                (d?.isConnected &&
                  updateMessage(d, pendingFeedbackHtml(t), {
                    html: !0,
                    rawText: t,
                    skipSave: !0,
                  }),
                  updateLiveDisplay(n, c, "assistant", pendingFeedbackHtml(t), {
                    html: !0,
                    rawText: t,
                    pending: !0,
                    runToken: a.token,
                    noScroll: !shouldFollowScroll(),
                  }));
              },
            });
            (saveImageJob(n, {
              id: i.id,
              prompt: g,
              payload: u,
              mode: "edit_image",
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
            const durableImageJob = {
                id: e,
                prompt: g,
                payload: u,
                mode: "image",
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
              savedImageJob = saveImageJob(n, durableImageJob);
            if (!isRecoverableJobSnapshot(savedImageJob, durableImageJob)) {
              clearImageJob(n);
              throw new Error(
                "\u65e0\u6cd5\u4fdd\u5b58\u5b8c\u6574\u7684\u56fe\u7247\u4efb\u52a1\u6062\u590d\u6570\u636e\uff0c\u672a\u5411\u4e0a\u6e38\u53d1\u9001\u8bf7\u6c42\u3002\u8bf7\u6e05\u7406\u6d4f\u89c8\u5668\u5b58\u50a8\u7a7a\u95f4\u540e\u91cd\u8bd5",
              );
            }
            completeDurableHandoff();
            T = performance.now();
            const imageJob = await startImageGenerationJob(u, s, e, {
              signal: a.abortController.signal,
              headers: q,
              sessionId: n,
            });
            (saveImageJob(n, {
              id: imageJob.id,
              prompt: g,
              payload: u,
              mode: "image",
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
              prompt: P,
              routePrompt: t.originalPrompt || I.routePrompt || "",
              sessionId: n,
              headers: q,
            });
          if (h && selectedIndexes.length)
            mergeSelectedGeneratedImages(n, selectedIndexes, P, C);
          (h || (!isRefGen && "edit_image" === I.mode)) &&
            (b.html = b.html.replace(
              "生成完成",
              h ? "基于上一张图修改完成" : "图片修改完成",
            ));
          const w = window.ChatUIServices?.images?.buildImageCompletionMessage
            ? window.ChatUIServices.images.buildImageCompletionMessage({
                prompt: P,
                mode: h || (!isRefGen && "edit_image" === I.mode) ? "edit_image" : "image",
              })
            : h
              ? `[图片编辑完成] ${P}`
              : `[图片生成完成] ${P}`;
          const resultImageContext = b.imageContext
              ? normalizeImageContextForStorage({
                  ...b.imageContext,
                  mode: h || (!isRefGen && "edit_image" === I.mode) ? "edit_image" : "image",
                  target: "previous",
                  usePreviousImage: !0,
                })
              : I,
            resultImageContextText = JSON.stringify(resultImageContext),
            clarificationReplay = t.clarificationReplay || null;
          if (n === state.activeSessionId) {
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
          (clearImageJob(n), notifyInterfaceCompleted(), playDoneSound());
        } catch (e) {
          if (e?.terminalJob) clearImageJob(n);
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
