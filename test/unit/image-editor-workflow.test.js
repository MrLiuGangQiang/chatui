'use strict';

const assert = require('assert');

const { createImageEditorWorkflow } = require('../../client/app/image-editor-workflow');

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

function makeWorkflow() {
  const calls = [];
  const userMessages = [];
  const state = { activeSessionId: 'session-1', sessions: [{ id: 'session-1', messages: [] }], messages: [] };
  const workflow = createImageEditorWorkflow({
    state,
    toast: () => {},
    isSessionBusy: () => false,
    sendImage: async (prompt, options) => { calls.push({ prompt, options }); },
    makeClientImageJobId: () => 'imgjob-editor',
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
  return { workflow, calls, state, userMessages };
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

async function testResizeEditCarriesTheCustomSize() {
  const restore = installFileReader();
  try {
    const { workflow, calls } = makeWorkflow();
    await workflow.applyImageEdit({
      sessionId: 'session-1',
      imageBlob: { type: 'image/png' },
      edit: { mode: 'resize', size: '1536x864', prompt: 'Resize the image to 1536x864.' },
    });
    assert.strictEqual(calls[0].options.dispatchContract.arguments.size, '1536x864');
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

async function testAnnotateEditDispatchesTheCompositedImage() {
  const restore = installFileReader();
  try {
    const { workflow, calls } = makeWorkflow();
    await workflow.applyImageEdit({
      sessionId: 'session-1',
      imageBlob: { type: 'image/png', marker: 'ORIGINAL' },
      edit: {
        mode: 'annotate',
        annotatedBlob: { type: 'image/png', marker: 'ANNOTATED' },
        prompt: '\u628a\u6807\u6ce8\u533a\u57df\u6539\u6210\u84dd\u8272',
      },
    });
    const { options } = calls[0];
    assert.strictEqual((options.maskAttachments || []).length, 0, 'annotation mode must not send a mask');
    assert.ok(String(options.attachments[0].src || '').includes('ANNOTATED'),
      'annotation mode must dispatch the composited image');
    assert.strictEqual(options.dispatchContract.arguments.prompt, '\u628a\u6807\u6ce8\u533a\u57df\u6539\u6210\u84dd\u8272');
  } finally {
    restore();
  }
}

async function testCommentEditSendsNumberedPromptWithoutMask() {
  const restore = installFileReader();
  try {
    const { workflow, calls } = makeWorkflow();
    await workflow.applyImageEdit({
      sessionId: 'session-1',
      imageBlob: { type: 'image/png', marker: 'ORIGINAL' },
      edit: {
        mode: 'comment',
        annotatedBlob: { type: 'image/png', marker: 'COMMENTED' },
        prompt: '\u56fe\u4e2d\u6807\u6ce8\uff1a\u2460 \u628a\u624b\u6539\u6210\u84dd\u8272',
      },
    });
    const { options } = calls[0];
    assert.strictEqual((options.maskAttachments || []).length, 0, 'comment mode must not send a mask');
    assert.ok(String(options.attachments[0].src || '').includes('COMMENTED'),
      'comment mode must dispatch the numbered composite');
    assert.ok(String(options.dispatchContract.arguments.prompt || '').includes('\u2460'),
      'the numbered prompt must reach the dispatch contract');
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
    assert.strictEqual(userMessages[0].options.rawText, '\u79fb\u9664\u56fe\u7247\u80cc\u666f');
  } finally {
    restore();
  }
}

async function testResizeEditMentionsTheTargetSize() {
  const restore = installFileReader();
  try {
    const { workflow, userMessages } = makeWorkflow();
    await workflow.applyImageEdit({
      sessionId: 'session-1',
      imageBlob: { type: 'image/png' },
      edit: { mode: 'resize', size: '1536x864', prompt: 'Resize the image to 1536x864.' },
    });
    assert.strictEqual(userMessages[0].options.rawText, '\u5c06\u56fe\u7247\u8c03\u6574\u4e3a 1536x864');
  } finally {
    restore();
  }
}

module.exports = [
  testEraseEditDispatchesOneMaskAndTarget,
  testResizeEditCarriesTheCustomSize,
  testRemoveBackgroundEditRequestsTransparentPng,
  testEraseWithoutMaskDataFailsClosed,
  testAnnotateEditDispatchesTheCompositedImage,
  testCommentEditSendsNumberedPromptWithoutMask,
  testEraseEditAppearsAsAUserTurnBeforeDispatch,
  testRemoveBackgroundEditLabelsTheUserTurn,
  testResizeEditMentionsTheTargetSize,
];
