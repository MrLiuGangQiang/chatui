const { createJobEvents, publicJob } = require('./common');
const { createChatJobHandlers } = require('./chat');
const { createImageJobHandlers } = require('./image');
const { normalizeReasoningText } = require('./reasoning');

function createJobHandlers({ imageJobs, chatJobs, jobSubscribers, upstreamTimeoutMs, contextWindowTokens }) {
  const { notifyJob, subscribeJob, abortJob, disposeJob } = createJobEvents({ jobSubscribers });
  const imageHandlers = createImageJobHandlers({ imageJobs, notifyJob, upstreamTimeoutMs });
  const chatHandlers = createChatJobHandlers({ chatJobs, notifyJob, upstreamTimeoutMs, contextWindowTokens });

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
