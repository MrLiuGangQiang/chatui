const { readBody, parseJson } = require('../../http/body');

const CLIENT_EXECUTION_TRACE_VERSION = 'client_execution_trace.v1';
const CLIENT_EXECUTION_TRACE_MAX_BYTES = 64 * 1024;

function createReportedError(value = {}) {
  const error = new Error(String(value?.message || 'Client execution rejected before dispatch'));
  error.name = String(value?.name || 'Error');
  error.code = String(value?.code || 'CLIENT_EXECUTION_REJECTED');
  error.statusCode = Number(value?.statusCode || value?.status_code) || 400;
  return error;
}

function createCoreRoutes({ appVersion, buildIdentity, readPublicConfig, readChangelog = () => [], readAnnouncements = () => [], sendJson, sendMethodNotAllowed, proxyImage, registerChatStreamJob, requestTrace }) {
  async function recordClientExecutionTrace(req, res) {
    try {
      const body = parseJson(await readBody(req, { maxBytes: CLIENT_EXECUTION_TRACE_MAX_BYTES }));
      if (body?.schema_version !== CLIENT_EXECUTION_TRACE_VERSION || body?.event !== 'execution.rejected') {
        return sendJson(res, 400, { error: { code: 'CLIENT_EXECUTION_TRACE_INVALID', message: 'Invalid client execution trace event' } });
      }
      requestTrace?.executionRejected?.({
        traceId: req?._traceId,
        rootTraceId: req?._rootTraceId,
        source: 'client_pre_dispatch',
        submissionId: String(body.submissionId || body.submission_id || ''),
        jobId: String(body.jobId || body.job_id || ''),
        stage: String(body.stage || 'client_context_projection'),
        body: {
          requestPurpose: String(body.requestPurpose || body.request_purpose || 'final_execution'),
          dispatchContract: body.dispatchContract || body.dispatch_contract,
          bindingEvidence: Array.isArray(body.bindingEvidence || body.binding_evidence)
            ? (body.bindingEvidence || body.binding_evidence)
            : [],
        },
        payload: {},
        payloadAvailable: false,
        transportApi: String(body.transportApi || body.transport_api || ''),
        contextProjection: body.contextProjection || body.context_projection || null,
        error: createReportedError(body.error),
      });
      return sendJson(res, 202, { recorded: !!requestTrace?.enabled });
    } catch (error) {
      return sendJson(res, Number(error?.statusCode) || 400, {
        error: {
          code: String(error?.code || 'CLIENT_EXECUTION_TRACE_INVALID'),
          message: String(error?.message || 'Invalid client execution trace event'),
        },
      });
    }
  }

  const routes = [
    {
      path: '/api/version',
      method: 'GET',
      handler: (req, res) => sendJson(res, 200, buildIdentity || { version: appVersion }, { 'Access-Control-Allow-Origin': '*' }),
    },
    {
      path: '/api/config/public',
      method: 'GET',
      handler: (req, res) => sendJson(res, 200, { version: appVersion, config: readPublicConfig() }, { 'Access-Control-Allow-Origin': '*' }),
    },
    {
      path: '/api/changelog',
      method: 'GET',
      handler: (req, res) => sendJson(res, 200, { releases: readChangelog() }, { 'Access-Control-Allow-Origin': '*' }),
    },
    {
      path: '/api/announcements',
      method: 'GET',
      handler: (req, res) => sendJson(res, 200, { announcements: readAnnouncements() }, { 'Access-Control-Allow-Origin': '*' }),
    },
    {
      path: '/api/image',
      method: 'POST',
      handler: proxyImage,
    },
    {
      path: '/api/chat-stream-jobs',
      method: 'POST',
      handler: registerChatStreamJob,
    },
    {
      path: '/api/client-execution-trace',
      method: 'POST',
      handler: recordClientExecutionTrace,
    },
  ];

  function routeCoreApi(req, res) {
    const route = routes.find(item => item.path === (req.pathname || req.url));
    if (!route) return false;
    if (req.method !== route.method) return sendMethodNotAllowed(res);
    return route.handler(req, res);
  }

  return { routeCoreApi };
}

module.exports = { createCoreRoutes };
