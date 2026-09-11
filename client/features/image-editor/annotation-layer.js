'use strict';
(function initChatUIImageEditorAnnotationLayer(root) {
  'use strict';

  // Numbered comments keep one shared truth between the composited image and
  // the prompt: comment N always renders the same circled label that the
  // prompt references.
  const COMMENT_LABELS = Object.freeze(['\u2460', '\u2461', '\u2462', '\u2463', '\u2464', '\u2465', '\u2466', '\u2467', '\u2468', '\u2469', '\u246a', '\u246b']);
  const DEFAULT_COLOR = '#ef4444';
  const DEFAULT_SIZE = 0.008;

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
    return COMMENT_LABELS[position] || `(${position + 1})`;
  }

  function buildCommentPrompt(comments = [], instruction = '') {
    const parts = [];
    const lines = (Array.isArray(comments) ? comments : [])
      .map((comment, index) => {
        const text = stringValue(comment?.text);
        return text ? `${commentLabel(index)} ${text}` : '';
      })
      .filter(Boolean);
    if (lines.length) parts.push(`\u56fe\u4e2d\u6807\u6ce8\uff1a${lines.join('\uff1b')}`);
    const extra = stringValue(instruction);
    if (extra) parts.push(extra);
    return parts.join('\n\n');
  }

  function shapeColor(shape = {}, fallback = DEFAULT_COLOR) {
    const color = stringValue(shape?.color);
    return color || fallback;
  }

  function shapeLineWidth(shape = {}, width = 0, height = 0) {
    const base = Math.max(1, Math.min(Number(width) || 0, Number(height) || 0));
    const size = Number(shape?.size);
    return Math.max(1, (Number.isFinite(size) && size > 0 ? size : DEFAULT_SIZE) * base);
  }

  function strokePath(ctx, points = [], toPixel) {
    const list = (Array.isArray(points) ? points : []).map(toPixel);
    if (!list.length) return false;
    ctx.beginPath();
    if (list.length === 1) {
      // A single tap still leaves a dot.
      const [point] = list;
      ctx.moveTo(point.x, point.y);
      ctx.lineTo(point.x + 0.01, point.y);
    } else {
      ctx.moveTo(list[0].x, list[0].y);
      for (let index = 1; index < list.length; index += 1) ctx.lineTo(list[index].x, list[index].y);
    }
    ctx.stroke();
    return true;
  }

  function drawArrow(ctx, shape = {}, toPixel, lineWidth) {
    const from = toPixel({ x: shape.x, y: shape.y });
    const to = toPixel({ x: shape.x2, y: shape.y2 });
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const length = Math.hypot(dx, dy);
    if (length < 1) return false;
    const angle = Math.atan2(dy, dx);
    const wing = Math.max(lineWidth * 4, length * 0.18);
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.moveTo(to.x, to.y);
    ctx.lineTo(to.x - wing * Math.cos(angle - Math.PI / 7), to.y - wing * Math.sin(angle - Math.PI / 7));
    ctx.moveTo(to.x, to.y);
    ctx.lineTo(to.x - wing * Math.cos(angle + Math.PI / 7), to.y - wing * Math.sin(angle + Math.PI / 7));
    ctx.stroke();
    return true;
  }

  function drawRect(ctx, shape = {}, toPixel, lineWidth) {
    const from = toPixel({ x: shape.x, y: shape.y });
    const to = toPixel({ x: shape.x2, y: shape.y2 });
    const left = Math.min(from.x, to.x);
    const top = Math.min(from.y, to.y);
    const width = Math.abs(to.x - from.x);
    const height = Math.abs(to.y - from.y);
    if (width < 1 || height < 1) return false;
    ctx.beginPath();
    ctx.rect(left, top, width, height);
    ctx.stroke();
    return true;
  }

  function drawText(ctx, shape = {}, toPixel, width, height) {
    const text = stringValue(shape.text);
    if (!text) return false;
    const point = toPixel({ x: shape.x, y: shape.y });
    const scale = Number(shape.size) > 0 ? Number(shape.size) : 1;
    const fontSize = Math.max(14, Math.round(Math.max(1, Math.min(width, height)) * 0.04 * scale));
    ctx.font = `600 ${fontSize}px system-ui, -apple-system, "Segoe UI", sans-serif`;
    ctx.textBaseline = 'top';
    ctx.fillText(text, point.x, point.y);
    return true;
  }

  function drawComment(ctx, comment = {}, index = 0, toPixel, width, height) {
    const point = toPixel({ x: comment.x, y: comment.y });
    const radius = Math.max(12, Math.round(Math.min(width, height) * 0.03));
    ctx.beginPath();
    ctx.arc(point.x, point.y, radius, 0, Math.PI * 2);
    ctx.fill();
    const label = commentLabel(index);
    if (!label) return true;
    const fontSize = Math.max(12, Math.round(radius * 1.15));
    ctx.font = `700 ${fontSize}px system-ui, -apple-system, "Segoe UI", sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#ffffff';
    ctx.fillText(label, point.x, point.y);
    ctx.textAlign = 'start';
    ctx.textBaseline = 'alphabetic';
    return true;
  }

  // Renders annotation shapes and numbered comment markers on a canvas that
  // already holds the source image. Coordinates are normalized so the same
  // model paints correctly on the display canvas and the full-resolution
  // composite.
  function paintAnnotations(ctx, { width = 0, height = 0, shapes = [], comments = [], color = DEFAULT_COLOR } = {}) {
    const canvasWidth = Math.max(1, Math.round(Number(width) || 0));
    const canvasHeight = Math.max(1, Math.round(Number(height) || 0));
    const toPixel = point => ({
      x: clamp01(point?.x) * canvasWidth,
      y: clamp01(point?.y) * canvasHeight,
    });
    let painted = 0;
    for (const shape of Array.isArray(shapes) ? shapes : []) {
      ctx.strokeStyle = shapeColor(shape, color);
      ctx.fillStyle = shapeColor(shape, color);
      ctx.lineWidth = shapeLineWidth(shape, canvasWidth, canvasHeight);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      if (shape?.type === 'freehand') {
        if (strokePath(ctx, shape.points, toPixel)) painted += 1;
      } else if (shape?.type === 'arrow') {
        if (drawArrow(ctx, shape, toPixel, ctx.lineWidth)) painted += 1;
      } else if (shape?.type === 'rect') {
        if (drawRect(ctx, shape, toPixel, ctx.lineWidth)) painted += 1;
      } else if (shape?.type === 'text') {
        if (drawText(ctx, shape, toPixel, canvasWidth, canvasHeight)) painted += 1;
      }
    }
    const commentColor = stringValue(color) || DEFAULT_COLOR;
    (Array.isArray(comments) ? comments : []).forEach((comment, index) => {
      ctx.fillStyle = commentColor;
      if (drawComment(ctx, comment, index, toPixel, canvasWidth, canvasHeight)) painted += 1;
    });
    return painted;
  }

  const api = Object.freeze({
    COMMENT_LABELS,
    DEFAULT_COLOR,
    DEFAULT_SIZE,
    commentLabel,
    buildCommentPrompt,
    paintAnnotations,
  });

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root?.[Symbol.for('chatui.module-registry.v1')]?.get('moduleRegistry')?.register('imageEditorAnnotationLayer', api);
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
