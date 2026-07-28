(function initChatUIExecutionResources(root) {
  'use strict';

  const PROJECTION_VERSION = 'execution_resources.v1';
  const MEDIA_TYPES = new Set(['image', 'file']);

  function normalizedId(item = {}, type = '') {
    return String(type === 'image'
      ? item.image_id || item.imageId || item.attachmentId || item.attachment_id || item.id || ''
      : item.file_id || item.fileId || item.attachmentId || item.attachment_id || item.id || '').trim();
  }

  function normalizedReferenceId(item = {}) {
    return String(item.reference_id || item.referenceId || '').trim();
  }

  function normalizedIdentityAliases(item = {}, type = '') {
    const primary = normalizedId(item, type);
    const aliases = item.identity_aliases || item.identityAliases || item.routeIdAliases || item.route_id_aliases;
    return [primary, ...(Array.isArray(aliases) ? aliases : [])]
      .map(value => String(value || '').trim())
      .filter(Boolean);
  }

  function normalizedSource(item = {}, fallback = '') {
    return String(item.routeSource || item.source || fallback || '').trim();
  }

  function normalizedMediaIndex(item = {}, fallback = 0) {
    return Number(item.media_index || item.mediaIndex || item.sourceIndex || item.source_index || fallback) || 0;
  }

  function candidateMatches(resource = {}, item = {}, type = '', fallbackSource = '', fallbackIndex = 0) {
    if (resource.type !== type) return false;
    if (normalizedSource(item, fallbackSource) !== resource.source) return false;
    const itemIds = normalizedIdentityAliases(item, type);
    const itemReferenceId = normalizedReferenceId(item);
    const resourceAliases = Array.isArray(resource.identity_aliases || resource.identityAliases)
      ? resource.identity_aliases || resource.identityAliases
      : [];
    const declaredIds = [resource.id, ...resourceAliases]
      .map(value => String(value || '').trim())
      .filter(Boolean);
    const identityMatchedByAlias = declaredIds.length > 0
      && itemIds.some(id => resourceAliases.map(value => String(value || '').trim()).includes(id));
    if (resource.id && !itemIds.includes(resource.id) && !identityMatchedByAlias) return false;
    // A validated current-turn alias may not have the route-context reference
    // ID on the in-memory File object. The alias itself is proof that the
    // route candidate and this upload were the same source/index pair.
    if (resource.reference_id && itemReferenceId !== resource.reference_id && !identityMatchedByAlias) return false;
    const itemIndex = normalizedMediaIndex(item, fallbackIndex);
    // A stable identity is authoritative.  Never use a presentation index to
    // choose between two candidates that share that identity: doing so would
    // turn a collision into an arbitrary attachment selection.
    if (resource.id || resourceAliases.length) return true;
    if (Number(resource.index) !== itemIndex) return false;
    return true;
  }

  function validateResource(resource = {}, type = '') {
    if (!resource || typeof resource !== 'object' || Array.isArray(resource)) return false;
    if (resource.type !== type || !/^r[1-9]\d*$/.test(String(resource.key || ''))) return false;
    if (!['current', 'quoted', 'history', 'context'].includes(String(resource.source || ''))) return false;
    if (!Number.isInteger(Number(resource.index)) || Number(resource.index) < 1) return false;
    if (typeof resource.id !== 'string' || typeof resource.reference_id !== 'string') return false;
    if (resource.identity_aliases !== undefined && (!Array.isArray(resource.identity_aliases) || resource.identity_aliases.some(value => typeof value !== 'string'))) return false;
    if (resource.index_aliases !== undefined && (!Array.isArray(resource.index_aliases) || resource.index_aliases.some(value => !Number.isInteger(Number(value)) || Number(value) < 1))) return false;
    return true;
  }

  function resolveOne(resource = {}, type = '', pools = {}) {
    if (!validateResource(resource, type)) {
      const error = new TypeError(`Invalid execution ${type} resource`);
      error.code = 'EXECUTION_RESOURCE_INVALID';
      error.resourceKey = String(resource?.key || '');
      throw error;
    }
    const source = String(resource.source || '');
    const pool = Array.isArray(pools[source]) ? pools[source] : [];
    let matches = pool
      .map((item, index) => ({ item, index }))
      .filter(({ item, index }) => candidateMatches(resource, item, type, source, index + 1));
    if (matches.length !== 1) {
      const error = new TypeError(`Resource ${resource.key || ''} is not uniquely available for execution`);
      error.code = 'EXECUTION_RESOURCE_UNRESOLVED';
      error.resourceKey = String(resource.key || '');
      error.resourceType = type;
      error.resourceSource = source;
      throw error;
    }
    const match = matches[0].item;
    return {
      ...match,
      routeResourceKey: resource.key,
      routeRole: resource.role,
      routeSource: resource.source,
      routeIndex: Number(resource.index),
      routeId: String(resource.id || normalizedId(match, type)),
      routeReferenceId: String(resource.reference_id || normalizedReferenceId(match)),
    };
  }

  function projectExecutionMedia(executionResources = {}, { imagePools = {}, filePools = {} } = {}) {
    if (executionResources?.version !== PROJECTION_VERSION) {
      throw new TypeError('A canonical execution resource projection is required');
    }
    const imageResources = Array.isArray(executionResources.images) ? executionResources.images : [];
    const fileResources = Array.isArray(executionResources.files) ? executionResources.files : [];
    const keys = new Set();
    [...imageResources, ...fileResources].forEach(resource => {
      if (keys.has(resource?.key)) {
        const error = new TypeError(`Duplicate execution resource key: ${resource.key}`);
        error.code = 'EXECUTION_RESOURCE_INVALID';
        throw error;
      }
      keys.add(resource?.key);
    });
    const images = imageResources.map(resource => resolveOne(resource, 'image', imagePools));
    const files = fileResources.map(resource => resolveOne(resource, 'file', filePools));
    const byRole = role => images.filter(item => item.routeRole === role);
    return {
      version: PROJECTION_VERSION,
      operation: executionResources.operation,
      images,
      files,
      targets: byRole('target'),
      references: images.filter(item => ['reference', 'style_reference'].includes(item.routeRole)),
      masks: byRole('mask'),
      imageInputs: images.filter(item => ['target', 'reference', 'style_reference'].includes(item.routeRole)),
      chatImages: images,
      chatFiles: files,
    };
  }

  const api = Object.freeze({
    PROJECTION_VERSION,
    candidateMatches,
    projectExecutionMedia,
  });

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root?.ChatUICore?.registerModule) root.ChatUICore.registerModule('executionResources', api);
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
