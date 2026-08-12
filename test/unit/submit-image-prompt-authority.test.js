"use strict";

const assert = require("assert");

const jobWorkflow = require("../../client/app/job-workflow");
const submitWorkflow = require("../../client/app/submit-workflow");
const { makeExecutionFixture } = require("../helpers/dispatch-contract-fixture");

const QUOTED_ASSISTANT_TEXT = "\u5f53\u7136\uff0c\u4e0b\u9762\u662f\u4e00\u6761\u9002\u5408\u751f\u6210\u9ca8\u9c7c\u56fe\u50cf\u7684\u63d0\u793a\u8bcd\uff1a **\u63d0\u793a\u8bcd\uff1a** \u4e00\u6761\u5de8\u5927\u7684\u767d\u9ca8\u5728\u6df1\u84dd\u8272\u6d77\u6d0b\u4e2d\u9ad8\u901f\u6e38\u52a8\u3002 **\u8d1f\u9762\u63d0\u793a\u8bcd\uff1a** \u6a21\u7cca\u3001\u6c34\u5370\u3001\u6587\u5b57\u3002";
const CURRENT_INPUT = "\u57fa\u4e8e\u8fd9\u4e2a\u751f\u6210\u56fe\u7247";
const RESOLVED_GOAL = "Create an ultra-realistic deep-sea shark image with an anatomically accurate great white shark, cinematic underwater light rays, bubbles, distant fish, detailed skin and eyes, wide-angle composition, dramatic motion, and no blur, malformed fins, bad teeth, text, or watermark.";

function memoryStorage() {
  const values = new Map();
  return {
    getItem(key) { return values.get(key) || null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
  };
}

function replaceGlobal(key, value) {
  const previous = global[key];
  if (value === undefined) delete global[key];
  else global[key] = value;
  return () => {
    if (previous === undefined) delete global[key];
    else global[key] = previous;
  };
}

async function testQuotedAssistantPromptExplanationDoesNotPolluteCanonicalImageGoal() {
  const restore = [
    replaceGlobal("window", global),
    replaceGlobal("localStorage", memoryStorage()),
    replaceGlobal("ChatUIAppJobWorkflow", jobWorkflow),
    replaceGlobal("ChatUIRouteService", {
      cleanQuotedContent: value => String(value || "").trim(),
      buildQuotedRouteContent: ({ text }) => String(text || "").trim(),
      isRouteDispatchable: () => true,
    }),
  ];

  try {
    const quotedMessage = {
      id: "quoted-shark-prompt",
      role: "assistant",
      content: QUOTED_ASSISTANT_TEXT,
      rawText: QUOTED_ASSISTANT_TEXT,
    };
    const session = { id: "session-image-prompt-authority", messages: [], display: [] };
    const state = {
      activeSessionId: session.id,
      sessions: [session],
      messages: session.messages,
      attachments: [],
      disposedSessionIds: new Set(),
      promptDrafts: new Map(),
      autoMode: true,
      mode: "image",
      editingIndex: null,
      editingNode: null,
      editingQuoteContext: "",
    };
    const prompt = { value: CURRENT_INPUT, focus() {} };
    const run = { stopped: false, abortController: new AbortController() };
    const execution = makeExecutionFixture({
      operation: "text_to_image",
      relation: "followup",
      prompt: RESOLVED_GOAL,
    });
    const route = {
      mode: "image",
      api: "image_generation",
      target: "new",
      intent: "text_to_image",
      needClarification: false,
      dispatchAuthorized: true,
      readiness: "ready",
      operationType: "text_to_image",
      operationApi: "image_generation",
      operationMode: "image",
      relation: "followup",
      executionPrompt: RESOLVED_GOAL,
      contextualImagePrompt: RESOLVED_GOAL,
      editInstruction: "",
      resources: [],
      imageRefs: [],
      fileRefs: [],
      messageRefs: [],
      selectedIndexes: [],
      selectedImageIndexes: [],
      selectedFileIndexes: [],
      selectedImageIds: [],
      selectedReferenceId: "",
      usePreviousImage: false,
      executionResources: execution.executionResources,
      dispatchContract: execution.dispatchContract,
    };
    const routed = [];
    const sent = [];
    const messagesElement = { querySelectorAll: () => [] };
    const noop = () => {};

    const workflow = submitWorkflow.createSubmitWorkflow({
      state,
      $: id => id === "prompt" ? prompt : id === "messages" ? messagesElement : { querySelectorAll: () => [] },
      isSessionBusy: () => false,
      stopActiveRun: async () => {},
      toast: noop,
      hasPendingUploads: () => false,
      updateSendAvailability: noop,
      unlockDoneSound: noop,
      saveConfig: noop,
      ensureActiveRun: () => run,
      prepareUserAttachmentPreviews: async () => {},
      prepareChatImageAttachments: async files => files,
      buildUploadedImageContext: async () => null,
      buildUserAttachmentContext: async () => null,
      renderUserMessageWithAttachments: text => text,
      buildUserMessageContent: text => text,
      buildUserApiContent: text => text,
      addMessage: () => ({ dataset: {}, isConnected: false }),
      appendSessionDisplayMessage: (_sessionId, role, content, options = {}) => {
        const item = { id: `display-${session.display.length + 1}`, role, content, ...options };
        session.display.push(item);
        return item;
      },
      persistSessionDisplay: noop,
      cloneMessageList: list => list.map(item => ({ ...item })),
      getActiveSession: () => session,
      saveChatHistory: async () => {},
      saveSessionMessages: async () => {},
      clearAttachments: noop,
      clearQuotedMessage: noop,
      getQuotedMessage: () => quotedMessage,
      scheduleAutoResize: noop,
      setSessionBusy: noop,
      prepareReplacementResponse: () => null,
      pendingFeedbackHtml: text => text,
      hasImageAttachments: () => false,
      normalizeRoute: value => value,
      getEffectiveRoute: async (input, routeAttachments, _sessionId, _headers, context) => {
        routed.push({ input, routeAttachments, context });
        return route;
      },
      createRouteRecognitionUi: () => ({ startSlowNotice() {}, stopSlowNotice() {}, showSlowNotice() {} }),
      updateModeUi: noop,
      warnMissingModel: () => false,
      updateMessage: noop,
      showRunError: (_sessionId, error) => { throw error; },
      updateSessionDisplayItem: noop,
      sendChat: async () => { throw new Error("image route must not dispatch chat"); },
      sendImage: async (imagePrompt, options) => {
        sent.push({ imagePrompt, options });
        options.onDurableHandoff();
      },
      getLatestUploadedImageContext: () => null,
      getUploadedImageContext: () => null,
      getPreviousImageAttachments: async () => [],
      restoreImageAttachmentsFromContext: async () => [],
      restoreUserAttachmentsFromContext: async () => [],
      isImageFile: item => String(item?.type || item?.file?.type || "").startsWith("image/"),
      getConfig: () => ({ baseUrl: "https://example.test/v1", apiKey: "test-key", routeModel: "route-model" }),
      getSessionRouteModel: () => "route-model",
      quotedAttachmentTextFromContext: () => "",
      quotedFileCandidatesFromContext: () => [],
      clearActiveRun: noop,
      finishSessionTask: noop,
      dispatchTaskEvent: noop,
      resumeSessionJobs: noop,
      makeClientChatJobId: () => "chatjob-image-prompt-authority",
      makeClientImageJobId: () => "imgjob-image-prompt-authority",
      saveChatJob: noop,
      clearChatJob: noop,
      shouldPrepareManagedChatJob: () => false,
      findMessageNodeByDisplayItem: () => null,
      insertMessageNodeAtDisplayPosition: noop,
      saveSessionsMeta: noop,
      buildRouteContext: () => ({}),
      clearReasoning: noop,
      clearPendingFeedback: noop,
      requestJson: async () => { throw new Error("the supplied canonical route must not invoke another classifier"); },
    });

    await workflow.onSubmit({ preventDefault() {}, submitter: { id: "sendBtn" } });

    assert.strictEqual(routed.length, 1);
    assert.ok(JSON.stringify(routed[0].context).includes(QUOTED_ASSISTANT_TEXT),
      "the quoted assistant text should remain available as routing evidence");
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(sent[0].imagePrompt, RESOLVED_GOAL,
      "the final image prompt must be exactly the canonical route goal");
    assert.strictEqual(sent[0].options.dispatchContract.arguments.prompt, RESOLVED_GOAL);
    assert.ok(!sent[0].imagePrompt.includes("\u5f53\u7136\uff0c\u4e0b\u9762\u662f\u4e00\u6761\u9002\u5408\u751f\u6210\u9ca8\u9c7c\u56fe\u50cf\u7684\u63d0\u793a\u8bcd"),
      "assistant presentation prose must never be prepended to the provider prompt");
  } finally {
    restore.reverse().forEach(fn => fn());
  }
}

module.exports = [
  testQuotedAssistantPromptExplanationDoesNotPolluteCanonicalImageGoal,
];
