(function initChatUIAppImageCaptionWorkflow(root) {
  'use strict';

  // Generated images get short internal tags so later questions can reference
  // a specific image by content ("把那只猫改成…"). Tags are derived WITHOUT
  // looking at the returned image: the configured chat model summarizes the
  // generation prompt that produced each image, so no image pixels are ever
  // sent upstream. The pass is best-effort and runs fully in the background:
  // it never blocks the visible image result and uses a generous timeout
  // because it is silent to the user. Tags are stored on the image record for
  // routing only and are never rendered in the chat UI.

  const chatService = root?.ChatUIChatService
    || root?.ChatUIServices?.chat
    || (typeof require === 'function' ? require('../services/chat-service') : {});

  const MAX_CAPTION_IMAGES = 8;
  const DEFAULT_TIMEOUT_MS = 15000;
  const MAX_DESCRIPTION_LENGTH = 120;

  // Refusals and "I cannot help" answers are not tags. Detecting them up front
  // keeps a broken summarization call from labeling every image with an
  // apology.
  const REFUSAL_PATTERNS = [
    /(?:抱歉|不好意思|无法|不能|拒绝|没有图片|不支持)/,
    /(?:sorry|unable|cannot|can't|could not|refuse|no image|do not see)/i,
  ];

  function looksLikeRefusal(text = '') {
    const raw = String(text || '');
    return REFUSAL_PATTERNS.some(pattern => pattern.test(raw));
  }

  function normalizeCaptionText(value = '') {
    return String(value || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, MAX_DESCRIPTION_LENGTH);
  }

  // Strip the leading "1." / "1、" / "图1：" / "第1张：" prefixes the model tends
  // to add when it numbers each line.
  function cleanCaptionLine(line = '') {
    return normalizeCaptionText(
      String(line || '')
        .replace(/^\s*(?:\d+|[一二三四五六七八九十百]+)\s*[.．、:：)）]\s*/, '')
        .replace(/^(?:图\s*)?(?:\d+|[一二三四五六七八九十百]+)\s*[.．、:：)）]\s*/, '')
        .replace(/^第\s*(?:\d+|[一二三四五六七八九十百]+)\s*张(?:图片|图)?\s*[.．:：)）]\s*/, '')
        .trim(),
    );
  }

  // One short tag per image, in order. Tags are summarized from the generation
  // prompts only, so the model never receives image pixels. The strict
  // per-line contract is what lets parseImageCaptionResponse map model output
  // back to image ordinals.
  function buildImageCaptionMessages({ images = [], language = '' } = {}) {
    const list = (Array.isArray(images) ? images : [])
      .map(item => String(item?.prompt || item?.revisedPrompt || '').trim())
      .filter(Boolean)
      .slice(0, MAX_CAPTION_IMAGES);
    if (!list.length) return [];
    const languageHint = normalizeCaptionText(language);
    const instruction = [
      '以下是生成图片时使用的提示词。请按顺序为每张图片给出一个简短的内容标签，例如：一只橘色小猫、一条金毛犬、雪山日出。',
      '要求：每张图片只输出一行，行首用图片序号加顿号或点号；只根据提示词总结画面内容，不描述画质、风格或提示词中不存在的内容；每行不超过 20 个字。',
      languageHint ? `使用${languageHint}回答。` : '',
      `共 ${list.length} 张：`,
    ].filter(Boolean).join('\n');
    const promptLines = list.map((prompt, index) => `${index + 1}. ${prompt}`).join('\n');
    return [
      { role: 'system', content: '你是图片内容标签助手。只根据生图提示词输出简短内容标签，不要编造提示词之外的内容。' },
      { role: 'user', content: `${instruction}\n${promptLines}` },
    ];
  }

  function parseChineseNumber(value = '') {
    const map = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
    const text = String(value || '').trim();
    if (!text) return 0;
    if (map[text] !== undefined) return map[text];
    if (text === '十') return 10;
    return 0;
  }

  function parseImageCaptionResponse(text = '', count = 1) {
    const raw = String(text || '').trim();
    if (!raw || looksLikeRefusal(raw)) return [];
    const expected = Math.max(1, Number(count) || 1);
    const lines = raw.split(/\r?\n/).map(line => cleanCaptionLine(line)).filter(Boolean);

    if (expected === 1) {
      const description = normalizeCaptionText(lines.length ? lines.join('；') : raw);
      return description ? [{ index: 1, description }] : [];
    }

    // Numbered contract: "1. 一只橘色小猫 / 2. 一条金毛犬".
    const numbered = [];
    for (const line of lines) {
      const match = String(line).match(/^\s*(?:图\s*)?(\d+|[一二三四五六七八九十百]+)\s*[.．、:：)）]/);
      const number = match ? (parseChineseNumber(match[1]) || Number(match[1]) || 0) : 0;
      const description = match ? normalizeCaptionText(line.slice(match[0].length)) : '';
      if (number >= 1 && number <= expected && description) numbered.push({ index: number, description });
    }
    if (numbered.length >= Math.ceil(expected / 2)) return numbered;

    // Positional fallback: one plain description per line, in order.
    return lines.slice(0, expected).map((description, index) => ({ index: index + 1, description }))
      .filter(item => item.description);
  }

  // Merge model-produced tags back onto stored image records. Records without
  // a matching tag are left untouched (prompt-derived description), so a
  // broken summarization call never rewrites existing metadata.
  function applyImageCaptions(images = [], captions = []) {
    const byOrdinal = new Map();
    for (const caption of Array.isArray(captions) ? captions : []) {
      const index = Number(caption?.index);
      const description = normalizeCaptionText(caption?.description);
      if (Number.isInteger(index) && index >= 1 && description) byOrdinal.set(index, description);
    }
    return (Array.isArray(images) ? images : []).map((item, index) => {
      const ordinal = Number(item?.ordinal || item?.sourceIndex) || index + 1;
      const tag = byOrdinal.get(ordinal);
      if (!tag) return { ...item };
      const originalLabels = Array.isArray(item?.labels) ? item.labels.map(String).filter(Boolean) : [];
      const labels = originalLabels.includes(tag) ? originalLabels : [tag, ...originalLabels].slice(0, 12);
      return {
        ...item,
        description: tag,
        label: tag,
        labels,
        semantic_text: [tag, String(item?.prompt || ''), ...labels].filter(Boolean).join(' | '),
      };
    });
  }

  function createImageCaptionWorkflow(deps = {}) {
    const requestJson = deps.requestJson;
    const buildResponsesPayload = deps.buildResponsesPayload || chatService.buildResponsesPayload;
    const getConfig = deps.getConfig || (() => ({}));
    const extractChatJobText = deps.extractChatJobText
      || (data => ({
        content: String(
          data?.choices?.[0]?.message?.content
          || data?.output_text
          || data?.text
          || data?.content
          || '',
        ),
      }));
    const timeoutMs = Number(deps.timeoutMs) > 0 ? Number(deps.timeoutMs) : DEFAULT_TIMEOUT_MS;

    async function describeGeneratedImages(images = [], options = {}) {
      const config = getConfig();
      if (options.enabled === false || config.captionGeneratedImages === false) return [];
      const baseUrl = String(options.baseUrl || config?.baseUrl || '').replace(/\/+$/, '');
      const model = String(options.model || config?.chatModel || '').trim();
      if (!baseUrl || !model) return [];
      const list = (Array.isArray(images) ? images : []).filter(Boolean).slice(0, MAX_CAPTION_IMAGES);
      if (!list.length) return [];
      const messages = buildImageCaptionMessages({
        images: list.map(item => ({
          prompt: String(item?.revisedPrompt || item?.prompt || options?.prompt || '').trim(),
        })),
        language: options.language || '',
      });
      if (!messages.length) return [];
      if (typeof buildResponsesPayload !== 'function') return [];
      const payload = buildResponsesPayload(model, messages, { stream: false, temperature: 0 });
      const url = `${baseUrl}/responses`;
      const optionTimeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : timeoutMs;
      let controller = null;
      let timer = null;
      if (typeof AbortController === 'function') {
        controller = new AbortController();
        timer = setTimeout(() => controller.abort(), optionTimeoutMs);
        if (options.signal) {
          if (options.signal.aborted) controller.abort();
          else if (typeof options.signal.addEventListener === 'function') {
            options.signal.addEventListener('abort', () => controller.abort(), { once: true });
          }
        }
      }
      try {
        if (typeof requestJson !== 'function') return [];
        const data = await requestJson(url, payload, String(options.apiKey ?? config?.apiKey ?? ''), {
          method: 'POST',
          headers: options.headers || {},
          signal: controller ? controller.signal : options.signal,
          requestPurpose: 'background_image_tag',
        });
        const text = String(extractChatJobText(data)?.content || '').trim();
        return parseImageCaptionResponse(text, list.length);
      } catch {
        return [];
      } finally {
        if (timer) clearTimeout(timer);
      }
    }

    return Object.freeze({
      describeGeneratedImages,
      buildImageCaptionMessages,
      parseImageCaptionResponse,
      applyImageCaptions,
    });
  }

  const api = Object.freeze({
    createImageCaptionWorkflow,
    buildImageCaptionMessages,
    parseImageCaptionResponse,
    applyImageCaptions,
    MAX_CAPTION_IMAGES,
    DEFAULT_TIMEOUT_MS,
  });

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.ChatUIAppImageCaptionWorkflow = api;
  if (root?.window) root.window.ChatUIAppImageCaptionWorkflow = api;
  root?.[Symbol.for('chatui.module-registry.v1')]?.get('moduleRegistry')?.register?.('imageCaptionWorkflow', api);
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
