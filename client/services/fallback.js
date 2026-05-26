(function () {
  const core = window.ChatUICore || {};
  const http = core.http || {};
  const reasoning = core.reasoning || {};
  const imageRouteContext = core.imageRouteContext || {};

  function parseJsonResponse(res) {
    const parse = http.parseResponseJson || (async response => {
      const text = await response.text();
      try { return text ? JSON.parse(text) : null; } catch { return { raw: text }; }
    });
    return parse(res);
  }

  function normalizeServiceError(err, payload) {
    const normalize = http.normalizeError || ((error, body) => body && body.error && body.error.message || error && error.message || '请求失败');
    return normalize(err, payload);
  }

  async function requestModels(options = {}) {
    const fetchImpl = options.fetchImpl || window.fetch.bind(window);
    const baseUrl = options.baseUrl || '';
    const apiKey = options.apiKey || '';
    if (!baseUrl) throw new Error('请先配置 Endpoint Base URL');
    let response;
    try {
      response = await fetchImpl('/api/models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ baseUrl, apiKey, query: {}, payload: {}, method: 'GET' }),
      });
    } catch (err) {
      throw new Error(`连接接口失败：${err && err.message || '网络请求失败'}`);
    }
    const payload = await parseJsonResponse(response);
    if (!response.ok) throw new Error(normalizeServiceError(null, payload));
    return payload;
  }

  function makeClientJobId(prefix) {
    return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }
  const makeClientImageJobId = () => makeClientJobId('imgjob');
  const makeClientChatJobId = () => makeClientJobId('chatjob');

  async function postJob(url, body, options = {}) {
    const response = await (options.fetchImpl || window.fetch.bind(window))(url, {
      method: 'POST',
      signal: options.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const payload = await parseJsonResponse(response);
    if (!response.ok) throw new Error(normalizeServiceError(null, payload));
    return payload;
  }

  async function startChatJob({ payload, config, jobId, headers = {}, signal, fetchImpl }) {
    return postJob('/api/chat-jobs', { jobId, baseUrl: config.baseUrl, apiKey: config.apiKey, payload, headers }, { signal, fetchImpl });
  }

  async function registerChatStreamJob({ payload, config, jobId, start = false, headers = {}, signal, fetchImpl }) {
    return postJob('/api/chat-stream-jobs', { jobId, baseUrl: config.baseUrl, apiKey: config.apiKey, payload, start, headers }, { signal, fetchImpl });
  }

  async function getJob({ url, fetchImpl }) {
    const response = await (fetchImpl || window.fetch.bind(window))(url);
    const payload = await parseJsonResponse(response);
    if (!response.ok) throw new Error(normalizeServiceError(null, payload));
    return payload;
  }

  async function startImageGenerationJob({ payload, config, jobId, mode = 'image', files = [], headers = {}, signal, onUploadProgress, fetchImpl }) {
    if (onUploadProgress) {
      return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', '/api/image-jobs');
        xhr.setRequestHeader('Content-Type', 'application/json');
        xhr.responseType = 'text';
        const abort = () => { try { xhr.abort(); } catch {} reject(new DOMException('已停止', 'AbortError')); };
        if (signal && signal.aborted) return abort();
        signal && signal.addEventListener('abort', abort, { once: true });
        xhr.upload.onprogress = event => event.lengthComputable && onUploadProgress(Math.round(event.loaded / event.total * 100), event.loaded, event.total);
        xhr.onload = async () => {
          signal && signal.removeEventListener('abort', abort);
          const payload = await parseJsonResponse({ text: async () => xhr.responseText });
          xhr.status >= 200 && xhr.status < 300 ? resolve(payload) : reject(new Error(normalizeServiceError(null, payload)));
        };
        xhr.onerror = () => { signal && signal.removeEventListener('abort', abort); reject(new Error('连接接口失败：网络请求失败')); };
        xhr.send(JSON.stringify({ jobId, baseUrl: config.baseUrl, apiKey: config.apiKey, payload, mode, files, headers }));
      });
    }
    return postJob('/api/image-jobs', { jobId, baseUrl: config.baseUrl, apiKey: config.apiKey, payload, mode, files, headers }, { signal, fetchImpl });
  }

  function normalizeText(value) {
    if (!value) return '';
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) return value.map(item => normalizeText(item && (item.text || item.content || item.output_text || item.message || item.delta) || item)).filter(Boolean).join('');
    if (typeof value === 'object') {
      const output = Array.isArray(value.output) ? value.output.filter(item => !/reason/i.test(String(item && (item.type || item.role) || ''))) : '';
      return normalizeText(value.text || value.content || value.output_text || value.message || value.delta || value.response || output || '');
    }
    return String(value || '');
  }

  function extractChatJobText(data) {
    const message = data && data.choices && data.choices[0] && data.choices[0].message || {};
    return {
      content: normalizeText(message.content || message.text || message.output_text || data && (data.output_text || data.content || data.text || data.message || data.response || data.output) || ''),
      reasoning: message.reasoning_content || message.reasoning || data && data.reasoning_content || data && data.reasoning || '',
      firstTokenMs: Number.isFinite(data && data.metrics && data.metrics.firstTokenMs) ? data.metrics.firstTokenMs : null,
    };
  }

  async function requestJson({ url, payload, apiKey = '', directMode = false, baseUrl = '', method = 'POST', headers = {}, signal, fetchImpl }) {
    const targetUrl = directMode ? url : http.toProxyUrl ? http.toProxyUrl(url, baseUrl) : url.startsWith(baseUrl) ? `/api${url.slice(baseUrl.length)}` : url;
    const body = directMode ? payload : { baseUrl, apiKey, payload, method, headers };
    let response;
    try {
      response = await (fetchImpl || window.fetch.bind(window))(targetUrl, {
        method,
        signal,
        headers: {
          'Content-Type': 'application/json',
          ...(directMode ? headers : {}),
          ...(directMode && apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        ...(method === 'GET' ? {} : { body: JSON.stringify(body) }),
      });
    } catch (err) {
      throw new Error(`连接接口失败：${err && err.message || '网络请求失败'}`);
    }
    const parsed = await parseJsonResponse(response);
    if (!response.ok) throw new Error(normalizeServiceError(null, parsed));
    return parsed;
  }

  function parseSseLine(line) {
    const trimmed = String(line || '').trim();
    if (!trimmed || trimmed.startsWith(':') || !trimmed.startsWith('data:')) return null;
    const data = trimmed.slice(5).trim();
    if (data === '[DONE]') return { done: true };
    return { done: false, delta: (reasoning.extractStreamDelta || (() => ({})))(JSON.parse(data)) };
  }

  const ROUTE_SYSTEM_PROMPT = "你是 ChatUI 意图路由器。一次性判断本次输入走 chat、image 还是 edit_image；只输出 JSON。\n\n输出：\n{\"mode\":\"chat|image|edit_image\",\"target\":\"none|new|uploaded|previous\",\"use_previous_image\":false,\"selected_reference_id\":\"imgref_...\",\"selected_indexes\":[],\"selected_image_ids\":[],\"contextual_image_prompt\":\"\",\"confidence\":0.0,\"evidence\":\"\"}\n\n流程：\n1. 普通对话/解释/总结/翻译/代码/文本改写 => chat + none。\n2. 从零创建/绘制/生成图片、海报、头像、logo、人物、动物、场景 => image + new。\n3. 修改/编辑/调整/替换/去掉/加上/换背景/继续改已有图片 => edit_image，并按下列规则选图。\n4. 如果 current_input 是“按照上述要求生成图片/按上面要求出图/根据前面描述生成图”等引用型生图，仍然在本次路由调用内判断为 image + new，并从 context.recent_messages 提取最近相关视觉需求，写入 contextual_image_prompt。\n\n引用型生图：\n- contextual_image_prompt 必须是可直接给生图模型的完整提示；历史是视觉描述时保留主体、风格、构图、尺寸、文字等要求。\n- 历史是文字需求、方案、流程、架构说明、功能说明时，也要把相关内容转成适合图片模型的视觉表达提示，例如流程图、信息图、架构图、界面示意图、技术说明图或海报；不要因为“不是视觉描述”而返回 chat。\n- 只允许使用 context.recent_messages 与 current_input 提取和改写相关内容；忽略发版、测试、配置、闲聊等无关历史。\n- 只有历史中完全没有可引用的相关内容时，才返回 chat + none，并在 evidence 说明缺少可用上下文。\n\n编辑选图：\n- 指本次上传/附件/原图/我发的图 => uploaded，use_previous_image=false。\n- 指上一张/刚才那张/最近结果/继续改 => previous，use_previous_image=true，selected_reference_id=imgref_latest。\n- 指更早图片，如“最开始的图/第一版/前面那张” => 必须从 context.recent_image_references 选最匹配的 selected_reference_id，不能默认最新图。\n- 未明确哪张已有图 => 用 context.latest_image_reference；多图组默认整组。\n\n精准选单图/多图：\n- 用户指定第 N 张、左/右/中间、某对象/标签/文件名时，必须在对应 reference 的 candidates 中匹配具体图片。\n- 填 1-based selected_indexes，并优先填对应 candidates.image_id 到 selected_image_ids；image_id 必须原样保留 img_ 前缀。\n- 选多张就填多个；无法确定具体图时不要猜，selected_indexes=[]、selected_image_ids=[] 表示整组。\n\n约束：\n- selected_reference_id 必须原样保留 imgref_ 前缀；最新图组用 imgref_latest。\n- 只能根据 current_input、recent_messages、last_generated_image、latest_uploaded_image、latest_image_reference、recent_image_references、attachments 元数据判断。\n- attachments 只有文件名/类型/大小/是否图片；不要读取、分析或臆测图片内容，不要使用 base64/附件正文。\n- 附件不含图片且未明确编辑已有图片 => chat + none。\n- confidence 表示把握；evidence 用一句短中文说明依据。";

  function stripJsonFence(text) {
    return String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  }

  function parseRouteResult(text, normalizeRoute) {
    const value = String(text || '').trim();
    if (!value) return null;
    const normalize = normalizeRoute || imageRouteContext.normalizeRoute;
    if (typeof normalize !== 'function') return null;
    try {
      const parsed = JSON.parse(stripJsonFence(value));
      const route = normalize(parsed);
      const contextualPrompt = String(parsed.contextual_image_prompt || parsed.contextualImagePrompt || '').trim();
      return contextualPrompt ? { ...route, contextualImagePrompt: contextualPrompt } : route;
    } catch {}
    const lower = value.toLowerCase();
    if (lower === 'edit_image') return normalize({ mode: 'edit_image', target: 'previous', use_previous_image: false, confidence: 0.5, evidence: '' });
    if (lower === 'image') return normalize({ mode: 'image', target: 'new', use_previous_image: false, confidence: 0.8 });
    if (lower === 'chat') return normalize({ mode: 'chat', target: 'none', use_previous_image: false, confidence: 0.8 });
    return null;
  }

  function buildRoutePayload({ model, input, attachments = [], context = {}, systemPrompt = ROUTE_SYSTEM_PROMPT } = {}) {
    return { model, temperature: 0, messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: JSON.stringify({ current_input: input, attachments, context }, null, 2) }] };
  }

  function extractRouteText(response) {
    return response && response.choices && response.choices[0] && response.choices[0].message && response.choices[0].message.content || response && response.output_text || '';
  }

  function imageItemToResult(item) {
    const url = item && item.url || '';
    const b64 = item && (item.b64_json || item.image_base64) || '';
    const src = url || (b64 ? `data:image/png;base64,${b64}` : '');
    return src ? { src, url, b64, raw: url || '[base64 image]' } : null;
  }

  function extractImageResult(result) {
    const items = Array.isArray(result && result.data) ? result.data.map(imageItemToResult).filter(Boolean) : [];
    if (!items.length) {
      const raw = JSON.stringify(result, null, 2);
      return result && result.data && result.data.length ? { kind: 'raw', url: '', b64: '', raw } : { kind: 'empty', url: '', b64: '', raw };
    }
    const first = items[0];
    return { kind: 'image', src: first.src, url: first.url, b64: first.b64, raw: items.map(item => item.raw).join('\n'), images: items };
  }

  function buildImageCompletionMessage({ prompt = '', mode = 'image' } = {}) {
    return mode === 'edit_image' ? `[图片编辑完成] ${prompt}` : `[图片生成完成] ${prompt}`;
  }

  function buildPromptWithTextAttachments(prompt = '', attachments = [], isImageFile = () => false) {
    const textAttachments = (attachments || []).filter(item => item && item.text);
    const unsupportedAttachments = (attachments || []).filter(item => item && !item.text && !isImageFile(item));
    const parts = [];
    if (prompt) parts.push(prompt);
    if (textAttachments.length) parts.push(textAttachments.map(item => `[附件：${item.name}]\n${item.text}`).join('\n\n'));
    if (unsupportedAttachments.length) parts.push(`[以下附件已上传到页面，但未能解析正文，因此不会直接发送二进制文件给模型，避免接口报错：\n${unsupportedAttachments.map(item => `- ${item.name} (${item.type})：${item.unsupportedReason || '暂不支持解析，请转换为文本/Markdown/CSV 后再上传'}`).join('\n')}\n]`);
    return parts.filter(Boolean).join('\n\n') || prompt;
  }

  function buildImagePromptWithStylePrompt(prompt = '', stylePrompt = '') {
    const style = String(stylePrompt || '').trim();
    const text = String(prompt || '').trim();
    return style && text ? `${text}\n\n图片样式要求：\n${style}` : text || style;
  }

  function buildImageRequestPayload({ model, prompt, size = 'auto' } = {}) {
    const payload = { model, prompt };
    if (size && size !== 'auto') payload.size = size;
    return payload;
  }

  function createImageContext({ prompt = '', routePrompt = '', attachments = [], mode = 'image', target = 'new', usePreviousImage = false, selectedReferenceId = '', selectedIndexes = [], selectedImageIds = [], makeImageItemId = null } = {}) {
    const makeId = typeof makeImageItemId === 'function' ? makeImageItemId : ((reference, index) => `img_${reference || 'latest'}_${index || 1}`);
    return { prompt, routePrompt, mode, target, usePreviousImage: !!usePreviousImage, selectedReferenceId: selectedReferenceId || '', selectedIndexes: Array.isArray(selectedIndexes) ? selectedIndexes : [], selectedImageIds: Array.isArray(selectedImageIds) ? selectedImageIds : [], attachments: (attachments || []).map((item, index) => ({ ...item, referenceId: item.referenceId || selectedReferenceId || '', imageId: item.imageId || makeId(selectedReferenceId || 'latest', item.sourceIndex || index + 1), sourceIndex: item.sourceIndex || index + 1 })) };
  }

  async function imageFileToJobPayload(attachment, readFileAsDataURL) {
    const file = attachment && attachment.file;
    if (!file) return null;
    const dataUrl = await readFileAsDataURL(file);
    const data = String(dataUrl || '').split(',')[1] || '';
    return data ? { name: attachment.name || file.name || 'image.png', type: attachment.type || file.type || 'image/png', data } : null;
  }

  async function imageFilesToJobPayload(attachments, readFileAsDataURL) {
    const result = [];
    for (const attachment of attachments || []) {
      const payload = await imageFileToJobPayload(attachment, readFileAsDataURL);
      if (payload) result.push(payload);
    }
    return result;
  }

  window.ChatUIServicesFallback = Object.freeze({
    models: Object.freeze({ requestModels }),
    jobs: Object.freeze({ makeClientImageJobId, makeClientChatJobId, startChatJob, registerChatStreamJob, getJob, startImageGenerationJob }),
    chat: Object.freeze({ extractChatJobText, requestJson, parseSseLine }),
    route: Object.freeze({ ROUTE_SYSTEM_PROMPT, stripJsonFence, parseRouteResult, buildRoutePayload, extractRouteText }),
    images: Object.freeze({ extractImageResult, buildImageCompletionMessage, buildPromptWithTextAttachments, buildImagePromptWithStylePrompt, buildImageRequestPayload, createImageContext, imageFileToJobPayload, imageFilesToJobPayload }),
  });
})();
