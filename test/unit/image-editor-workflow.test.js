'use strict';

const assert = require('assert');

const { createImageEditorWorkflow } = require('../../client/app/image-editor-workflow');
const taskState = require('../../client/core/task-state');

function installFileReader() {
  const previous = global.FileReader;
  class FakeFileReader {
    readAsDataURL(blob) {
      this.result = `data:${blob?.type || 'image/png'};base64,${blob?.marker || 'AAAA'}`;
      queueMicrotask(() => this.onload && this.onload());
    }
  }
  global.FileReader = FakeFileReader;
  return () => {
    if (previous === undefined) delete global.FileReader;
    else global.FileReader = previous;
  };
}

function makeWorkflow({ sendImageImpl = null, routeUtils = null, submitHelpers = null } = {}) {
  const calls = [];
  const userMessages = [];
  const lifecycle = { events: [], finishes: [], run: { token: 'run-editor', stopped: false, abortController: new AbortController() } };
  const state = { activeSessionId: 'session-1', sessions: [{ id: 'session-1', messages: [] }], messages: [] };
  const workflow = createImageEditorWorkflow({
    state,
    routeUtils: routeUtils || undefined,
    submitHelpers: submitHelpers || undefined,
    toast: () => {},
    isSessionBusy: () => false,
    sendImage: async (prompt, options) => {
      calls.push({ prompt, options });
      if (sendImageImpl) return sendImageImpl(prompt, options);
    },
    makeClientImageJobId: () => 'imgjob-editor',
    ensureActiveRun: () => lifecycle.run,
    clearActiveRun: () => {},
    setSessionBusy: (_sessionId, value) => lifecycle.events.push({ type: 'BUSY', value }),
    dispatchTaskEvent: (_sessionId, event) => lifecycle.events.push(event),
    finishSessionTask: (_sessionId, options) => lifecycle.finishes.push(options),
    addMessage: () => ({ dataset: {} }),
    appendSessionDisplayMessage: (sessionId, role, html, options) => {
      userMessages.push({ sessionId, role, html, options });
      return { id: 'display-user-1' };
    },
    persistSessionDisplay: () => {},
    saveChatHistory: async () => {},
    saveSessionMessages: async () => {},
    escapeHtml: value => String(value),
  });
  return { workflow, calls, state, userMessages, lifecycle };
}

async function testEraseEditDispatchesOneMaskAndTarget() {
  const restore = installFileReader();
  try {
    const { workflow, calls } = makeWorkflow();
    const ok = await workflow.applyImageEdit({
      sessionId: 'session-1',
      imageBlob: { type: 'image/png' },
      filename: 'target.png',
      edit: {
        mode: 'erase',
        maskBlob: { type: 'image/png' },
        prompt: 'Remove the selected area and fill it naturally with the surrounding background.',
      },
    });
    assert.strictEqual(ok, true);
    assert.strictEqual(calls.length, 1);
    const { options } = calls[0];
    assert.strictEqual(options.dispatchContract.operation, 'edit_image');
    assert.strictEqual(options.dispatchContract.api, 'image_edit');
    assert.strictEqual((options.maskAttachments || []).length, 1, 'exactly one mask attachment must travel');
    assert.strictEqual((options.attachments || []).length, 1, 'the target image is the only image input');
    assert.strictEqual((options.executionMedia.masks || []).length, 1);
    assert.deepStrictEqual(
      options.dispatchContract.bindings.map(binding => `${binding.role}:${binding.type}`).sort(),
      ['mask:image', 'target:image'],
    );
  } finally {
    restore();
  }
}

async function testRemoveBackgroundEditRequestsTransparentPng() {
  const restore = installFileReader();
  try {
    const { workflow, calls } = makeWorkflow();
    await workflow.applyImageEdit({
      sessionId: 'session-1',
      imageBlob: { type: 'image/png' },
      edit: {
        mode: 'remove_background',
        background: 'transparent',
        output_format: 'png',
        prompt: 'Remove the background and keep the subject cleanly cut out.',
      },
    });
    const args = calls[0].options.dispatchContract.arguments;
    assert.strictEqual(args.background, 'transparent');
    assert.strictEqual(args.output_format, 'png');
    assert.strictEqual((calls[0].options.maskAttachments || []).length, 0, 'background removal needs no mask');
  } finally {
    restore();
  }
}

async function testEnhanceEditDispatchesOnlyTheTargetWithoutMask() {
  const restore = installFileReader();
  try {
    const { workflow, calls, userMessages } = makeWorkflow();
    await workflow.applyImageEdit({
      sessionId: 'session-1',
      imageBlob: { type: 'image/png' },
      filename: 'target.png',
      edit: {
        mode: 'enhance',
        prompt: '提升这张图片的清晰度。增强细节、纹理、边缘和局部对比度，减少模糊、噪点与压缩伪影；保持原始构图、主体、姿态、颜色、光照、风格和文字内容不变，不要添加或删除任何元素。',
      },
    });
    assert.strictEqual(calls.length, 1);
    const { options } = calls[0];
    assert.strictEqual(options.dispatchContract.operation, 'edit_image');
    assert.strictEqual(options.dispatchContract.api, 'image_edit');
    assert.strictEqual((options.maskAttachments || []).length, 0, 'clarity enhancement must not send a mask');
    assert.strictEqual((options.attachments || []).length, 1, 'the target image is the only image input');
    assert.strictEqual((options.executionMedia.masks || []).length, 0);
    assert.deepStrictEqual(
      options.dispatchContract.bindings.map(binding => `${binding.role}:${binding.type}`),
      ['target:image'],
    );
    assert.match(options.dispatchContract.arguments.prompt, /提升这张图片的清晰度/);
    assert.strictEqual(userMessages[0].options.rawText, '提升图片清晰度');
  } finally {
    restore();
  }
}

async function testResizeEditDispatchesTheSelectedSizeWithoutAMask() {
  const restore = installFileReader();
  try {
    const { workflow, calls, userMessages } = makeWorkflow();
    await workflow.applyImageEdit({
      sessionId: 'session-1',
      imageBlob: { type: 'image/png' },
      filename: 'target.png',
      edit: {
        mode: 'resize',
        size: '1536x864',
        prompt: '保持主体、内容、颜色、风格和细节，将图片自然重构图到宽屏 16:9（1536 × 864）。',
        label: '调整图片尺寸为宽屏 16:9（1536 × 864）',
      },
    });
    assert.strictEqual(calls.length, 1);
    const { options } = calls[0];
    assert.strictEqual(options.dispatchContract.arguments.size, '1536x864');
    assert.strictEqual((options.maskAttachments || []).length, 0, 'resize alone must not send a mask');
    assert.strictEqual((options.attachments || []).length, 1, 'resize must use the original image as the only target');
    assert.deepStrictEqual(
      options.dispatchContract.bindings.map(binding => `${binding.role}:${binding.type}`),
      ['target:image'],
    );
    assert.strictEqual(userMessages[0].options.rawText, '调整图片尺寸为宽屏 16:9（1536 × 864）');
  } finally {
    restore();
  }
}

async function testResizeEditRejectsUnexpectedMasks() {
  const restore = installFileReader();
  try {
    const { workflow, calls } = makeWorkflow();
    await assert.rejects(
      () => workflow.applyImageEdit({
        sessionId: 'session-1',
        imageBlob: { type: 'image/png' },
        edit: {
          mode: 'resize',
          maskBlob: { type: 'image/png' },
          size: '1536x864',
          prompt: '保持主体，将图片自然重构图到宽屏 16:9。',
        },
      }),
      /全局编辑操作不支持遮罩/,
    );
    assert.strictEqual(calls.length, 0, 'a standalone resize must not dispatch with an unexpected mask');
  } finally {
    restore();
  }
}

async function testCompositeEditCarriesOneCombinedMaskAndGlobalParameters() {
  const restore = installFileReader();
  try {
    const { workflow, calls } = makeWorkflow();
    await workflow.applyImageEdit({
      sessionId: 'session-1',
      imageBlob: { type: 'image/png' },
      edit: {
        mode: 'composite',
        maskBlob: { type: 'image/png', marker: 'COMBINED' },
        background: 'transparent',
        output_format: 'png',
        prompt: 'combined prompt',
        label: '提升图片清晰度\n1. 淡化左侧水面',
      },
    });
    const { options } = calls[0];
    assert.strictEqual((options.maskAttachments || []).length, 1);
    assert.strictEqual((options.attachments || []).length, 1);
    assert.deepStrictEqual(
      options.dispatchContract.bindings.map(binding => `${binding.role}:${binding.type}`).sort(),
      ['mask:image', 'target:image'],
    );
    assert.strictEqual(options.dispatchContract.arguments.background, 'transparent');
    assert.strictEqual(options.dispatchContract.arguments.output_format, 'png');
    assert.strictEqual(options.dispatchContract.arguments.prompt, 'combined prompt');
  } finally {
    restore();
  }
}

async function testEraseWithoutMaskDataFailsClosed() {
  const restore = installFileReader();
  try {
    const { workflow, calls } = makeWorkflow();
    await assert.rejects(
      () => workflow.applyImageEdit({
        sessionId: 'session-1',
        imageBlob: { type: 'image/png' },
        edit: { mode: 'erase', prompt: 'Remove the selected area.' },
      }),
      /遮罩|mask/i,
    );
    assert.strictEqual(calls.length, 0, 'no request may leave the client without a mask');
  } finally {
    restore();
  }
}

async function testCommentEditSendsMaskAndCleanOriginal() {
  const restore = installFileReader();
  try {
    const { workflow, calls } = makeWorkflow();
    await workflow.applyImageEdit({
      sessionId: 'session-1',
      imageBlob: { type: 'image/png', marker: 'ORIGINAL' },
      edit: {
        mode: 'comment',
        maskBlob: { type: 'image/png', marker: 'COMMENT-MASK' },
        prompt: '\u56fe\u7247\u4e0a\u6709\u4e00\u4e2a\u7f16\u8f91\u8499\u7248\uff1a\u8499\u7248\u4e2d\u7684\u900f\u660e\u533a\u57df\u662f\u5141\u8bb8\u4fee\u6539\u7684\u4f4d\u7f6e\u3002\n1. \u4f4d\u7f6e (x=0.250, y=0.250)\uff1a\u628a\u624b\u6539\u6210\u84dd\u8272',
      },
    });
    const { options } = calls[0];
    assert.strictEqual((options.maskAttachments || []).length, 1, 'comment mode must send the generated edit mask');
    assert.strictEqual(options.attachments.length, 1, 'comment mode must send the clean original as the only image input');
    assert.ok(String(options.attachments[0].src || '').includes('ORIGINAL'),
      'the clean original must be the edit target');
    assert.deepStrictEqual(options.dispatchContract.bindings.map(binding => binding.role), ['target', 'mask']);
    assert.strictEqual((options.executionMedia.imageInputs || []).length, 1, 'the clean original must reach execution media');
    const prompt = String(options.dispatchContract.arguments.prompt || '');
    assert.ok(prompt.includes('图片上有一个编辑蒙版'),
      'the prompt must describe the generated edit mask');
    assert.ok(prompt.includes('1.'), 'the numbered prompt must reach the dispatch contract');
  } finally {
    restore();
  }
}

async function testEraseEditAppearsAsAUserTurnBeforeDispatch() {
  const restore = installFileReader();
  try {
    const { workflow, calls, state, userMessages } = makeWorkflow();
    await workflow.applyImageEdit({
      sessionId: 'session-1',
      imageBlob: { type: 'image/png' },
      edit: {
        mode: 'erase',
        maskBlob: { type: 'image/png' },
        prompt: 'Remove the selected area and fill it naturally with the surrounding background.',
      },
    });
    assert.strictEqual(userMessages.length, 1, 'the edit must appear as one user turn');
    assert.strictEqual(userMessages[0].role, 'user');
    assert.strictEqual(userMessages[0].options.rawText, '\u64e6\u9664\u56fe\u7247\u4e2d\u7684\u9009\u533a');
    assert.strictEqual(state.messages.at(-1).role, 'user', 'the transcript owns the new user turn');
    assert.strictEqual(calls[0].options.userAlreadyAdded, true,
      'sendImage must not create a second user turn');
  } finally {
    restore();
  }
}

async function testRemoveBackgroundEditLabelsTheUserTurn() {
  const restore = installFileReader();
  try {
    const { workflow, userMessages } = makeWorkflow();
    await workflow.applyImageEdit({
      sessionId: 'session-1',
      imageBlob: { type: 'image/png' },
      edit: {
        mode: 'remove_background',
        background: 'transparent',
        output_format: 'png',
        prompt: 'Remove the background and keep the subject cleanly cut out.',
      },
    });
    assert.strictEqual(userMessages[0].options.rawText, '移除此图像的背景。保持所有前景主体不变且完整无损，边缘干净平滑。将背景设为透明。');
  } finally {
    restore();
  }
}

async function testEditorEditOwnsAndSettlesTheManagedTaskLifecycle() {
  const restore = installFileReader();
  try {
    const { workflow, calls, lifecycle } = makeWorkflow();
    await workflow.applyImageEdit({
      sessionId: 'session-1',
      imageBlob: { type: 'image/png' },
      edit: { mode: 'erase', maskBlob: { type: 'image/png' }, prompt: 'Remove the selected area.' },
    });
    const eventTypes = lifecycle.events.filter(event => event.type !== 'BUSY').map(event => event.type);
    assert.deepStrictEqual(eventTypes, [
      taskState.TASK_EVENTS.TASK_ACCEPTED,
      taskState.TASK_EVENTS.JOB_RECOVERY_STARTED,
      taskState.TASK_EVENTS.JOB_COMPLETED_COMMITTED,
    ], 'the editor edit must own one managed task and settle it on completion');
    assert.strictEqual(lifecycle.events.find(event => event.type === taskState.TASK_EVENTS.JOB_RECOVERY_STARTED).jobId, 'imgjob-editor');
    assert.strictEqual(lifecycle.events.at(-1).jobId, 'imgjob-editor');
    assert.strictEqual(lifecycle.finishes.length, 1);
    assert.strictEqual(lifecycle.finishes[0].run, lifecycle.run, 'completion must release the editor run');
    assert.strictEqual(lifecycle.finishes[0].jobId, 'imgjob-editor');
    assert.strictEqual(calls[0].options.clientJobId, 'imgjob-editor');
    assert.match(calls[0].options.submissionId, /^image-edit-/);
    assert.strictEqual(typeof calls[0].options.onInterfaceCompleted, 'function');
  } finally {
    restore();
  }
}

async function testEditorEditReleasesTheTaskWhenDispatchFails() {
  const restore = installFileReader();
  try {
    const { workflow, lifecycle } = makeWorkflow({
      sendImageImpl: async () => { throw new Error('dispatch failed'); },
    });
    await assert.rejects(
      () => workflow.applyImageEdit({
        sessionId: 'session-1',
        imageBlob: { type: 'image/png' },
        edit: { mode: 'erase', maskBlob: { type: 'image/png' }, prompt: 'Remove the selected area.' },
      }),
      /dispatch failed/,
    );
    const eventTypes = lifecycle.events.filter(event => event.type !== 'BUSY').map(event => event.type);
    assert.strictEqual(eventTypes.at(-1), taskState.TASK_EVENTS.JOB_FAILED,
      'a failed editor dispatch must fail the managed task');
    assert.strictEqual(lifecycle.finishes.length, 1, 'a failed editor dispatch must release the run and busy state');
    assert.strictEqual(lifecycle.finishes[0].run, lifecycle.run);
  } finally {
    restore();
  }
}


async function testRouteFailureDoesNotLeaveAnOrphanedUserTurn() {
  const restore = installFileReader();
  try {
    const { workflow, state, userMessages } = makeWorkflow({
      routeUtils: { compileLocalRoute: () => null },
    });
    await assert.rejects(
      () => workflow.applyImageEdit({
        sessionId: 'session-1',
        imageBlob: { type: 'image/png' },
        edit: { mode: 'enhance', prompt: '提升图片清晰度' },
      }),
      /图片编辑请求未能安全执行/,
    );
    assert.strictEqual(state.messages.length, 0,
      'a locally rejected edit must not create a canonical user message');
    assert.strictEqual(userMessages.length, 0,
      'a locally rejected edit must not create a display user message');
  } finally {
    restore();
  }
}

async function testImageEditUsesOneSubmissionIdentityForUserAndJob() {
  const restore = installFileReader();
  const previousIdentity = global.ChatUIAppSessionPersistence;
  try {
    global.ChatUIAppSessionPersistence = {
      createMessageTurnIdentity: ({ submissionId, role }) => ({
        id: `message:${submissionId}:${role}`,
        turnId: `turn:${submissionId}`,
      }),
    };
    const { workflow, state, calls } = makeWorkflow();
    await workflow.applyImageEdit({
      sessionId: 'session-1',
      imageBlob: { type: 'image/png' },
      edit: { mode: 'enhance', prompt: '提升图片清晰度' },
    });
    const submissionId = calls[0].options.submissionId;
    assert.ok(submissionId, 'the managed image job must have a submission id');
    assert.strictEqual(state.messages[0].turnId, `turn:${submissionId}`,
      'the user turn and managed job must share one turn identity');
    assert.strictEqual(state.messages[0].submissionId, submissionId,
      'the canonical user turn must retain the managed submission identity');
    assert.strictEqual(state.messages[0].id, `message:${submissionId}:user`);
  } finally {
    if (previousIdentity === undefined) delete global.ChatUIAppSessionPersistence;
    else global.ChatUIAppSessionPersistence = previousIdentity;
    restore();
  }
}

async function testGlobalImageEditsRejectUnexpectedMasks() {
  const restore = installFileReader();
  try {
    const { workflow, state, calls } = makeWorkflow();
    await assert.rejects(
      () => workflow.applyImageEdit({
        sessionId: 'session-1',
        imageBlob: { type: 'image/png' },
        edit: { mode: 'enhance', maskBlob: { type: 'image/png' }, prompt: '提升图片清晰度' },
      }),
      /全局编辑操作不支持遮罩/,
    );
    assert.strictEqual(calls.length, 0);
    assert.strictEqual(state.messages.length, 0);
  } finally {
    restore();
  }
}


async function testExecutionMediaFailureDoesNotLeaveAnOrphanedUserTurn() {
  const restore = installFileReader();
  try {
    const { workflow, state, userMessages } = makeWorkflow({
      submitHelpers: { projectRouteExecutionMediaForDispatch: () => null },
    });
    await assert.rejects(
      () => workflow.applyImageEdit({
        sessionId: 'session-1',
        imageBlob: { type: 'image/png' },
        edit: { mode: 'enhance', prompt: '提升图片清晰度' },
      }),
      /编辑资源投影失败/,
    );
    assert.strictEqual(state.messages.length, 0);
    assert.strictEqual(userMessages.length, 0);
  } finally {
    restore();
  }
}

module.exports = [
  testEraseEditDispatchesOneMaskAndTarget,
  testRemoveBackgroundEditRequestsTransparentPng,
  testEnhanceEditDispatchesOnlyTheTargetWithoutMask,
  testResizeEditDispatchesTheSelectedSizeWithoutAMask,
  testResizeEditRejectsUnexpectedMasks,
  testCompositeEditCarriesOneCombinedMaskAndGlobalParameters,
  testEraseWithoutMaskDataFailsClosed,
  testCommentEditSendsMaskAndCleanOriginal,
  testEraseEditAppearsAsAUserTurnBeforeDispatch,
  testRemoveBackgroundEditLabelsTheUserTurn,
  testEditorEditOwnsAndSettlesTheManagedTaskLifecycle,
  testEditorEditReleasesTheTaskWhenDispatchFails,
  testRouteFailureDoesNotLeaveAnOrphanedUserTurn,
  testImageEditUsesOneSubmissionIdentityForUserAndJob,
  testGlobalImageEditsRejectUnexpectedMasks,
  testExecutionMediaFailureDoesNotLeaveAnOrphanedUserTurn,
];
