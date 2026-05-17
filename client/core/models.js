function normalizeModelType(type = '') {
  const value = String(type || '').toLowerCase();
  if (['chat', 'text', 'llm'].includes(value)) return 'chat';
  if (['image', 'images', 'text-to-image', 'image-generation'].includes(value)) return 'image';
  if (['embedding', 'embeddings'].includes(value)) return 'embedding';
  return value || '';
}

function inferModelType(model = {}) {
  const explicit = normalizeModelType(model.type || model.capability || model.mode);
  if (explicit) return explicit;
  const id = String(model.id || model.name || model || '').toLowerCase();
  if (/embedding|embed/.test(id)) return 'embedding';
  if (/image|dall-e|gpt-image|imagen|flux|sdxl|midjourney|wan2\.?[0-9]?/.test(id)) return 'image';
  return 'chat';
}

function normalizeModelMeta(models = [], meta = {}) {
  const result = {};
  for (const item of Array.isArray(models) ? models : []) {
    const id = typeof item === 'string' ? item : item?.id || item?.name;
    if (!id) continue;
    const current = meta?.[id] || {};
    const type = normalizeModelType(current.type) || inferModelType(item);
    result[id] = {
      id,
      type,
      unrecognized: current.unrecognized === true || !type,
    };
  }
  return result;
}

function isModelAllowedFor(modelId, targetType, meta = {}) {
  const type = normalizeModelType(meta?.[modelId]?.type || '');
  if (!targetType) return true;
  if (!type) return true;
  return type === normalizeModelType(targetType);
}

function extractModels(payload) {
  const data = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload) ? payload : [];
  return data
    .map(item => typeof item === 'string' ? { id: item } : item)
    .filter(item => item?.id || item?.name)
    .map(item => ({ id: String(item.id || item.name), type: inferModelType(item) }));
}

module.exports = { normalizeModelType, inferModelType, normalizeModelMeta, isModelAllowedFor, extractModels };
