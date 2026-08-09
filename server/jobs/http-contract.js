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
  'Access-Control-Allow-Origin': '*',
});

function sendJobNotFound(res) {
  return sendJson(res, 404, { error: { message: JOB_NOT_FOUND_MESSAGE } }, JOB_RESPONSE_HEADERS);
}

module.exports = {
  JOB_NOT_FOUND_MESSAGE,
  JOB_RESPONSE_HEADERS,
  JOB_SSE_HEADERS,
  sendJobNotFound,
};
