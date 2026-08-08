(function initChatUIExecutionResources(root) {
  'use strict';

  const PROJECTION_VERSION = 'execution_resources.v2';
  const MEDIA_TYPES = new Set(['image', 'file', 'message']);
  const POOL_SOURCES = Object.freeze(['current', 'quoted', 'history', 'context']);
  const resourceIdentity = root?.[Symbol.for('chatui.module-registry.v1')]?.get('resourceIdentity')
    || root?.ChatUICore?.resourceIdentity
    || (typeof require === 'function' ? require('./resource-identity') : {});

  function scalarIdentityValue(value = '') {
    if (typeof resourceIdentity?.scalarIdentityValue === 'function') return resourceIdentity.scalarIdentityValue(value);
    if (typeof value === 'string') return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    if (typeof value === 'bigint') return String(value);
    return '';
  }

  function firstIdentityValue(values = []) {
    for (const value of values) {
      const normalized = scalarIdentityValue(value);
      if (normalized) return normalized;
    }
    return '';
  }

  function normalizedId(item = {}, type = '') {
    if (type === 'message') {
      return firstIdentityValue([item.message_id, item.messageId, item.display_item_id, item.displayItemId, item.attachmentId, item.attachment_id, item.id]);
    }
    return type === 'image'
      ? firstIdentityValue([item.image_id, item.imageId, item.attachmentId, item.attachment_id, item.id])
      : firstIdentityValue([item.file_id, item.fileId, item.attachmentId, item.attachment_id, item.id]);
  }

  function normalizedReferenceId(item = {}) {
    return firstIdentityValue([item.reference_id, item.referenceId]);
  }

  function explicitResourceId(item = {}) {
    return firstIdentityValue([item.resource_id, item.resourceId, item.routeResourceId]);
  }

  function normalizedResourceId(item = {}, type = '') {
    const canonical = resourceIdentity?.canonicalResourceId?.(type, item);
    if (canonical) return String(canonical).trim();
    const explicit = explicitResourceId(item);
    if (explicit.startsWith(`res:${type}:`)) return explicit;
    const native = normalizedId(item, type);
    return native ? `res:${type}:${encodeURIComponent(native)}` : '';
  }

  function normalizedIdentityAliases(item = {}, type = '') {
    const primary = normalizedId(item, type);
    const canonical = normalizedResourceId(item, type);
    const tokens = resourceIdentity?.identityTokens?.(item, type) || [];
    const aliases = item.identity_aliases || item.identityAliases || item.routeIdAliases || item.route_id_aliases;
    return [...new Set([canonical, primary, ...tokens, ...(Array.isArray(aliases) ? aliases : [])]
      .map(value => String(value || '').trim())
      .filter(Boolean))];
  }

  function normalizedSource(item = {}, fallback = '') {
    return String(item.routeSource || item.source || fallback || '').trim();
  }

  function normalizedMediaIndex(item = {}, fallback = 0) {
    return Number(item.media_index || item.mediaIndex || item.sourceIndex || item.source_index || fallback) || 0;
  }

  function durableLocatorOf(item = {}) {
    const locator = resourceIdentity?.durableLocator?.(item)
      || firstIdentityValue([item.persistedSrc, item.persisted_src, item.storageKey, item.storage_key, item.src, item.url, item.href]);
    return locator && !/^(?:data:|blob:)/i.test(locator) ? locator : '';
  }

  function candidateMatches(resource = {}, item = {}, type = '', options = {}) {
    if (resource.type !== type) return false;
    const itemTokens = normalizedIdentityAliases(item, type);
    const itemResourceId = normalizedResourceId(item, type);
    const resourceResourceId = normalizedResourceId(resource, type);
    const itemExplicitResourceId = explicitResourceId(item);
    const resourceExplicitResourceId = explicitResourceId(resource);
    const resourceTokens = normalizedIdentityAliases(resource, type);
    const itemReferenceId = normalizedReferenceId(item);
    const resourceReferenceId = String(resource.reference_id || resource.referenceId || '').trim();
    const identityMatched = resourceTokens.length > 0
      && itemTokens.some(token => resourceTokens.includes(token));
    // Distinct explicit canonical identities never merge through aliases or
    // presentation locators.
    if (resourceExplicitResourceId && itemExplicitResourceId
        && resourceResourceId && itemResourceId && resourceResourceId !== itemResourceId) return false;
    if (resourceTokens.length && !identityMatched) return false;
    // A validated identity alias may bridge route-context and restored runtime
    // representations even when only the route context carried reference_id.
    if (resourceReferenceId && itemReferenceId !== resourceReferenceId && !identityMatched) return false;
    if (type !== 'message') {
      const itemIndex = normalizedMediaIndex(item, Number(options.fallbackIndex) || 1);
      const resourceIndex = Number(resource.index) || 0;
      // Stable identity is authoritative. Never use a presentation index to pick
      // between multiple objects claiming the same identity.
      if (resourceIndex >= 1 && itemIndex !== resourceIndex && !identityMatched) return false;
    }
    return true;
  }

  function validateResource(resource = {}, type = '') {
    if (!resource || typeof resource !== 'object' || Array.isArray(resource)) return false;
    if (resource.type !== type || !/^r[1-9]\d*$/.test(String(resource.key || ''))) return false;
    if (!['current', 'quoted', 'history', 'context'].includes(String(resource.source || ''))) return false;
    if (!Number.isInteger(Number(resource.index)) || Number(resource.index) < 1) return false;
    if (typeof resource.id !== 'string' || typeof resource.reference_id !== 'string') return false;
    if (resource.resource_id !== undefined && typeof resource.resource_id !== 'string') return false;
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
    const matches = [];
    for (const source of POOL_SOURCES) {
      const pool = Array.isArray(pools[source]) ? pools[source] : [];
      pool.forEach((item, index) => {
        if (candidateMatches(resource, item, type, { fallbackIndex: index + 1 })) {
          matches.push({ item, source });
        }
      });
    }
    if (!matches.length) {
      const error = new TypeError(`Resource ${resource.key || ''} is not uniquely available for execution`);
      error.code = 'EXECUTION_RESOURCE_UNRESOLVED';
      error.resourceKey = String(resource.key || '');
      error.resourceType = type;
      error.resourceSource = String(resource.source || '');
      throw error;
    }
    const locators = [...new Set(matches.map(match => durableLocatorOf(match.item)).filter(Boolean))];
    if (locators.length > 1) {
      const error = new TypeError(`Resource ${resource.key || ''} resolves to conflicting durable identities`);
      error.code = 'EXECUTION_RESOURCE_ID_CONFLICT';
      error.resourceKey = String(resource.key || '');
      error.resourceType = type;
      throw error;
    }
    if (matches.length > 1 && !locators.length) {
      const error = new TypeError(`Resource ${resource.key || ''} is ambiguous across unproven duplicates`);
      error.code = 'EXECUTION_RESOURCE_UNRESOLVED';
      error.resourceKey = String(resource.key || '');
      error.resourceType = type;
      throw error;
    }
    const origins = [...new Set(matches.map(match => match.source))].sort();
    const primary = matches[0].item;
    const canonicalResourceId = String(resource.resource_id || normalizedResourceId(primary, type));
    return {
      ...primary,
      resource_id: canonicalResourceId,
      resourceId: canonicalResourceId,
      routeResourceKey: resource.key,
      routeResourceType: type,
      routeRole: resource.role,
      routeSource: resource.source,
      routeIndex: Number(resource.index),
      routeId: String(resource.id || normalizedId(primary, type)),
      routeResourceId: canonicalResourceId,
      routeReferenceId: String(resource.reference_id || normalizedReferenceId(primary)),
      routeOriginSource: origins.length === 1 ? origins[0] : '',
      routeOriginSources: origins,
    };
  }

  function projectExecutionMedia(executionResources = {}, { imagePools = {}, filePools = {}, messagePools = {} } = {}) {
    if (executionResources?.version !== PROJECTION_VERSION) {
      throw new TypeError('A canonical execution resource projection is required');
    }
    const imageResources = Array.isArray(executionResources.images) ? executionResources.images : [];
    const fileResources = Array.isArray(executionResources.files) ? executionResources.files : [];
    const messageResources = Array.isArray(executionResources.messages) ? executionResources.messages : [];
    const keys = new Set();
    [...imageResources, ...fileResources, ...messageResources].forEach(resource => {
      if (keys.has(resource?.key)) {
        const error = new TypeError(`Duplicate execution resource key: ${resource.key}`);
        error.code = 'EXECUTION_RESOURCE_INVALID';
        throw error;
      }
      keys.add(resource?.key);
    });
    const images = imageResources.map(resource => resolveOne(resource, 'image', imagePools));
    const files = fileResources.map(resource => resolveOne(resource, 'file', filePools));
    const messages = messageResources.map(resource => resolveOne(resource, 'message', messagePools));
    const byRole = role => images.filter(item => item.routeRole === role);
    return {
      version: PROJECTION_VERSION,
      operation: executionResources.operation,
      api: executionResources.api,
      relation: executionResources.relation,
      images,
      files,
      messages,
      targets: byRole('target'),
      references: images.filter(item => ['reference', 'style_reference'].includes(item.routeRole)),
      masks: byRole('mask'),
      imageInputs: images.filter(item => ['target', 'reference', 'style_reference'].includes(item.routeRole)),
      chatImages: images,
      chatFiles: files,
      chatMessages: messages,
      selectedMessageRefs: messages,
    };
  }

  const api = Object.freeze({
    PROJECTION_VERSION,
    POOL_SOURCES,
    candidateMatches,
    resolveOne,
    projectExecutionMedia,
  });

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root?.ChatUICore?.registerModule) root.ChatUICore.registerModule('executionResources', api);
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
