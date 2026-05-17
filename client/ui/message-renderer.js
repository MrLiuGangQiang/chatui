function attachmentsSummaryMarkdown(attachments = []) {
  return attachments.length ? '\n\n' + attachments.map(item => `📎 ${item.name}`).join('\n') : '';
}

function userAttachmentPreviewItems(attachments = [], fitImageThumb = (w, h) => ({ width: w || 180, height: h || 120 })) {
  return attachments
    .filter(item => item && item.isImage && (item.previewSrc || item.dataUrl))
    .map(item => {
      const thumb = fitImageThumb(item.previewWidth, item.previewHeight, 180, 120);
      return {
        ...item,
        src: item.previewSrc || item.dataUrl,
        thumbWidth: item.thumbWidth || thumb.width,
        thumbHeight: item.thumbHeight || thumb.height,
      };
    });
}

function renderUserMessageParts({ markdownHtml = '', imagePreviewHtml = '', attachmentSummaryHtml = '' } = {}) {
  return `${markdownHtml}${imagePreviewHtml}${attachmentSummaryHtml}`;
}

module.exports = { attachmentsSummaryMarkdown, userAttachmentPreviewItems, renderUserMessageParts };
