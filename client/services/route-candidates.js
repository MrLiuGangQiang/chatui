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

  const api = Object.freeze({ createRouteCandidateDirectory });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root?.[Symbol.for('chatui.module-registry.v1')]?.get('moduleRegistry')?.register('routeCandidates', api);
})(typeof globalThis !== 'undefined' ? globalThis : this);
