function downloadImageButtonHtml(href, filename, escapeAttr = value => String(value)) {
  return `<button class="image-icon-btn" type="button" data-download-image="1" data-persisted-href="${escapeAttr(href)}" data-filename="${escapeAttr(filename)}" title="下载图片" aria-label="下载图片"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v11"/><path d="m7 10 5 5 5-5"/><path d="M5 20h14"/></svg></button>`;
}

function shareImageButtonHtml(href, filename, escapeAttr = value => String(value)) {
  return `<button class="image-icon-btn" type="button" data-share-image="1" data-persisted-href="${escapeAttr(href)}" data-filename="${escapeAttr(filename)}" title="分享图片" aria-label="分享图片"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="M8.6 10.6 15.4 6.4"/><path d="M8.6 13.4 15.4 17.6"/></svg></button>`;
}

function imageActionButtonsHtml(href, filename, escapeAttr = value => String(value)) {
  return downloadImageButtonHtml(href, filename, escapeAttr) + shareImageButtonHtml(href, filename, escapeAttr);
}

module.exports = { downloadImageButtonHtml, shareImageButtonHtml, imageActionButtonsHtml };
