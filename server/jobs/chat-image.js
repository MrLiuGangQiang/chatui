const { createJobEvents, publicJob } = require('./common');
const { createChatJobHandlers } = require('./chat');
const { createImageJobHandlers } = require('./image');
const { normalizeReasoningText } = require('./reasoning');

function createJobHandlers({ imageJobs, chatJobs, jobSubscribers, upstreamTimeoutMs, contextWindowTokens, jobAdmission, upstreamLimiter, fetchUpstream }) {
  const { notifyJob, subscribeJob, abortJob, disposeJob } = createJobEvents({ jobSubscribers });
  const imageHandlers = createImageJobHandlers({ imageJobs, notifyJob, upstreamTimeoutMs, jobAdmission, upstreamLimiter, fetchUpstream });
  const chatHandlers = createChatJobHandlers({ chatJobs, notifyJob, upstreamTimeoutMs, contextWindowTokens, jobAdmission, upstreamLimiter, fetchUpstream });

  return {
    ...chatHandlers,
    ...imageHandlers,
    abortJob,
    disposeJob,
    publicJob,
    notifyJob,
    subscribeJob,
  };
}

module.exports = { createJobHandlers, normalizeReasoningText };
