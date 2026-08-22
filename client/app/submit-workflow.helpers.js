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
  const imageRouteContext =
    root?.ChatUICore?.imageRouteContext ||
    root?.ChatUICoreImageRouteContext ||
    (typeof require === "function"
      ? require("../core/image-route-context")
      : {});
  const storageCore =
    root?.ChatUICoreStorage ||
    (typeof require === "function"
      ? require("../core/storage")
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

  // A route reference is compiled from the compact route context, while the
  // final dispatch resolves it against the live session message. Both records
  // may carry more than one durable identifier (for example `id` plus a UI
  // `displayItemId`). Treat these as aliases rather than rejecting the message
  // because a different, still-valid alias happens to be first on one side.
  function messageIdentityAliases(message = {}) {
    const aliases = [
      message?.message_id,
      message?.messageId,
      message?.id,
      message?.display_item_id,
      message?.displayItemId,
    ].map(value => String(value || '').trim()).filter(Boolean);
    return [...new Set(aliases)];
  }

  function messageIdentity(message = {}) {
    return messageIdentityAliases(message)[0] || '';
  }

  function messageMatchesIdentity(message = {}, expectedIdentity = '') {
    const expected = String(expectedIdentity || '').trim();
    return !expected || messageIdentityAliases(message).includes(expected);
  }

  function messagesShareIdentity(left = {}, right = {}) {
    const leftAliases = new Set(messageIdentityAliases(left));
    return leftAliases.size > 0 && messageIdentityAliases(right).some(alias => leftAliases.has(alias));
  }

  function imageReferenceFromItem(item = {}) {
    const explicit = String(item?.referenceId || item?.reference_id || "");
    if (explicit) return explicit;
    const imageId = String(item?.imageId || item?.image_id || item?.id || "");
    return imageId.match(/^img_(imgref_.+)_\d+$/)?.[1] || "";
  }

  function isEllipticalFollowup(text = '') {
    const value = String(text || '').trim();
    return /^(?:这个呢|那个呢|然后呢|还有呢|再呢|这样呢|那样呢|然后|还有|接着|继续|what about|how about|and then|this one|that one)[?？]?$/i.test(value)
      || /^(?:这个|那个|它|他|她|它们|这些|那些)[呢啊呀]?[?？]?$/.test(value);
  }

  function deriveConversationContinuity({
    routeInfo = null,
    input = '',
    messages = [],
    currentMessageIndex = 0,
  } = {}) {
    const text = String(input || '').trim();
    const relation = String(
      routeInfo?.relation || 'new',
    ).trim();
    const contextualPrompt = String(routeInfo?.contextualImagePrompt || '').trim();
    if (contextualPrompt) {
      const index = contextualPrompt.lastIndexOf(text);
      const base = (index > 0 ? contextualPrompt.slice(0, index) : '')
        .replace(/\n{2,}/g, '\n')
        .trim();
      return {
        schema_version: 'conversation_continuity.v1',
        relation: relation || 'followup',
        anchor: base || text,
        inherited: !!base,
        source: base ? 'history' : 'current',
      };
    }
    const previousMessages = (Array.isArray(messages) ? messages : [])
      .slice(0, Number(currentMessageIndex) || 0)
      .filter(message => message?.role === 'user');
    let previous = null;
    for (let index = previousMessages.length - 1; index >= 0; index -= 1) {
      const message = previousMessages[index];
      const continuity = message?.conversation_continuity;
      if (continuity?.anchor) { previous = continuity; break; }
      const textValue = String(message?.rawText || message?.content || '').trim();
      if (textValue) { previous = { anchor: textValue, inherited: false, source: 'current', relation: 'new' }; break; }
    }
    if (!isEllipticalFollowup(text) || !previous?.anchor) {
      return {
        schema_version: 'conversation_continuity.v1',
        relation: relation || 'new',
        anchor: text,
        inherited: false,
        source: 'current',
      };
    }
    return {
      schema_version: 'conversation_continuity.v1',
      relation: relation || 'followup',
      anchor: previous.anchor,
      inherited: true,
      source: 'history',
    };
  }

  // Persist the exact read-only resource bindings on the originating user
  // turn. Candidate indexes are presentation locators, not durable conversation
  // scope, so the next route must inherit identities from executed resources
  // rather than rescan every historical attachment.
  function routeExecutionAnchor(route = {}) {
    const operation = String(route?.operationType || route?.dispatchContract?.operation || '').trim();
    const readOnlyResourceOperations = new Set([
      'image_qa', 'image_compare', 'ocr', 'file_qa', 'multimodal_qa',
    ]);
    if (!readOnlyResourceOperations.has(operation)) return null;

    const images = Array.isArray(route?.executionResources?.images)
      ? route.executionResources.images
      : [];
    const files = Array.isArray(route?.executionResources?.files)
      ? route.executionResources.files
      : [];
    if (!images.length && !files.length) return null;

    const imageBindings = images.map(resource => {
      const source = String(resource?.source || '').trim();
      const resourceId = String(resource?.resource_id || resource?.resourceId || '').trim();
      const imageId = String(resource?.image_id || resource?.imageId || resource?.id || '').trim();
      const referenceId = String(resource?.reference_id || resource?.referenceId || '').trim();
      const index = Number(resource?.index) || 0;
      return {
        source,
        ...(resourceId ? { resource_id: resourceId } : {}),
        ...(imageId ? { image_id: imageId } : {}),
        reference_id: referenceId,
        ...(index ? { index } : {}),
      };
    }).filter(binding => binding.source && (binding.resource_id || binding.image_id || binding.reference_id || binding.index));
    const fileBindings = files.map(resource => {
      const source = String(resource?.source || '').trim();
      const resourceId = String(resource?.resource_id || resource?.resourceId || '').trim();
      const fileId = String(resource?.file_id || resource?.fileId || resource?.id || '').trim();
      const index = Number(resource?.index) || 0;
      return {
        source,
        ...(resourceId ? { resource_id: resourceId } : {}),
        ...(fileId ? { file_id: fileId } : {}),
        ...(index ? { index } : {}),
      };
    }).filter(binding => binding.source && (binding.resource_id || binding.file_id || binding.index));
    if (imageBindings.length !== images.length || fileBindings.length !== files.length) return null;

    return Object.freeze({
      schema_version: 'route_execution_anchor.v1',
      operation,
      ...(imageBindings.length ? { image_bindings: Object.freeze(imageBindings) } : {}),
      ...(fileBindings.length ? { file_bindings: Object.freeze(fileBindings) } : {}),
    });
  }

  function composeContinuityPrompt(input = '', anchor = '') {
    const text = String(input || '').trim();
    const base = String(anchor || '').trim();
    return [
      base ? `补充问题来自以下原问题：${base}` : '',
      `本轮输入：${text}`,
      '本轮显式引用的对象或资源替换此前对象',
    ].filter(Boolean).join('\n\n');
  }

  function buildQuotedRouteContext({
    quotedMessage = null,
    quotedImageContext = null,
    restoredImageAttachments = [],
    quotedFileCandidates = [],
    currentInput = "",
    conversationContinuity = null,
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
        resource_id: String(quotedMessage?.resourceId || quotedMessage?.resource_id || ""),
        content: routeContent || "[quoted_message]",
      },
      recent_messages: [
        {
          index: 1,
          role: quotedMessage?.role || "user",
          id: messageIdentity(quotedMessage),
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
      ...(conversationContinuity && typeof conversationContinuity === 'object'
        ? { conversation_continuity: conversationContinuity }
        : {}),
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

  function mergeQuotedRouteContext(baseContext = {}, quotedContext = {}) {
    const base = baseContext && typeof baseContext === 'object' ? baseContext : {};
    const quoted = quotedContext && typeof quotedContext === 'object' ? quotedContext : {};
    const next = { ...base };
    for (const [key, value] of Object.entries(quoted)) {
      if (value === undefined || value === null) continue;
      if (Array.isArray(value) && value.length === 0 && Array.isArray(base[key]) && base[key].length) continue;
      next[key] = value;
    }
    const mergeCandidates = (left, right) => {
      const merged = [];
      const seen = new Set();
      for (const item of [...(Array.isArray(left) ? left : []), ...(Array.isArray(right) ? right : [])]) {
        if (!item || typeof item !== 'object') continue;
        const identity = String(
          item.resource_id || item.resourceId || item.image_id || item.imageId
          || item.file_id || item.fileId || item.id || `${item.source || ''}:${item.index || ''}:${item.filename || item.name || ''}`,
        );
        const key = `${item.source || ''}|${identity}`;
        if (seen.has(key)) continue;
        seen.add(key);
        merged.push(item);
      }
      return merged;
    };
    const baseRecent = Array.isArray(base.recent_messages) ? base.recent_messages : [];
    const quotedRecent = Array.isArray(quoted.recent_messages) ? quoted.recent_messages : [];
    next.recent_messages = baseRecent.length ? [...baseRecent] : [...quotedRecent];
    next.image_candidates = mergeCandidates(quoted.image_candidates, base.image_candidates);
    next.file_candidates = mergeCandidates(quoted.file_candidates, base.file_candidates);
    return next;
  }

  function projectRouteMessageContext(
    route = {},
    sessionMessages = [],
    explicitQuotedMessage = null,
  ) {
    const refs = Array.isArray(route?.messageRefs) ? route.messageRefs : [];
    if (!refs.length) return null;
    const source = Array.isArray(sessionMessages) ? sessionMessages : [];
    const selected = [];
    const seen = new Set();
    let usesExplicitQuote = false;

    for (const [selectionOrder, ref] of refs.entries()) {
      const refId = String(ref?.message_id || ref?.id || "");
      const refSource = String(ref?.source || "");
      const index = Number(ref?.index);
      let message = null;
      let conversationOrder = Number.isInteger(index) && index >= 1 ? index : Number.MAX_SAFE_INTEGER;
      if (
        explicitQuotedMessage &&
        refSource === 'quoted' &&
        messageMatchesIdentity(explicitQuotedMessage, refId)
      ) {
        message = explicitQuotedMessage;
        usesExplicitQuote = true;
        const quotedSessionIndex = source.findIndex(item => messagesShareIdentity(item, explicitQuotedMessage));
        if (quotedSessionIndex >= 0) conversationOrder = quotedSessionIndex + 1;
      } else if (Number.isInteger(index) && index >= 1) {
        message = source[index - 1] || null;
        if (message && !messageMatchesIdentity(message, refId)) message = null;
      }
      if (!message) return null;
      const key = refId || messageIdentity(message) || `index:${index}`;
      if (!seen.has(key)) {
        seen.add(key);
        selected.push({ message, conversationOrder, selectionOrder });
      }
    }

    selected.sort((left, right) => (
      left.conversationOrder - right.conversationOrder
      || left.selectionOrder - right.selectionOrder
    ));
    const messages = selected.map(item => item.message);
    return Object.freeze({
      messages,
      usesExplicitQuote,
      protectedMessageCount: messages.length,
    });
  }

  function buildExecutionPreviewText(route = {}, executionMedia = {}) {
    const operation = String(route?.operationType || route?.operation || '').trim();
    if (!['edit_image', 'image_reference_gen', 'text_to_image'].includes(operation)) return '';
    const candidates = operation === 'edit_image'
      ? (Array.isArray(executionMedia?.targets) ? executionMedia.targets : [])
      : (Array.isArray(executionMedia?.references) ? executionMedia.references : []);
    const labels = candidates.map((item, index) => String(
      item?.label || item?.description || item?.semantic_description || item?.semanticDescription
      || item?.prompt || item?.name || item?.filename || `第${index + 1}张图片`,
    ).replace(/\s+/g, ' ').trim().slice(0, 72)).filter(Boolean);
    const subject = labels.length === 1 ? labels[0] : labels.length ? labels.join('、') : '已选择的图片';
    const instruction = String(
      route?.editInstruction || route?.contextualImagePrompt || route?.executionPlan?.arguments?.prompt || '',
    ).replace(/\s+/g, ' ').trim().slice(0, 120);
    const verb = operation === 'edit_image' ? '将修改' : operation === 'image_reference_gen' ? '将参考' : '将生成';
    return `${verb}：${subject}${instruction && operation === 'edit_image' ? `；修改内容：${instruction}` : ''}`.slice(0, 220);
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

  // Dispatch projection is defined for executable routes only. A compiled image
  // batch is a planning envelope; its child routes own the canonical resource
  // projections and the parent must never be projected as a single execution.
  function projectRouteExecutionMediaForDispatch(route = {}, pools = {}) {
    if (typeof executableImageBatch === "function" && executableImageBatch(route)) return null;
    return projectRouteExecutionMedia(route, pools);
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

  // Only make resources that the canonical route explicitly declared available
  // to the execution projection. This is important for regenerate: restoring an
  // attachment from the original user turn must not make it an implicit
  // `current` binding when the replayed route is text-only.
  function restrictExecutionResourcePools(route = {}, sourcePools = {}) {
    const resources = [
      ...(Array.isArray(route?.executionResources?.images) ? route.executionResources.images : []),
      ...(Array.isArray(route?.executionResources?.files) ? route.executionResources.files : []),
    ];
    const declaredSources = new Set(resources
      .map(resource => String(resource?.source || '').trim())
      .filter(Boolean));
    const restricted = {};
    for (const source of ['current', 'quoted', 'history', 'context']) {
      restricted[source] = declaredSources.has(source)
        ? (Array.isArray(sourcePools?.[source]) ? sourcePools[source] : [])
        : [];
    }
    return restricted;
  }

  function buildExecutionResourcePools(sourcePools = {}, options = {}) {
    const isImageFile = options.isImageFile || defaultIsImageFile;
    const imagePools = {};
    const filePools = {};
    const messagePools = {};
    const sources = ["current", "quoted", "history", "context"];
    for (const source of sources) {
      const decorated = decorateExecutionPool(sourcePools[source], source, {
        isImageFile,
      });
      imagePools[source] = decorated.filter(isImageFile);
      filePools[source] = decorated.filter((item) => !isImageFile(item));
      messagePools[source] = [];
    }
    const messages = Array.isArray(options.messages) ? options.messages : [];
    for (const message of messages) {
      const declared = String(message?.routeSource || message?.source || 'history').trim();
      messagePools[sources.includes(declared) ? declared : 'history'].push(message);
    }
    return Object.freeze({ imagePools, filePools, messagePools });
  }

  function routeMediaResources(route = {}, type = "", source = "") {
    const resourceField = type === "image" ? "images" : "files";
    // A multi-image parent is only a planning envelope: it intentionally has no
    // executable resource projection. Restore the union of the independently
    // authorized child resources before projecting each child, otherwise a
    // valid iN reference resolves against an empty runtime pool at handoff.
    const childRoutes = route?.imagePlanCompiled?.kind === "batch"
      ? route.imagePlanCompiled.items.map(item => item?.route).filter(Boolean)
      : [];
    const routes = childRoutes.length ? childRoutes : [route];
    const resources = routes.flatMap(candidateRoute => {
      const list = candidateRoute?.executionResources?.[resourceField];
      return Array.isArray(list) ? list : [];
    }).filter(resource => !source || resource?.source === source);
    // Multiple batch children may deliberately bind the same source image.
    // Restore it once so execution projection never treats duplicated restored
    // objects as an ambiguous runtime resource.
    const seen = new Set();
    return resources.filter(resource => {
      const identity = [
        resource?.type,
        resource?.source,
        resource?.resource_id || resource?.resourceId || "",
        resource?.id || "",
        resource?.reference_id || resource?.referenceId || "",
        Number(resource?.index) || 0,
      ].map(value => String(value || "").trim()).join("\u0000");
      if (seen.has(identity)) return false;
      seen.add(identity);
      return true;
    });
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
      const id = String(resource?.id || resource?.resource_id || resource?.resourceId || "").trim();
      // The route contract may expose a native image-item id or its canonical
      // execution id. The historical-image service accepts native item ids in
      // its exact-id path; canonical ids must be decoded before crossing that
      // boundary, otherwise the selected image is restored as an empty pool.
      const exactImageId = /^img_imgref_.+_\d+$/.test(id)
        ? id
        : /^res:image:(.+)$/.test(id)
          ? (() => {
            try {
              const decoded = decodeURIComponent(id.slice('res:image:'.length));
              return /^img_imgref_.+_\d+$/.test(decoded) ? decoded : '';
            } catch { return ''; }
          })()
          : '';
      const candidates = exactImageId
        ? await getPreviousImageAttachments(sessionId, null, "", [exactImageId])
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
        // snake_case image metadata. Canonicalize every identity-bearing
        // field here, at restoration time, so projection cannot see the
        // recovered durable ID as a second, competing identity.
        imageId: exactImageId || recoveredId,
        image_id: exactImageId || recoveredId,
        attachmentId: exactImageId || recoveredId,
        attachment_id: exactImageId || recoveredId,
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
      const contextualMetadata = (
        Array.isArray(context?.attachments) ? context.attachments : []
      ).filter((item) => !isImageFile(item));
      const recoveredMetadata = typeof imageRouteContext.uploadedFileAttachmentsFromMessage === "function"
        ? imageRouteContext.uploadedFileAttachmentsFromMessage(message).filter((item) => !isImageFile(item))
        : [];
      const metadataById = new Map();
      for (const item of [...contextualMetadata, ...recoveredMetadata]) {
        const id = mediaIdentity(item, "file");
        const key = id || `${String(item?.name || "")}|${String(item?.type || "")}|${Number(item?.size) || 0}`;
        if (!key) continue;
        const existing = metadataById.get(key) || {};
        metadataById.set(key, { ...item, ...existing });
      }
      const metadata = [...metadataById.values()];
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
      const restorationContext = context && Array.isArray(context.attachments)
        ? { ...context, attachments: metadata }
        : { prompt: String(message.rawText || message.content || ""), attachments: metadata };
      const restored = (
        await restoreUserAttachmentsFromContext(restorationContext)
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

  // A compiled Stage 2 batch runs each child through the canonical single
  // image executor, so media-bearing children (edit/reference generation) are
  // supported. Every child must still carry its own validated dispatch
  // contract and execution projection; an incomplete child fails closed.
  function executableImageBatch(route = {}) {
    const compiled = route?.imagePlanCompiled;
    if (!compiled || compiled.kind !== 'batch'
        || !Array.isArray(compiled.items) || compiled.items.length <= 1) return null;
    return Object.freeze({ items: compiled.items, unsupported: null });
  }

  // Batch recovery needs a stable index plus one durable child per job so a
  // refresh can resume exactly the same provider jobs instead of re-planning
  // and re-dispatching the whole batch.
  const IMAGE_BATCH_VERSION = 'image_batch.v1';
  const IMAGE_BATCH_INDEX_PREFIX = 'openapi-chat-image-batch-v1';
  const IMAGE_BATCH_CHILD_PREFIX = 'openapi-chat-image-batch-child-v1';

  function imageBatchIndexKey(sessionId = '') {
    return `${IMAGE_BATCH_INDEX_PREFIX}:${sessionId || 'default'}`;
  }

  function imageBatchChildKey(sessionId = '', jobId = '') {
    return `${IMAGE_BATCH_CHILD_PREFIX}:${sessionId || 'default'}:${jobId || ''}`;
  }

  function normalizeImageBatchIndex(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    if (value.schema_version !== IMAGE_BATCH_VERSION
        || !String(value.batchId || '').trim()
        || !Array.isArray(value.children)
        || !value.children.length
        || value.children.some(child => !child || typeof child !== 'object'
          || !String(child.jobId || '').trim()
          || !String(child.prompt || '').trim())) return null;
    return {
      schema_version: IMAGE_BATCH_VERSION,
      batchId: String(value.batchId),
      submissionId: String(value.submissionId || ''),
      sessionId: String(value.sessionId || ''),
      startedAt: Number(value.startedAt) || 0,
      children: value.children.map(child => ({
        jobId: String(child.jobId),
        prompt: String(child.prompt),
        displayItemId: String(child.displayItemId || ''),
        responseIndex: String(child.responseIndex || ''),
        mode: String(child.mode || 'image'),
        status: String(child.status || 'running'),
        label: String(child.label || ''),
        ...(child.imageContext ? { imageContext: child.imageContext } : {}),
      })),
    };
  }

  function saveImageBatchIndex(storage, sessionId = '', value = {}) {
    if (typeof storageCore.safeSetJsonStorage !== 'function' || !storage) return false;
    return storageCore.safeSetJsonStorage(storage, imageBatchIndexKey(sessionId), value) === true;
  }

  function loadImageBatchIndex(storage, sessionId = '') {
    if (typeof storageCore.readJsonStorage !== 'function' || !storage) return null;
    return normalizeImageBatchIndex(storageCore.readJsonStorage(storage, imageBatchIndexKey(sessionId), null));
  }

  function clearImageBatchIndex(storage, sessionId = '') {
    try { storage?.removeItem?.(imageBatchIndexKey(sessionId)); return true; } catch { return false; }
  }

  function loadImageBatchChild(storage, sessionId = '', jobId = '') {
    if (typeof storageCore.readJsonStorage !== 'function' || !storage || !jobId) return null;
    const value = storageCore.readJsonStorage(storage, imageBatchChildKey(sessionId, jobId), null);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  }

  function clearImageBatchChild(storage, sessionId = '', jobId = '') {
    try { storage?.removeItem?.(imageBatchChildKey(sessionId, jobId)); return true; } catch { return false; }
  }

  // The parent index is a convenience pointer, not the only proof that a batch
  // exists. A refresh can interrupt an unrelated localStorage write, so every
  // child also carries enough ownership data to rebuild that pointer. This is
  // deliberately limited to the current session and to one persisted parent
  // card; it must never guess a batch from unrelated single-image jobs.
  function listImageBatchChildren(storage, sessionId = '') {
    if (!storage || typeof storage.key !== 'function') return [];
    const prefix = `${IMAGE_BATCH_CHILD_PREFIX}:${sessionId || 'default'}:`;
    const keys = [];
    try {
      const length = Math.max(0, Number(storage.length) || 0);
      for (let index = 0; index < length; index += 1) {
        const key = String(storage.key(index) || '');
        if (key.startsWith(prefix)) keys.push(key);
      }
    } catch { return []; }
    return keys.map(key => {
      const jobId = key.slice(prefix.length);
      const snapshot = loadImageBatchChild(storage, sessionId, jobId);
      return snapshot && typeof snapshot === 'object' ? { key, jobId, snapshot } : null;
    }).filter(Boolean);
  }

  function recoverImageBatchIndex(storage, sessionId = '', { batchId = '', displayItemId = '' } = {}) {
    const expectedBatchId = String(batchId || '').trim();
    const expectedDisplayItemId = String(displayItemId || '').trim();
    if (!expectedBatchId || !expectedDisplayItemId) return null;
    const children = listImageBatchChildren(storage, sessionId)
      .map(({ jobId, snapshot }) => ({ jobId, snapshot }))
      .filter(({ snapshot }) => String(snapshot.displayItemId || '').trim() === expectedDisplayItemId)
      .filter(({ snapshot }) => !snapshot.batchId || String(snapshot.batchId) === expectedBatchId)
      .filter(({ jobId, snapshot }) => String(snapshot.id || '') === jobId
        && String(snapshot.prompt || '').trim()
        && String(snapshot.requestPurpose || '') === 'final_execution');
    // A batch always has at least two children. Requiring that invariant is what
    // prevents this recovery path from taking ownership of an ordinary image job.
    if (children.length < 2) return null;
    const recovered = normalizeImageBatchIndex({
      schema_version: IMAGE_BATCH_VERSION,
      batchId: expectedBatchId,
      submissionId: String(children[0]?.snapshot?.submissionId || ''),
      sessionId: String(sessionId || ''),
      startedAt: Math.min(...children.map(({ snapshot }) => Math.max(0, Number(snapshot.startedAt) || Date.now()))),
      children: children.map(({ jobId, snapshot }) => ({
        jobId,
        prompt: String(snapshot.prompt),
        label: String(snapshot.label || ''),
        displayItemId: expectedDisplayItemId,
        responseIndex: String(snapshot.responseIndex ?? ''),
        mode: String(snapshot.mode || 'image'),
        status: String(snapshot.status || 'running'),
        ...(snapshot.imageContext ? { imageContext: snapshot.imageContext } : {}),
      })),
    });
    if (!recovered) return null;
    saveImageBatchIndex(storage, sessionId, recovered);
    return recovered;
  }

  // Concurrent image children share session message state. Their result
  // commits must be serialized so each child appends exactly one assistant
  // message without losing the concurrent writes of its siblings.
  function createSerialCommitQueue() {
    let chain = Promise.resolve();
    return Object.freeze({
      acquire() {
        let release;
        const previous = chain;
        chain = new Promise(resolve => { release = resolve; });
        return previous.then(() => release);
      },
    });
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
    deriveConversationContinuity,
    routeExecutionAnchor,
    composeContinuityPrompt,
    buildQuotedRouteContext,
    mergeQuotedRouteContext,
    projectRouteMessageContext,
    projectRouteExecutionMedia,
    projectRouteExecutionMediaForDispatch,
    executableImageBatch,
    createSerialCommitQueue,
    IMAGE_BATCH_VERSION,
    imageBatchIndexKey,
    imageBatchChildKey,
    normalizeImageBatchIndex,
    saveImageBatchIndex,
    loadImageBatchIndex,
    clearImageBatchIndex,
    loadImageBatchChild,
    clearImageBatchChild,
    listImageBatchChildren,
    recoverImageBatchIndex,
    buildExecutionPreviewText,
    mediaIdentity,
    mergeContinuationAttachments,
    partitionExecutionAttachmentsBySource,
    decorateExecutionPool,
    buildExecutionResourcePools,
    restrictExecutionResourcePools,
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
