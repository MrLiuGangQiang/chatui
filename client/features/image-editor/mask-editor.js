'use strict';
(function initChatUIImageEditorMaskEditor(root) {
  'use strict';

  const commentLayer = root?.[Symbol.for('chatui.module-registry.v1')]?.get('imageEditorCommentLayer')
    || (typeof require === 'function' ? require('./comment-layer') : {});

  const EDITOR_STYLE_ID = 'chatui-image-editor-style';

  // Record thumbnails always sample a small fixed window centered on the
  // marker or the stroke center; following the stroke bounding box made the
  // crop grow until it covered a large part of the image.
  const RECORD_THUMBNAIL_CROP_SCALE = 0.15;
  const RECORD_THUMBNAIL_RATIO = 4 / 3;
  const RECORD_THUMBNAIL_WIDTH = 120;
  const RECORD_THUMBNAIL_HEIGHT = 90;

  const EDITOR_CSS = `
.image-editor-backdrop{--image-editor-blue:#0872f3;--image-editor-blue-deep:#0068f2;--image-editor-ink:#182642;--image-editor-muted:#5d7195;--image-editor-line:#e5edf8;position:fixed;inset:0;z-index:1200;display:flex;overflow:hidden;background:radial-gradient(circle at 50% 18%,rgba(255,255,255,.98) 0,rgba(255,255,255,0) 32%),linear-gradient(180deg,#f8fbff 0,#edf3fb 100%);color:var(--image-editor-ink);font-family:"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
.image-editor-backdrop *,.image-editor-backdrop *:before,.image-editor-backdrop *:after{box-sizing:border-box}
.image-editor-panel{width:100%;height:100%;display:flex;flex-direction:column;overflow:hidden}
.image-editor-body{position:relative;display:flex;flex:1 1 auto;min-height:0;flex-direction:column;align-items:center;overflow:hidden;padding:14px 20px 12px;background:transparent}
.image-editor-workbench{display:flex;flex:1 1 auto;width:100%;min-height:0;align-items:stretch;justify-content:center;gap:16px}
.image-editor-toolbar,.image-editor-comment-panel{min-height:0;border:1px solid #e6eef8;border-radius:14px;background:rgba(255,255,255,.985);box-shadow:0 18px 44px rgba(34,78,132,.075);overflow:hidden;z-index:3}
.image-editor-toolbar{display:flex;flex:0 0 292px;flex-direction:column;align-items:stretch;gap:4px;padding:4px 10px 18px}
.image-editor-toolbar-title{margin:4px 20px 2px;font-size:20px;font-weight:700;line-height:1.4}
.image-editor-tool{position:relative;display:flex;align-items:center;gap:15px;min-height:58px;padding:0 16px;border:0;border-radius:10px;background:transparent;color:#1f2d4a;font-family:inherit;font-size:16px;line-height:1;text-align:left;cursor:pointer}
.image-editor-tool svg{width:24px;height:24px;flex:none}
.image-editor-tool:hover{background:#f1f6fd}
.image-editor-tool[aria-pressed=true]{background:linear-gradient(135deg,#0873f4,#006af2);color:#fff;box-shadow:0 7px 16px rgba(0,105,242,.2)}
.image-editor-canvas{width:760px;height:100%;flex:0 0 760px;min-width:0;min-height:0;display:flex;align-items:center;justify-content:flex-start;overflow:hidden;padding:4px;background:transparent;overscroll-behavior:contain}
.image-editor-stage{position:relative;flex:0 0 auto;margin:auto;line-height:0;transform:translateZ(0)}
.image-editor-stage canvas{display:block;max-width:none;max-height:none;border-radius:7px}
.image-editor-stage .image-editor-base{box-shadow:0 7px 18px rgba(28,72,126,.18)}
.image-editor-overlay{position:absolute;left:0;top:0;cursor:crosshair;touch-action:none}
.image-editor-comment-panel{position:relative;display:flex;flex:0 0 360px;flex-direction:column;border-radius:14px}
.image-editor-comment-header{display:flex;flex:0 0 58px;height:58px;align-items:center;justify-content:space-between;padding:0 18px;border-bottom:1px solid #e8f0f9;background:linear-gradient(180deg,#ffffff,#fbfdff)}
.image-editor-comment-title{color:#20304f;font-size:17px;font-weight:650}
.image-editor-comment-count{display:grid;place-items:center;min-width:30px;height:28px;padding:0 9px;border-radius:999px;background:#eaf3ff;color:#0872f3;font-size:13px;font-weight:700;line-height:1}
.image-editor-comment-list{display:flex;flex:1 1 auto;min-height:0;flex-direction:column;gap:8px;overflow:auto;padding:10px 12px 18px;background:#fbfdff}
.image-editor-comment-empty{margin:auto;padding:36px 20px;text-align:center;color:#8394b1;font-size:14px}
.image-editor-comment-card{position:relative;display:grid;grid-template-columns:40px minmax(0,1fr) auto;gap:11px;padding:12px;border:1px solid #e9f1fa;border-radius:11px;background:#fff;box-shadow:0 3px 10px rgba(37,83,139,.045)}
.image-editor-comment-index{display:grid;place-items:center;align-self:start;width:32px;height:32px;margin:1px auto 0;border-radius:50%;background:#2563eb;color:#fff;font-size:14px;font-weight:700;line-height:1;box-shadow:0 3px 9px rgba(37,99,235,.18)}
.image-editor-comment-index svg{width:16px;height:16px;stroke-width:2.2}
.image-editor-comment-copy{min-width:0;padding-top:1px}
.image-editor-comment-copy strong{display:block;color:#263653;font-size:15px;font-weight:700;line-height:1.5;overflow-wrap:anywhere}
.image-editor-comment-card[data-modification-type=comment] .image-editor-comment-copy strong{font-weight:400}
.image-editor-comment-copy p{margin:4px 0 0;color:#6c7c9d;font-size:13px;line-height:1.65;white-space:pre-wrap;overflow-wrap:anywhere}
.image-editor-record-visual{display:flex;min-width:0;flex-direction:column;align-items:flex-end;gap:6px}
.image-editor-record-actions{display:flex;justify-content:flex-end;gap:4px}
.image-editor-record-action{display:grid;place-items:center;width:28px;height:28px;padding:0;border:0;border-radius:8px;background:transparent;color:#7b8aa7;cursor:pointer}
.image-editor-record-action:hover{background:#eef5fd;color:#0872f3}
.image-editor-record-action.danger:hover{background:#fff1f2;color:#e11d48}
.image-editor-record-action svg{width:14px;height:14px}
.image-editor-comment-thumbnail{display:block;width:88px;height:66px;border:1px solid #dbe7f5;border-radius:8px;background:#f8fafc;object-fit:cover}
.image-editor-record-editor{display:block;width:100%;height:36px;border:0;border-radius:8px;padding:0;background:#fff;box-shadow:inset 0 0 0 1px #dbe7f5;color:#263653;font:inherit;font-size:13px;line-height:1.65;outline:0;resize:vertical;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere}
.image-editor-record-editor:focus{box-shadow:inset 0 0 0 1px #0872f3,0 0 0 2px rgba(8,114,243,.1)}
.image-editor-record-editor-actions{display:flex;justify-content:flex-end;gap:6px;margin-top:7px}
.image-editor-record-editor-button{height:30px;padding:0 10px;border:1px solid #dbe7f5;border-radius:8px;background:#fff;color:#40536f;font:inherit;font-size:12px;cursor:pointer}
.image-editor-record-editor-button.save{border-color:#0872f3;background:#0872f3;color:#fff}
.image-editor-footer{position:relative;z-index:4;flex:0 0 58px;width:100%;height:58px;margin-top:12px;display:grid;grid-template-columns:minmax(160px,1fr) auto minmax(260px,1fr);align-items:center;padding:0 14px;border:1px solid #e4edf8;border-radius:14px;background:linear-gradient(180deg,#fbfdff,#f6f9fd);box-shadow:0 10px 28px rgba(34,78,132,.055)}
.image-editor-file-info{display:flex;align-items:center;min-width:0;color:#536b99;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.image-editor-footer-controls{display:inline-flex;align-items:center;justify-content:center;gap:8px;white-space:nowrap}
.image-editor-control{display:inline-flex;align-items:center;justify-content:center;gap:7px;height:40px;padding:0 10px;border:0;border-radius:8px;background:transparent;color:#263653;font-family:inherit;font-size:14px;line-height:1;cursor:pointer}
.image-editor-control svg{width:19px;height:19px;flex:none}
.image-editor-control:hover{background:#eef5fd}
.image-editor-control:disabled{color:#aab7ca;background:transparent;cursor:default}
.image-editor-action{display:inline-flex;align-items:center;justify-content:center;gap:8px;height:42px;padding:0 15px;border:1px solid #dfe8f3;border-radius:9px;background:#fff;color:#1d2d4b;font-family:inherit;font-size:14px;line-height:1;white-space:nowrap;cursor:pointer}
.image-editor-action svg{width:19px;height:19px;flex:none}
.image-editor-action:hover{background:#f8fbff}
.image-editor-action.primary{min-width:150px;border-color:#0872f3;background:#0872f3;color:#fff;box-shadow:0 5px 12px rgba(8,114,243,.14)}
.image-editor-action.primary:hover{background:#0068ea}
.image-editor-action.danger{min-width:112px;border-color:#ffd9dc;background:#fff;color:#f35c64}
.image-editor-action.danger svg{color:#f35c64}
.image-editor-action.danger:hover{background:#fff7f8}
.image-editor-action:disabled{border-color:#e8eef6;background:#f8fafc;color:#b2bece;box-shadow:none;cursor:default}
.image-editor-action[hidden],.image-editor-tool-options[hidden]{display:none}
.image-editor-footer-actions{display:inline-flex;align-items:center;justify-self:end;gap:10px}
.image-editor-hint{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}
.image-editor-tool-options{margin-top:auto;padding:12px 5px 0;border-top:1px solid #edf3fa}
.image-editor-brush{display:none;align-items:center;gap:8px;min-height:38px;padding:0 11px;color:#50658e;font-size:13px;white-space:nowrap}
.image-editor-brush input{flex:1;min-width:80px;accent-color:#0872f3}
.image-editor-row{display:none;align-items:center;gap:8px;width:100%;padding-top:8px}
.image-editor-row.active{display:flex}
.image-editor-row input{width:100%;height:38px;padding:0 11px;border:1px solid #dce7f4;border-radius:8px;background:#fff;color:#20304f;font-family:inherit;font-size:12px;outline:none}
.image-editor-row input:focus{border-color:#8bbcf8;box-shadow:0 0 0 2px rgba(8,114,243,.1)}
.image-editor-comment-popover{position:absolute;z-index:6;display:none;align-items:center;gap:6px;padding:6px 8px;border:1px solid rgba(27,48,80,.08);border-radius:12px;background:#fff;box-shadow:0 10px 30px rgba(15,23,42,.22);line-height:normal}
.image-editor-comment-popover.active{display:inline-flex}
.image-editor-comment-popover input{width:190px;border:0;outline:0;background:transparent;color:#17233b;font:inherit;font-size:13px}
.image-editor-comment-confirm,.image-editor-comment-cancel{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border:0;border-radius:50%;cursor:pointer}
.image-editor-comment-confirm{background:#0872f3;color:#fff}
.image-editor-comment-confirm svg{width:15px;height:15px}
.image-editor-comment-cancel{background:transparent;color:#64748b}
.image-editor-comment-cancel svg{width:14px;height:14px}
@media (max-width:1500px){
.image-editor-body{padding-left:14px;padding-right:14px}
.image-editor-workbench{gap:12px}
.image-editor-toolbar{flex-basis:268px}
.image-editor-comment-panel{flex-basis:330px}
.image-editor-footer{grid-template-columns:minmax(150px,1fr) auto minmax(250px,1fr)}
}
@media (max-width:1180px){
.image-editor-toolbar{flex-basis:228px}
.image-editor-comment-panel{flex-basis:290px}
.image-editor-control span{display:none}
.image-editor-file-info{font-size:12px}
.image-editor-action.primary{min-width:140px}
}
@media (max-width:980px){
.image-editor-body{overflow:auto;padding:12px}
.image-editor-workbench{flex:0 0 auto;width:100%;flex-direction:column;align-items:stretch}
.image-editor-toolbar,.image-editor-comment-panel{flex:0 0 auto;width:100%}
.image-editor-canvas{width:100%;height:420px;flex-basis:420px}
.image-editor-comment-panel{height:380px}
.image-editor-footer{width:100%;height:auto;min-height:70px;grid-template-columns:1fr auto;gap:8px;padding:10px 14px}
.image-editor-file-info{grid-column:1/-1;justify-content:center}
.image-editor-footer-controls{justify-self:start}
.image-editor-footer-actions{grid-column:1/-1;width:100%;justify-content:flex-end}
}
@media (max-width:700px){
.image-editor-footer-actions{justify-content:stretch}
.image-editor-action.primary{flex:1}
}
`;

  const COMMENT_CURSOR = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='28' height='28' viewBox='0 0 28 28'%3E%3Cg fill='none' stroke-linecap='round'%3E%3Ccircle cx='14' cy='14' r='8' stroke='%23ffffff' stroke-width='4.4'/%3E%3Ccircle cx='14' cy='14' r='8' stroke='%23111827' stroke-width='2'/%3E%3Cpath d='M14 2v5M14 21v5M2 14h5M21 14h5' stroke='%23ffffff' stroke-width='4.4'/%3E%3Cpath d='M14 2v5M14 21v5M2 14h5M21 14h5' stroke='%23111827' stroke-width='2'/%3E%3C/g%3E%3Ccircle cx='14' cy='14' r='1.7' fill='%23111827'/%3E%3C/svg%3E") 14 14, crosshair`;
  const COMMENT_ICON = '<path d="M20.5 4.5h-17A1.5 1.5 0 0 0 2 6v10a1.5 1.5 0 0 0 1.5 1.5H7v4l5-4h8.5a1.5 1.5 0 0 0 1.5-1.5V6a1.5 1.5 0 0 0-1.5-1.5Z"/><path d="M12 8.5v5"/><path d="M9.5 11h5"/>';
  const BACKGROUND_ICON = '<circle cx="12" cy="8" r="3"/><path d="M6.5 19c.6-3.8 2.4-5.7 5.5-5.7s4.9 1.9 5.5 5.7"/><path d="M4 8V4h4M16 4h4v4M20 16v4h-4M8 20H4v-4"/>';
  const ERASE_ICON = '<path d="m7 21-4.3-4.3a1 1 0 0 1 0-1.4L13.4 4.6a1 1 0 0 1 1.4 0l5.6 5.6a1 1 0 0 1 0 1.4L11 21"/><path d="M22 21H7"/><path d="m5 11 9 9"/>';
  const ENHANCE_ICON = '<path d="m12 3 1.2 3.3L16.5 7.5l-3.3 1.2L12 12l-1.2-3.3-3.3-1.2 3.3-1.2Z"/><path d="m18.5 14 .8 2.1 2.2.9-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.9Z"/><path d="m6 14 .7 1.8 1.8.7-1.8.7L6 19l-.7-1.8-1.8-.7 1.8-.7Z"/>';
  const EDIT_ICON = '<path d="m4 20 4.5-1 10-10a2.1 2.1 0 0 0-3-3l-10 10L4 20Z"/><path d="m14.5 7.5 2 2"/>';
  const APPLY_ICON = '<path d="m5 12.5 4.5 4.5L19 7"/>';
  const CANCEL_ICON = '<path d="m7 7 10 10"/><path d="m17 7-10 10"/>';
  const CLEAR_ICON = '<path d="M4 7h16"/><path d="M9 7V4h6v3"/><path d="m6.5 7 1 13h9l1-13"/><path d="M10 11v5M14 11v5"/>';
  const UNDO_ICON = '<path d="M9 7 4 12l5 5"/><path d="M5 12h9a5 5 0 0 1 5 5v1"/>';
  const REDO_ICON = '<path d="m15 7 5 5-5 5"/><path d="M19 12h-9a5 5 0 0 0-5 5v1"/>';
  const COMMENT_COLOR_PALETTE = Array.isArray(commentLayer.COMMENT_COLORS) && commentLayer.COMMENT_COLORS.length
    ? commentLayer.COMMENT_COLORS
    : ['#2563eb', '#7c3aed', '#db2777', '#dc2626', '#ea580c', '#0f766e', '#0891b2', '#4f46e5', '#16a34a'];
  function commentColorFor(index = 0, offset = 0) {
    if (typeof commentLayer.commentColorAt === 'function') return commentLayer.commentColorAt(index, offset);
    const paletteIndex = ((Number(index) + Number(offset)) % COMMENT_COLOR_PALETTE.length + COMMENT_COLOR_PALETTE.length) % COMMENT_COLOR_PALETTE.length;
    return COMMENT_COLOR_PALETTE[paletteIndex];
  }
  function toolbarIcon(paths) {
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
  }

  function clamp01(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return 0;
    return Math.min(1, Math.max(0, number));
  }

  function strokeContainsPoint(stroke = {}, x = 0, y = 0) {
    const dx = Number(x) - Number(stroke.x);
    const dy = Number(y) - Number(stroke.y);
    const radius = Math.max(0, Number(stroke.radius) || 0);
    return dx * dx + dy * dy <= radius * radius;
  }

  // The exported mask keeps the OpenAI semantics: transparent pixels are the
  // area to edit, opaque white pixels must be preserved. This pure helper
  // mirrors what paintMask draws on the canvas so pixel semantics stay
  // testable without a DOM.
  function maskAlphaAtPoint(strokes = [], x = 0, y = 0) {
    const list = Array.isArray(strokes) ? strokes : [];
    return list.some(stroke => strokeContainsPoint(stroke, x, y)) ? 0 : 255;
  }

  function normalizeStrokePoint(event = {}, rect = {}) {
    const width = Number(rect.width) || 0;
    const height = Number(rect.height) || 0;
    if (!width || !height) return { x: 0, y: 0 };
    return {
      x: clamp01((Number(event.clientX) - Number(rect.left)) / width),
      y: clamp01((Number(event.clientY) - Number(rect.top)) / height),
    };
  }

  function buildEnhancePrompt() {
    return '提升这张图片的清晰度。增强细节、纹理、边缘和局部对比度，减少模糊、噪点与压缩伪影；保持原始构图、主体、姿态、颜色、光照、风格和文字内容不变，不要添加或删除任何元素。';
  }

  function strokeBoundsData(strokes = []) {
    const points = (Array.isArray(strokes) ? strokes : [])
      .map(stroke => {
        const radius = Math.max(0, Number(stroke?.radius) || 0);
        const x = clamp01(stroke?.x);
        const y = clamp01(stroke?.y);
        return {
          left: clamp01(x - radius),
          right: clamp01(x + radius),
          top: clamp01(y - radius),
          bottom: clamp01(y + radius),
          x,
          y,
        };
      })
      .filter(point => Number.isFinite(point.x) && Number.isFinite(point.y));
    if (!points.length) return null;
    const left = Math.min(...points.map(point => point.left));
    const right = Math.max(...points.map(point => point.right));
    const top = Math.min(...points.map(point => point.top));
    const bottom = Math.max(...points.map(point => point.bottom));
    const centerX = points.reduce((sum, point) => sum + point.x, 0) / points.length;
    const centerY = points.reduce((sum, point) => sum + point.y, 0) / points.length;
    const horizontal = centerX < 0.4 ? '左侧' : centerX > 0.6 ? '右侧' : '中部';
    const vertical = centerY < 0.4 ? '上方' : centerY > 0.6 ? '下方' : '中部';
    return { left, right, top, bottom, centerX, centerY, horizontal, vertical };
  }

  function strokeBounds(strokes = []) {
    const bounds = strokeBoundsData(strokes);
    if (!bounds) return null;
    const { left, right, top, bottom, centerX, centerY, horizontal, vertical } = bounds;
    const direction = horizontal === '中部' && vertical === '中部'
      ? '中央'
      : horizontal === '中部'
        ? vertical
        : vertical === '中部'
          ? horizontal
          : `${horizontal}${vertical}`;
    const fixed = value => clamp01(value).toFixed(3);
    return `画面${direction}，中心 (x=${fixed(centerX)}, y=${fixed(centerY)})，边界 x=${fixed(left)}–${fixed(right)}、y=${fixed(top)}–${fixed(bottom)}`;
  }

  function buildEraseActionsPrompt(actions = []) {
    const list = (Array.isArray(actions) ? actions : []).filter(Boolean);
    return list.map((action, index) => {
      const prompt = buildSelectedAreaPrompt(action.instruction || '', action.strokes || []);
      return list.length > 1 ? `局部修改 ${index + 1}：\n${prompt}` : prompt;
    }).join('\n\n');
  }

  function buildCompositeEditPrompt({
    comments = [],
    eraseActions = [],
    eraseInstructions = [],
    hasErase = false,
    removeBackground = false,
    enhance = false,
  } = {}) {
    const hasLocalEdits = hasErase || comments.length > 0;
    const localPrompts = [];
    if (comments.length) localPrompts.push(commentLayer.buildCommentPrompt?.(comments, '') || '');
    if (hasErase) {
      const actions = eraseActions.length
        ? eraseActions
        : eraseInstructions.map(instruction => ({ instruction, strokes: [] }));
      localPrompts.push(buildEraseActionsPrompt(actions));
    }
    const localPrompt = localPrompts.filter(Boolean).join('\n\n');
    // Transparent background is not reliable when the provider has to perform
    // multiple visual operations in one image-edit call. Keep this combination
    // out of prompt construction so no caller can dispatch it by accident.
    if (removeBackground && (hasLocalEdits || enhance)) return '';
    const categoryCount = Number(hasLocalEdits) + Number(enhance) + Number(removeBackground);
    if (categoryCount <= 1) {
      return localPrompt
        || (enhance ? buildEnhancePrompt() : '')
        || (removeBackground ? '移除此图像的背景。保持所有前景主体不变且完整无损，边缘干净平滑。将背景设为透明。' : '');
    }

    const instructions = [];
    if (hasLocalEdits) {
      instructions.push(`请先只修改编辑蒙版中的透明区域，蒙版外的原始内容必须保持原样。\n${localPrompt}`);
    }
    if (enhance) {
      instructions.push(`随后，对整张图片进行清晰度提升：${buildEnhancePrompt()}`);
    }
    if (removeBackground) {
      instructions.push('最后，移除此图像的背景。保持所有前景主体、文字、姿态和边缘完整无损，边缘干净平滑，将背景设为透明。不要改变已完成的主体内容。');
    }
    return instructions.join('\n\n');
  }

  function buildSelectedAreaPrompt(instruction = '', strokes = []) {
    const value = String(instruction ?? '').trim();
    const location = strokeBounds(strokes);
    if (!value && !location) return 'Remove the selected area and fill it naturally with the surrounding background.';
    return [
      '请只修改图片中编辑蒙版覆盖的区域。',
      ...(location ? [`选中区域位置：${location}。坐标采用归一化坐标，左上角为 (0, 0)，右下角为 (1, 1)。`] : []),
      `修改内容：${value || '移除该区域内容，并根据周围环境自然补全。'}`,
      '蒙版外的原始内容必须保持不变，不要输出蒙版、编号或任何标记。',
    ].join('\n');
  }

  function paintMask(ctx, { width = 0, height = 0, strokes = [] } = {}) {
    const canvasWidth = Math.max(1, Math.round(Number(width) || 0));
    const canvasHeight = Math.max(1, Math.round(Number(height) || 0));
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvasWidth, canvasHeight);
    ctx.globalCompositeOperation = 'destination-out';
    for (const stroke of Array.isArray(strokes) ? strokes : []) {
      const radius = Math.max(1, (Number(stroke?.radius) || 0) * Math.min(canvasWidth, canvasHeight));
      ctx.beginPath();
      ctx.arc(clamp01(stroke?.x) * canvasWidth, clamp01(stroke?.y) * canvasHeight, radius, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalCompositeOperation = 'source-over';
  }

  function createImageEditor({ document: documentRef, window: windowRef, URL: URLApi, Image: ImageCtor, toast } = {}) {
    let styleInjected = false;
    function ensureStyle() {
      if (styleInjected || !documentRef?.head) return;
      if (documentRef.getElementById?.(EDITOR_STYLE_ID)) { styleInjected = true; return; }
      const style = documentRef.createElement('style');
      style.id = EDITOR_STYLE_ID;
      style.textContent = EDITOR_CSS;
      documentRef.head.appendChild(style);
      styleInjected = true;
    }

    function open(imageBlob, { tool = '', filename: requestedFilename = '' } = {}) {
      ensureStyle();
      const filename = String(requestedFilename || '').trim();
      function formatFileSize(bytes) {
        if (!Number.isFinite(bytes) || bytes <= 0) return '未知大小';
        if (bytes < 1024) return `${bytes} B`;
        if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
        return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
      }
      function formatFileType(type, name) {
        const normalized = String(type || '').toLowerCase();
        if (normalized.includes('png')) return 'PNG';
        if (normalized.includes('webp')) return 'WEBP';
        if (normalized.includes('jpeg') || normalized.includes('jpg')) return 'JPG';
        const extension = String(name || '').split('.').pop();
        return extension && extension !== name ? extension.toUpperCase() : 'PNG';
      }
      return new Promise(resolve => {
        const URLImpl = URLApi || windowRef?.URL;
        const ImageImpl = ImageCtor || windowRef?.Image;
        if (!documentRef || !URLImpl || !ImageImpl || !imageBlob) { resolve(null); return; }
        const sourceUrl = URLImpl.createObjectURL(imageBlob);
        const image = new ImageImpl();
        const state = {
          tool: 'none',
          brush: 28,
          strokeSeq: 0,
          strokes: [],
          comments: [],
          pendingComment: null,
          history: [],
          recordSeq: 0,
          editingRecordId: '',
          editingRecordSize: null,
          commentColorOffset: Math.floor(Math.random() * COMMENT_COLOR_PALETTE.length),
          settled: false,
        };

        function el(tag, props = {}) {
          const node = documentRef.createElement(tag);
          for (const [key, value] of Object.entries(props)) {
            if (key === 'textContent') node.textContent = value;
            else if (key.startsWith('aria-') || key.startsWith('data-') || key === 'role') node.setAttribute(key, value);
            else node[key] = value;
          }
          return node;
        }

        function nextRecordId(kind = 'record') {
          state.recordSeq += 1;
          return `${kind}-${state.recordSeq}`;
        }

        function captureRegionThumbnail(region = {}) {
          const imageWidth = Number(image.naturalWidth || image.width) || 0;
          const imageHeight = Number(image.naturalHeight || image.height) || 0;
          if (!imageWidth || !imageHeight || !documentRef.createElement) return '';
          const left = Number(region.left);
          const right = Number(region.right);
          const top = Number(region.top);
          const bottom = Number(region.bottom);
          const centerX = Number.isFinite(Number(region.centerX))
            ? clamp01(region.centerX)
            : Number.isFinite(left) && Number.isFinite(right) ? clamp01((left + right) / 2) : 0.5;
          const centerY = Number.isFinite(Number(region.centerY))
            ? clamp01(region.centerY)
            : Number.isFinite(top) && Number.isFinite(bottom) ? clamp01((top + bottom) / 2) : 0.5;
          let cropWidth = Math.min(imageWidth, Math.min(imageWidth, imageHeight) * RECORD_THUMBNAIL_CROP_SCALE);
          let cropHeight = cropWidth / RECORD_THUMBNAIL_RATIO;
          if (cropHeight > imageHeight) {
            cropHeight = imageHeight;
            cropWidth = cropHeight * RECORD_THUMBNAIL_RATIO;
          }
          const sourceX = Math.max(0, Math.min(imageWidth - cropWidth, centerX * imageWidth - cropWidth / 2));
          const sourceY = Math.max(0, Math.min(imageHeight - cropHeight, centerY * imageHeight - cropHeight / 2));
          const canvas = documentRef.createElement('canvas');
          canvas.width = RECORD_THUMBNAIL_WIDTH;
          canvas.height = RECORD_THUMBNAIL_HEIGHT;
          const context = canvas.getContext?.('2d');
          if (!context || typeof context.drawImage !== 'function' || typeof canvas.toDataURL !== 'function') return '';
          try {
            context.drawImage(image, sourceX, sourceY, cropWidth, cropHeight, 0, 0, canvas.width, canvas.height);
            return String(canvas.toDataURL('image/png') || '');
          } catch {
            return '';
          }
        }

        function detachRecord(action = {}) {
          if (action.type === 'comment') {
            const index = state.comments.indexOf(action.comment);
            if (index >= 0) state.comments.splice(index, 1);
          } else if (action.type === 'erase') {
            const strokeIds = new Set((action.strokes || []).map(stroke => stroke.strokeId));
            state.strokes = state.strokes.filter(stroke => !strokeIds.has(stroke.strokeId));
          }
        }

        function removeHistoryRecord(action = {}) {
          const index = state.history.indexOf(action);
          if (index >= 0) state.history.splice(index, 1);
          detachRecord(action);
        }

        const backdrop = el('div', { className: 'image-editor-backdrop' });
        const panel = el('div', { className: 'image-editor-panel', role: 'dialog', 'aria-label': '图片编辑工作台' });
        const body = el('div', { className: 'image-editor-body' });
        const workbench = el('div', { className: 'image-editor-workbench' });
        const toolbar = el('aside', { className: 'image-editor-toolbar', role: 'toolbar', 'aria-label': '编辑工具' });
        const toolbarTitle = el('div', { className: 'image-editor-toolbar-title', textContent: '编辑工具' });
        const commentButton = toolButton('添加评论', 'comment', COMMENT_ICON);
        const backgroundButton = toolButton('智能移除背景', 'remove_background', BACKGROUND_ICON);
        const enhanceButton = toolButton('提升清晰度', 'enhance', ENHANCE_ICON);
        const eraseButton = toolButton('局部擦除', 'erase', ERASE_ICON);
        const toolOptions = el('div', { className: 'image-editor-tool-options' });
        const brushRow = el('label', { className: 'image-editor-brush' });
        const brushInput = el('input', { type: 'range', min: '8', max: '80', value: String(state.brush) });
        brushRow.append(documentRef.createTextNode('画笔'), brushInput);
        const instructionRow = el('div', { className: 'image-editor-row' });
        const instructionInput = el('input', { type: 'text', placeholder: '描述选中区域要改成什么（留空则移除并自然填充）' });
        instructionRow.appendChild(instructionInput);
        toolOptions.append(brushRow, instructionRow);
        toolbar.append(toolbarTitle, commentButton, backgroundButton, enhanceButton, eraseButton, toolOptions);

        const canvas = el('div', { className: 'image-editor-canvas' });
        const stage = el('div', { className: 'image-editor-stage' });
        const baseCanvas = el('canvas', { className: 'image-editor-base' });
        const overlayCanvas = el('canvas', { className: 'image-editor-overlay' });
        stage.append(baseCanvas, overlayCanvas);
        canvas.appendChild(stage);

        const commentPanel = el('aside', { className: 'image-editor-comment-panel' });
        const commentHeader = el('div', { className: 'image-editor-comment-header' });
        const commentTitle = el('span', { className: 'image-editor-comment-title', textContent: '修改记录' });
        const commentCount = el('span', { className: 'image-editor-comment-count', textContent: '0' });
        commentHeader.append(commentTitle, commentCount);
        const commentList = el('div', { className: 'image-editor-comment-list' });
        commentPanel.append(commentHeader, commentList);

        workbench.append(toolbar, canvas, commentPanel);

        const commentPopover = el('div', { className: 'image-editor-comment-popover' });
        const commentInput = el('input', { type: 'text', placeholder: '输入评论' });
        const commentConfirm = el('button', { className: 'image-editor-comment-confirm', type: 'button', 'aria-label': '确认评论' });
        commentConfirm.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7"/></svg>';
        const commentCancel = el('button', { className: 'image-editor-comment-cancel', type: 'button', 'aria-label': '取消评论' });
        commentCancel.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="m7 7 10 10"/><path d="m17 7-10 10"/></svg>';
        commentPopover.append(commentInput, commentConfirm, commentCancel);
        stage.appendChild(commentPopover);

        const footer = el('div', { className: 'image-editor-footer' });
        const fileInfo = el('div', { className: 'image-editor-file-info', textContent: '原始图片  |  自动适配尺寸  |  PNG/JPG' });
        const footerControls = el('div', { className: 'image-editor-footer-controls' });
        function footerControl(label, icon) {
          const control = el('button', { className: 'image-editor-control', type: 'button' });
          control.innerHTML = toolbarIcon(icon) + `<span>${label}</span>`;
          control.title = label;
          control.setAttribute('aria-label', label);
          return control;
        }
        const undoButton = footerControl('撤销', UNDO_ICON);
        const redoButton = footerControl('重做', REDO_ICON);
        footerControls.append(undoButton, redoButton);
        const hint = el('span', { className: 'image-editor-hint', textContent: '先选择工具，再在图片上操作' });
        const footerActions = el('div', { className: 'image-editor-footer-actions' });
        const clearButton = el('button', { className: 'image-editor-action danger', type: 'button' });
        clearButton.innerHTML = toolbarIcon(CLEAR_ICON) + '<span>清空评论</span>';
        const applyButton = el('button', { className: 'image-editor-action primary', type: 'button' });
        applyButton.innerHTML = toolbarIcon(APPLY_ICON) + '<span>完成并应用</span>';
        const cancelButton = el('button', { className: 'image-editor-action', type: 'button' });
        cancelButton.innerHTML = toolbarIcon(CANCEL_ICON) + '<span>取消编辑</span>';
        footerActions.append(clearButton, applyButton, cancelButton);
        footer.append(fileInfo, footerControls, hint, footerActions);
        body.append(workbench, footer);
        panel.append(body);
        backdrop.appendChild(panel);
        documentRef.body.appendChild(backdrop);

        const requestedTool = String(tool || '');
        selectTool(['erase', 'comment', 'remove_background', 'enhance'].includes(requestedTool) ? requestedTool : 'none');

        function toolButton(label, value, icon) {
          const button = el('button', { className: 'image-editor-tool', type: 'button', 'aria-pressed': 'false' });
          button.innerHTML = toolbarIcon(icon) + `<span>${label}</span>`;
          button.addEventListener('click', () => selectTool(value));
          return button;
        }

        function commentParts(text) {
          const normalized = String(text || '').trim();
          const separator = normalized.indexOf('\n');
          if (separator >= 0) {
            return {
              title: normalized.slice(0, separator).trim(),
              description: normalized.slice(separator + 1).trim(),
            };
          }
          const sentenceEnd = ['。', '！', '？', '!', '?', '；', ';']
            .map(mark => normalized.indexOf(mark))
            .filter(index => index > 0 && index < normalized.length - 1)
            .sort((left, right) => left - right)[0];
          if (sentenceEnd === undefined) return { title: normalized, description: '' };
          return {
            title: normalized.slice(0, sentenceEnd).trim(),
            description: normalized.slice(sentenceEnd + 1).trim(),
          };
        }

        function orderedModificationActions(actions = state.history) {
          return [
            ...actions.filter(action => action.type === 'comment'),
            ...actions.filter(action => action.type === 'erase'),
            ...actions.filter(action => action.type === 'operation' && action.operation === 'enhance'),
            ...actions.filter(action => action.type === 'operation' && action.operation === 'remove_background'),
          ];
        }

        // 编辑框必须和原文字块同宽同高，所以在替换成编辑框之前先量一次文字块。
        function recordCopySize(action) {
          const card = commentList.querySelector?.(`[data-record-id="${action.id}"]`);
          const copy = card?.querySelector?.('.image-editor-comment-copy');
          if (!copy) return null;
          const rect = typeof copy.getBoundingClientRect === 'function' ? copy.getBoundingClientRect() : null;
          const width = Math.round(Number(rect?.width) || Number(copy.offsetWidth) || 0);
          const height = Math.round(Number(rect?.height) || Number(copy.offsetHeight) || 0);
          return width > 0 && height > 0 ? { id: action.id, width, height } : null;
        }

        function beginRecordEdit(action) {
          if (action.type !== 'comment') return;
          state.editingRecordId = action.id;
          state.editingRecordSize = recordCopySize(action);
          updateModificationList();
          commentList.querySelector('[data-record-editor]')?.focus?.();
        }

        function saveRecordEdit(action, value) {
          if (action.type !== 'comment') return false;
          const text = String(value || '').trim();
          if (!text) {
            toast?.('评论内容不能为空');
            return false;
          }
          action.comment.text = text;
          state.editingRecordId = '';
          drawOverlay();
          updateCommentStatus();
          return true;
        }

        function deleteRecord(action) {
          if (state.editingRecordId === action.id) state.editingRecordId = '';
          removeHistoryRecord(action);
          drawOverlay();
          updateCommentStatus();
        }

        function appendRecordEditor(copy, action, value) {
          const editor = el('textarea', {
            className: 'image-editor-record-editor',
            rows: 1,
            'aria-label': '编辑评论，Enter 换行，Ctrl+Enter 保存',
            'data-record-editor': action.id,
          });
          editor.value = String(value || '');
          const size = state.editingRecordSize?.id === action.id ? state.editingRecordSize : null;
          if (size) {
            editor.style.width = `${size.width}px`;
            editor.style.height = `${size.height}px`;
            editor.style.maxWidth = '100%';
          }
          const actions = el('div', { className: 'image-editor-record-editor-actions' });
          const save = el('button', {
            className: 'image-editor-record-editor-button save',
            type: 'button',
            textContent: '保存',
            'data-record-save': '1',
          });
          const cancel = el('button', {
            className: 'image-editor-record-editor-button',
            type: 'button',
            textContent: '取消',
            'data-record-cancel': '1',
          });
          save.addEventListener('click', event => {
            event.preventDefault?.();
            event.stopPropagation?.();
            saveRecordEdit(action, editor.value);
          });
          cancel.addEventListener('click', event => {
            event.preventDefault?.();
            event.stopPropagation?.();
            state.editingRecordId = '';
            updateModificationList();
          });
          editor.addEventListener('keydown', event => {
            event.stopPropagation?.();
            if (event.key === 'Escape') {
              event.preventDefault?.();
              state.editingRecordId = '';
              updateModificationList();
            } else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
              event.preventDefault?.();
              saveRecordEdit(action, editor.value);
            }
          });
          actions.append(save, cancel);
          copy.append(editor, actions);
        }

        function appendRecordActions(card, action) {
          const actions = el('div', { className: 'image-editor-record-actions' });
          const remove = el('button', {
            className: 'image-editor-record-action danger',
            type: 'button',
            innerHTML: toolbarIcon(CLEAR_ICON),
            'data-record-action': 'delete',
          });
          const label = action.type === 'comment'
            ? `评论 ${Math.max(0, state.comments.indexOf(action.comment)) + 1}`
            : action.type === 'erase'
              ? '擦除记录'
              : action.operation === 'remove_background'
                ? '背景记录'
                : '清晰度记录';
          remove.setAttribute('aria-label', `删除${label}`);
          remove.addEventListener('click', event => {
            event.preventDefault?.();
            event.stopPropagation?.();
            deleteRecord(action);
          });
          if (action.type === 'comment') {
            const edit = el('button', {
              className: 'image-editor-record-action',
              type: 'button',
              innerHTML: toolbarIcon(EDIT_ICON),
              'data-record-action': 'edit',
            });
            edit.setAttribute('aria-label', `编辑${label}`);
            edit.addEventListener('click', event => {
              event.preventDefault?.();
              event.stopPropagation?.();
              beginRecordEdit(action);
            });
            actions.appendChild(edit);
          }
          actions.appendChild(remove);
          card.appendChild(actions);
        }

        function modificationRecord(action) {
          const card = el('div', {
            className: 'image-editor-comment-card',
            'data-modification-type': action.type,
            'data-record-id': action.id,
          });
          const badge = el('span', { className: 'image-editor-comment-index' });
          const copy = el('div', { className: 'image-editor-comment-copy' });
          const visual = el('div', { className: 'image-editor-record-visual' });
          const editing = action.type === 'comment' && state.editingRecordId === action.id;
          let canDelete = false;
          if (action.type === 'comment') {
            const commentIndex = Math.max(0, state.comments.indexOf(action.comment));
            const color = action.comment.color || commentColorFor(commentIndex, state.commentColorOffset);
            badge.textContent = String(commentIndex + 1);
            badge.style.backgroundColor = color;
            canDelete = true;
            if (editing) {
              appendRecordEditor(copy, action, action.comment.text);
            } else {
              const parts = commentParts(action.comment.text);
              copy.appendChild(el('strong', { textContent: parts.title || '未命名评论' }));
              if (parts.description) copy.appendChild(el('p', { textContent: parts.description }));
            }
          } else if (action.type === 'erase') {
            badge.innerHTML = toolbarIcon(ERASE_ICON);
            badge.style.backgroundColor = '#ef4444';
            canDelete = true;
            copy.appendChild(el('strong', { textContent: '局部擦除' }));
            copy.appendChild(el('p', { textContent: action.instruction || '移除涂抹区域并自然补全' }));
          } else if (action.operation === 'remove_background') {
            badge.innerHTML = toolbarIcon(BACKGROUND_ICON);
            badge.style.backgroundColor = '#0f766e';
            canDelete = true;
            copy.appendChild(el('strong', { textContent: '移除背景' }));
            copy.appendChild(el('p', { textContent: '保持前景完整，背景设为透明' }));
          } else if (action.operation === 'enhance') {
            badge.innerHTML = toolbarIcon(ENHANCE_ICON);
            badge.style.backgroundColor = '#7c3aed';
            canDelete = true;
            copy.appendChild(el('strong', { textContent: '提升清晰度' }));
            copy.appendChild(el('p', { textContent: '增强细节、纹理与边缘' }));
          }
          if (canDelete && !editing) appendRecordActions(visual, action);
          const thumbnail = String(action.thumbnail || action.comment?.thumbnail || '');
          if (thumbnail) {
            visual.appendChild(el('img', {
              className: 'image-editor-comment-thumbnail',
              src: thumbnail,
              alt: action.type === 'comment' ? '评论位置局部截图' : '擦除区域局部截图',
            }));
          }
          card.append(badge, copy, visual);
          return card;
        }

        function updateModificationList() {
          if (!state.history.length) {
            commentList.replaceChildren(el('div', { className: 'image-editor-comment-empty', textContent: '暂无修改，选择工具添加记录' }));
            return;
          }
          commentList.replaceChildren(...orderedModificationActions().map(action => modificationRecord(action)));
        }

        function updateActionAvailability() {
          const hasItems = state.tool === 'comment'
            ? state.history.some(action => action.type === 'comment')
            : state.tool === 'erase'
              ? state.history.some(action => action.type === 'erase')
              : false;
          const canUndo = state.history.length > 0;
          const hasAnyEdits = state.history.length > 0;
          backgroundButton.setAttribute('aria-pressed', String(operationSelected('remove_background')));
          enhanceButton.setAttribute('aria-pressed', String(operationSelected('enhance')));
          undoButton.disabled = !canUndo;
          redoButton.disabled = !hasAnyEdits;
          redoButton.title = '清除所有修改并回到初始状态';
          redoButton.setAttribute('aria-label', '清除所有修改并回到初始状态');
          clearButton.hidden = !hasItems;
          clearButton.disabled = !hasItems;
          const clearLabel = state.tool === 'erase' ? '清空选区' : '清空评论';
          clearButton.innerHTML = toolbarIcon(CLEAR_ICON) + `<span>${clearLabel}</span>`;
          clearButton.setAttribute('aria-label', clearLabel);
        }

        function updateCommentStatus() {
          commentPanel.style.display = '';
          commentTitle.textContent = '修改记录';
          commentCount.textContent = String(state.history.length);
          updateModificationList();
          updateActionAvailability();
          if (state.tool === 'comment') {
            hint.textContent = state.comments.length
              ? `已添加 ${state.comments.length} 条评论，可继续标注或点击完成并应用`
              : '点击图片添加评论标记';
          }
        }

        function closeCommentPopover() {
          state.pendingComment = null;
          commentPopover.classList.remove('active');
          commentInput.value = '';
          commentConfirm.style.removeProperty('background-color');
          drawOverlay();
          updateActionAvailability();
        }

        function openCommentPopover(point) {
          state.pendingComment = {
            x: point.x,
            y: point.y,
            color: commentColorFor(state.comments.length, state.commentColorOffset),
          };
          commentPopover.classList.add('active');
          commentConfirm.style.backgroundColor = state.pendingComment.color;
          const displayWidth = overlayCanvas.clientWidth || overlayCanvas.width || 0;
          const displayHeight = overlayCanvas.clientHeight || overlayCanvas.height || 0;
          const markerRadius = Math.min(17, Math.max(8, Math.round(Math.min(displayWidth, displayHeight) * 0.0155)));
          const popoverWidth = commentPopover.offsetWidth || 260;
          const popoverHeight = commentPopover.offsetHeight || 40;
          const anchorX = point.x * displayWidth;
          const anchorY = point.y * displayHeight;
          const markerOuterRadius = Math.round(markerRadius * 1.14);
          let left = anchorX + markerOuterRadius + 10;
          if (left + popoverWidth > displayWidth) left = anchorX - markerOuterRadius - popoverWidth - 10;
          left = Math.max(8, Math.min(left, Math.max(8, displayWidth - popoverWidth - 8)));
          const top = Math.max(8, Math.min(anchorY - popoverHeight / 2, Math.max(8, displayHeight - popoverHeight - 8)));
          commentPopover.style.left = `${left}px`;
          commentPopover.style.top = `${top}px`;
          commentInput.value = '';
          const focusCommentInput = () => { try { commentInput.focus?.(); } catch {} };
          focusCommentInput();
          if (typeof windowRef?.requestAnimationFrame === 'function') windowRef.requestAnimationFrame(focusCommentInput);
          else if (typeof setTimeout === 'function') setTimeout(focusCommentInput, 0);
          drawOverlay();
          updateActionAvailability();
        }

        function confirmComment() {
          const text = String(commentInput.value || '').trim();
          if (!text) { toast?.('请输入评论内容'); return; }
          const point = state.pendingComment;
          if (!point) return;
          const comment = {
            x: point.x,
            y: point.y,
            text,
            color: point.color || commentColorFor(state.comments.length, state.commentColorOffset),
            thumbnail: captureRegionThumbnail({ centerX: point.x, centerY: point.y }),
          };
          state.comments.push(comment);
          state.history.push({ id: nextRecordId('comment'), type: 'comment', comment });
          state.pendingComment = null;
          commentPopover.classList.remove('active');
          commentInput.value = '';
          commentConfirm.style.removeProperty('background-color');
          drawOverlay();
          updateCommentStatus();
        }

        function operationSelected(operation) {
          return state.history.some(action => action.type === 'operation' && action.operation === operation);
        }

        function toggleOperation(operation) {
          const existing = state.history.find(action => action.type === 'operation' && action.operation === operation);
          if (existing) {
            removeHistoryRecord(existing);
            drawOverlay();
            updateCommentStatus();
            return false;
          }
          state.history.push({ id: nextRecordId('operation'), type: 'operation', operation });
          return true;
        }

        function selectTool(tool) {
          const globalOperation = tool === 'remove_background' || tool === 'enhance';
          const previousTool = state.tool;
          if (globalOperation) toggleOperation(tool);
          else state.tool = tool;

          const commenting = state.tool === 'comment';
          const erasing = state.tool === 'erase';
          const neutral = !commenting && !erasing;
          commentButton.setAttribute('aria-pressed', String(commenting));
          eraseButton.setAttribute('aria-pressed', String(erasing));
          backgroundButton.setAttribute('aria-pressed', String(operationSelected('remove_background')));
          enhanceButton.setAttribute('aria-pressed', String(operationSelected('enhance')));
          brushRow.style.display = erasing ? 'flex' : 'none';
          toolOptions.hidden = !erasing;
          overlayCanvas.style.pointerEvents = neutral ? 'none' : '';
          overlayCanvas.style.cursor = commenting ? COMMENT_CURSOR : 'crosshair';
          if (previousTool === 'comment' && !commenting) closeCommentPopover();
          if (commenting) hint.textContent = '点击图片放置编号评论，可连续评论多个位置';
          else if (erasing) hint.textContent = '在图片上涂抹要修改的区域';
          else hint.textContent = state.history.length ? '修改已加入右侧记录，可继续使用其他工具' : '可组合使用多个编辑工具';
          updateCommentStatus();
        }

        let resizeFrame = 0;
        function canvasViewport() {
          const innerWidth = Number(windowRef?.innerWidth) || 1400;
          const innerHeight = Number(windowRef?.innerHeight) || 900;
          const bodyWidth = Math.max(320, Number(body.getBoundingClientRect?.().width) || innerWidth);
          const workbenchHeight = Number(workbench.getBoundingClientRect?.().height) || 0;
          const availableHeight = Math.max(160, workbenchHeight || innerHeight - 96);
          if (innerWidth <= 980) {
            return { width: Math.max(240, bodyWidth - 24), height: availableHeight, vertical: true, bodyWidth, padding: 24 };
          }
          const metrics = innerWidth <= 1180
            ? { toolbar: 228, comments: 290, gap: 12, padding: 28 }
            : innerWidth <= 1500
              ? { toolbar: 268, comments: 330, gap: 12, padding: 28 }
              : { toolbar: 292, comments: 360, gap: 16, padding: 40 };
          return {
            width: Math.max(240, bodyWidth - metrics.padding - metrics.toolbar - metrics.comments - metrics.gap * 2),
            height: availableHeight,
            vertical: false,
            bodyWidth,
            ...metrics,
          };
        }

        function updateCanvasFrame(displayWidth) {
          const viewport = canvasViewport();
          canvas.scrollLeft = 0;
          canvas.scrollTop = 0;
          if (viewport.vertical) {
            canvas.style.width = '100%';
            canvas.style.flexBasis = 'auto';
            footer.style.width = '100%';
            return;
          }
          const frameWidth = Math.min(displayWidth + 8, viewport.width);
          canvas.style.width = `${frameWidth}px`;
          canvas.style.flexBasis = `${frameWidth}px`;
          const groupWidth = Math.min(
            viewport.bodyWidth - viewport.padding,
            frameWidth + viewport.toolbar + viewport.comments + viewport.gap * 2,
          );
          footer.style.width = `${groupWidth}px`;
        }

        function fitScale() {
          const naturalWidth = Number(image.naturalWidth || image.width) || 1;
          const naturalHeight = Number(image.naturalHeight || image.height) || 1;
          const viewport = canvasViewport();
          return Math.max(0.01, Math.min(
            (viewport.width - 8) / naturalWidth,
            (viewport.height - 8) / naturalHeight,
          ));
        }

        function renderImageCanvas() {
          const naturalWidth = Math.max(1, Number(image.naturalWidth || image.width) || 860);
          const naturalHeight = Math.max(1, Number(image.naturalHeight || image.height) || 600);
          const scale = fitScale();
          const displayWidth = Math.max(1, Math.round(naturalWidth * scale));
          const displayHeight = Math.max(1, Math.round(naturalHeight * scale));
          if (baseCanvas.width !== naturalWidth) baseCanvas.width = naturalWidth;
          if (baseCanvas.height !== naturalHeight) baseCanvas.height = naturalHeight;
          if (overlayCanvas.width !== naturalWidth) overlayCanvas.width = naturalWidth;
          if (overlayCanvas.height !== naturalHeight) overlayCanvas.height = naturalHeight;
          for (const element of [baseCanvas, overlayCanvas]) {
            element.style.width = `${displayWidth}px`;
            element.style.height = `${displayHeight}px`;
          }
          updateCanvasFrame(displayWidth);
          baseCanvas.getContext('2d')?.drawImage(image, 0, 0, naturalWidth, naturalHeight);
          drawOverlay();
        }

        function onResize() {
          if (resizeFrame && typeof windowRef?.cancelAnimationFrame === 'function') windowRef.cancelAnimationFrame(resizeFrame);
          const redraw = () => { resizeFrame = 0; renderImageCanvas(); };
          if (typeof windowRef?.requestAnimationFrame === 'function') resizeFrame = windowRef.requestAnimationFrame(redraw);
          else redraw();
        }

        windowRef?.addEventListener?.('resize', onResize);

        function cleanup(result) {
          if (state.settled) return;
          state.settled = true;
          documentRef.removeEventListener('keydown', onKeydown);
          windowRef?.removeEventListener?.('resize', onResize);
          if (resizeFrame && typeof windowRef?.cancelAnimationFrame === 'function') windowRef.cancelAnimationFrame(resizeFrame);
          try { URLImpl.revokeObjectURL(sourceUrl); } catch {}
          backdrop.remove();
          resolve(result);
        }

        function onKeydown(event) {
          const key = String(event.key || '').toLowerCase();
          if (key === 'escape') {
            if (commentPopover.classList.contains('active')) closeCommentPopover();
            else cleanup(null);
            return;
          }
          const target = event.target;
          const typing = target?.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(String(target?.tagName || '').toUpperCase());
          if (typing) return;
          if ((event.ctrlKey || event.metaKey) && key === 'z') {
            event.preventDefault?.();
            if (event.shiftKey) resetAllEdits();
            else undoLastAction();
            return;
          }
          if ((event.ctrlKey || event.metaKey) && key === 'y') {
            event.preventDefault?.();
            resetAllEdits();
            return;
          }
        }

        function drawOverlay() {
          const ctx = overlayCanvas.getContext('2d');
          if (!ctx) return;
          ctx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
          ctx.fillStyle = 'rgba(239,68,68,.45)';
          for (const stroke of state.strokes) {
            ctx.beginPath();
            ctx.arc(stroke.x * overlayCanvas.width, stroke.y * overlayCanvas.height, Math.max(1, stroke.radius * Math.min(overlayCanvas.width, overlayCanvas.height)), 0, Math.PI * 2);
            ctx.fill();
          }
          const comments = state.pendingComment
            ? [...state.comments, { ...state.pendingComment, text: '' }]
            : state.comments;
          if (comments.length) {
            commentLayer.paintComments?.(ctx, {
              width: overlayCanvas.width,
              height: overlayCanvas.height,
              comments,
            });
          }
        }

        let painting = false;
        let activeStroke = null;
        overlayCanvas.addEventListener('pointerdown', event => {
          if (state.tool === 'comment') event.preventDefault?.();
          if (state.tool === 'erase') {
            painting = true;
            state.strokeSeq += 1;
            activeStroke = { startIndex: state.strokes.length };
            overlayCanvas.setPointerCapture?.(event.pointerId);
            addStroke(event);
            updateActionAvailability();
            return;
          }
          if (state.tool === 'comment') {
            openCommentPopover(pointFromEvent(event));
          }
        });
        overlayCanvas.addEventListener('pointermove', event => {
          if (painting) addStroke(event);
        });
        function finishStroke() {
          if (!painting) return;
          painting = false;
          if (activeStroke && state.strokes.length > activeStroke.startIndex) {
            const strokes = state.strokes.slice(activeStroke.startIndex);
            state.history.push({
              id: nextRecordId('erase'),
              type: 'erase',
              strokes,
              instruction: String(instructionInput.value || '').trim(),
              thumbnail: captureRegionThumbnail(strokeBoundsData(strokes) || {}),
            });
          }
          activeStroke = null;
          updateCommentStatus();
        }
        overlayCanvas.addEventListener('pointerup', finishStroke);
        overlayCanvas.addEventListener('pointercancel', finishStroke);

        function pointFromEvent(event) {
          const rect = overlayCanvas.getBoundingClientRect?.() || { width: overlayCanvas.width, height: overlayCanvas.height, left: 0, top: 0 };
          return normalizeStrokePoint(event, rect);
        }

        function addStroke(event) {
          const rect = overlayCanvas.getBoundingClientRect?.() || { width: overlayCanvas.width, height: overlayCanvas.height, left: 0, top: 0 };
          const point = normalizeStrokePoint(event, rect);
          const radius = state.brush / Math.max(1, Math.min(rect.width || overlayCanvas.width, rect.height || overlayCanvas.height));
          // One pointer drag is one undoable stroke; every sample keeps the
          // gesture id so undo removes the whole scribble instead of one dab.
          state.strokes.push({ x: point.x, y: point.y, radius, strokeId: state.strokeSeq });
          drawOverlay();
        }

        commentConfirm.addEventListener('click', confirmComment);
        commentCancel.addEventListener('click', closeCommentPopover);
        commentInput.addEventListener('keydown', event => {
          event.stopPropagation?.();
          if (event.key === 'Enter') { event.preventDefault(); confirmComment(); }
          else if (event.key === 'Escape') { event.preventDefault(); closeCommentPopover(); }
        });

        brushInput.addEventListener('input', () => { state.brush = Number(brushInput.value) || 28; });

        function undoLastAction() {
          const action = state.history.pop();
          if (!action) return;
          if (state.editingRecordId === action.id) state.editingRecordId = '';
          detachRecord(action);
          drawOverlay();
          updateCommentStatus();
        }

        function resetAllEdits() {
          state.strokes = [];
          state.comments = [];
          state.history = [];
          state.pendingComment = null;
          state.editingRecordId = '';
          state.brush = 28;
          brushInput.value = '28';
          instructionInput.value = '';
          activeStroke = null;
          painting = false;
          commentPopover.classList.remove('active');
          commentInput.value = '';
          commentConfirm.style.removeProperty('background-color');
          drawOverlay();
          updateCommentStatus();
          selectTool('none');
          commentList.scrollTop = 0;
        }

        undoButton.addEventListener('click', undoLastAction);
        redoButton.addEventListener('click', resetAllEdits);
        clearButton.addEventListener('click', () => {
          if (state.tool === 'comment') {
            state.comments = [];
            state.history = state.history.filter(action => action.type !== 'comment');
          } else if (state.tool === 'erase') {
            state.strokes = [];
            state.history = state.history.filter(action => action.type !== 'erase');
          }
          state.editingRecordId = '';
          drawOverlay();
          updateCommentStatus();
        });
        cancelButton.addEventListener('click', () => cleanup(null));
        backdrop.addEventListener('click', event => { if (event.target === backdrop) cleanup(null); });
        documentRef.addEventListener('keydown', onKeydown);

        function combinedEditLabel(actions, comments) {
          if (actions.length === 1) {
            const action = actions[0];
            if (action.type === 'comment') {
              return comments.map((comment, index) => `${index + 1}. ${comment.text}`).join('\n');
            }
            if (action.type === 'erase') return action.instruction || '';
            return '';
          }
          return actions.map(action => {
            if (action.type === 'comment') {
              const index = comments.indexOf(action.comment);
              return `${index + 1}. ${action.comment.text}`;
            }
            if (action.type === 'erase') return action.instruction ? `局部擦除：${action.instruction}` : '局部擦除';
            if (action.operation === 'remove_background') return '移除图片背景';
            if (action.operation === 'enhance') return '提升图片清晰度';
            return '';
          }).filter(Boolean).join('\n');
        }

        async function applyHistoryEdit() {
          if (painting) finishStroke();
          if (state.pendingComment) { toast?.('请先完成当前评论'); return; }
          if (!state.history.length) { toast?.('请先添加修改记录'); return; }

          const actions = [...state.history];
          const commentActions = actions.filter(action => action.type === 'comment');
          const eraseActions = actions.filter(action => action.type === 'erase');
          const comments = commentActions.map(action => action.comment);
          const hasErase = eraseActions.length > 0;
          const removeBackground = operationSelected('remove_background');
          const enhance = operationSelected('enhance');
          const hasLocalEdits = comments.length > 0 || hasErase;
          if (removeBackground && (hasLocalEdits || enhance)) {
            toast?.('由于模型能力限制，移除背景不能和其他操作同时执行，否则可能生成黑白棋盘背景。请单独使用“移除背景”。');
            return;
          }
          let maskBlob = null;
          let maskWidth = 0;
          let maskHeight = 0;

          if (hasLocalEdits) {
            const maskCanvas = documentRef.createElement('canvas');
            maskCanvas.width = image.naturalWidth || image.width;
            maskCanvas.height = image.naturalHeight || image.height;
            const maskCtx = maskCanvas.getContext('2d');
            if (!maskCtx || typeof maskCanvas.toBlob !== 'function') {
              toast?.('当前浏览器不支持生成编辑蒙版，请更换浏览器后重试');
              return;
            }
            paintMask(maskCtx, {
              width: maskCanvas.width,
              height: maskCanvas.height,
              strokes: eraseActions.flatMap(action => action.strokes || []),
            });
            if (comments.length) {
              maskCtx.globalCompositeOperation = 'destination-out';
              const maskRadius = Math.max(24, Math.round(Math.min(maskCanvas.width, maskCanvas.height) * 0.06));
              for (const comment of comments) {
                maskCtx.beginPath();
                maskCtx.arc(clamp01(comment.x) * maskCanvas.width, clamp01(comment.y) * maskCanvas.height, maskRadius, 0, Math.PI * 2);
                maskCtx.fill();
              }
              maskCtx.globalCompositeOperation = 'source-over';
            }
            maskWidth = maskCanvas.width;
            maskHeight = maskCanvas.height;
            maskBlob = await new Promise(resolveBlob => maskCanvas.toBlob(resolveBlob, 'image/png'));
            if (!maskBlob) { toast?.('编辑蒙版生成失败，请重试'); return; }
          }

          const prompt = buildCompositeEditPrompt({
            comments,
            eraseActions,
            hasErase,
            removeBackground,
            enhance,
          });
          if (!prompt) { toast?.('请先添加有效的修改记录'); return; }

          const single = actions.length === 1 ? actions[0] : null;
          const mode = single?.type === 'comment'
            ? 'comment'
            : single?.type === 'erase'
              ? 'erase'
              : single?.type === 'operation' && single.operation === 'remove_background'
                ? 'remove_background'
                : single?.type === 'operation' && single.operation === 'enhance'
                  ? 'enhance'
                  : 'composite';
          const label = combinedEditLabel(orderedModificationActions(actions), comments);
          cleanup({
            mode,
            ...(maskBlob ? { maskBlob, width: maskWidth, height: maskHeight } : {}),
            prompt,
            ...(label ? { label } : {}),
            ...(removeBackground ? { background: 'transparent', output_format: 'png' } : {}),
          });
        }

        applyButton.addEventListener('click', applyHistoryEdit);
        image.onload = () => {
          const naturalWidth = Math.max(1, Number(image.naturalWidth || image.width) || 860);
          const naturalHeight = Math.max(1, Number(image.naturalHeight || image.height) || 600);
          fileInfo.textContent = `${naturalWidth} × ${naturalHeight}  |  ${formatFileSize(Number(imageBlob.size) || 0)}  |  ${formatFileType(imageBlob.type, filename)}`;
          renderImageCanvas();
        };
        image.onerror = () => cleanup(null);
        image.src = sourceUrl;
      });
    }

    return Object.freeze({ open });
  }

  const api = Object.freeze({
    EDITOR_STYLE_ID,
    COMMENT_CURSOR,
    strokeContainsPoint,
    maskAlphaAtPoint,
    normalizeStrokePoint,
    buildEnhancePrompt,
    buildCompositeEditPrompt,
    buildSelectedAreaPrompt,
    paintMask,
    createImageEditor,
  });

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root?.[Symbol.for('chatui.module-registry.v1')]?.get('moduleRegistry')?.register('imageEditorMaskEditor', api);
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
