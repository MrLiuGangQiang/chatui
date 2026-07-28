(function initChatUIAppImagePreviewWorkflow(root) {
  'use strict';

  function createImagePreviewWorkflow(deps = {}) {
    const { getElement, getImageBlob, canWriteImageClipboard, imageClipboardUnsupportedMessage, URL, document } = deps;
    const MIN_PREVIEW_SCALE = 0.5;
    const MAX_PREVIEW_SCALE = 5;
    const PREVIEW_SCALE_STEP = 0.14;
    let previewScale = 1;

    function updateImagePreviewCopyAvailability(){const e=getElement("imagePreviewCopy");if(!e)return;const t=canWriteImageClipboard();e.disabled=!t,e.classList.toggle("is-disabled",!t),e.title=t?"复制图片":imageClipboardUnsupportedMessage(),e.setAttribute("aria-label",e.title)}

    async function resolvePreviewSrc(e){if(!e)return{src:"",owned:!1};if(String(e).startsWith("indexeddb://")){const t=await getImageBlob(String(e).replace("indexeddb://",""));return t?{src:URL.createObjectURL(t),owned:!0}:{src:"",owned:!1}}if(String(e).startsWith("blob:"))return{src:e,owned:!1};return{src:e,owned:!1}}

    function clampPreviewScale(value){const numeric=Number(value);return Math.min(MAX_PREVIEW_SCALE,Math.max(MIN_PREVIEW_SCALE,Number.isFinite(numeric)?numeric:1))}

    function applyPreviewScale(value){const img=getElement("imagePreviewImg");previewScale=clampPreviewScale(value);if(img){img.style.transform=`scale(${previewScale})`;img.dataset.previewScale=previewScale.toFixed(2);img.classList.toggle("is-zoomed",previewScale>1.01);img.setAttribute("aria-label",`图片预览，当前缩放 ${Math.round(previewScale*100)}%，滚轮可放大或缩小`) }return previewScale}

    function resetPreviewZoom(){return applyPreviewScale(1)}

    function zoomImagePreview(delta){const direction=Number(delta)<0?1:-1;return applyPreviewScale(previewScale*(1+direction*PREVIEW_SCALE_STEP))}

    function bindPreviewWheel(){const preview=getElement("imagePreview");if(!preview||preview.dataset.wheelZoomBound==="1")return;preview.dataset.wheelZoomBound="1";preview.addEventListener("wheel",event=>{if(!preview.classList.contains("show"))return;event.preventDefault();event.stopPropagation();zoomImagePreview(event.deltaY)},{passive:!1});preview.addEventListener("dblclick",event=>{if(event.target?.closest?.("button"))return;event.preventDefault();resetPreviewZoom()})}

    async function openImagePreview(e,t="image.png"){const s=await resolvePreviewSrc(e);if(s?.src){const n=getElement("imagePreviewImg"),a=n?.dataset.previewObjectUrl;a?.startsWith("blob:")&&a!==s.src&&URL.revokeObjectURL(a),n.dataset.previewObjectUrl=s.owned?s.src:"",n.dataset.persistedSrc=e||"",n.dataset.filename=t||"image.png",n.src=s.src;resetPreviewZoom();const i=getElement("imagePreviewDownload");i&&(i.dataset.persistedHref=e||s.src,i.dataset.filename=t||"image.png",i.hidden=!1);const o=getElement("imagePreviewCopy");o&&(o.dataset.persistedHref=e||s.src,o.dataset.filename=t||"image.png",o.hidden=!1,updateImagePreviewCopyAvailability());bindPreviewWheel();const r=getElement("imagePreview");r&&(r._returnFocus=document?.activeElement,r.classList.add("show"),r.setAttribute("aria-hidden","false"));getElement("imagePreviewClose")?.focus?.({preventScroll:!0})}}

    function closeImagePreview(){const r=getElement("imagePreview"),a=document?.activeElement,i=r?._returnFocus;if(a&&r?.contains?.(a)){i&&i.isConnected&&!i.disabled?i.focus?.({preventScroll:!0}):a.blur?.()}const e=getElement("imagePreviewImg"),t=e?.dataset.previewObjectUrl;t?.startsWith("blob:")&&URL.revokeObjectURL(t),e&&(delete e.dataset.previewObjectUrl,delete e.dataset.persistedSrc,delete e.dataset.filename,delete e.dataset.previewScale,e.classList.remove("is-zoomed"),e.style.transform="",e.removeAttribute("aria-label")),previewScale=1,getElement("imagePreviewCopy")&&(getElement("imagePreviewCopy").hidden=!0),r?.classList.remove("show"),r?.setAttribute("aria-hidden","true"),r&&delete r._returnFocus,e&&(e.src="")}

    return Object.freeze({ updateImagePreviewCopyAvailability, resolvePreviewSrc, openImagePreview, closeImagePreview, zoomImagePreview, resetPreviewZoom, applyPreviewScale });
  }

  const api = Object.freeze({ createImagePreviewWorkflow });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.ChatUIAppImagePreviewWorkflow = api;
  if (root?.window) root.window.ChatUIAppImagePreviewWorkflow = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
