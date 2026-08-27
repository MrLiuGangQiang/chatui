'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const routeService = require('../../client/services/route-service');

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

function publishedImageKeys(context, input) {
  const catalog = routeService.buildRouteResourceCandidates({
    attachments: [],
    context,
    input,
    currentTurn: { messageIndex: 40 },
  });
  return catalog.filter(candidate => candidate.type === 'image').map(candidate => candidate.candidate_key).sort();
}

function testHistoricalImageCandidatesStayPublishedAsEvidenceForTheModel() {
  // Architecture boundary: local routing must not hide stale candidates by
  // focus/keyword and decide semantics for the intent model. The fix for an
  // ambiguous text follow-up ("哪个效果最好") lives in the route prompt, which
  // tells the model to resolve the anaphora against the recent text topic.
  assert.deepStrictEqual(publishedImageKeys(staleTextContext(), '哪个效果最好'), ['i1', 'i2', 'i3'],
    'historical image candidates remain model evidence and must not be hidden locally');
}

function testRoutePromptDeclaresTextFocusTopicPriority() {
  const source = fs.readFileSync(path.join(__dirname, '../../client/services/route-prompts.js'), 'utf8');
  assert.ok(source.includes('conversation_focus=text且输入无图片词汇'),
    'the router prompt must state that a text-focused ambiguous anaphora stays on the text topic');
  assert.ok(source.includes('不因历史图片候选存在就判成图片任务'),
    'the prompt must forbid judging an image task merely because historical image candidates exist');
}

function testRoutePromptStaysWithinBoundedLength() {
  const source = fs.readFileSync(path.join(__dirname, '../../client/services/route-prompts.js'), 'utf8');
  const start = source.indexOf('const ROUTE_SYSTEM_PROMPT = [');
  const end = source.indexOf('].join(', start);
  assert.ok(start >= 0 && end > start, 'route system prompt block must be present');
  const block = source.slice(start, end);
  const matches = [...block.matchAll(/^\s*'((?:[^'\\]|\\.)*)'\s*$/gm)];
  const promptLength = matches.map(match => match[1].replace(/\\'/g, "'").replace(/\\\\/g, '\\')).join('\n').length;
  assert.ok(promptLength <= 5000, `route system prompt must remain bounded, got ${promptLength}`);
}

module.exports = [
  testHistoricalImageCandidatesStayPublishedAsEvidenceForTheModel,
  testRoutePromptDeclaresTextFocusTopicPriority,
  testRoutePromptStaysWithinBoundedLength,
];
