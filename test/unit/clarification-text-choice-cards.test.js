'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const presentation = require('../../client/features/clarification/presentation');

const LONG_DESC = '一位年轻优雅的中国女性，精致自然的五官，温柔自信的微笑，乌黑柔顺的长发，白皙细腻的肌肤，身穿简约高级的现代中式连衣裙，站在江南园林的石桥旁，背景有柳树、古典亭台与轻雾，清晨柔和自然光，电影级人像摄影，浅景深，真实皮肤纹理，高细节，8K，构图干净，高级时尚杂志风格。';

function testTextChoiceCardsRenderClampedLabels() {
  const rendered = presentation.buildClarificationPresentation({
    clarificationQuestion: '检测到多个相关描述，请选择要基于哪一条生成图片：',
    clarificationSlots: [{
      key: 'r1',
      type: 'text',
      role: 'source',
      reason: 'ambiguous',
      choices: [
        { key: 'c1', label: LONG_DESC },
        { key: 'c2', label: '一位成年美国女性的时尚肖像，纽约街头背景。' },
      ],
    }],
  }, {});
  assert.strictEqual(rendered.hasChoices, true);
  assert.strictEqual(rendered.hasImageChoices, false);
  assert.ok(rendered.html.includes('clarification-choice-button'), 'text choices must render as card buttons');
  assert.ok(rendered.html.includes('clarification-choice-list'),
    'text choices must use their own full-width list instead of image-card geometry');
  assert.ok(!rendered.html.includes('选项组 1'),
    'a single unlabeled choice group must not render a synthetic heading');
  assert.ok(rendered.html.includes(`data-choice-label="${LONG_DESC}"`),
    'the full label must be preserved for answer matching');
  assert.ok(rendered.html.includes('…'), 'long labels must be truncated with an ellipsis');
  const visible = rendered.html.match(/<span class="clarification-choice-label">([\s\S]*?)<\/span>/g) || [];
  for (const span of visible) {
    const text = span.replace(/<[^>]+>/g, '');
    assert.ok(text.length <= 96 + 1, `visible label must stay within the display budget: ${text.length}`);
  }
}


function testTextChoiceListUsesSimpleAlignedRows() {
  const css = fs.readFileSync(path.join(__dirname, '../../styles/messages.css'), 'utf8');
  assert.match(css, /\.markdown-body \.clarification-choice-list\{[\s\S]*?grid-template-columns:minmax\(0,1fr\);[\s\S]*?width:min\(460px,100%\);/,
    'text clarification choices must render as one aligned list');
  assert.match(css, /\.markdown-body \.clarification-choice-list>\.clarification-choice-card\{[\s\S]*?width:100%;/,
    'each text choice row must fill the same list width');
  assert.match(css, /\.clarification-presentation\[data-clarification-choice-options="1"\] \.clarification-choice-number\{[\s\S]*?border-radius:6px;[\s\S]*?background:#eff6ff;/,
    'text choice numbers must use the quiet badge style rather than the image strip style');
}

module.exports = [
  testTextChoiceCardsRenderClampedLabels,
  testTextChoiceListUsesSimpleAlignedRows,
];
