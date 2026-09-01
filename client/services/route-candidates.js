(function initChatUIRouteCandidates(root) {
  'use strict';

  function defaultCleanQuotedContent(text = '') {
    return String(text || '')
      .replace(/\[base64 image\]/gi, '')
      .replace(/耗时：[^\n]+/g, '')
      .replace(/RT\s+[^\n]+/gi, '')
      .replace(/TTFT\s+[^\n]+/gi, '')
      .replace(/^\[图片(?:生成|编辑|修改)完成\]\s*/g, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function createRouteCandidateDirectory({ intentContract = {}, cleanQuotedContent = defaultCleanQuotedContent } = {}) {
    function messageIdentity(message = {}) {
      return String(
        message?.display_item_id
        || message?.displayItemId
        || message?.id
        || message?.message_id
        || message?.messageId
        || '',
      );
    }

    function messageBody(message = {}) {
      const raw = Array.isArray(message?.content)
        ? message?.rawText || ''
        : message?.content || message?.rawText || '';
      const text = cleanQuotedContent(String(raw || '').trim())
        .replace(/\[quoted_image[^\]]*\]/gi, '')
        .replace(/\[quoted_message\]/gi, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
      return /^\[quoted_message\]$/i.test(text) ? '' : text;
    }

    function routeCandidateLabel(candidate = {}, raw = {}) {
      const normalize = value => String(value || '').replace(/\s+/g, ' ').trim();
      const unique = values => {
        const seen = new Set();
        return values.map(normalize).filter(value => {
          const fingerprint = value.toLocaleLowerCase();
          if (!value || seen.has(fingerprint)) return false;
          seen.add(fingerprint);
          return true;
        });
      };
      const filename = normalize(raw?.name || raw?.filename || candidate?.name || '');
      const descriptions = unique([
        raw?.description, raw?.semantic_description, raw?.semanticDescription,
        raw?.subject, raw?.label,
      ]);
      const labels = unique(Array.isArray(raw?.labels) ? raw.labels : []);
      const semanticParts = unique(String(raw?.semantic_text || '').split(/\s*\|\s*/));
      const promptParts = unique(String(raw?.prompt || '').split(/\s*\|\s*/));
      const isCurrentImage = candidate.type === 'image' && candidate.source === 'current';
      // A current upload's raw label may be the user's question rather than a
      // file label. Never replicate that instruction across every image.
      const preferred = candidate.type === 'file'
        ? [filename, ...descriptions]
        : isCurrentImage
          ? [filename, ...unique([raw?.description, raw?.semantic_description, raw?.semanticDescription, raw?.subject])]
          : [filename, ...descriptions, ...labels];
      const fallback = [...semanticParts, ...promptParts];
      const parts = unique((preferred.some(Boolean) ? preferred : fallback)).slice(0, 2);
      return (parts.join(' · ') || `${candidate.type || 'resource'} ${candidate.index || ''}`).slice(0, 120);
    }

    function routeCandidateSelectionText(candidate = {}, raw = {}) {
      const specific = [
        raw?.description, raw?.semantic_description, raw?.semanticDescription,
        raw?.subject, raw?.label,
        ...(Array.isArray(raw?.labels) ? raw.labels : []),
        raw?.name, raw?.filename,
      ].map(value => String(value || '').replace(/\s+/g, ' ').trim()).filter(Boolean);
      const fallback = [raw?.semantic_text, raw?.prompt, candidate?.label]
        .map(value => String(value || '').replace(/\s+/g, ' ').trim()).filter(Boolean);
      return (specific.length ? specific : fallback).join(' | ').slice(0, 720);
    }

    function buildRouteResourceCandidates({ attachments = [], context = {} } = {}) {
      const catalog = [];
      const addMedia = (type, prefix) => {
        const candidates = typeof intentContract?.mediaCandidates === 'function'
          ? intentContract.mediaCandidates(type, context, attachments)
          : [];
        const rawCandidates = Array.isArray(type === 'image' ? context?.image_candidates : context?.file_candidates)
          ? (type === 'image' ? context.image_candidates : context.file_candidates)
          : [];
        const rawAttachments = (Array.isArray(attachments) ? attachments : []).filter(item => {
          const mime = String(item?.type || item?.mime || '').toLowerCase();
          const isImage = item?.is_image === true || item?.isImage === true || mime.startsWith('image/');
          return (type === 'image') === isImage;
        });
        candidates.forEach((candidate, index) => {
          const contextualRaw = rawCandidates.find(item => {
            const id = String(type === 'image' ? item?.image_id || item?.imageId || '' : item?.file_id || item?.fileId || item?.id || '');
            const referenceId = String(item?.reference_id || item?.referenceId || '');
            return candidate.id && id === candidate.id
              || type === 'image' && candidate.referenceId && referenceId === candidate.referenceId && Number(item?.index) === Number(candidate.index)
              || Number(item?.index) === Number(candidate.index) && String(item?.source || '') === String(candidate.source || '');
          });
          const attachmentRaw = candidate.source === 'current' ? rawAttachments.find((item, attachmentIndex) => {
            const id = String(type === 'image'
              ? item?.image_id || item?.imageId || item?.id || item?.attachmentId || item?.attachment_id || ''
              : item?.file_id || item?.fileId || item?.id || item?.attachmentId || item?.attachment_id || '');
            const sourceIndex = Number(type === 'image'
              ? item?.media_index || item?.mediaIndex || item?.source_index || item?.sourceIndex
              : item?.source_index || item?.sourceIndex || item?.media_index || item?.mediaIndex) || attachmentIndex + 1;
            return candidate.id && id === candidate.id || sourceIndex === Number(candidate.sourceIndex);
          }) : null;
          const raw = contextualRaw || attachmentRaw || {};
          const catalogCandidate = {
            candidate_key: `${prefix}${index + 1}`,
            type,
            source: String(candidate.source || 'context'),
            index: Number(candidate.index),
            id: String(candidate.id || ''),
            reference_id: type === 'image' ? String(candidate.referenceId || '') : '',
            label: routeCandidateLabel({ ...candidate, type }, raw),
            filename: String(raw?.name || raw?.filename || candidate?.name || ''),
          };
          catalogCandidate.selection_text = routeCandidateSelectionText(catalogCandidate, raw);
          catalog.push(catalogCandidate);
        });
      };
      addMedia('image', 'i');
      addMedia('file', 'f');

      const quote = context?.quoted_message && typeof context.quoted_message === 'object' ? context.quoted_message : null;
      const quoteIndex = Number(quote?.index);
      const quoteId = messageIdentity(quote);
      const messages = typeof intentContract?.messageCandidates === 'function'
        ? intentContract.messageCandidates(context)
        : [];
      messages.forEach((candidate, index) => {
        const isQuote = Number.isInteger(quoteIndex)
          && quoteIndex >= 1
          && Number(candidate.index) === quoteIndex
          && (!quoteId || !candidate.id || String(candidate.id) === quoteId);
        const recent = (Array.isArray(context?.recent_messages) ? context.recent_messages : []).find(message => Number(message?.index) === Number(candidate.index));
        const raw = isQuote && quote ? { ...recent, ...quote } : recent || {};
        catalog.push({
          candidate_key: `m${index + 1}`,
          type: 'message',
          source: isQuote ? 'quoted' : 'history',
          index: Number(candidate.index),
          id: String(candidate.id || (isQuote ? quoteId : '')),
          reference_id: '',
          label: String(messageBody(raw) || `${candidate.role || 'message'} message ${candidate.index}`).replace(/\s+/g, ' ').slice(0, 240),
        });
      });
      return catalog;
    }

    function publicRouteResourceCandidates(catalog = []) {
      return catalog.map(candidate => ({
        candidate_key: candidate.candidate_key,
        type: candidate.type,
        source: candidate.source,
        label: candidate.label,
      }));
    }

    return Object.freeze({
      routeCandidateLabel,
      routeCandidateSelectionText,
      buildRouteResourceCandidates,
      publicRouteResourceCandidates,
      messageIdentity,
      messageBody,
    });
  }

  function createCanonicalCandidateDirectory({
    resourceIdentityModule = {},
    attachmentsModule = {},
    validResourceSources = ['current', 'quoted', 'history', 'context'],
    selectImageMemoryCards = () => ({ cards: [], metadata: null }),
    resourceCatalogMetadata = Symbol('chatui.resource-catalog-metadata'),
  } = {}) {
    const VALID_RESOURCE_SOURCES = new Set(validResourceSources || []);
    const RESOURCE_CATALOG_METADATA = resourceCatalogMetadata;

    function stringValue(value) {
      return String(value ?? '').trim();
    }

    function identityValue(value = '') {
      if (typeof resourceIdentityModule?.scalarIdentityValue === 'function') {
        return resourceIdentityModule.scalarIdentityValue(value);
      }
      if (typeof value === 'string') return value.trim();
      if (typeof value === 'number' && Number.isFinite(value)) return String(value);
      if (typeof value === 'bigint') return String(value);
      return '';
    }

    function uniqueStrings(values = []) {
      const seen = new Set();
      const result = [];
      for (const value of values) {
        const normalized = stringValue(value);
        if (!normalized || seen.has(normalized)) continue;
        seen.add(normalized);
        result.push(normalized);
      }
      return result;
    }

    function uniqueIndexes(values = []) {
      return [...new Set(values.map(Number).filter(value => Number.isInteger(value) && value >= 1))];
    }

    function normalizedSource(value = '', fallback = 'context') {
      const source = stringValue(value);
      if (VALID_RESOURCE_SOURCES.has(source)) return source;
      if (source === 'uploaded' || source === 'user_message') return fallback === 'history' ? 'history' : 'current';
      if (source === 'previous' || source === 'assistant') return 'history';
      return VALID_RESOURCE_SOURCES.has(fallback) ? fallback : 'context';
    }

    function resourceTypeFor(item = {}) {
      const declared = stringValue(item?.resource_type || item?.resourceType || item?.type).toLowerCase();
      if (['image', 'file', 'message', 'text'].includes(declared)) return declared;
      const mime = stringValue(item?.mime || item?.type || item?.file?.type).toLowerCase();
      return item?.is_image === true || item?.isImage === true || mime.startsWith('image/') ? 'image' : 'file';
    }

    function firstIdentityValue(values = []) {
      for (const value of values) {
        const normalized = identityValue(value);
        if (normalized) return normalized;
      }
      return '';
    }

    function nativeResourceId(type = '', item = {}) {
      if (type === 'image') {
        return firstIdentityValue([item?.image_id, item?.imageId, item?.attachment_id, item?.attachmentId, item?.id]);
      }
      if (type === 'file') {
        return firstIdentityValue([item?.file_id, item?.fileId, item?.attachment_id, item?.attachmentId, item?.id]);
      }
      if (type === 'message') {
        return firstIdentityValue([item?.message_id, item?.messageId, item?.display_item_id, item?.displayItemId, item?.id]);
      }
      return identityValue(item?.id);
    }

    function canonicalResourceId(type = '', item = {}) {
      const canonical = resourceIdentityModule?.canonicalResourceId?.(type, item);
      if (canonical) return stringValue(canonical);
      const explicit = firstIdentityValue([item?.resource_id, item?.resourceId, item?.routeResourceId]);
      if (explicit.startsWith(`res:${type}:`)) return explicit;
      const nativeId = explicit || nativeResourceId(type, item);
      return nativeId ? `res:${type}:${encodeURIComponent(nativeId)}` : '';
    }

    function identityAliases(type = '', item = {}, resourceId = '', nativeId = '') {
      const tokens = resourceIdentityModule?.identityTokens?.(item, type) || [];
      return uniqueStrings([
        ...tokens,
        nativeId,
        resourceId,
        ...(Array.isArray(item?.identity_aliases) ? item.identity_aliases : []),
        ...(Array.isArray(item?.identityAliases) ? item.identityAliases : []),
        ...(Array.isArray(item?.routeIdAliases) ? item.routeIdAliases : []),
        ...(Array.isArray(item?.route_id_aliases) ? item.route_id_aliases : []),
      ]);
    }

    function candidateIndex(item = {}, fallback = 1) {
      // index is type-local presentation order. source_index is the position in
      // the mixed attachment list and must never replace image/file numbering.
      const index = Number(
        item?.route_index || item?.routeIndex
        || item?.media_index || item?.mediaIndex
        || item?.index
        || item?.source_index || item?.sourceIndex
        || fallback,
      );
      return Number.isInteger(index) && index >= 1 ? index : fallback;
    }

    function candidateAvailability(type = '', item = {}) {
      const declared = stringValue(item?.availability).toLowerCase();
      const unavailableReason = stringValue(
        item?.unavailable_reason || item?.unavailableReason || item?.unsupported_reason || item?.unsupportedReason,
      );
      const explicitlyUnavailable = declared === 'unavailable'
        || item?.available === false
        || item?.input_file_available === false
        || item?.inputFileAvailable === false;
      const unreadableFile = type === 'file'
        && item?.has_extracted_text === false
        && item?.input_file_available !== true
        && item?.inputFileAvailable !== true;
      const resolvedReason = unavailableReason
        || (item?.input_file_available === false || item?.inputFileAvailable === false
          ? 'file_content_unavailable'
          : unreadableFile ? 'file_text_unavailable' : '');
      return {
        availability: explicitlyUnavailable || unreadableFile ? 'unavailable' : 'available',
        unavailable_reason: resolvedReason,
      };
    }

    function candidateLabel(type = '', item = {}, fallbackIndex = 1) {
      const rawSource = stringValue(item?.route_source || item?.routeSource || item?.source);
      const source = normalizedSource(rawSource, 'context');
      const isUploadedImage = type === 'image' && (
        source === 'current'
        || rawSource === 'user_message'
        || rawSource === 'uploaded'
        || stringValue(item?.target) === 'uploaded'
      );
      // An uploaded image label describes that one resource. The turn prompt may
      // remain in semantic_text for retrieval, but it must never become the
      // public label shared by every image in the turn.
      if (isUploadedImage) {
        const sharedLabel = typeof attachmentsModule?.imageAttachmentLabel === 'function'
          ? attachmentsModule.imageAttachmentLabel(item, fallbackIndex)
          : '';
        if (sharedLabel) return stringValue(sharedLabel).slice(0, 240);
        const values = [item?.label, item?.description, item?.semantic_description,
          item?.semanticDescription, item?.subject, item?.name, item?.filename];
        const text = stringValue(values.find(value => stringValue(value).trim())).replace(/\s+/g, ' ');
        return (text || `第 ${fallbackIndex} 张上传图片`).slice(0, 240);
      }
      const values = [item?.label, item?.description, item?.semantic_description, item?.semanticDescription,
        item?.prompt, item?.name, item?.filename, item?.content];
      const text = stringValue(values.find(value => stringValue(value).trim())).replace(/\s+/g, ' ');
      return (text || (type === 'image' ? `第 ${fallbackIndex} 张图片` : `${type} ${fallbackIndex}`)).slice(0, 240);
    }

    function canonicalCandidate(type = '', item = {}, { source = 'context', index = 1 } = {}) {
      const resolvedSource = normalizedSource(
        item?.route_source || item?.routeSource || item?.source,
        source,
      );
      const resolvedIndex = candidateIndex(item, index);
      const nativeId = nativeResourceId(type, item);
      const resourceId = canonicalResourceId(type, item);
      if (type !== 'text' && !resourceId) return null;
      const availability = candidateAvailability(type, item);
      const referenceId = type === 'image'
        ? stringValue(item?.reference_id || item?.referenceId)
        : '';
      return {
        candidate_key: '',
        type,
        source: resolvedSource,
        index: resolvedIndex,
        source_index: resolvedIndex,
        message_index: Number(item?.message_index || item?.messageIndex) || (type === 'message' ? resolvedIndex : 0),
        id: nativeId,
        resource_id: resourceId,
        reference_id: referenceId,
        identity_aliases: identityAliases(type, item, resourceId, nativeId),
        index_aliases: uniqueIndexes([
          resolvedIndex,
          item?.index,
          item?.source_index,
          item?.sourceIndex,
          item?.media_index,
          item?.mediaIndex,
        ]),
        label: candidateLabel(type, item, resolvedIndex),
        filename: stringValue(item?.name || item?.filename || item?.file?.name),
        prompt: stringValue(item?.prompt),
        description: stringValue(item?.description || item?.semantic_description || item?.semanticDescription),
        semantic_text: stringValue(item?.semantic_text || item?.semanticText),
        labels: uniqueStrings(Array.isArray(item?.labels) ? item.labels : []),
        operation: stringValue(item?.operation || item?.mode),
        parent_reference_id: stringValue(item?.parent_reference_id || item?.parentReferenceId),
        parent_image_ids: uniqueStrings(item?.parent_image_ids || item?.parentImageIds || []),
        memory_index: Number(item?.memory_index || item?.memoryIndex) || 0,
        chronological_index: Number(item?.chronological_index || item?.chronologicalIndex) || 0,
        generation_index: Number(item?.generation_index || item?.generationIndex) || 0,
        generation_recency_index: Number(item?.generation_recency_index || item?.generationRecencyIndex) || 0,
        generation_image_index: Number(item?.generation_image_index || item?.generationImageIndex) || 0,
        generation_image_count: Number(item?.generation_image_count || item?.generationImageCount) || 0,
        memory_retrieval: stringValue(item?.memory_retrieval || item?.memoryRetrieval),
        target: stringValue(item?.target),
        role: stringValue(item?.role),
        availability: availability.availability,
        unavailable_reason: availability.unavailable_reason,
      };
    }

    function mergeCandidate(existing = {}, incoming = {}) {
      return {
        ...existing,
        id: existing.id || incoming.id,
        reference_id: existing.reference_id || incoming.reference_id,
        label: existing.label || incoming.label,
        filename: existing.filename || incoming.filename,
        prompt: existing.prompt || incoming.prompt,
        description: existing.description || incoming.description,
        semantic_text: existing.semantic_text || incoming.semantic_text,
        labels: uniqueStrings([...(existing.labels || []), ...(incoming.labels || [])]),
        operation: existing.operation || incoming.operation,
        parent_reference_id: existing.parent_reference_id || incoming.parent_reference_id,
        parent_image_ids: uniqueStrings([...(existing.parent_image_ids || []), ...(incoming.parent_image_ids || [])]),
        memory_index: existing.memory_index || incoming.memory_index || 0,
        chronological_index: existing.chronological_index || incoming.chronological_index || 0,
        generation_index: existing.generation_index || incoming.generation_index || 0,
        generation_recency_index: existing.generation_recency_index || incoming.generation_recency_index || 0,
        generation_image_index: existing.generation_image_index || incoming.generation_image_index || 0,
        generation_image_count: existing.generation_image_count || incoming.generation_image_count || 0,
        memory_retrieval: existing.memory_retrieval || incoming.memory_retrieval || '',
        target: existing.target || incoming.target,
        role: existing.role || incoming.role,
        index: Math.min(Number(existing.index) || Number.MAX_SAFE_INTEGER, Number(incoming.index) || Number.MAX_SAFE_INTEGER),
        source_index: Math.min(Number(existing.source_index) || Number.MAX_SAFE_INTEGER, Number(incoming.source_index) || Number.MAX_SAFE_INTEGER),
        message_index: Number(existing.message_index) || Number(incoming.message_index) || 0,
        availability: existing.availability === 'available' || incoming.availability === 'available' ? 'available' : 'unavailable',
        unavailable_reason: existing.unavailable_reason || incoming.unavailable_reason || '',
        identity_aliases: uniqueStrings([...(existing.identity_aliases || []), ...(incoming.identity_aliases || [])]),
        index_aliases: uniqueIndexes([...(existing.index_aliases || []), ...(incoming.index_aliases || [])]),
      };
    }

    // Current-turn attachments are the highest-priority resource evidence.
    // Historical media/messages remain available only when the current input
    // explicitly points back to history, or when the requested resource type is
    // absent from the current turn and must be recovered from history. This
    // prevents a first route attempt from making the model choose between a
    // current upload and unrelated old candidates.
    const EXPLICIT_IMAGE_REFERENCE_PATTERN = /图|图片|照片|画|生成|编辑|修改|改|换|调|修|加|去|删|变|第\s*[0-9一二两三四五六七八九十百千万]+\s*(?:张|幅|个|次)|哪张|这张|那张|这些图|那些图|image|photo/i;
    const EXPLICIT_HISTORY_REFERENCE_PATTERN = /上一张|上一条|之前的?|此前的?|以前的?|刚才的?|上次的?|前面的?|上面的?|前文|上文|上一轮|历史|引用的?|previous|last|earlier|history/i;
    const IMAGE_RESOURCE_INPUT_PATTERN = /图|图片|照片|截图|图表|监控图|image|photo|picture/i;
    const FILE_RESOURCE_INPUT_PATTERN = /文件|文档|合同|报告|pdf|表格|附件|file|document|report/i;
    // After a long text-only topic, old generated images are no longer the
    // subject of an ambiguous follow-up. Only a recent image result (within a
    // few turns) remains a legitimate visual target without explicit wording.
    const STALE_IMAGE_TURN_GAP = 4;

    function historicalImageCandidatesRelevant(context = {}, input = '') {
      const focusKind = String(context?.conversation_focus?.kind || '').trim();
      if (focusKind === 'image') return true;
      if (focusKind !== 'text') return true;
      const text = String(input || '').trim();
      if (!text) return true;
      if (EXPLICIT_IMAGE_REFERENCE_PATTERN.test(text)) return true;
      const candidates = Array.isArray(context?.image_candidates) ? context.image_candidates : [];
      if (candidates.some(candidate => ['current', 'quoted'].includes(candidate?.source))) return true;
      let latestHistoryIndex = 0;
      for (const message of Array.isArray(context?.recent_messages) ? context.recent_messages : []) {
        const index = Number(message?.index);
        if (Number.isInteger(index) && index > latestHistoryIndex) latestHistoryIndex = index;
      }
      let latestImageIndex = 0;
      for (const candidate of candidates) {
        const index = Number(candidate?.message_index);
        if (Number.isInteger(index) && index > latestImageIndex) latestImageIndex = index;
      }
      return latestHistoryIndex - latestImageIndex <= STALE_IMAGE_TURN_GAP;
    }

    const CHINESE_ORDINAL_DIGITS = Object.freeze({
      一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
    });

    function ordinalValue(token = '') {
      if (/^[0-9]+$/.test(token)) return Number(token);
      const chars = [...String(token)];
      if (chars.length === 1) return CHINESE_ORDINAL_DIGITS[token] || 0;
      if (chars[0] === '十') return 10 + (CHINESE_ORDINAL_DIGITS[chars[1]] || 0);
      if (chars[chars.length - 1] === '十') return (CHINESE_ORDINAL_DIGITS[chars[0]] || 0) * 10;
      if (chars.length === 3 && chars[1] === '十') {
        return (CHINESE_ORDINAL_DIGITS[chars[0]] || 0) * 10 + (CHINESE_ORDINAL_DIGITS[chars[2]] || 0);
      }
      return 0;
    }

    // A bare image ordinal ("第2张") names an image by position. When the
    // ordinal counts past the images attached to the current turn, the referent
    // cannot live in the current turn and must be recovered from history.
    function imageOrdinalBeyondCurrentTurn(text = '', currentImageCount = 0) {
      const match = String(text || '').match(/第\s*([0-9]+|[一二两三四五六七八九十]+)\s*(?:张|幅)/i);
      if (!match) return false;
      const value = ordinalValue(match[1]);
      return Number.isSafeInteger(value) && value > 0 && value > currentImageCount;
    }

    function buildResourceCandidates(attachments = [], context = {}, input = '', options = {}) {
      const candidates = [];
      const byIdentityAndSource = new Map();
      const add = (type, item, fallback) => {
        const candidate = canonicalCandidate(type, item, fallback);
        if (!candidate) return;
        const dedupeKey = `${type}|${candidate.source}|${candidate.resource_id}`;
        let existingIndex = byIdentityAndSource.get(dedupeKey);
        // Restored image cards can carry a new durable id while retaining an
        // explicit identity alias from the original card. Treat those as one
        // candidate. reference_id is deliberately excluded: it identifies a
        // result group/lineage and is legitimately shared by sibling images.
        if (existingIndex === undefined) {
          const incomingIds = new Set([candidate.resource_id, candidate.id, ...(candidate.identity_aliases || [])].filter(Boolean));
          existingIndex = candidates.findIndex(existing => {
            if (existing.type !== type || existing.source !== candidate.source) return false;
            const existingIds = [existing.resource_id, existing.id, ...(existing.identity_aliases || [])].filter(Boolean);
            return existingIds.some(id => incomingIds.has(id));
          });
        }
        if (existingIndex !== undefined && existingIndex >= 0) {
          candidates[existingIndex] = mergeCandidate(candidates[existingIndex], candidate);
          byIdentityAndSource.set(dedupeKey, existingIndex);
          return;
        }
        byIdentityAndSource.set(dedupeKey, candidates.length);
        candidates.push(candidate);
      };

      (Array.isArray(attachments) ? attachments : []).forEach((item, index) => {
        const type = resourceTypeFor(item);
        if (!['image', 'file'].includes(type)) return;
        add(type, item, {
          source: normalizedSource(item?.route_source || item?.routeSource || item?.source, 'current'),
          index: candidateIndex(item, index + 1),
        });
      });

      const text = String(input || '').trim();
      const contextMediaCandidates = [
        ...(Array.isArray(context?.image_candidates) ? context.image_candidates : []),
        ...(Array.isArray(context?.file_candidates) ? context.file_candidates : []),
      ];
      const currentImageCount = candidates.filter(candidate => candidate?.type === 'image' && candidate?.source === 'current').length
        + contextMediaCandidates.filter(candidate => candidate?.type === 'image' && candidate?.source === 'current').length;
      const currentFileCount = candidates.filter(candidate => candidate?.type === 'file' && candidate?.source === 'current').length
        + contextMediaCandidates.filter(candidate => candidate?.type === 'file' && candidate?.source === 'current').length;
      const hasCurrentTurnMedia = currentImageCount + currentFileCount > 0;
      const explicitHistoricalReference = EXPLICIT_HISTORY_REFERENCE_PATTERN.test(text);
      const allowHistoricalResources = !hasCurrentTurnMedia || explicitHistoricalReference;
      const allowHistoricalImages = allowHistoricalResources
        || imageOrdinalBeyondCurrentTurn(text, currentImageCount)
        || (currentImageCount === 0 && IMAGE_RESOURCE_INPUT_PATTERN.test(text));
      const allowHistoricalFiles = allowHistoricalResources
        || (currentFileCount === 0 && FILE_RESOURCE_INPUT_PATTERN.test(text));
      const directImageCandidates = (Array.isArray(context?.image_candidates) ? context.image_candidates : [])
        .filter(item => {
          const source = String(item?.source || item?.route_source || '').trim();
          if (source === 'current' || source === 'quoted') return true;
          return allowHistoricalImages && historicalImageCandidatesRelevant(context, input);
        });
      directImageCandidates.forEach((item, index) => {
        add('image', item, { source: normalizedSource(item?.source, 'history'), index: index + 1 });
      });
      const includeAllImageMemoryCards = options?.includeAllImageMemoryCards === true;
      const allMemoryCards = Array.isArray(context?.image_memory_cards) ? context.image_memory_cards : [];
      const memorySelection = includeAllImageMemoryCards
        ? {
          cards: allMemoryCards.filter(candidate => candidate?.type === 'image')
            .map(candidate => ({ ...candidate, memory_retrieval: 'clarification' })),
          metadata: null,
        }
        : allowHistoricalImages
          ? selectImageMemoryCards(input, allMemoryCards, context, candidates)
          : { cards: [], metadata: null };
      memorySelection.cards.forEach((item, index) => {
        add('image', item, { source: normalizedSource(item?.source, 'history'), index: Number(item?.memory_index) || index + 1 });
      });
      (Array.isArray(context?.file_candidates) ? context.file_candidates : []).forEach((item, index) => {
        const source = String(item?.source || item?.route_source || '').trim();
        if (source !== 'current' && source !== 'quoted' && !allowHistoricalFiles) return;
        add('file', item, { source: normalizedSource(item?.source, 'history'), index: index + 1 });
      });

      const quote = context?.quoted_message && typeof context.quoted_message === 'object'
        ? context.quoted_message
        : null;
      const quoteId = quote ? canonicalResourceId('message', quote) : '';
      const quoteIndex = Number(quote?.index);
      (Array.isArray(context?.recent_messages) ? context.recent_messages : []).forEach((message, index) => {
        const messageId = canonicalResourceId('message', message);
        const isQuote = !!quote && (
          quoteId && messageId && quoteId === messageId
          || Number.isInteger(quoteIndex) && quoteIndex >= 1 && quoteIndex === Number(message?.index || index + 1)
        );
        if (!isQuote && !allowHistoricalResources) return;
        add('message', message, { source: isQuote ? 'quoted' : 'history', index: Number(message?.index) || index + 1 });
      });
      if (quote && !candidates.some(candidate => candidate.type === 'message' && candidate.source === 'quoted')) {
        add('message', quote, { source: 'quoted', index: Number(quote.index) || 1 });
      }

      const counters = { image: 0, file: 0, message: 0 };
      const catalog = candidates.map(candidate => ({
        ...candidate,
        candidate_key: `${candidate.type === 'image' ? 'i' : candidate.type === 'file' ? 'f' : 'm'}${++counters[candidate.type]}`,
      }));
      if (memorySelection?.metadata) {
        Object.defineProperty(catalog, RESOURCE_CATALOG_METADATA, {
          value: Object.freeze({
            schema_version: 'resource_catalog.v1',
            image_memory: memorySelection.metadata,
          }),
          enumerable: false,
        });
      }
      return catalog;
    }

    return Object.freeze({
      identityValue,
      uniqueStrings,
      uniqueIndexes,
      normalizedSource,
      resourceTypeFor,
      canonicalResourceId,
      candidateIndex,
      canonicalCandidate,
      mergeCandidate,
      buildResourceCandidates,
    });
  }

  const api = Object.freeze({ createRouteCandidateDirectory, createCanonicalCandidateDirectory });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root?.[Symbol.for('chatui.module-registry.v1')]?.get('moduleRegistry')?.register('routeCandidates', api);
})(typeof globalThis !== 'undefined' ? globalThis : this);
