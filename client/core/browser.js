(function () {
  function normalizeError(error, payload) {
    return payload && payload.error && payload.error.message
      ? payload.error.message
      : payload && payload.error && payload.error.code
        ? payload.error.code
        : payload && payload.message
          ? payload.message
          : payload && payload.raw
            ? payload.raw
            : error && error.message || '请求失败';
  }

  function toProxyUrl(url, baseUrl) {
    return String(url || '').startsWith(baseUrl) ? `/api${String(url).slice(String(baseUrl).length)}` : url;
  }

  async function parseResponseJson(response) {
    const text = await response.text();
    try { return text ? JSON.parse(text) : null; } catch { return { raw: text }; }
  }

  function normalizeReasoningText(value) {
    if (!value) return '';
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) return value.map(item => normalizeReasoningText(item && (item.text || item.content || item.summary || item.reasoning || item.thinking) || item)).filter(Boolean).join('\n');
    if (typeof value === 'object') return normalizeReasoningText(value.text || value.content || value.summary || value.reasoning || value.thinking || value.reasoning_content || value.thinking_content || value.reasoning_details || value.output_text || '');
    return String(value || '');
  }

  function extractStreamDelta(event) {
    const choice = event && event.choices && event.choices[0];
    const delta = choice && choice.delta || {};
    const message = choice && choice.message || {};
    const reasoning = normalizeReasoningText(delta.reasoning_content || delta.reasoning || delta.thinking || delta.reasoning_details || delta.thinking_content || message.reasoning_content || message.reasoning || message.thinking || message.reasoning_details || message.thinking_content || event && (event.reasoning_content || event.reasoning || event.thinking || event.reasoning_details || event.thinking_content) || '');
    let content = delta.content || message.content || (typeof (event && event.delta) === 'string' ? event.delta : '') || (typeof (event && event.content) === 'string' ? event.content : '') || '';
    if (!content && Array.isArray(event && event.output)) content = event.output.map(item => item && item.content && item.content.map(part => part && part.text || '').join('') || '').join('');
    const outputReasoning = !reasoning && Array.isArray(event && event.output) ? normalizeReasoningText(event.output.filter(item => /reason/i.test(String(item && (item.type || item.role) || '')) || item && (item.summary || item.reasoning || item.thinking))) : '';
    return { content, reasoning: reasoning || outputReasoning };
  }

  function reasoningBudgetTokens(level) {
    return { low: 1024, medium: 4096, high: 8192, xhigh: 16384 }[level || 'medium'] || 4096;
  }



  function normalizeModelType(type) {
    const value = String(type || '').trim().toLowerCase();
    if (!value) return '';
    if (/image|image_generation|image-generation|imagegeneration|vision|picture|img|dall|gpt-image|flux|sd|stable|midjourney|wan|kling/.test(value)) return 'image';
    if (/chat|text|llm|language|completion|reason|assistant|gpt|claude|gemini|qwen|deepseek|llama|mistral/.test(value)) return 'chat';
    if (/embedding|embed/.test(value)) return 'embedding';
    return value;
  }

  function inferModelType(model) {
    const explicit = model && typeof model !== 'string' ? normalizeModelType(model.type || model.model_type || model.modelType || model.mode || model.category || model.task || model.capability || (Array.isArray(model.capabilities) ? model.capabilities.join(',') : '')) : '';
    if (explicit) return explicit;
    const id = String(typeof model === 'string' ? model : model && (model.id || model.name) || '').toLowerCase();
    if (/embedding|embed/.test(id)) return 'embedding';
    if (/image|dall-e|gpt-image|imagen|flux|sdxl|midjourney|wan2\.?[0-9]?/.test(id)) return 'image';
    return '';
  }

  function extractModels(payload) {
    const data = Array.isArray(payload && payload.data) ? payload.data : Array.isArray(payload) ? payload : [];
    const meta = {};
    const models = [];
    data.forEach(item => {
      const id = typeof item === 'string' ? item : item && (item.id || item.name);
      if (!id) return;
      const modelId = String(id);
      const explicit = !!(item && typeof item !== 'string' && [item.type, item.model_type, item.modelType, item.mode, item.category, item.task, item.capability, Array.isArray(item.capabilities) ? item.capabilities.join(',') : ''].some(value => String(value || '').trim()));
      const type = inferModelType(item);
      meta[modelId] = { id: modelId, type, unrecognized: !explicit || !type, inferred: !explicit && !!type };
      models.push(modelId);
    });
    return { models: Array.from(new Set(models)).sort(), meta };
  }

  function isModelAllowedFor(modelId, targetType, meta) {
    const type = meta && meta[modelId] && meta[modelId].type || '';
    if (!type) return true;
    return targetType === 'image' ? type === 'image' : targetType !== 'chat' || type !== 'image';
  }



  function isImageFile(file) {
    const type = String(file && file.type || '').toLowerCase();
    const name = String(file && file.name || '').toLowerCase();
    return type.startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(name);
  }

  function isCompressibleRasterImage(file) {
    const type = String(file && file.type || '').toLowerCase();
    const name = String(file && file.name || '').toLowerCase();
    return /image\/(png|jpe?g|webp)/i.test(type) || /\.(png|jpe?g|webp)$/i.test(name);
  }

  function formatBytes(bytes) {
    const value = Number(bytes) || 0;
    if (value >= 1048576) return `${(value / 1024 / 1024).toFixed(1)}MB`;
    if (value >= 1024) return `${(value / 1024).toFixed(1)}KB`;
    return `${value}B`;
  }

  function looksLikeImageEditInstruction(text) {
    return /(换|替换|改|修改|编辑|调整|优化|重做|修|去掉|加上|放大|缩小|变成|换个|换成|logo|图标|背景|颜色|字体|样式|清晰|高清|edit|change|remove|replace|add)/i.test(String(text || ''));
  }

  function parseImageContext(value) {
    if (!value) return null;
    if (typeof value === 'object') return value;
    try { return JSON.parse(value); } catch { return null; }
  }

  window.ChatUICore = Object.freeze({
    http: Object.freeze({ normalizeError, toProxyUrl, parseResponseJson }),
    reasoning: Object.freeze({ normalizeReasoningText, extractStreamDelta, reasoningBudgetTokens }),
    models: Object.freeze({ normalizeModelType, inferModelType, extractModels, isModelAllowedFor }),
    attachments: Object.freeze({ isImageFile, isCompressibleRasterImage, formatBytes, looksLikeImageEditInstruction, parseImageContext }),
  });
})();
