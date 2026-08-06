(function initChatUISubmitWorkflowHelpers(root) {
  "use strict";

  const executionResources =
    root?.ChatUICore?.executionResources ||
    (typeof require === "function"
      ? require("../core/execution-resources")
      : {});
  const messagePrimitives =
    root?.[Symbol.for("chatui.module-registry.v1")]?.get("messagePrimitives") ||
    (typeof require === "function"
      ? require("../core/message-primitives")
      : {});
  const parseContextValue = messagePrimitives.parseContext;
  if (typeof parseContextValue !== "function") {
    throw new Error("ChatUI message primitives are not loaded");
  }

  function escapeHtml(value) {
    return String(value ?? "").replace(
      /[&<>"']/g,
      (ch) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[ch],
    );
  }

  function previewQuoteText(value) {
    return String(value || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 48);
  }

  function withPendingQuotePreview(html = "", quoteContextValue = "") {
    if (
      !quoteContextValue ||
      /class=["'][^"']*sent-quote-preview/.test(String(html || ""))
    )
      return String(html || "");
    const quote = parseContextValue(quoteContextValue);
    if (!quote) return String(html || "");
    const label = quote.role === "assistant" ? "AI" : "用户";
    const text = previewQuoteText(quote.content || quote.rawText || "追问来源");
    return `<button class="sent-quote-preview pending-clarification-source" type="button" data-quote-context="${escapeHtml(JSON.stringify(quote))}" title="基于这条消息追问"><span class="sent-quote-label">追问 ${escapeHtml(label)}</span><span class="sent-quote-text">${escapeHtml(text)}</span></button>${String(html || "")}`;
  }

  function originalImageIndex(item, index) {
    return (
      Number(item?.sourceIndex) ||
      Number(
        String(item?.imageId || item?.image_id || item?.id || "").match(
          /_(\d+)$/,
        )?.[1],
      ) ||
      index + 1
    );
  }

  function defaultIsImageFile(item) {
    return String(item?.type || item?.file?.type || "").startsWith("image/");
  }

  function imageAttachmentIndexGuide(
    list = [],
    {
      isImageFile = defaultIsImageFile,
      originalIndex = originalImageIndex,
    } = {},
  ) {
    const images = (list || []).filter((item) => isImageFile(item));
    if (!images.length) return '';
    const rows = images.map((item, index) => ({
      part: index + 1,
      source: originalIndex(item, index),
      role: String(item?.routeRole || item?.route_role || item?.role || '').trim(),
      id: String(item?.imageId || item?.image_id || item?.id || '').trim(),
    }));
    const needsMap = rows.length > 1
      || rows.some(row => row.role && row.role !== 'source')
      || rows.some(row => row.part !== row.source);
    if (!needsMap) return '';
    return [
      '<media_map>',
      ...rows.map(row => [
        `image_part_${row.part}`,
        `source_index=${row.source}`,
        row.role ? `role=${row.role}` : '',
        row.id ? `id=${row.id}` : '',
      ].filter(Boolean).join(': ')),
      '</media_map>',
    ].join('\n');
  }

  function buildMediaMapContext(list = [], options = {}) {
    return imageAttachmentIndexGuide(list, options);
  }

  function messageIdentity(message = {}) {
    return String(
      message?.displayItemId ||
        message?.display_item_id ||
        message?.id ||
        message?.messageId ||
        message?.message_id ||
        "",
    );
  }

  function imageReferenceFromItem(item = {}) {
    const explicit = String(item?.referenceId || item?.reference_id || "");
    if (explicit) return explicit;
    const imageId = String(item?.imageId || item?.image_id || item?.id || "");
    return imageId.match(/^img_(imgref_.+)_\d+$/)?.[1] || "";
  }

  function buildQuotedRouteContext({
    quotedMessage = null,
    quotedImageContext = null,
    restoredImageAttachments = [],
    quotedFileCandidates = [],
    currentInput = "",
    cleanQuotedContent = (value) => String(value || "").trim(),
    buildQuotedRouteContent = ({ text = "", images = [] } = {}) =>
      [String(text || "").trim(), images.length ? "[quoted_image]" : ""]
        .filter(Boolean)
        .join("\n"),
  } = {}) {
    const contextAttachments = Array.isArray(quotedImageContext?.attachments)
      ? quotedImageContext.attachments
      : [];
    const restored = Array.isArray(restoredImageAttachments)
      ? restoredImageAttachments
      : [];
    const imageAttachments = restored.length ? restored : contextAttachments;
    const imageSource =
      quotedImageContext?.target === "uploaded" ||
      quotedImageContext?.mode === "edit_image"
        ? "uploaded"
        : "previous";
    const contextReferenceId = String(
      quotedImageContext?.referenceId ||
        quotedImageContext?.reference_id ||
        quotedImageContext?.selectedReferenceId ||
        "",
    );
    const messageText = cleanQuotedContent(
      quotedMessage?.content || quotedMessage?.rawText || "",
    );
    const contextPrompt = cleanQuotedContent(
      quotedImageContext?.prompt ||
        quotedImageContext?.userPrompt ||
        quotedImageContext?.originalPrompt ||
        "",
    );
    const cleanText = messageText || contextPrompt;
    const routeContent = buildQuotedRouteContent({
      text: cleanText || quotedMessage?.content || quotedMessage?.rawText || "",
      images: imageAttachments,
    });
    const defaultReferenceId =
      contextReferenceId || imageReferenceFromItem(imageAttachments[0]) || "imgref_quote";
    const referenceSummary = {
      reference_id: defaultReferenceId,
      source: "quoted",
      target: imageSource,
      count: imageAttachments.length,
    };
    const imageCandidates = imageAttachments.map((item, index) => {
      const imageId = String(item?.imageId || item?.image_id || item?.id || "");
      return {
        index: index + 1,
        image_id: imageId,
        reference_id:
          contextReferenceId ||
          imageReferenceFromItem(item) ||
          defaultReferenceId,
        target: imageSource,
        source: "quoted",
        filename: String(item?.name || item?.filename || item?.file?.name || ""),
        prompt: cleanText,
      };
    });
    const hasQuotedImage = imageCandidates.length > 0;
    const context = {
      quoted_message: {
        index: 1,
        role: quotedMessage?.role || "user",
        id: messageIdentity(quotedMessage),
      },
      recent_messages: [
        {
          index: 1,
          role: quotedMessage?.role || "user",
          content: routeContent || "[quoted_message]",
        },
      ],
      latest_assistant_image_result:
        hasQuotedImage && imageSource === "previous" ? referenceSummary : null,
      image_candidates: imageCandidates,
      file_candidates: Array.isArray(quotedFileCandidates)
        ? quotedFileCandidates
        : [],
      last_generated_image: null,
      latest_uploaded_image:
        hasQuotedImage && imageSource === "uploaded" ? referenceSummary : null,
      latest_image_reference: hasQuotedImage ? referenceSummary : null,
      recent_image_references: [],
      recent_uploaded_image_references: [],
    };
    return Object.freeze({
      context,
      cleanText,
      routeContent,
      imageAttachments,
      imageSource,
      referenceId: defaultReferenceId,
      hasQuotedMessage: !!quotedMessage,
      hasQuotedImage,
    });
  }

  function projectRouteMessageContext(
    route = {},
    sessionMessages = [],
    explicitQuotedMessage = null,
  ) {
    const refs = Array.isArray(route?.messageRefs) ? route.messageRefs : [];
    if (!refs.length) return null;
    const source = Array.isArray(sessionMessages) ? sessionMessages : [];
    const quotedId = messageIdentity(explicitQuotedMessage);
    const selected = [];
    const seen = new Set();
    let usesExplicitQuote = false;

    for (const ref of refs) {
      const refId = String(ref?.message_id || ref?.id || "");
      const index = Number(ref?.index);
      let message = null;
      if (
        explicitQuotedMessage &&
        (!refId || !quotedId || refId === quotedId) &&
        index === 1
      ) {
        message = explicitQuotedMessage;
        usesExplicitQuote = true;
      } else if (Number.isInteger(index) && index >= 1) {
        message = source[index - 1] || null;
        if (
          message &&
          refId &&
          messageIdentity(message) &&
          messageIdentity(message) !== refId
        )
          message = null;
      }
      if (!message) return null;
      const key = refId || messageIdentity(message) || `index:${index}`;
      if (!seen.has(key)) {
        seen.add(key);
        selected.push(message);
      }
    }

    return Object.freeze({
      messages: selected,
      usesExplicitQuote,
      protectedMessageCount: selected.length,
    });
  }

  function projectRouteExecutionMedia(route = {}, pools = {}) {
    if (!route?.executionResources) {
      const error = new TypeError(
        "A canonical route execution resource projection is required",
      );
      error.code = "EXECUTION_RESOURCE_PROJECTION_MISSING";
      throw error;
    }
    if (typeof executionResources.projectExecutionMedia !== "function") {
      throw new TypeError(
        "Execution resource projection service is unavailable",
      );
    }
    return executionResources.projectExecutionMedia(
      route.executionResources,
      pools,
    );
  }

  function mediaIdentity(item = {}, type = "") {
    return String(
      type === "image"
        ? item.imageId ||
            item.image_id ||
            item.attachmentId ||
            item.attachment_id ||
            item.id ||
            ""
        : item.fileId ||
            item.file_id ||
            item.attachmentId ||
            item.attachment_id ||
            item.id ||
            "",
    ).trim();
  }

  function mergeContinuationAttachments(
    { pending = [], current = [], isImageFile = defaultIsImageFile } = {},
  ) {
    const merged = [];
    const seen = new Set();
    for (const item of [...(Array.isArray(pending) ? pending : []), ...(Array.isArray(current) ? current : [])]) {
      if (!item) continue;
      const type = isImageFile(item) ? "image" : "file";
      const id = mediaIdentity(item, type);
      const key = id ? `${type}:${id}` : "";
      if (key && seen.has(key)) continue;
      if (key) seen.add(key);
      merged.push(item);
    }
    return merged;
  }

  function partitionExecutionAttachmentsBySource(
    list = [],
    { isImageFile = defaultIsImageFile } = {},
  ) {
    const pools = { current: [], quoted: [], history: [], context: [] };
    for (const item of Array.isArray(list) ? list : []) {
      if (!item) continue;
      const declared = String(item?.routeSource || item?.route_source || item?.source || '').trim();
      const source = ['quoted', 'history', 'context'].includes(declared) ? declared : 'current';
      pools[source].push(item);
    }
    return Object.freeze({
      current: mergeContinuationAttachments({ pending: pools.current, isImageFile }),
      quoted: mergeContinuationAttachments({ pending: pools.quoted, isImageFile }),
      history: mergeContinuationAttachments({ pending: pools.history, isImageFile }),
      context: mergeContinuationAttachments({ pending: pools.context, isImageFile }),
    });
  }

  function decorateExecutionPool(
    sourceAttachments = [],
    source = "current",
    { isImageFile = defaultIsImageFile } = {},
  ) {
    const attachments = Array.isArray(sourceAttachments)
      ? sourceAttachments
      : [];
    let imageIndex = 0;
    let fileIndex = 0;
    return attachments.map((item, sourcePosition) => {
      const image = isImageFile(item);
      const mediaIndex = image ? ++imageIndex : ++fileIndex;
      const existingIndex = Number(
        item?.routeIndex ||
          item?.route_index ||
          item?.sourceIndex ||
          item?.source_index ||
          item?.media_index ||
          item?.mediaIndex,
      );
      return {
        ...item,
        routeSource: source,
        sourceIndex:
          Number.isInteger(existingIndex) && existingIndex >= 1
            ? existingIndex
            : source === "current"
              ? sourcePosition + 1
              : mediaIndex,
        media_index:
          Number(item?.media_index || item?.mediaIndex) || mediaIndex,
      };
    });
  }

  function buildExecutionResourcePools(sourcePools = {}, options = {}) {
    const isImageFile = options.isImageFile || defaultIsImageFile;
    const imagePools = {};
    const filePools = {};
    for (const source of ["current", "quoted", "history", "context"]) {
      const decorated = decorateExecutionPool(sourcePools[source], source, {
        isImageFile,
      });
      imagePools[source] = decorated.filter(isImageFile);
      filePools[source] = decorated.filter((item) => !isImageFile(item));
    }
    return Object.freeze({ imagePools, filePools });
  }

  function routeMediaResources(route = {}, type = "", source = "") {
    const list =
      type === "image"
        ? route?.executionResources?.images
        : route?.executionResources?.files;
    return (Array.isArray(list) ? list : []).filter(
      (resource) => !source || resource?.source === source,
    );
  }

  async function restoreBoundImagePool(
    route = {},
    { source = "history", sessionId = "", getPreviousImageAttachments } = {},
  ) {
    const required = routeMediaResources(route, "image", source);
    if (!required.length) return [];
    if (typeof getPreviousImageAttachments !== "function") {
      throw new TypeError("Historical image restoration service is unavailable");
    }
    const restored = [];
    for (const resource of required) {
      const id = String(resource?.id || "").trim();
      const candidates = id
        ? await getPreviousImageAttachments(sessionId, null, "", [id])
        : await getPreviousImageAttachments(
          sessionId,
          [Number(resource?.index)],
          String(resource?.reference_id || ""),
          [],
        );
      if (!Array.isArray(candidates) || candidates.length !== 1) {
        const error = new TypeError(`Resource ${resource?.key || ""} is not uniquely recoverable for execution`);
        error.code = "EXECUTION_RESOURCE_UNRESOLVED";
        error.resourceKey = String(resource?.key || "");
        error.resourceType = "image";
        error.resourceSource = source;
        throw error;
      }
      const attachment = candidates[0];
      const recoveredId = mediaIdentity(attachment, "image");
      const aliases = [
        recoveredId,
        ...(attachment?.routeIdAliases || attachment?.route_id_aliases || []),
      ].map(value => String(value || "").trim()).filter(Boolean);
      restored.push({
        ...attachment,
        // Execution-resource matching accepts both camelCase and persisted
        // snake_case image metadata.  Canonicalize every identity-bearing
        // field here, at restoration time, so projection cannot see the
        // recovered durable ID as a second, competing identity.
        imageId: id || recoveredId,
        image_id: id || recoveredId,
        attachmentId: id || recoveredId,
        attachment_id: id || recoveredId,
        referenceId: String(resource?.reference_id || attachment?.referenceId || attachment?.reference_id || ""),
        reference_id: String(resource?.reference_id || attachment?.referenceId || attachment?.reference_id || ""),
        routeIdAliases: [...new Set([
          ...aliases,
          ...(resource?.identity_aliases || resource?.identityAliases || []),
        ].map(value => String(value || "").trim()).filter(value => value && value !== id))],
        routeSource: source,
        routeResourceKey: String(resource?.key || ""),
        routeRole: String(resource?.role || ""),
        sourceIndex: Number(resource?.index),
        media_index: Number(resource?.index),
      });
    }
    return restored;
  }

  async function restoreHistoricalFilePool(
    route = {},
    {
      messages = [],
      restoreUserAttachmentsFromContext,
      isImageFile = defaultIsImageFile,
      source = "history",
    } = {},
  ) {
    const required = routeMediaResources(route, "file", source);
    if (!required.length) return [];
    if (typeof restoreUserAttachmentsFromContext !== "function") {
      throw new TypeError("Historical file restoration service is unavailable");
    }
    const requiredIds = new Set(
      required
        .flatMap((resource) => [
          resource.id,
          ...(resource.identity_aliases || []),
        ])
        .map((value) => String(value || ""))
        .filter(Boolean),
    );
    const requiredIndexes = new Set(
      required
        .map((resource) => Number(resource.index))
        .filter((index) => Number.isInteger(index) && index >= 1),
    );
    const restoredPool = [];
    let candidateIndex = 0;

    for (
      let messageIndex = (Array.isArray(messages) ? messages.length : 0) - 1;
      messageIndex >= 0;
      messageIndex -= 1
    ) {
      const message = messages[messageIndex];
      if (message?.role !== "user") continue;
      const context = parseContextValue(
        message.attachmentContext || message.attachment_context,
      );
      const metadata = (
        Array.isArray(context?.attachments) ? context.attachments : []
      ).filter((item) => !isImageFile(item));
      if (!metadata.length) continue;
      const candidates = metadata.map((item, index) => ({
        item,
        localIndex: index,
        candidateIndex: ++candidateIndex,
        id: mediaIdentity(item, "file"),
      }));
      const selected = candidates.filter(
        (candidate) =>
          requiredIds.has(candidate.id) ||
          (!requiredIds.size && requiredIndexes.has(candidate.candidateIndex)),
      );
      if (!selected.length) continue;
      const restored = (
        await restoreUserAttachmentsFromContext(context)
      ).filter((item) => !isImageFile(item));
      for (const candidate of selected) {
        const exact = restored.filter(
          (item) =>
            mediaIdentity(item, "file") &&
            mediaIdentity(item, "file") === candidate.id,
        );
        const attachment =
          exact.length === 1
            ? exact[0]
            : !candidate.id
              ? restored[candidate.localIndex]
              : null;
        if (!attachment) continue;
        restoredPool.push({
          ...attachment,
          attachmentId: mediaIdentity(attachment, "file") || candidate.id,
          routeSource: source,
          sourceIndex: candidate.candidateIndex,
          routeMessageIndex: messageIndex + 1,
        });
      }
    }
    return restoredPool;
  }

  const api = Object.freeze({
    parseContextValue,
    escapeHtml,
    previewQuoteText,
    withPendingQuotePreview,
    originalImageIndex,
    imageAttachmentIndexGuide,
    buildMediaMapContext,
    messageIdentity,
    imageReferenceFromItem,
    buildQuotedRouteContext,
    projectRouteMessageContext,
    projectRouteExecutionMedia,
    mediaIdentity,
    mergeContinuationAttachments,
    partitionExecutionAttachmentsBySource,
    decorateExecutionPool,
    buildExecutionResourcePools,
    routeMediaResources,
    restoreBoundImagePool,
    restoreHistoricalFilePool,
  });

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.ChatUISubmitWorkflowHelpers = api;
  if (root?.window) root.window.ChatUISubmitWorkflowHelpers = api;
})(
  typeof globalThis !== "undefined"
    ? globalThis
    : typeof window !== "undefined"
      ? window
      : this,
);
