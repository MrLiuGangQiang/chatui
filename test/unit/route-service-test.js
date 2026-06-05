#!/usr/bin/env node
const assert = require('assert');
const {
  ROUTE_SYSTEM_PROMPT,
  stripJsonFence,
  parseRouteResult,
  inferLocalImageRoute,
  buildRoutePayload,
  extractRouteText,
} = require('../../client/services/route-service');
const { normalizeRoute } = require('../../client/core/image-route-context');

assert.ok(ROUTE_SYSTEM_PROMPT.length < 2200);
assert.ok(ROUTE_SYSTEM_PROMPT.includes('流程'));
assert.ok(ROUTE_SYSTEM_PROMPT.includes('编辑选图'));
assert.ok(ROUTE_SYSTEM_PROMPT.includes('精准选单图/多图'));
assert.ok(ROUTE_SYSTEM_PROMPT.includes('selected_reference_id'));
assert.ok(ROUTE_SYSTEM_PROMPT.includes('imgref_latest'));
assert.ok(ROUTE_SYSTEM_PROMPT.includes('selected_image_ids'));
assert.ok(ROUTE_SYSTEM_PROMPT.includes('contextual_image_prompt'));
assert.ok(ROUTE_SYSTEM_PROMPT.includes('引用型生图'));
assert.ok(ROUTE_SYSTEM_PROMPT.includes('转成适合图片模型的视觉表达提示'));
assert.ok(ROUTE_SYSTEM_PROMPT.includes('不要因为“不是视觉描述”而返回 chat'));
assert.ok(ROUTE_SYSTEM_PROMPT.includes('忽略发版、测试、配置、闲聊'));
assert.ok(ROUTE_SYSTEM_PROMPT.includes('不能默认最新图'));
assert.ok(ROUTE_SYSTEM_PROMPT.includes('必须在对应 reference 的 candidates 中匹配具体图片'));
assert.ok(ROUTE_SYSTEM_PROMPT.includes('选多张就填多个'));
assert.ok(ROUTE_SYSTEM_PROMPT.includes('无法确定具体图时不要猜'));
assert.ok(ROUTE_SYSTEM_PROMPT.includes('不要读取、分析或臆测图片内容'));
assert.ok(ROUTE_SYSTEM_PROMPT.includes('confidence 表示把握'));
assert.strictEqual(stripJsonFence('```json\n{"mode":"chat"}\n```'), '{"mode":"chat"}');
assert.strictEqual(parseRouteResult('{"mode":"image","confidence":1}', normalizeRoute).target, 'new');
assert.strictEqual(parseRouteResult('{"mode":"image","target":"new","contextual_image_prompt":"画一只蓝色机械猫","confidence":1}', normalizeRoute).contextualImagePrompt, '画一只蓝色机械猫');
assert.strictEqual(inferLocalImageRoute('生成两张图片：一个红色圆点，一个黑色圆点', [], normalizeRoute).mode, 'image');
assert.strictEqual(inferLocalImageRoute('生成一张蓝色小猫图片', [], normalizeRoute).mode, 'image');
assert.strictEqual(parseRouteResult('chat', normalizeRoute).mode, 'chat');
assert.strictEqual(parseRouteResult('edit_image', normalizeRoute).mode, 'edit_image');
assert.strictEqual(parseRouteResult('', normalizeRoute), null);
const payload = buildRoutePayload({ model: 'router', input: '改最开始的图', attachments: [{ name: 'a.png', is_image: true }], context: { recent_image_references: [] } });
assert.strictEqual(payload.model, 'router');
assert.strictEqual(payload.temperature, 0);
assert.strictEqual(payload.messages.length, 2);
assert.ok(payload.messages[0].content.includes('selected_reference_id'));
const userPayload = JSON.parse(payload.messages[1].content);
assert.strictEqual(userPayload.current_input, '改最开始的图');
assert.strictEqual(userPayload.current_mode, 'chat');
assert.strictEqual(userPayload.auto_mode, true);
assert.deepStrictEqual(userPayload.attachments, [{ name: 'a.png', is_image: true }]);
assert.deepStrictEqual(userPayload.context, { recent_image_references: [] });
assert.strictEqual(extractRouteText({ choices: [{ message: { content: 'ok' } }] }), 'ok');
assert.strictEqual(extractRouteText({ output_text: 'fallback' }), 'fallback');
console.log('route service ok');
