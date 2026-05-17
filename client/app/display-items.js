function compactDisplayItems(items = []) {
  const result = [];
  for (const item of items || []) {
    if (!item) continue;
    const prev = result[result.length - 1];
    const key = [item.role || '', item.rawText || '', item.html || '', item.pending || '', item.jobId || '', item.responseIndex || '', item.messageIndex || ''].join('');
    const prevKey = prev ? [prev.role || '', prev.rawText || '', prev.html || '', prev.pending || '', prev.jobId || '', prev.responseIndex || '', prev.messageIndex || ''].join('') : '';
    if (!prev || key !== prevKey) result.push(item);
  }
  return result;
}

function makeDisplayItemId(now = Date.now, random = Math.random) {
  return `display_${now().toString(36)}_${random().toString(36).slice(2, 9)}`;
}

function displayItemHasRichMedia(item) {
  return !!(item?.html && (
    /data-persisted-src=/.test(item.html) ||
    /data-persisted-href=/.test(item.html) ||
    /user-attachment-preview-grid/.test(item.html) ||
    /class=["'][^"']*generated-thumb/.test(item.html) ||
    /class=["'][^"']*user-attachment-image/.test(item.html) ||
    /image-download-row/.test(item.html)
  ));
}

module.exports = { compactDisplayItems, makeDisplayItemId, displayItemHasRichMedia };
