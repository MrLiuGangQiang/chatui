'use strict';
(function initChatUIImageEditorCommentLayer(root) {
  'use strict';

  // Numbered comments keep one shared truth between the composited image and
  // the prompt: comment N always renders the same plain number that the
  // prompt references.
  const DEFAULT_COLOR = '#111827';

  function stringValue(value = '') {
    return String(value ?? '').trim();
  }

  function clamp01(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return 0;
    return Math.min(1, Math.max(0, number));
  }

  function commentLabel(index = 0) {
    const position = Number(index);
    if (!Number.isInteger(position) || position < 0) return '';
    return String(position + 1);
  }

  function buildCommentPrompt(comments = [], instruction = '') {
    const parts = [];
    const lines = (Array.isArray(comments) ? comments : [])
      .map((comment, index) => {
        const text = stringValue(comment?.text);
        if (!text) return '';
        const x = clamp01(comment?.x).toFixed(3);
        const y = clamp01(comment?.y).toFixed(3);
        return `${commentLabel(index)}. 位置 (x=${x}, y=${y})：${text}`;
      })
      .filter(Boolean);
    if (lines.length) {
      parts.push([
        '图片上有一个编辑蒙版：蒙版中的透明区域是允许修改的位置，其余区域必须保持不变。',
        '请只修改以下编号位置对应的原始内容，结果中不要添加或保留任何编号标记：',
        ...lines,
      ].join('\n'));
    }
    const extra = stringValue(instruction);
    if (extra) parts.push(extra);
    return parts.join('\n\n');
  }

  function drawComment(ctx, comment = {}, index = 0, toPixel, width, height) {
    const point = toPixel({ x: comment.x, y: comment.y });
    const radius = Math.min(17, Math.max(8, Math.round(Math.min(width, height) * 0.0155)));
    const label = commentLabel(index);
    const ringWidth = Math.max(1.5, radius * 0.14);
    ctx.beginPath();
    ctx.arc(point.x, point.y, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.save?.();
    if ('shadowColor' in ctx) ctx.shadowColor = 'rgba(15,23,42,.32)';
    if ('shadowBlur' in ctx) ctx.shadowBlur = Math.max(2, radius * 0.4);
    if ('shadowOffsetY' in ctx) ctx.shadowOffsetY = Math.max(1, radius * 0.08);
    ctx.beginPath();
    ctx.arc(point.x, point.y, radius + ringWidth / 2, 0, Math.PI * 2);
    ctx.lineWidth = ringWidth;
    ctx.strokeStyle = '#ffffff';
    ctx.stroke();
    ctx.restore?.();
    if (!label) return true;
    const fontSize = Math.max(8, Math.round(radius * 0.98));
    ctx.font = `700 ${fontSize}px "Segoe UI", Arial, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    let textX = point.x;
    let textY = point.y;
    if (typeof ctx.measureText === 'function') {
      const metrics = ctx.measureText(label) || {};
      const left = Number(metrics.actualBoundingBoxLeft);
      const right = Number(metrics.actualBoundingBoxRight);
      const ascent = Number(metrics.actualBoundingBoxAscent);
      const descent = Number(metrics.actualBoundingBoxDescent);
      if (Number.isFinite(left) && Number.isFinite(right)) textX = point.x + (left - right) / 2;
      if (Number.isFinite(ascent) && Number.isFinite(descent)) textY = point.y + (ascent - descent) / 2;
    } else {
      ctx.textBaseline = 'middle';
    }
    ctx.fillStyle = '#ffffff';
    ctx.fillText(label, textX, textY);
    ctx.textAlign = 'start';
    ctx.textBaseline = 'alphabetic';
    return true;
  }
  // Renders numbered comment markers on a canvas that already holds the source
  // image. Coordinates are normalized so the same model paints correctly on
  // the display canvas and the full-resolution composite.
  function paintComments(ctx, { width = 0, height = 0, comments = [], color = DEFAULT_COLOR } = {}) {
    const canvasWidth = Math.max(1, Math.round(Number(width) || 0));
    const canvasHeight = Math.max(1, Math.round(Number(height) || 0));
    const toPixel = point => ({
      x: clamp01(point?.x) * canvasWidth,
      y: clamp01(point?.y) * canvasHeight,
    });
    let painted = 0;
    const commentColor = stringValue(color) || DEFAULT_COLOR;
    (Array.isArray(comments) ? comments : []).forEach((comment, index) => {
      ctx.fillStyle = commentColor;
      if (drawComment(ctx, comment, index, toPixel, canvasWidth, canvasHeight)) painted += 1;
    });
    return painted;
  }

  const api = Object.freeze({
    DEFAULT_COLOR,
    commentLabel,
    buildCommentPrompt,
    paintComments,
  });

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root?.[Symbol.for('chatui.module-registry.v1')]?.get('moduleRegistry')?.register('imageEditorCommentLayer', api);
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
