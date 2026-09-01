'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const routeService = require('../../client/services/route-service');
const routePrompts = require('../../client/services/route-prompts');
const imageRouteContext = require('../../client/core/image-route-context');

function imageCandidate(index, description, messageIndex) {
  return {
    index,
    source_index: index,
    source: 'history',
    image_id: `img-${messageIndex}-${index}`,
    reference_id: `imgref-${messageIndex}`,
    target: 'previous',
    message_index: messageIndex,
    description,
    prompt: description,
  };
}

function staleTextContext() {
  const recentMessages = [
    { index: 5, role: 'user', content: '分别画五个科幻场景的图' },
    { index: 6, role: 'assistant', content: '[图片生成完成] 未来科幻城市、宇宙飞船、机器人' },
  ];
  for (let index = 7; index <= 39; index += 1) {
    recentMessages.push({
      index,
      role: index % 2 === 1 ? 'user' : 'assistant',
      content: `第${index}条 OpenResty h2 相关 ${index % 2 === 1 ? '问题' : '回答'}`,
    });
  }
  return {
    recent_messages: recentMessages,
    image_candidates: [
      imageCandidate(1, '未来科幻城市', 6),
      imageCandidate(2, '宇宙飞船航行', 6),
      imageCandidate(3, '沙漠星球机器人', 6),
    ],
    file_candidates: [],
    conversation_focus: {
      schema_version: 'conversation_focus.v1',
      kind: 'text',
      source_message_index: 38,
      text_message_index: 38,
      image_message_index: 6,
      context_role: 'conversation_focus',
    },
  };
}

function recentTextContext() {
  return {
    recent_messages: [
      { index: 1, role: 'user', content: '生成一辆红色跑车' },
      { index: 2, role: 'assistant', content: '[图片生成完成] 一辆红色跑车' },
      { index: 3, role: 'user', content: '输出一个md' },
      { index: 4, role: 'assistant', content: '# Markdown 示例' },
    ],
    image_candidates: [imageCandidate(1, '一辆红色跑车', 2)],
    file_candidates: [],
    conversation_focus: {
      schema_version: 'conversation_focus.v1',
      kind: 'text',
      source_message_index: 4,
      text_message_index: 4,
      image_message_index: 2,
      context_role: 'conversation_focus',
    },
  };
}

function publishedImageKeys(context, input) {
  const catalog = routeService.buildRouteResourceCandidates({
    attachments: [],
    context,
    input,
    currentTurn: { messageIndex: 40 },
  });
  return catalog.filter(candidate => candidate.type === 'image').map(candidate => candidate.candidate_key).sort();
}

function testStaleTextFocusFoldsOldImageCandidates() {
  for (const input of ['哪个效果最好', '哪个协议效果最好', '那这个呢']) {
    assert.deepStrictEqual(publishedImageKeys(staleTextContext(), input), [],
      `stale generated images must be folded away for a non-image text follow-up: ${input}`);
  }
}

function testRecentTextFocusKeepsTheLatestGeneratedImage() {
  for (const input of ['要复杂一点', '换个颜色', '这个效果怎么样']) {
    assert.deepStrictEqual(publishedImageKeys(recentTextContext(), input), ['i1'],
      `a recent image result must remain addressable even under a text focus: ${input}`);
  }
}

function testImageFocusKeepsImageCandidatesForAmbiguousComparison() {
  const context = staleTextContext();
  context.conversation_focus.kind = 'image';
  assert.deepStrictEqual(publishedImageKeys(context, '哪个效果最好'), ['i1', 'i2', 'i3'],
    'right after an image result, an ambiguous comparison may still refer to those images');
}

function testTextFocusExplicitImageReferenceKeepsStaleImageCandidates() {
  for (const input of ['继续画第二张', '第二张', '把第二张改成黑白']) {
    assert.deepStrictEqual(publishedImageKeys(staleTextContext(), input), ['i1', 'i2', 'i3'],
      `explicit image vocabulary (${input}) must keep historical candidates published`);
  }
}

function testUnknownFocusKeepsHistoricalImageCandidates() {
  const context = staleTextContext();
  delete context.conversation_focus;
  assert.deepStrictEqual(publishedImageKeys(context, '哪个效果最好'), ['i1', 'i2', 'i3'],
    'without an explicit text focus, historical candidates must keep the legacy behavior');
}

function testRoutePromptDeclaresTextFocusTopicPriority() {
  const source = fs.readFileSync(path.join(__dirname, '../../client/services/route-prompts.js'), 'utf8');
  assert.ok(source.includes('conversation_focus=text且无图片词汇'),
    'the router prompt must state that a text-focused ambiguous anaphora stays on the text topic');
  assert.ok(source.includes('不因历史图片候选存在就判成图片任务'),
    'the prompt must forbid judging an image task merely because historical image candidates exist');
}

function testRoutePromptStaysWithinBoundedLength() {
  const routeNodeLength = routePrompts.ROUTE_NODE_SYSTEM_PROMPT_LINES.join('\n').length;
  const understandLength = routePrompts.UNDERSTAND_SYSTEM_PROMPT_LINES.join('\n').length;
  assert.ok(routeNodeLength <= 6400, 'route node prompt must remain bounded, got ' + routeNodeLength);
  assert.ok(understandLength <= 2600, 'understand node prompt must remain bounded, got ' + understandLength);
}

function testRoutePromptDeclaresPriorityAnchorsAndInteractionModes() {
  const source = fs.readFileSync(path.join(__dirname, '../../client/services/route-prompts.js'), 'utf8');
  assert.ok(source.includes('【优先级】严格按current_input与当前附件>current_input明确引用的quoted'),
    'the router prompt must not let historical understanding override the current request');
  assert.ok(source.includes('无图片词汇的模糊续问默认跟随最近文字话题'),
    'ambiguous text-only follow-ups must resolve to the recent text topic');
  assert.ok(source.includes('【引用与附件】'),
    'the router prompt must distinguish quoted context from current attachments');
  assert.ok(source.includes('quoted只有在current_input明确指向时才补充') && source.includes('当前附件是本轮最高优先级资源'),
    'quoted context must be conditional while current attachments remain highest priority');
  assert.ok(source.includes('带附件的组合请求') && source.includes('不得丢动作'),
    'combination requests must preserve every requested action in goal');
}

function testRecentRouteMessagesCarryMoreContextThanOlderHistory() {
  const messages = Array.from({ length: 10 }, (_, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    id: 'message-' + (index + 1),
    content: 'message ' + (index + 1) + ' ' + 'x'.repeat(600),
  }));
  const context = imageRouteContext.buildRouteContext({ messages, maxChars: 256 * 1024 });
  const older = context.recent_messages.slice(0, -6);
  const recent = context.recent_messages.slice(-6);
  assert.ok(older.every(message => message.content.length <= 240),
    'older history must stay compact for the intent model');
  assert.ok(recent.every(message => message.content.length > 240),
    'the most recent turns must keep more of their content so the intent model understands the current topic');
}

module.exports = [
  testStaleTextFocusFoldsOldImageCandidates,
  testRecentTextFocusKeepsTheLatestGeneratedImage,
  testImageFocusKeepsImageCandidatesForAmbiguousComparison,
  testTextFocusExplicitImageReferenceKeepsStaleImageCandidates,
  testUnknownFocusKeepsHistoricalImageCandidates,
  testRoutePromptDeclaresTextFocusTopicPriority,
  testRoutePromptStaysWithinBoundedLength,
  testRoutePromptDeclaresPriorityAnchorsAndInteractionModes,
  testRecentRouteMessagesCarryMoreContextThanOlderHistory,
];
