const dispatchContract = require('../../shared/dispatch-contract');

const API_BY_OPERATION = Object.freeze({
  plain_chat: 'chat',
  file_qa: 'chat',
  multimodal_qa: 'chat',
  image_qa: 'chat',
  image_compare: 'chat',
  ocr: 'chat',
  text_to_image: 'image_generation',
  image_reference_gen: 'image_edit',
  edit_image: 'image_edit',
});

function normalizedResource(resource = {}, index = 0) {
  const type = resource.type || 'file';
  const id = String(resource.id || `${type}-${index + 1}`);
  return {
    key: resource.key || `r${index + 1}`,
    type,
    source: resource.source || 'current',
    role: resource.role || (type === 'file' ? 'attachment' : type === 'message' ? 'context' : 'source'),
    index: Number(resource.index || index + 1),
    id,
    resource_id: resource.resource_id || `res:${type}:${encodeURIComponent(id)}`,
    reference_id: String(resource.reference_id || ''),
    missing: false,
  };
}

function makeExecutionFixture({ prompt = '', operation = 'plain_chat', relation = 'new', resources = [], defaults = {} } = {}) {
  const normalized = resources.map(normalizedResource);
  const groups = { images: [], files: [], messages: [] };
  for (const resource of normalized) {
    const projected = { ...resource, resourceId: resource.resource_id };
    if (resource.type === 'image') groups.images.push(projected);
    else if (resource.type === 'file') groups.files.push(projected);
    else if (resource.type === 'message') groups.messages.push(projected);
  }
  const executionResources = {
    version: 'execution_resources.v2',
    operation,
    api: API_BY_OPERATION[operation],
    relation,
    ...groups,
    targets: groups.images.filter(resource => resource.role === 'target'),
    masks: groups.images.filter(resource => resource.role === 'mask'),
    references: groups.images.filter(resource => ['reference', 'style_reference'].includes(resource.role)),
    imageInputs: groups.images.filter(resource => ['target', 'reference', 'style_reference'].includes(resource.role)),
    chatImages: groups.images,
    chatFiles: groups.files,
    selectedMessageRefs: groups.messages,
  };
  return Object.freeze({
    resources: normalized,
    executionResources,
    dispatchContract: dispatchContract.compileDispatchContract({
      operation,
      relation,
      input: prompt,
      defaults,
      bindings: normalized.map(resource => ({
        key: resource.key,
        type: resource.type,
        role: resource.role,
        resource_id: resource.resource_id,
        source: resource.source,
      })),
      constraints: [],
    }),
  });
}

function makeDispatchContract(options = {}) {
  return makeExecutionFixture(options).dispatchContract;
}

module.exports = { makeExecutionFixture, makeDispatchContract, normalizedResource };
