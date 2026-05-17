function extractImageResult(result) {
  const item = result?.data?.[0] || null;
  if (!item) return { kind: 'empty', url: '', b64: '', raw: JSON.stringify(result, null, 2) };
  const url = item.url || '';
  const b64 = item.b64_json || item.image_base64 || '';
  const src = url || (b64 ? `data:image/png;base64,${b64}` : '');
  return src
    ? { kind: 'image', src, url, b64, raw: url || '[base64 image]' }
    : { kind: 'raw', url: '', b64: '', raw: JSON.stringify(result, null, 2) };
}

function buildImageCompletionMessage({ prompt = '', mode = 'image' } = {}) {
  return mode === 'edit_image' ? `[图片编辑完成] ${prompt}` : `[图片生成完成] ${prompt}`;
}

async function imageFileToJobPayload(attachment, readFileAsDataURL) {
  const file = attachment?.file;
  if (!file) return null;
  const dataUrl = await readFileAsDataURL(file);
  const data = String(dataUrl || '').split(',')[1] || '';
  return data ? {
    name: attachment.name || file.name || 'image.png',
    type: attachment.type || file.type || 'image/png',
    data,
  } : null;
}

async function imageFilesToJobPayload(attachments = [], readFileAsDataURL) {
  const result = [];
  for (const attachment of attachments) {
    const payload = await imageFileToJobPayload(attachment, readFileAsDataURL);
    if (payload) result.push(payload);
  }
  return result;
}

module.exports = { extractImageResult, buildImageCompletionMessage, imageFileToJobPayload, imageFilesToJobPayload };
