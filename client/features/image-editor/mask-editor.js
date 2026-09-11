'use strict';
(function initChatUIImageEditorMaskEditor(root) {
  'use strict';

  const sizePolicy = root?.[Symbol.for('chatui.module-registry.v1')]?.get('imageSizePolicy')
    || (typeof require === 'function' ? require('../../../shared/image-size-policy') : {});
  const annotationLayer = root?.[Symbol.for('chatui.module-registry.v1')]?.get('imageEditorAnnotationLayer')
    || (typeof require === 'function' ? require('./annotation-layer') : {});

  const EDITOR_STYLE_ID = 'chatui-image-editor-style';

  const EDITOR_CSS = `
.image-editor-backdrop{position:fixed;inset:0;z-index:1200;background:rgba(15,23,42,.55);display:flex;align-items:center;justify-content:center;padding:20px}
.image-editor-panel{width:min(920px,100%);max-height:92vh;display:flex;flex-direction:column;background:var(--surface,#fff);color:var(--text,#0f172a);border-radius:16px;box-shadow:0 24px 64px rgba(15,23,42,.35);overflow:hidden}
.image-editor-header{display:flex;align-items:center;gap:8px;padding:12px 16px;border-bottom:1px solid var(--border,#e2e8f0)}
.image-editor-title{font-size:14px;font-weight:600;margin-right:auto}
.image-editor-tool{display:inline-flex;align-items:center;gap:6px;padding:6px 12px;border:1px solid var(--border,#e2e8f0);border-radius:999px;background:transparent;color:inherit;font-size:13px;cursor:pointer}
.image-editor-tool[aria-pressed="true"]{background:var(--accent,#2563eb);border-color:var(--accent,#2563eb);color:#fff}
.image-editor-body{position:relative;display:flex;align-items:center;justify-content:center;padding:16px;overflow:auto;background:rgba(15,23,42,.04)}
.image-editor-stage{position:relative;line-height:0}
.image-editor-stage canvas{display:block;max-width:100%;border-radius:8px}
.image-editor-overlay{position:absolute;left:0;top:0;cursor:crosshair;touch-action:none}
.image-editor-footer{display:flex;align-items:center;gap:12px;padding:12px 16px;border-top:1px solid var(--border,#e2e8f0);flex-wrap:wrap}
.image-editor-hint{font-size:12px;color:var(--text-muted,#64748b);margin-right:auto}
.image-editor-action{padding:7px 16px;border-radius:8px;border:1px solid var(--border,#e2e8f0);background:transparent;color:inherit;font-size:13px;cursor:pointer}
.image-editor-action.primary{background:var(--accent,#2563eb);border-color:var(--accent,#2563eb);color:#fff}
.image-editor-brush{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--text-muted,#64748b)}
.image-editor-brush input{width:120px}
.image-editor-size-row{display:none;align-items:center;gap:8px;flex-wrap:wrap}
.image-editor-size-row.active{display:flex}
.image-editor-size-row select,.image-editor-size-row input{padding:6px 10px;border:1px solid var(--border,#e2e8f0);border-radius:8px;background:var(--surface,#fff);color:inherit;font-size:13px}
.image-editor-size-error{font-size:12px;color:#dc2626;min-height:16px}
`;

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
          tool: 'erase',
          brush: 28,
          strokes: [],
          size: '1024x1024',
          annotateTool: 'freehand',
          shapes: [],
          draftShape: null,
          comments: [],
          pendingTextPoint: null,
          pendingTextKind: '',
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
        const eraseButton = toolButton('\u64e6\u9664', 'erase');
        const backgroundButton = toolButton('\u79fb\u9664\u80cc\u666f', 'remove_background');
        const resizeButton = toolButton('\u8c03\u6574\u5c3a\u5bf8', 'resize');
        const annotateButton = toolButton('\u6807\u6ce8', 'annotate');
        const commentButton = toolButton('\u8bc4\u8bba', 'comment');
        const closeButton = el('button', { className: 'image-editor-action', type: 'button', textContent: '\u53d6\u6d88' });
        header.append(title, eraseButton, backgroundButton, resizeButton, annotateButton, commentButton, closeButton);

        const body = el('div', { className: 'image-editor-body' });
        const stage = el('div', { className: 'image-editor-stage' });
        const baseCanvas = el('canvas', { className: 'image-editor-base' });
        const overlayCanvas = el('canvas', { className: 'image-editor-overlay' });
        stage.append(baseCanvas, overlayCanvas);
        body.appendChild(stage);

        const footer = el('div', { className: 'image-editor-footer' });
        const hint = el('span', { className: 'image-editor-hint', textContent: '\u5728\u56fe\u7247\u4e0a\u6d82\u62b9\u8981\u64e6\u9664\u7684\u533a\u57df' });
        const brushRow = el('label', { className: 'image-editor-brush' });
        const brushInput = el('input', { type: 'range', min: '8', max: '80', value: String(state.brush) });
        brushRow.append(documentRef.createTextNode('\u7b14\u5237'), brushInput);
        const undoButton = el('button', { className: 'image-editor-action', type: 'button', textContent: '\u64a4\u9500' });
        const clearButton = el('button', { className: 'image-editor-action', type: 'button', textContent: '\u6e05\u9664' });
        const sizeRow = el('div', { className: 'image-editor-size-row' });
        const sizeSelect = el('select', {});
        for (const size of (sizePolicy.PRESET_SIZES || []).filter(item => item !== 'auto')) {
          sizeSelect.appendChild(el('option', { value: size, textContent: size }));
        }
        sizeSelect.appendChild(el('option', { value: 'custom', textContent: '\u81ea\u5b9a\u4e49' }));
        const sizeInput = el('input', { type: 'text', placeholder: '\u4f8b\u5982 1536x864', value: '' });
        const sizeError = el('span', { className: 'image-editor-size-error' });
        sizeRow.append(sizeSelect, sizeInput, sizeError);
        const annotateRow = el('div', { className: 'image-editor-size-row' });
        const annotateToolButtons = [
          ['\u753b\u7b14', 'freehand'],
          ['\u7bad\u5934', 'arrow'],
          ['\u77e9\u5f62', 'rect'],
          ['\u6587\u5b57', 'text'],
        ].map(([label, value]) => {
          const button = el('button', { className: 'image-editor-tool', type: 'button', textContent: label, 'aria-pressed': 'false' });
          button.addEventListener('click', () => selectAnnotateTool(value));
          annotateRow.appendChild(button);
          return { button, value };
        });
        const instructionRow = el('div', { className: 'image-editor-size-row' });
        const instructionInput = el('input', { type: 'text', placeholder: '\u63cf\u8ff0\u8981\u5982\u4f55\u4fee\u6539\uff08\u6807\u6ce8\u5fc5\u586b\uff09' });
        instructionRow.appendChild(instructionInput);
        const textRow = el('div', { className: 'image-editor-size-row image-editor-text-row' });
        const textInput = el('input', { type: 'text', placeholder: '\u8f93\u5165\u5185\u5bb9\u540e\u6309\u56de\u8f66\u786e\u8ba4' });
        const textConfirm = el('button', { className: 'image-editor-action', type: 'button', textContent: '\u786e\u5b9a' });
        const textCancel = el('button', { className: 'image-editor-action', type: 'button', textContent: '\u53d6\u6d88' });
        textRow.append(textInput, textConfirm, textCancel);
        const applyButton = el('button', { className: 'image-editor-action primary', type: 'button', textContent: '\u5e94\u7528' });
        footer.append(hint, brushRow, undoButton, clearButton, sizeRow, annotateRow, instructionRow, textRow, applyButton);
        panel.append(header, body, footer);
        backdrop.appendChild(panel);
        documentRef.body.appendChild(backdrop);
        // The tool must be interactive before the bitmap finishes decoding;
        // otherwise early clicks land on an uninitialised editor.
        selectTool(['erase', 'annotate', 'comment', 'resize', 'remove_background'].includes(String(tool || ''))
          ? String(tool)
          : 'erase');

        function toolButton(label, value) {
          const button = el('button', { className: 'image-editor-tool', type: 'button', textContent: label, 'aria-pressed': 'false' });
          button.addEventListener('click', () => selectTool(value));
          return button;
        }

        function selectAnnotateTool(tool) {
          state.annotateTool = tool;
          for (const entry of annotateToolButtons) {
            entry.button.setAttribute('aria-pressed', String(entry.value === tool));
          }
        }

        function selectTool(tool) {
          state.tool = tool;
          eraseButton.setAttribute('aria-pressed', String(tool === 'erase'));
          backgroundButton.setAttribute('aria-pressed', String(tool === 'remove_background'));
          resizeButton.setAttribute('aria-pressed', String(tool === 'resize'));
          annotateButton.setAttribute('aria-pressed', String(tool === 'annotate'));
          commentButton.setAttribute('aria-pressed', String(tool === 'comment'));
          const erasing = tool === 'erase';
          const annotating = tool === 'annotate';
          const commenting = tool === 'comment';
          brushRow.style.display = erasing ? '' : 'none';
          undoButton.style.display = erasing || annotating ? '' : 'none';
          clearButton.style.display = erasing || annotating ? '' : 'none';
          overlayCanvas.style.pointerEvents = tool === 'remove_background' || tool === 'resize' ? 'none' : '';
          hint.textContent = tool === 'erase'
            ? '\u5728\u56fe\u7247\u4e0a\u6d82\u62b9\u8981\u64e6\u9664\u7684\u533a\u57df'
            : tool === 'remove_background'
              ? '\u5c06\u81ea\u52a8\u79fb\u9664\u80cc\u666f\u5e76\u8f93\u51fa\u900f\u660e\u5e95 PNG'
              : tool === 'resize'
                ? '\u9009\u62e9\u6216\u8f93\u5165\u8f93\u51fa\u5c3a\u5bf8'
                : annotating
                  ? '\u9009\u62e9\u5b50\u5de5\u5177\u540e\u5728\u56fe\u7247\u4e0a\u7ed8\u5236\u6807\u6ce8\uff0c\u5e76\u586b\u5199\u4fee\u6539\u8bf4\u660e'
                  : '\u70b9\u51fb\u56fe\u7247\u6dfb\u52a0\u7f16\u53f7\u8bc4\u8bba\uff0c\u7f16\u53f7\u4f1a\u5199\u5165\u4fee\u6539\u8bf4\u660e';
          sizeRow.classList.toggle('active', tool === 'resize');
          annotateRow.classList.toggle('active', annotating);
          instructionRow.classList.toggle('active', annotating || commenting);
          if (annotating) selectAnnotateTool(state.annotateTool);
          cancelTextEntry();
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
          const shapes = state.draftShape ? [...state.shapes, state.draftShape] : state.shapes;
          if (shapes.length || state.comments.length) {
            annotationLayer.paintAnnotations?.(ctx, {
              width: overlayCanvas.width,
              height: overlayCanvas.height,
              shapes,
              comments: state.comments,
            });
          }
        }

        let painting = false;
        overlayCanvas.addEventListener('pointerdown', event => {
          if (state.tool === 'erase') {
            painting = true;
            overlayCanvas.setPointerCapture?.(event.pointerId);
            addStroke(event);
            return;
          }
          if (state.tool === 'annotate') {
            startAnnotate(event);
            return;
          }
          if (state.tool === 'comment') {
            addComment(event);
          }
        });
        overlayCanvas.addEventListener('pointermove', event => {
          if (painting) { addStroke(event); return; }
          if (state.draftShape) updateAnnotate(event);
        });
        const stopPainting = () => {
          painting = false;
          finishAnnotate();
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
          state.strokes.push({ x: point.x, y: point.y, radius });
          drawOverlay();
        }

        function startAnnotate(event) {
          const point = pointFromEvent(event);
          if (state.annotateTool === 'text') {
            beginTextEntry('annotation', point);
            return;
          }
          overlayCanvas.setPointerCapture?.(event.pointerId);
          state.draftShape = state.annotateTool === 'freehand'
            ? { type: 'freehand', points: [point] }
            : { type: state.annotateTool, x: point.x, y: point.y, x2: point.x, y2: point.y };
          drawOverlay();
        }

        function updateAnnotate(event) {
          if (!state.draftShape) return;
          const point = pointFromEvent(event);
          if (state.draftShape.type === 'freehand') state.draftShape.points.push(point);
          else {
            state.draftShape.x2 = point.x;
            state.draftShape.y2 = point.y;
          }
          drawOverlay();
        }

        function finishAnnotate() {
          const draft = state.draftShape;
          state.draftShape = null;
          if (!draft) return;
          if (draft.type === 'freehand') {
            if (draft.points.length >= 2) state.shapes.push(draft);
          } else if (Math.abs(draft.x2 - draft.x) > 0.005 || Math.abs(draft.y2 - draft.y) > 0.005) {
            state.shapes.push(draft);
          }
          drawOverlay();
        }

        function beginTextEntry(kind, point) {
          state.pendingTextKind = kind;
          state.pendingTextPoint = point;
          textRow.classList.add('active');
          textInput.value = '';
          textInput.focus?.();
        }

        function cancelTextEntry() {
          state.pendingTextKind = '';
          state.pendingTextPoint = null;
          textRow.classList.remove('active');
          textInput.value = '';
        }

        function commitTextEntry() {
          const text = String(textInput.value || '').trim();
          const point = state.pendingTextPoint;
          const kind = state.pendingTextKind;
          if (!text || !point) { cancelTextEntry(); return; }
          if (kind === 'annotation') state.shapes.push({ type: 'text', x: point.x, y: point.y, text });
          else state.comments.push({ x: point.x, y: point.y, text });
          cancelTextEntry();
          drawOverlay();
        }

        textConfirm.addEventListener('click', commitTextEntry);
        textCancel.addEventListener('click', cancelTextEntry);
        textInput.addEventListener('keydown', event => {
          if (event.key === 'Enter') { event.preventDefault(); commitTextEntry(); }
          else if (event.key === 'Escape') { event.preventDefault(); cancelTextEntry(); }
        });

        function addComment(event) {
          beginTextEntry('comment', pointFromEvent(event));
        }

        brushInput.addEventListener('input', () => { state.brush = Number(brushInput.value) || 28; });
        undoButton.addEventListener('click', () => {
          if (state.tool === 'annotate') state.shapes.pop();
          else state.strokes.pop();
          drawOverlay();
        });
        clearButton.addEventListener('click', () => {
          if (state.tool === 'annotate') state.shapes = [];
          else state.strokes = [];
          drawOverlay();
        });
        sizeSelect.addEventListener('change', () => {
          const custom = sizeSelect.value === 'custom';
          sizeInput.style.display = custom ? '' : 'none';
          if (!custom) state.size = sizeSelect.value;
          sizeError.textContent = '';
        });
        sizeInput.addEventListener('input', () => {
          const result = sizePolicy.validateImageSize(sizeInput.value);
          sizeError.textContent = result.valid ? '' : (result.message || '');
          if (result.valid) state.size = result.size;
        });
        sizeInput.style.display = 'none';
        closeButton.addEventListener('click', () => cleanup(null));
        backdrop.addEventListener('click', event => { if (event.target === backdrop) cleanup(null); });
        documentRef.addEventListener('keydown', onKeydown);

        applyButton.addEventListener('click', async () => {
          if (state.tool === 'erase') {
            if (!state.strokes.length) { toast?.('\u8bf7\u5148\u5728\u56fe\u7247\u4e0a\u6d82\u62b9\u8981\u64e6\u9664\u7684\u533a\u57df'); return; }
            const maskCanvas = documentRef.createElement('canvas');
            maskCanvas.width = image.naturalWidth || image.width;
            maskCanvas.height = image.naturalHeight || image.height;
            const maskCtx = maskCanvas.getContext('2d');
            if (!maskCtx || typeof maskCanvas.toBlob !== 'function') { toast?.('\u5f53\u524d\u6d4f\u89c8\u5668\u4e0d\u652f\u6301\u751f\u6210\u906e\u7f69\uff0c\u8bf7\u66f4\u6362\u6d4f\u89c8\u5668\u540e\u91cd\u8bd5'); return; }
            paintMask(maskCtx, { width: maskCanvas.width, height: maskCanvas.height, strokes: state.strokes });
            const maskBlob = await new Promise(resolveBlob => maskCanvas.toBlob(resolveBlob, 'image/png'));
            if (!maskBlob) { toast?.('\u906e\u7f69\u56fe\u751f\u6210\u5931\u8d25\uff0c\u8bf7\u91cd\u8bd5'); return; }
            cleanup({
              mode: 'erase',
              maskBlob,
              width: maskCanvas.width,
              height: maskCanvas.height,
              prompt: 'Remove the selected area and fill it naturally with the surrounding background.',
            });
            return;
          }
          if (state.tool === 'annotate' || state.tool === 'comment') {
            const instruction = String(instructionInput.value || '').trim();
            const composite = documentRef.createElement('canvas');
            composite.width = image.naturalWidth || image.width;
            composite.height = image.naturalHeight || image.height;
            const compositeCtx = composite.getContext('2d');
            if (!compositeCtx || typeof composite.toBlob !== 'function') {
              toast?.('\u5f53\u524d\u6d4f\u89c8\u5668\u4e0d\u652f\u6301\u5408\u6210\u6807\u6ce8\u56fe\uff0c\u8bf7\u66f4\u6362\u6d4f\u89c8\u5668\u540e\u91cd\u8bd5');
              return;
            }
            compositeCtx.drawImage(image, 0, 0, composite.width, composite.height);
            const painted = annotationLayer.paintAnnotations?.(compositeCtx, {
              width: composite.width,
              height: composite.height,
              shapes: state.shapes,
              comments: state.comments,
            }) || 0;
            if (!painted) {
              toast?.('\u8bf7\u5148\u5728\u56fe\u7247\u4e0a\u6dfb\u52a0\u6807\u6ce8\u6216\u8bc4\u8bba');
              return;
            }
            if (state.tool === 'annotate' && !instruction) {
              toast?.('\u8bf7\u586b\u5199\u8981\u5982\u4f55\u4fee\u6539\u7684\u8bf4\u660e');
              return;
            }
            const prompt = state.tool === 'comment'
              ? (annotationLayer.buildCommentPrompt?.(state.comments, instruction) || '')
              : instruction + '\n\n\u8bf7\u6839\u636e\u56fe\u7247\u4e0a\u7684\u6807\u6ce8\u8fdb\u884c\u4fee\u6539\u3002';
            if (!prompt) {
              toast?.('\u8bf7\u586b\u5199\u8bc4\u8bba\u6216\u4fee\u6539\u8bf4\u660e');
              return;
            }
            const annotatedBlob = await new Promise(resolveBlob => composite.toBlob(resolveBlob, 'image/png'));
            if (!annotatedBlob) {
              toast?.('\u6807\u6ce8\u56fe\u751f\u6210\u5931\u8d25\uff0c\u8bf7\u91cd\u8bd5');
              return;
            }
            cleanup({ mode: state.tool, annotatedBlob, prompt });
            return;
          }
          if (state.tool === 'remove_background') {
            cleanup({
              mode: 'remove_background',
              background: 'transparent',
              output_format: 'png',
              prompt: 'Remove the background and keep the subject cleanly cut out.',
            });
            return;
          }
          const result = sizePolicy.validateImageSize(state.size);
          if (!result.valid) { sizeError.textContent = result.message || '\u5c3a\u5bf8\u65e0\u6548'; return; }
          cleanup({ mode: 'resize', size: result.size, prompt: `Resize the image to ${result.size}.` });
        });

        image.onload = () => {
          const naturalWidth = image.naturalWidth || image.width || 860;
          const naturalHeight = image.naturalHeight || image.height || 600;
          const maxWidth = Math.min(860, naturalWidth);
          const maxHeight = Math.max(240, Math.round((windowRef?.innerHeight || 900) * 0.6));
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
    strokeContainsPoint,
    maskAlphaAtPoint,
    normalizeStrokePoint,
    paintMask,
    createImageEditor,
  });

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root?.[Symbol.for('chatui.module-registry.v1')]?.get('moduleRegistry')?.register('imageEditorMaskEditor', api);
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
