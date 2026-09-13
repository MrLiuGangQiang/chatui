'use strict';

const { sendJson } = require('../http/response');

const JOB_NOT_FOUND_MESSAGE = '任务不存在或服务已重启';
const JOB_RESPONSE_HEADERS = Object.freeze({
  'Access-Control-Allow-Origin': '*',
  'Cache-Control': 'private, no-store',
});
const JOB_SSE_HEADERS = Object.freeze({
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'private, no-store, no-transform',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
  'Access-Control-Allow-Origin': '*',
});

const JOB_GROUP_MAX_IDS = 64;
const JOB_GROUP_MAX_URL_BYTES = 6144;
const JOB_GROUP_ID_PATTERN = /^chatjob-[A-Za-z0-9-]{1,80}$/;
const SAFE_OFFSET_PATTERN = /^(?:0|[1-9][0-9]*)$/;

function contractError(message, code, statusCode = 400) {
  return { message, code, statusCode };
}

function parseSafeOffset(value) {
  const text = String(value ?? '');
  if (!SAFE_OFFSET_PATTERN.test(text)) return null;
  const number = Number(text);
  return Number.isSafeInteger(number) ? number : null;
}

function validateJobGroupUrl(requestUrl = '') {
  const urlText = String(requestUrl || '');
  if (Buffer.byteLength(urlText, 'utf8') > JOB_GROUP_MAX_URL_BYTES) {
    return { error: contractError('任务订阅地址过长，请减少任务数量或重新连接', 'JOB_GROUP_URL_TOO_LONG', 414) };
  }

  let parsed;
  try { parsed = new URL(urlText, 'http://localhost'); }
  catch { return { error: contractError('任务订阅地址无效，请重试', 'INVALID_JOB_GROUP', 400) }; }

  const rawIds = parsed.searchParams.getAll('ids');
  if (rawIds.length !== 1 || !rawIds[0]) {
    return { error: contractError('任务订阅必须包含一个非空 ids 参数', 'INVALID_JOB_GROUP', 400) };
  }
  const ids = rawIds[0].split(',');
  if (!ids.length || ids.some(id => !JOB_GROUP_ID_PATTERN.test(id))) {
    return { error: contractError('任务 id 格式无效，请重新连接', 'INVALID_JOB_GROUP', 400) };
  }
  if (ids.length > JOB_GROUP_MAX_IDS) {
    return { error: contractError('一次最多订阅 64 个任务', 'INVALID_JOB_GROUP', 400) };
  }
  if (new Set(ids).size !== ids.length) {
    return { error: contractError('任务 id 不能重复，请重新连接', 'INVALID_JOB_GROUP', 400) };
  }

  const offsets = new Map();
  for (const raw of parsed.searchParams.getAll('offset')) {
    const fields = String(raw || '').split(':');
    if (fields.length !== 3) {
      return { error: contractError('任务 offset 格式无效，请重新连接', 'INVALID_JOB_OFFSET', 400) };
    }
    const [id, contentText, reasoningText] = fields;
    if (!ids.includes(id) || offsets.has(id)) {
      return { error: contractError('任务 offset 必须对应唯一的任务 id', 'INVALID_JOB_OFFSET', 400) };
    }
    const contentLength = parseSafeOffset(contentText);
    const reasoningLength = parseSafeOffset(reasoningText);
    if (contentLength === null || reasoningLength === null) {
      return { error: contractError('任务 offset 必须是非负安全整数', 'INVALID_JOB_OFFSET', 400) };
    }
    offsets.set(id, { contentLength, reasoningLength });
  }

  return { ids, offsets };
}

function sendJobGroupError(res, error) {
  return sendJson(
    res,
    error?.statusCode || 400,
    { error: { message: error?.message || '任务订阅请求无效', code: error?.code || 'INVALID_JOB_GROUP' } },
    { ...JOB_RESPONSE_HEADERS },
  );
}

function sendJobNotFound(res) {
  return sendJson(res, 404, { error: { message: JOB_NOT_FOUND_MESSAGE } }, JOB_RESPONSE_HEADERS);
}

module.exports = {
  JOB_NOT_FOUND_MESSAGE,
  JOB_RESPONSE_HEADERS,
  JOB_SSE_HEADERS,
  JOB_GROUP_MAX_IDS,
  JOB_GROUP_MAX_URL_BYTES,
  JOB_GROUP_ID_PATTERN,
  parseSafeOffset,
  validateJobGroupUrl,
  sendJobGroupError,
  sendJobNotFound,
};
