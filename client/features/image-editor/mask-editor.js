'use strict';
(function initChatUIImageEditorMaskEditor(root) {
  'use strict';

  const commentLayer = root?.[Symbol.for('chatui.module-registry.v1')]?.get('imageEditorCommentLayer')
    || (typeof require === 'function' ? require('./comment-layer') : {});

  const EDITOR_STYLE_ID = 'chatui-image-editor-style';

  const EDITOR_CSS = `.image-editor-backdrop{position:fixed;inset:0;z-index:1200;background:#0b1220;display:flex;align-items:stretch;justify-content:center;padding:0}
.image-editor-panel{position:relative;width:100%;height:100%;max-height:none;display:flex;flex-direction:column;background:var(--surface,#fff);color:var(--text,#0f172a);border-radius:0;box-shadow:none;overflow:hidden}
.image-editor-header{position:relative;display:flex;align-items:center;justify-content:center;min-height:58px;padding:8px 16px;border-bottom:1px solid var(--border,#e2e8f0)}
.image-editor-title{position:absolute;left:16px;font-size:14px;font-weight:600}
.image-editor-toolbar{display:inline-flex;align-items:center;gap:4px;padding:4px;border:1px solid var(--border,#e2e8f0);border-radius:12px;background:rgba(148,163,184,.14)}
.image-editor-tool{display:inline-flex;align-items:center;gap:6px;padding:6px 12px;border:none;border-radius:9px;background:transparent;color:inherit;font-size:13px;cursor:pointer;white-space:nowrap}
.image-editor-tool svg{width:16px;height:16px;flex:none}
.image-editor-tool[aria-pressed="true"]{background:var(--accent,#2563eb);color:#fff;box-shadow:0 1px 3px rgba(37,99,235,.35)}
.image-editor-body{position:relative;display:flex;flex:1 1 auto;min-height:0;align-items:center;justify-content:center;padding:12px;overflow:auto;background:#0f172a}
.image-editor-stage{position:relative;line-height:0}
.image-editor-stage canvas{display:block;max-width:100%;border-radius:8px}
.image-editor-overlay{position:absolute;left:0;top:0;cursor:crosshair;touch-action:none}
.image-editor-footer{display:flex;align-items:center;gap:12px;padding:12px 16px;border-top:1px solid var(--border,#e2e8f0);flex-wrap:wrap}
.image-editor-hint{font-size:12px;color:var(--text-muted,#64748b);margin-right:auto}
.image-editor-action{display:inline-flex;align-items:center;gap:6px;padding:7px 16px;border-radius:8px;border:1px solid var(--border,#e2e8f0);background:transparent;color:inherit;font-size:13px;cursor:pointer}
.image-editor-action svg{width:15px;height:15px;flex:none}
.image-editor-action.primary{background:var(--accent,#2563eb);border-color:var(--accent,#2563eb);color:#fff}
.image-editor-footer-actions{display:inline-flex;align-items:center;gap:8px;margin-left:auto}
.image-editor-brush{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--text-muted,#64748b)}
.image-editor-brush input{width:120px}
.image-editor-row{display:none;align-items:center;gap:8px;flex-wrap:wrap}
.image-editor-row.active{display:flex}
.image-editor-row input{padding:6px 10px;border:1px solid var(--border,#e2e8f0);border-radius:8px;background:var(--surface,#fff);color:inherit;font-size:13px}
.image-editor-comment-popover{position:absolute;z-index:6;display:none;align-items:center;gap:6px;padding:6px 8px;border-radius:999px;background:#fff;box-shadow:0 10px 30px rgba(15,23,42,.22);border:1px solid rgba(15,23,42,.08);line-height:normal}
.image-editor-comment-popover.active{display:inline-flex}
.image-editor-comment-popover input{width:180px;border:none;outline:none;font-size:13px;color:#0f172a;background:transparent}
.image-editor-comment-confirm{width:26px;height:26px;border:none;border-radius:50%;background:#2563eb;color:#fff;cursor:pointer;display:inline-flex;align-items:center;justify-content:center}
.image-editor-comment-confirm svg{width:14px;height:14px}
.image-editor-comment-cancel{width:26px;height:26px;border:none;border-radius:50%;background:transparent;color:#64748b;cursor:pointer;display:inline-flex;align-items:center;justify-content:center}
.image-editor-comment-cancel svg{width:13px;height:13px}
@media (max-width:640px){.image-editor-title{display:none}}`;

  const COMMENT_CURSOR = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='28' height='28' viewBox='0 0 28 28'%3E%3Cg fill='none' stroke-linecap='round'%3E%3Ccircle cx='14' cy='14' r='8' stroke='%23ffffff' stroke-width='4.4'/%3E%3Ccircle cx='14' cy='14' r='8' stroke='%23111827' stroke-width='2'/%3E%3Cpath d='M14 2v5M14 21v5M2 14h5M21 14h5' stroke='%23ffffff' stroke-width='4.4'/%3E%3Cpath d='M14 2v5M14 21v5M2 14h5M21 14h5' stroke='%23111827' stroke-width='2'/%3E%3C/g%3E%3Ccircle cx='14' cy='14' r='1.7' fill='%23111827'/%3E%3C/svg%3E") 14 14, crosshair`;
  const COMMENT_ICON = '<path d="M20.5 4.5h-17A1.5 1.5 0 0 0 2 6v10a1.5 1.5 0 0 0 1.5 1.5H7v4l5-4h8.5a1.5 1.5 0 0 0 1.5-1.5V6a1.5 1.5 0 0 0-1.5-1.5Z"/><path d="M12 8.5v5"/><path d="M9.5 11h5"/>';
  const BACKGROUND_ICON = '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/>';
  const ERASE_ICON = '<path d="m7 21-4.3-4.3a1 1 0 0 1 0-1.4L13.4 4.6a1 1 0 0 1 1.4 0l5.6 5.6a1 1 0 0 1 0 1.4L11 21"/><path d="M22 21H7"/><path d="m5 11 9 9"/>';
  const APPLY_ICON = '<path d="m5 12.5 4.5 4.5L19 7"/>';
  const CANCEL_ICON = '<path d="m7 7 10 10"/><path d="m17 7-10 10"/>';
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

    function open(imageBlob, { tool = '' } = {}) {
      ensureStyle();
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
          settled: false,
        };

        function el(tag, props = {}) {
          const node = documentRef.createElement(tag);
          for (const [key, value] of Object.entries(props)) {
            if (key === 'textContent') node.textContent = value;
            else if (key.startsWith('aria-') || key === 'role') node.setAttribute(key, value);
            else node[key] = value;
          }
          return node;
        }

        const backdrop = el('div', { className: 'image-editor-backdrop' });
        const panel = el('div', { className: 'image-editor-panel', role: 'dialog', 'aria-label': '\u56fe\u7247\u7f16\u8f91' });
        const header = el('div', { className: 'image-editor-header' });
        const title = el('span', { className: 'image-editor-title', textContent: '\u56fe\u7247\u7f16\u8f91' });
        const toolbar = el('div', { className: 'image-editor-toolbar', role: 'toolbar', 'aria-label': '\u7f16\u8f91\u5de5\u5177' });
        const commentButton = toolButton('\u8bc4\u8bba', 'comment', COMMENT_ICON);
        const backgroundButton = toolButton('\u79fb\u9664\u80cc\u666f', 'remove_background', BACKGROUND_ICON);
        const eraseButton = toolButton('\u64e6\u9664', 'erase', ERASE_ICON);
        toolbar.append(commentButton, backgroundButton, eraseButton);
        header.append(title, toolbar);

        const body = el('div', { className: 'image-editor-body' });
        const stage = el('div', { className: 'image-editor-stage' });
        const baseCanvas = el('canvas', { className: 'image-editor-base' });
        const overlayCanvas = el('canvas', { className: 'image-editor-overlay' });
        stage.append(baseCanvas, overlayCanvas);
        body.appendChild(stage);

        const commentPopover = el('div', { className: 'image-editor-comment-popover' });
        const commentInput = el('input', { type: 'text', placeholder: '\u8f93\u5165\u8bc4\u8bba' });
        const commentConfirm = el('button', { className: 'image-editor-comment-confirm', type: 'button', 'aria-label': '\u786e\u8ba4\u8bc4\u8bba' });
        commentConfirm.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7"/></svg>';
        const commentCancel = el('button', { className: 'image-editor-comment-cancel', type: 'button', 'aria-label': '\u53d6\u6d88\u8bc4\u8bba' });
        commentCancel.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="m7 7 10 10"/><path d="m17 7-10 10"/></svg>';
        commentPopover.append(commentInput, commentConfirm, commentCancel);
        stage.appendChild(commentPopover);

        const footer = el('div', { className: 'image-editor-footer' });
        const hint = el('span', { className: 'image-editor-hint', textContent: '\u5148\u5728\u9876\u90e8\u9009\u62e9\u5de5\u5177\uff0c\u518d\u5728\u56fe\u7247\u4e0a\u64cd\u4f5c' });
        const brushRow = el('label', { className: 'image-editor-brush' });
        const brushInput = el('input', { type: 'range', min: '8', max: '80', value: String(state.brush) });
        brushRow.append(documentRef.createTextNode('\u7b14\u5237'), brushInput);
        const undoButton = el('button', { className: 'image-editor-action', type: 'button', textContent: '\u64a4\u9500' });
        const clearButton = el('button', { className: 'image-editor-action', type: 'button', textContent: '\u6e05\u9664' });
        const instructionRow = el('div', { className: 'image-editor-row' });
        const instructionInput = el('input', { type: 'text', placeholder: '\u63cf\u8ff0\u9009\u4e2d\u533a\u57df\u8981\u6539\u6210\u4ec0\u4e48\uff08\u7559\u7a7a\u5219\u79fb\u9664\u5e76\u81ea\u7136\u586b\u5145\uff09' });
        instructionRow.appendChild(instructionInput);
        const footerActions = el('div', { className: 'image-editor-footer-actions' });
        const applyButton = el('button', { className: 'image-editor-action primary', type: 'button' });
        applyButton.innerHTML = toolbarIcon(APPLY_ICON) + '<span>\u5e94\u7528</span>';
        const cancelButton = el('button', { className: 'image-editor-action', type: 'button' });
        cancelButton.innerHTML = toolbarIcon(CANCEL_ICON) + '<span>\u53d6\u6d88</span>';
        footerActions.append(applyButton, cancelButton);
        footer.append(hint, brushRow, undoButton, clearButton, instructionRow, footerActions);
        panel.append(header, body, footer);
        backdrop.appendChild(panel);
        documentRef.body.appendChild(backdrop);

        const requestedTool = String(tool || '');
        selectTool(['erase', 'comment', 'remove_background'].includes(requestedTool) ? requestedTool : 'none');

        function toolButton(label, value, icon) {
          const button = el('button', { className: 'image-editor-tool', type: 'button', 'aria-pressed': 'false' });
          button.innerHTML = toolbarIcon(icon) + `<span>${label}</span>`;
          button.addEventListener('click', () => selectTool(value));
          return button;
        }

        function updateCommentStatus() {
          if (state.tool !== 'comment') return;
          hint.textContent = state.comments.length
            ? `\u5df2\u6dfb\u52a0 ${state.comments.length} \u6761\u8bc4\u8bba\uff0c\u70b9\u51fb\u5e94\u7528\u53d1\u9001`
            : '\u70b9\u51fb\u56fe\u7247\u6dfb\u52a0\u7f16\u53f7\u8bc4\u8bba\uff0c\u5b8c\u6210\u540e\u70b9\u5e94\u7528\u53d1\u9001';
        }

        function closeCommentPopover() {
          state.pendingComment = null;
          commentPopover.classList.remove('active');
          commentInput.value = '';
          drawOverlay();
          updateCommentStatus();
        }

        function openCommentPopover(point) {
          state.pendingComment = point;
          commentPopover.classList.add('active');
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
          updateCommentStatus();
        }

        function confirmComment() {
          const text = String(commentInput.value || '').trim();
          if (!text) { toast?.('\u8bf7\u8f93\u5165\u8bc4\u8bba\u5185\u5bb9'); return; }
          const point = state.pendingComment;
          if (!point) return;
          state.comments.push({ x: point.x, y: point.y, text });
          state.pendingComment = null;
          commentPopover.classList.remove('active');
          commentInput.value = '';
          drawOverlay();
          updateCommentStatus();
        }

        function selectTool(tool) {
          state.tool = tool;
          commentButton.setAttribute('aria-pressed', String(tool === 'comment'));
          backgroundButton.setAttribute('aria-pressed', String(tool === 'remove_background'));
          eraseButton.setAttribute('aria-pressed', String(tool === 'erase'));
          const neutral = tool === 'none';
          const erasing = tool === 'erase';
          const commenting = tool === 'comment';
          brushRow.style.display = erasing ? '' : 'none';
          undoButton.style.display = erasing || commenting ? '' : 'none';
          clearButton.style.display = erasing || commenting ? '' : 'none';
          overlayCanvas.style.pointerEvents = tool === 'remove_background' || neutral ? 'none' : '';
          overlayCanvas.style.cursor = commenting
            ? COMMENT_CURSOR
            : 'crosshair';
          hint.textContent = neutral
            ? '\u5148\u5728\u9876\u90e8\u9009\u62e9\u5de5\u5177\uff0c\u518d\u5728\u56fe\u7247\u4e0a\u64cd\u4f5c'
            : erasing
              ? '\u5728\u56fe\u7247\u4e0a\u6d82\u62b9\u8981\u4fee\u6539\u7684\u533a\u57df'
              : tool === 'remove_background'
                ? '\u5c06\u81ea\u52a8\u79fb\u9664\u80cc\u666f\u5e76\u8f93\u51fa\u900f\u660e\u5e95 PNG'
                : '\u70b9\u51fb\u56fe\u7247\u653e\u7f6e\u7f16\u53f7\u8bc4\u8bba\uff0c\u53ef\u8fde\u7eed\u8bc4\u8bba\u591a\u4e2a\u4f4d\u7f6e';
          instructionRow.classList.toggle('active', erasing);
          if (!commenting) closeCommentPopover();
          updateCommentStatus();
        }

        function cleanup(result) {
          if (state.settled) return;
          state.settled = true;
          documentRef.removeEventListener('keydown', onKeydown);
          try { URLImpl.revokeObjectURL(sourceUrl); } catch {}
          backdrop.remove();
          resolve(result);
        }

        function onKeydown(event) {
          if (event.key === 'Escape') cleanup(null);
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
            ? [...state.comments, { x: state.pendingComment.x, y: state.pendingComment.y, text: '' }]
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
        overlayCanvas.addEventListener('pointerdown', event => {
          if (state.tool === 'comment') event.preventDefault?.();
          if (state.tool === 'erase') {
            painting = true;
            state.strokeSeq += 1;
            overlayCanvas.setPointerCapture?.(event.pointerId);
            addStroke(event);
            return;
          }
          if (state.tool === 'comment') {
            openCommentPopover(pointFromEvent(event));
          }
        });
        overlayCanvas.addEventListener('pointermove', event => {
          if (painting) addStroke(event);
        });
        const stopPainting = () => {
          painting = false;
        };
        overlayCanvas.addEventListener('pointerup', stopPainting);
        overlayCanvas.addEventListener('pointercancel', stopPainting);

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
          if (event.key === 'Enter') { event.preventDefault(); confirmComment(); }
          else if (event.key === 'Escape') { event.preventDefault(); closeCommentPopover(); }
        });

        brushInput.addEventListener('input', () => { state.brush = Number(brushInput.value) || 28; });
        undoButton.addEventListener('click', () => {
          if (state.tool === 'comment') {
            state.comments.pop();
          } else if (state.tool === 'erase') {
            const lastStrokeId = state.strokes.at(-1)?.strokeId;
            if (lastStrokeId === undefined) state.strokes.pop();
            else while (state.strokes.length && state.strokes.at(-1).strokeId === lastStrokeId) state.strokes.pop();
          }
          drawOverlay();
          updateCommentStatus();
        });
        clearButton.addEventListener('click', () => {
          if (state.tool === 'comment') state.comments = [];
          else state.strokes = [];
          drawOverlay();
          updateCommentStatus();
        });
        cancelButton.addEventListener('click', () => cleanup(null));
        backdrop.addEventListener('click', event => { if (event.target === backdrop) cleanup(null); });
        documentRef.addEventListener('keydown', onKeydown);

        async function applyCommentEdit() {
          if (state.pendingComment) { toast?.('\u8bf7\u5148\u5b8c\u6210\u5f53\u524d\u8bc4\u8bba'); return; }
          if (!state.comments.length) { toast?.('\u8bf7\u5148\u6dfb\u52a0\u8bc4\u8bba'); return; }
          const maskCanvas = documentRef.createElement('canvas');
          maskCanvas.width = image.naturalWidth || image.width;
          maskCanvas.height = image.naturalHeight || image.height;
          const maskCtx = maskCanvas.getContext('2d');
          if (!maskCtx || typeof maskCanvas.toBlob !== 'function') {
            toast?.('\u5f53\u524d\u6d4f\u89c8\u5668\u4e0d\u652f\u6301\u751f\u6210\u8bc4\u8bba\u906e\u7f69\uff0c\u8bf7\u66f4\u6362\u6d4f\u89c8\u5668\u540e\u91cd\u8bd5');
            return;
          }
          maskCtx.fillStyle = '#ffffff';
          maskCtx.fillRect(0, 0, maskCanvas.width, maskCanvas.height);
          maskCtx.globalCompositeOperation = 'destination-out';
          const maskRadius = Math.max(24, Math.round(Math.min(maskCanvas.width, maskCanvas.height) * 0.06));
          for (const comment of state.comments) {
            maskCtx.beginPath();
            maskCtx.arc(clamp01(comment.x) * maskCanvas.width, clamp01(comment.y) * maskCanvas.height, maskRadius, 0, Math.PI * 2);
            maskCtx.fill();
          }
          maskCtx.globalCompositeOperation = 'source-over';
          const prompt = commentLayer.buildCommentPrompt?.(state.comments, '') || '';
          if (!prompt) { toast?.('\u8bf7\u5148\u586b\u5199\u8bc4\u8bba\u5185\u5bb9'); return; }
          const maskBlob = await new Promise(resolveBlob => maskCanvas.toBlob(resolveBlob, 'image/png'));
          if (!maskBlob) { toast?.('\u8bc4\u8bba\u906e\u7f69\u751f\u6210\u5931\u8d25\uff0c\u8bf7\u91cd\u8bd5'); return; }
          const label = state.comments.map((comment, index) => `${index + 1}. ${comment.text}`).join('\n');
          cleanup({ mode: 'comment', maskBlob, width: maskCanvas.width, height: maskCanvas.height, prompt, label });
        }

        applyButton.addEventListener('click', async () => {
          if (state.tool === 'none') {
            toast?.('\u8bf7\u5148\u9009\u62e9\u7f16\u8f91\u5de5\u5177'); return;
          }
          if (state.tool === 'comment') {
            await applyCommentEdit();
            return;
          }
          if (state.tool === 'erase') {
            if (!state.strokes.length) { toast?.('\u8bf7\u5148\u5728\u56fe\u7247\u4e0a\u6d82\u62b9\u8981\u4fee\u6539\u7684\u533a\u57df'); return; }
            const maskCanvas = documentRef.createElement('canvas');
            maskCanvas.width = image.naturalWidth || image.width;
            maskCanvas.height = image.naturalHeight || image.height;
            const maskCtx = maskCanvas.getContext('2d');
            if (!maskCtx || typeof maskCanvas.toBlob !== 'function') { toast?.('\u5f53\u524d\u6d4f\u89c8\u5668\u4e0d\u652f\u6301\u751f\u6210\u906e\u7f69\uff0c\u8bf7\u66f4\u6362\u6d4f\u89c8\u5668\u540e\u91cd\u8bd5'); return; }
            paintMask(maskCtx, { width: maskCanvas.width, height: maskCanvas.height, strokes: state.strokes });
            const maskBlob = await new Promise(resolveBlob => maskCanvas.toBlob(resolveBlob, 'image/png'));
            if (!maskBlob) { toast?.('\u906e\u7f69\u56fe\u751f\u6210\u5931\u8d25\uff0c\u8bf7\u91cd\u8bd5'); return; }
            const instruction = String(instructionInput.value || '').trim();
            const prompt = instruction
              ? `\u8bf7\u4fee\u6539\u9009\u4e2d\u533a\u57df\uff1a${instruction}\n\u4fdd\u6301\u5176\u4f59\u533a\u57df\u4e0d\u53d8\u3002`
              : 'Remove the selected area and fill it naturally with the surrounding background.';
            cleanup({
              mode: 'erase',
              maskBlob,
              width: maskCanvas.width,
              height: maskCanvas.height,
              prompt,
              ...(instruction ? { label: `\u4fee\u6539\u56fe\u7247\u9009\u533a\uff1a${instruction}` } : {}),
            });
            return;
          }
          if (state.tool === 'remove_background') {
            cleanup({
              mode: 'remove_background',
              background: 'transparent',
              output_format: 'png',
              prompt: '移除此图像的背景。保持所有前景主体不变且完整无损，边缘干净平滑。将背景设为透明。',
            });
          }
        });

        image.onload = () => {
          const naturalWidth = image.naturalWidth || image.width || 860;
          const naturalHeight = image.naturalHeight || image.height || 600;
          const availableWidth = Math.max(320, (body.clientWidth || windowRef?.innerWidth || 1400) - 24);
          const availableHeight = Math.max(240, (body.clientHeight || windowRef?.innerHeight || 900) - 24);
          const maxWidth = Math.min(availableWidth, naturalWidth);
          const maxHeight = Math.min(availableHeight, naturalHeight);
          const scale = Math.min(1, maxWidth / naturalWidth, maxHeight / naturalHeight);
          const displayWidth = Math.max(1, Math.round(naturalWidth * scale));
          const displayHeight = Math.max(1, Math.round(naturalHeight * scale));
          baseCanvas.width = displayWidth;
          baseCanvas.height = displayHeight;
          overlayCanvas.width = displayWidth;
          overlayCanvas.height = displayHeight;
          overlayCanvas.style.width = `${displayWidth}px`;
          overlayCanvas.style.height = `${displayHeight}px`;
          baseCanvas.getContext('2d')?.drawImage(image, 0, 0, displayWidth, displayHeight);
          overlayCanvas.getContext('2d')?.clearRect(0, 0, displayWidth, displayHeight);
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
    paintMask,
    createImageEditor,
  });

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root?.[Symbol.for('chatui.module-registry.v1')]?.get('moduleRegistry')?.register('imageEditorMaskEditor', api);
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
