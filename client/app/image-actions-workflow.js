(function initChatUIAppImageActionsWorkflow(root) {
  'use strict';

  function createImageActionsWorkflow(deps = {}) {
    const { document, window, navigator, ClipboardItem, File, Image, URL, fetch, getImageBlob, toast, resetActionButtonState, markActionButtonBusy, restoreActionButtonSoon, openImagePreview, escapeAttr, getImageEditor, applyImageEdit, reconcileMessageActions } = deps;
    const fileNames = window?.ChatUIFileNames || root?.ChatUIFileNames;
    function downloadFilename(filename, fallbackStem = 'generated-image', fallbackExt = 'png') {
      return fileNames?.timestampExistingFilename ? fileNames.timestampExistingFilename(filename, { fallbackStem, fallbackExt }) : (filename || `${fallbackStem}.${fallbackExt}`);
    }

    function removeGeneratedImageInlineActions(e){e?.querySelectorAll?.(".content img.generated-thumb").forEach(e=>{let t=e.nextElementSibling;for(;t&&(t.matches?.(".image-icon-btn,[data-download-image],[data-copy-image],[data-share-image],.generated-image-actions")||!String(t.textContent||"").trim()&&0===t.children.length);){const e=t.nextElementSibling;t.remove(),t=e}}),e?.querySelectorAll?.(".content .generated-image-actions").forEach(e=>e.remove())}

    // A single render callback is not enough: messages can appear through
    // lazy rendering, history restore, or attribute updates. Observe the
    // transcript so every generated thumbnail gets its edit entry.
    let imageEditEntryObserver = null;
    function startImageEditEntryObserver() {
      if (imageEditEntryObserver || typeof MutationObserver !== 'function') return;
      const host = document.getElementById?.('messages') || document.querySelector?.('#messages');
      if (!host) return;
      const handleNode = node => {
        if (!node || node.nodeType !== 1) return;
        const message = node.classList?.contains('message') ? node : node.closest?.('.message');
        if (message) ensureImageEditEntry(message);
        if (node.matches?.('img.generated-thumb')) {
          const parentMessage = node.closest?.('.message');
          if (parentMessage) ensureImageEditEntry(parentMessage);
        }
        node.querySelectorAll?.('.message').forEach(child => ensureImageEditEntry(child));
      };
      imageEditEntryObserver = new MutationObserver(mutations => {
        for (const mutation of mutations) {
          if (mutation.type === 'attributes') { handleNode(mutation.target); continue; }
          mutation.addedNodes?.forEach(handleNode);
        }
      });
      imageEditEntryObserver.observe(host, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['data-persisted-src', 'src'],
      });
    }

    function moveImageActionsToMessageActions(e, options = {}) {
      startImageEditEntryObserver();
      if (!(e.classList.contains("assistant") && !!e.querySelector("img.generated-thumb"))) return;
      if (options.complete === true) reconcileMessageActions?.(e);
      removeGeneratedImageInlineActions(e);
      const t = e.querySelector(".msg-actions");
      if (!t) return;
      t.querySelector(".copy-btn")?.remove();
      t.querySelectorAll("[data-image-action-clone]").forEach(clone => clone.remove());
      const s = t.querySelector(".refresh-btn"), n = document.createElement("button");
      n.className = "image-icon-btn icon-action-btn";
      n.type = "button";
      n.dataset.downloadAllImages = "1";
      n.dataset.imageActionClone = "1";
      n.title = "下载全部图片";
      n.setAttribute("aria-label", "下载全部图片");
      n.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v11"/><path d="m7 10 5 5 5-5"/><path d="M5 20h14"/></svg>';
      n.addEventListener("click", () => downloadAllImagesFromMessage(e, n));
      s ? t.insertBefore(n, s) : t.appendChild(n);
      ensureImageEditEntry(e);
    }

    function imageEditEntryUi() {
      return root?.[Symbol.for('chatui.module-registry.v1')]?.get('imageEditEntry')
        || (typeof require === 'function' ? require('../ui/image-edit-entry') : {});
    }

    // ChatGPT keeps the edit affordance on the image itself: a persistent edit
    // button opens the single-surface image editor directly instead of
    // inserting controls (or a second modal) into the transcript. The editor
    // owns tool selection, drawing, instructions, and apply/cancel.
    // Rendered thumbnails lose data-persisted-src whenever the source is still
    // a blob/data URL (stripTransientBlobUrlsFromHtml removes those attributes),
    // so the entry must match every generated thumbnail and resolve the blob
    // source lazily when the editor is opened.
    function imageSourceForEdit(image) {
      const api = window?.ChatUI?.imageActions || window?.ChatUIImageActions || {};
      if (typeof api.imageEditSource === 'function') return api.imageEditSource(image);
      return String(
        image?.dataset?.persistedSrc
        || image?.dataset?.originalSrc
        || image?.dataset?.persistedUrl
        || image?.dataset?.objectUrl
        || image?.currentSrc
        || image?.src
        || '',
      ).trim();
    }

    function imageEditHostFor(content, image) {
      return image?.closest?.('.generated-image-item')
        || image?.parentElement
        || content;
    }

    function ensureImageEditEntry(message) {
      if (typeof getImageEditor !== 'function' || typeof applyImageEdit !== 'function') return;
      const content = message.querySelector('.content');
      const images = content ? [...content.querySelectorAll('img.generated-thumb')] : [];
      if (!content || !images.length) return;
      let lastEntry = null;
      for (const image of images) {
        const host = imageEditHostFor(content, image);
        if (!host) continue;
        let entry = host.querySelector?.('[data-image-edit-entry]') || null;
        if (!entry) {
          entry = imageEditEntryUi().createImageEditEntryButton?.(document);
          if (!entry) return lastEntry;
          entry.addEventListener('click', event => {
            event.preventDefault();
            event.stopPropagation();
            const currentImage = host.querySelector?.('img.generated-thumb') || image;
            openImageEditorForElement(currentImage, { button: entry });
          });
          host.appendChild(entry);
        } else if (entry.parentElement !== host) {
          host.appendChild(entry);
        }
        lastEntry = entry;
      }
      return lastEntry;
    }

    // Shared by transcript thumbnails and the fullscreen image preview: resolve
    // the displayed image to its blob, open the single-surface editor, then
    // dispatch the edit through the same image workflow.
    async function openImageEditorForElement(image, { button = null, tool = '' } = {}) {
      if (!image) {
        toast('\u8fd9\u5f20\u56fe\u7247\u6682\u65f6\u65e0\u6cd5\u7f16\u8f91\uff0c\u8bf7\u91cd\u65b0\u751f\u6210\u540e\u518d\u8bd5');
        return false;
      }
      const editor = getImageEditor();
      if (!editor?.open) {
        toast('\u56fe\u7247\u7f16\u8f91\u5668\u4e0d\u53ef\u7528\uff0c\u8bf7\u5237\u65b0\u9875\u9762\u540e\u91cd\u8bd5');
        return false;
      }
      if (button && typeof markActionButtonBusy === 'function') markActionButtonBusy(button);
      try {
        const imageSource = imageSourceForEdit(image);
        if (!imageSource) throw new Error('\u56fe\u7247\u6682\u65f6\u4e0d\u53ef\u7528\uff0c\u8bf7\u5237\u65b0\u9875\u9762\u540e\u91cd\u8bd5');
        const filename = image.dataset?.filename || image.alt || 'image.png';
        const blob = await getImageActionBlob({ dataset: { persistedHref: imageSource }, getAttribute: () => '' });
        const edit = await editor.open(blob, { filename, tool });
        if (!edit) return false;
        await applyImageEdit({ imageBlob: blob, filename, edit });
        return true;
      } catch (error) {
        toast(error?.message || '\u56fe\u7247\u7f16\u8f91\u5931\u8d25\uff0c\u8bf7\u91cd\u8bd5');
        return false;
      } finally {
        if (button && typeof resetActionButtonState === 'function') resetActionButtonState(button);
      }
    }

    function downloadImageButtonHtml(e,t){return window.ChatUI.imageActions.downloadImageButtonHtml(e,t,escapeAttr)}

    function shareImageButtonHtml(e,t){return window.ChatUI.imageActions.shareImageButtonHtml(e,t,escapeAttr)}

    function copyImageButtonHtml(e,t){return window.ChatUI.imageActions.copyImageButtonHtml(e,t,escapeAttr)}

    function imageActionButtonsHtml(e,t){return window.ChatUI.imageActions.imageActionButtonsHtml(e,t,escapeAttr)}

    function ensureImageDownloadRow(e){const t=[...e.querySelectorAll("img.generated-thumb[data-persisted-src]")].filter(e=>e.dataset.persistedSrc);if(!t.length)return;let s=e.querySelector(".image-download-row");s||(s=document.createElement("div"),s.className="image-download-row",t[t.length-1].insertAdjacentElement("afterend",s));s.querySelector("[data-download-all-images]")||(s.innerHTML=downloadImageButtonHtml("","generated-images.zip").replace('data-download-image="1"','data-download-all-images="1"').replace("下载图片","下载全部图片"));s.querySelector("[data-download-all-images]")?.addEventListener("click",t=>downloadAllImagesFromMessage(e,t.currentTarget)),s.querySelectorAll("[data-download-image]").forEach(bindImageDownload),s.querySelectorAll("[data-copy-image]").forEach(bindImageCopy),s.querySelectorAll("[data-share-image]").forEach(bindImageShare)}

    async function getImageActionBlob(e){const t=e.dataset.persistedHref||e.getAttribute?.("href")||"";if(t.startsWith("indexeddb://")){const e=await getImageBlob(t.replace("indexeddb://",""));if(!e)throw new Error("图片缓存不存在，请重新生成");return e}if(/^https?:|^data:|^blob:/i.test(t)){const e=await fetch(t);if(e.ok)return e.blob()}throw new Error("图片缓存不存在，请重新生成")}

        async function imageBlobToPng(blob) {
      if (!blob || normalizedImageMimeType(blob.type) === IMAGE_CLIPBOARD_TYPE) return blob;
      const createBitmap = window?.createImageBitmap || root?.createImageBitmap;
      let source = null;
      let width = 0;
      let height = 0;
      if (typeof createBitmap === 'function') {
        source = await createBitmap(blob);
        width = Number(source?.width) || 0;
        height = Number(source?.height) || 0;
      } else {
        const url = URL.createObjectURL(blob);
        try {
          source = await new Promise((resolve, reject) => {
            const image = new Image();
            image.onload = () => resolve(image);
            image.onerror = () => reject(new Error('\u56fe\u7247\u8f6c\u6362\u5931\u8d25'));
            image.src = url;
          });
          width = Number(source.naturalWidth || source.width) || 0;
          height = Number(source.naturalHeight || source.height) || 0;
        } finally {
          URL.revokeObjectURL(url);
        }
      }
      if (!source || !width || !height) throw new Error('\u56fe\u7247\u8f6c\u6362\u5931\u8d25');
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext('2d', { alpha: true });
      if (!context) throw new Error('\u56fe\u7247\u8f6c\u6362\u5931\u8d25');
      context.drawImage(source, 0, 0, width, height);
      const png = await new Promise(resolve => canvas.toBlob(resolve, IMAGE_CLIPBOARD_TYPE));
      if (!png) throw new Error('\u56fe\u7247\u8f6c\u6362\u5931\u8d25');
      return png;
    }

    async function downloadImageActionElement(e) {
      const message = e?.closest?.('.message');
      const isGenerated = e?.dataset?.generatedImage === '1'
        || (!!message?.classList?.contains?.('assistant') && !!message.querySelector?.('img.generated-thumb'));
      let filename = downloadFilename(e.dataset.filename, 'generated-image', 'png');
      try {
        let blob = await getImageActionBlob(e);
        if (isGenerated) {
          blob = await imageBlobToPng(blob);
          const api = window?.ChatUI?.imageActions || window?.ChatUIImageActions || {};
          filename = typeof api.pngFilename === 'function'
            ? api.pngFilename(filename, 'generated-image')
            : filename.replace(/\.[a-z0-9]{2,5}$/i, '') + '.png';
        }
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = filename;
        anchor.rel = 'noreferrer';
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        setTimeout(() => URL.revokeObjectURL(url), 3e4);
      } catch (error) {
        toast(error?.message || String(error));
      }
    }

    const IMAGE_CLIPBOARD_TYPE="image/png";

    function normalizedImageMimeType(e){return String(e||"").split(";",1)[0].trim().toLowerCase()}

    function clipboardItemSupports(e){try{return typeof ClipboardItem?.supports!=="function"||ClipboardItem.supports(e)}catch{return!1}}

    function canWriteImageClipboard(){return!!window?.isSecureContext&&"function"==typeof navigator?.clipboard?.write&&"function"==typeof ClipboardItem&&clipboardItemSupports(IMAGE_CLIPBOARD_TYPE)}

    function imageClipboardUnsupportedMessage(){return window?.isSecureContext?"当前浏览器不支持复制图片到剪切板":"复制图片需要 HTTPS 或 localhost，当前局域网 HTTP 地址不支持"}

    function imageBlobToClipboardPng(e){if(!e)throw new Error("图片缓存不存在，请重新生成");if(IMAGE_CLIPBOARD_TYPE===normalizedImageMimeType(e.type))return e;return new Promise((t,s)=>{if(typeof Image!=="function"||typeof URL?.createObjectURL!=="function")return s(new Error("图片转换失败"));const n=new Image,a=URL.createObjectURL(e);let i=!1;const o=()=>{a&&URL.revokeObjectURL(a)},r=e=>{if(i)return;i=!0,o(),s(e)},c=e=>{if(i)return;i=!0,o(),t(e)};n.onload=()=>{try{const e=n.naturalWidth||n.width,s=n.naturalHeight||n.height;if(!(e>0&&s>0))throw new Error("图片转换失败");const l=document.createElement("canvas");l.width=e,l.height=s;const a=l.getContext("2d");if(!a)throw new Error("图片转换失败");a.drawImage(n,0,0,e,s),l.toBlob(e=>{e?c(e):r(new Error("图片转换失败"))},IMAGE_CLIPBOARD_TYPE)}catch(e){r(e)}};n.onerror=()=>r(new Error("图片转换失败"));try{n.src=a}catch(e){r(e)}})}

    async function copyImageActionElement(e){try{if(!canWriteImageClipboard())throw new Error(imageClipboardUnsupportedMessage());const t=getImageActionBlob(e).then(imageBlobToClipboardPng),s=new ClipboardItem({[IMAGE_CLIPBOARD_TYPE]:t});await navigator.clipboard.write([s]),toast("图片已复制")}catch(e){toast(e.message||String(e))}}

    async function downloadAllImagesFromMessage(e,t=null){const s=t||e?.querySelector?.("[data-download-all-images],.download-answer-btn");markActionButtonBusy(s);try{const t=[...e?.querySelectorAll?.("img.generated-thumb[data-persisted-src]")||[]].filter(e=>e.dataset.persistedSrc);if(!t.length)return resetActionButtonState(s),void toast("暂无可下载的图片");for(const e of t){const t=document.createElement("button");t.dataset.persistedHref=e.dataset.persistedSrc,t.dataset.filename=downloadFilename(e.dataset.filename,"generated-image","png"),t.dataset.generatedImage="1",await downloadImageActionElement(t)}restoreActionButtonSoon(s)}catch(e){resetActionButtonState(s),toast(e.message||String(e))}}

    function bindImageDownload(e){e.dataset.downloadBound||(e.dataset.downloadBound="1",e.addEventListener("click",()=>downloadImageActionElement(e)))}

    function bindImageCopy(e){e.dataset.copyBound||(e.dataset.copyBound="1",e.addEventListener("click",()=>copyImageActionElement(e)))}

    function bindImageShare(e){e.dataset.shareBound||(e.dataset.shareBound="1",e.addEventListener("click",async()=>{const t=downloadFilename(e.dataset.filename,"generated-image","png");try{const s=await getImageActionBlob(e),n=new File([s],t,{type:s.type||"image/png"});if(!navigator.share||!navigator.canShare?.({files:[n]}))throw new Error("当前浏览器不支持文件分享");await navigator.share({files:[n],title:t})}catch(e){if("AbortError"===e?.name)return;toast(e.message||String(e))}}))}

    function previewItemFromImage(image) {
      return {
        source: image?.dataset?.persistedSrc || image?.dataset?.originalSrc || image?.dataset?.persistedUrl || image?.currentSrc || image?.src || '',
        filename: image?.dataset?.filename || image?.alt || 'image.png',
      };
    }

    function previewItemsFromConversation(message) {
      const messages = document?.getElementById?.('messages') || message?.closest?.('#messages') || message;
      return [...messages.querySelectorAll('.message .content img, .content img')]
        .filter(image => !image.classList?.contains?.('clarification-choice-image'))
        .map(previewItemFromImage)
        .filter(item => item.source);
    }

    function openMessageImagePreview(message, image) {
      const items = previewItemsFromConversation(message);
      const selected = previewItemFromImage(image);
      const index = Math.max(0, items.findIndex(item => item.source === selected.source));
      return openImagePreview(selected.source, selected.filename, { items, index });
    }

    function bindImagePreview(e){
      e.querySelectorAll("[data-download-image]").forEach(bindImageDownload),e.querySelectorAll("[data-copy-image]").forEach(bindImageCopy),e.querySelectorAll("[data-share-image]").forEach(bindImageShare);
      e.querySelectorAll(".content img").forEach(img=>{if(img.classList?.contains?.("clarification-choice-image")||"1"===img.dataset.previewBound)return;img.dataset.previewBound="1";img.addEventListener("click",event=>{event.stopPropagation();openMessageImagePreview(e,img)})});
      e.querySelectorAll(".generated-image-item").forEach(item=>{if("1"!==item.dataset.previewBound){item.dataset.previewBound="1";item.addEventListener("click",event=>{if(event.target?.closest?.("button,a"))return;const img=item.querySelector("img.generated-thumb");img&&openMessageImagePreview(e,img)})}})
    }

    return Object.freeze({ removeGeneratedImageInlineActions, moveImageActionsToMessageActions, openImageEditorForElement, downloadImageButtonHtml, shareImageButtonHtml, copyImageButtonHtml, imageActionButtonsHtml, ensureImageDownloadRow, getImageActionBlob, downloadImageActionElement, canWriteImageClipboard, imageClipboardUnsupportedMessage, copyImageActionElement, downloadAllImagesFromMessage, bindImageDownload, bindImageCopy, bindImageShare, bindImagePreview });
  }

  const api = Object.freeze({ createImageActionsWorkflow });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.ChatUIAppImageActionsWorkflow = api;
  if (root?.window) root.window.ChatUIAppImageActionsWorkflow = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
