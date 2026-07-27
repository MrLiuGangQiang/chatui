(function initChatUISubmitWorkflowHelpers(root) {
  "use strict";

  const executionResources =
    root?.ChatUICore?.executionResources ||
    (typeof require === "function"
      ? require("../core/execution-resources")
      : {});

  function parseContextValue(value) {
    if (!value) return null;
    if (typeof value === "string") {
      try {
        return JSON.parse(value);
      } catch {
        return null;
      }
    }
    return typeof value === "object" ? value : null;
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
    if (!images.length) return "";
    const rows = images.map((item, index) => ({
      sent: index + 1,
      source: originalIndex(item, index),
      id: item.imageId || item.image_id || item.id || "",
      name: item.name || item.file?.name || "",
    }));
    if (rows.every((row) => row.sent === row.source)) return "";
    return [
      "图片引用说明：本轮实际随附的图片可能只是原消息图片的一部分，用户说“第N张”时按原消息里的图片编号理解，不按当前随附图片顺序重新编号。",
      ...rows.map(
        (row) =>
          `- 当前随附图片${row.sent} = 原消息第${row.source}张${row.id ? `，image_id=${row.id}` : ""}${row.name ? `，文件名=${row.name}` : ""}`,
      ),
      "请按这个编号映射回答用户问题。",
    ].join("\n");
  }

  function messageIdentity(message = {}) {
    return String(
      message?.displayItemId || message?.id || message?.messageId || "",
    );
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
    messageIdentity,
    projectRouteMessageContext,
    projectRouteExecutionMedia,
    mediaIdentity,
    decorateExecutionPool,
    buildExecutionResourcePools,
    routeMediaResources,
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
