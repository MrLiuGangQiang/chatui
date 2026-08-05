(function initChatUIChatService(root) {
  'use strict';

const fileInputs = root?.ChatUICore?.fileInputs
  || (typeof require === 'function' ? require('../../shared/file-inputs') : null);

function normalizeText(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(item => normalizeText(item?.text || item?.content || item?.output_text || item?.message || item?.delta || item)).filter(Boolean).join('');
  if (typeof value === 'object') {
    const output = Array.isArray(value.output)
      ? value.output.filter(item => !/reason/i.test(String(item?.type || item?.role || '')))
      : '';
    return normalizeText(value.text || value.content || value.output_text || value.message || value.delta || value.response || output || '');
  }
  return String(value || '');
}

function extractChatJobText(data) {
  const message = data?.choices?.[0]?.message || {};
  return {
    content: normalizeText(message.content || message.text || message.output_text || data?.output_text || data?.content || data?.text || data?.message || data?.response || data?.output || ''),
    reasoning: message.reasoning_content || message.reasoning || data?.reasoning_content || data?.reasoning || '',
    firstTokenMs: Number.isFinite(data?.metrics?.firstTokenMs) ? data.metrics.firstTokenMs : null,
    durationMs: Number.isFinite(data?.metrics?.durationMs) ? data.metrics.durationMs : null,
  };
}

function isImageAttachment(item = {}) {
  const type = String(item?.type || item?.file?.type || '').toLowerCase();
  const name = String(item?.name || item?.file?.name || '').toLowerCase();
  return type.startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(name);
}

function isNativeFileAttachment(item = {}) {
  return item?.inputFile === true || item?.input_file === true || /^data:[^,]+;base64,/i.test(String(item?.fileData || item?.file_data || ''));
}

function inputFileData(item = {}) {
  const value = String(item?.fileData || item?.file_data || '');
  return /^data:[^,]+;base64,/i.test(value) ? value : '';
}

function isPdfInputFilePart(part = {}) {
  const dataType = /^data:([^;,]+);base64,/i.exec(String(part?.file_data || ''))?.[1] || '';
  return fileInputs?.isPdfFile?.({ name: part?.filename, type: dataType })
    || dataType.toLowerCase() === 'application/pdf'
    || /\.pdf$/i.test(String(part?.filename || ''));
}

function buildUserContentWithAttachments(prompt = '', attachments = []) {
  const list = Array.isArray(attachments) ? attachments : [];
  const nativeFiles = list.filter(item => !isImageAttachment(item) && isNativeFileAttachment(item) && inputFileData(item));
  const inlineTextFiles = list.filter(item => !isImageAttachment(item) && !isNativeFileAttachment(item) && String(item?.text || '').trim());
  const images = list.filter(item => isImageAttachment(item) && /^data:image\//i.test(String(item?.dataUrl || '')));
  const unavailable = list.filter(item => {
    if (isImageAttachment(item)) return !/^data:image\//i.test(String(item?.dataUrl || ''));
    if (isNativeFileAttachment(item)) return !inputFileData(item);
    return !String(item?.text || '').trim();
  });
  if (unavailable.length) {
    const error = new Error(`附件内容不可用，已停止发送：${unavailable.map(item => item.name || 'attachment').join('、')}`);
    error.code = 'ATTACHMENT_CONTENT_UNAVAILABLE';
    error.attachments = unavailable.map(item => ({
      name: String(item.name || 'attachment'),
      type: String(item.type || 'application/octet-stream'),
      reason: String(item.unsupportedReason || ''),
    }));
    throw error;
  }
  const text = [
    String(prompt || '').trim(),
    inlineTextFiles.length
      ? inlineTextFiles.map(item => `[附件：${item.name || 'attachment'}]\n${String(item.text || '').trim()}`).join('\n\n')
      : '',
  ].filter(Boolean).join('\n\n');

  if (!nativeFiles.length && !images.length) return text;
  const parts = [];
  for (const item of nativeFiles) {
    const part = {
      type: 'input_file',
      filename: String(item.name || item.file?.name || 'attachment'),
      file_data: inputFileData(item),
    };
    if (fileInputs?.isPdfFile?.(item)) part.detail = fileInputs.normalizePdfDetail?.(item.pdfDetail || item.pdf_detail) || 'auto';
    parts.push(part);
  }
  if (text) parts.push({ type: 'text', text });
  for (const item of images) parts.push({ type: 'image_url', image_url: { url: item.dataUrl } });
  return parts;
}

function responsesInputFromChatMessages(messages = []) {
  return (Array.isArray(messages) ? messages : []).map(message => {
    const role = ['system', 'user', 'assistant'].includes(message?.role) ? message.role : 'user';
    const content = message?.content;
    if (!Array.isArray(content)) return { role, content: String(content ?? '') };
    const parts = content.map(part => {
      if (part?.type === 'text') return { type: 'input_text', text: String(part.text || '') };
      if (part?.type === 'image_url') return { type: 'input_image', image_url: String(part.image_url?.url || part.image_url || '') };
      if (part?.type === 'input_file' && part.file_data) {
        const includeDetail = !!part.detail && isPdfInputFilePart(part);
        return {
          type: 'input_file',
          filename: String(part.filename || 'attachment'),
          file_data: String(part.file_data),
          ...(includeDetail ? { detail: fileInputs?.normalizePdfDetail?.(part.detail) || String(part.detail) } : {}),
        };
      }
      return null;
    }).filter(Boolean);
    return { role, content: parts.length ? parts : '' };
  });
}

function messagesHaveInputFiles(messages = []) {
  return (Array.isArray(messages) ? messages : []).some(message => Array.isArray(message?.content)
    && message.content.some(part => part?.type === 'input_file' && part?.file_data));
}

function buildResponsesPayload(model, messages, options = {}) {
  const payload = { model, input: responsesInputFromChatMessages(messages) };
  if (options.reasoningEnabled) {
    payload.reasoning = {
      effort: options.reasoningEffort || 'medium',
      summary: options.summary || 'auto',
    };
  }
  if (options.stream !== false) payload.stream = true;
  return payload;
}

async function requestJson({ fetchImpl = fetch, url, payload, apiKey = '', baseUrl = '', method = 'POST', headers = {}, signal, toProxyUrl, parseResponseJson, normalizeError }) {
  const targetUrl = toProxyUrl(url, baseUrl);
  const body = { baseUrl, apiKey, payload, method, headers };
  let response;
  try {
    response = await fetchImpl(targetUrl, {
      method,
      signal,
      headers: {
        'Content-Type': 'application/json',
      },
      ...(method === 'GET' ? {} : { body: JSON.stringify(body) }),
    });
  } catch (err) {
    if (err?.name === 'AbortError' || signal?.aborted) throw err;
    const msg = String(err?.message || '网络请求失败');
    if (/Failed to fetch|fetch failed|ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT|network/i.test(msg)) throw new Error('连接接口失败：Endpoint 地址不可达或网络连接被拒绝，请检查 Endpoint Base URL、端口和代理服务是否可用');
    throw new Error(`连接接口失败：${msg}`);
  }
  const parsed = await parseResponseJson(response);
  if (!response.ok) throw new Error(normalizeError(null, parsed));
  return parsed;
}

function parseSseLine(line, extractStreamDelta) {
  const trimmed = String(line || '').trim();
  if (!trimmed || trimmed.startsWith(':') || !trimmed.startsWith('data:')) return null;
  const data = trimmed.slice(5).trim();
  if (data === '[DONE]') return { done: true };
  const delta = extractStreamDelta(JSON.parse(data));
  return { done: false, delta };
}

const api = Object.freeze({
  extractChatJobText,
  buildUserContentWithAttachments,
  responsesInputFromChatMessages,
  messagesHaveInputFiles,
  buildResponsesPayload,
  requestJson,
  parseSseLine,
});

if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (root) root.ChatUIChatService = api;
if (root?.window) root.window.ChatUIChatService = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
