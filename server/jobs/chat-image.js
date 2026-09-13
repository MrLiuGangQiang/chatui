const { createJobEvents, publicJob } = require('./common');
const { createChatJobHandlers } = require('./chat');
const { createImageJobHandlers } = require('./image');

function createJobHandlers({ imageJobs, chatJobs, jobSubscribers, upstreamTimeoutMs, contextWindowTokens, requestTrace, errorLog, idempotencyTable = null, providerCapabilities = null }) {
  const { notifyJob, subscribeJob, subscribeJobGroup, abortJob, disposeJob } = createJobEvents({ jobSubscribers });
  const imageHandlers = createImageJobHandlers({ imageJobs, notifyJob, upstreamTimeoutMs, requestTrace, errorLog, idempotencyTable, providerCapabilities });
  const chatHandlers = createChatJobHandlers({ chatJobs, notifyJob, upstreamTimeoutMs, contextWindowTokens, requestTrace, errorLog, idempotencyTable, providerCapabilities });

  return {
    ...chatHandlers,
    ...imageHandlers,
    abortJob,
    disposeJob,
    publicJob,
    notifyJob,
    subscribeJob,
    subscribeChatJobs: (req, res, store) => subscribeJobGroup(req, res, store || chatJobs),
  };
}

module.exports = { createJobHandlers };
