(function initChatUIRouteDispatchGate(root) {
  'use strict';

  function createRouteDispatchGate({ intentContract = {}, executionResourcesVersion = 'execution_resources.v1', taskContractVersion = 'task_contract.v5' } = {}) {
    function orderedResourceKeys(resources = []) {
      return Array.isArray(resources) ? resources.map(resource => String(resource?.key || '')) : null;
    }

    function sameOrderedResourceKeys(actual = [], expected = []) {
      const actualKeys = orderedResourceKeys(actual);
      const expectedKeys = orderedResourceKeys(expected);
      return !!actualKeys
        && !!expectedKeys
        && actualKeys.length === expectedKeys.length
        && actualKeys.every((key, index) => key && key === expectedKeys[index]);
    }

    function projectedResourceMatchesContract(resource = {}, expected = {}, type = '') {
      if (!resource || typeof resource !== 'object' || Array.isArray(resource)) return false;
      if (resource.type !== type || resource.key !== expected.key) return false;
      if (resource.source !== expected.source || (type !== 'message' && resource.role !== expected.role)) return false;
      if (!Number.isInteger(Number(resource.index)) || Number(resource.index) < 1) return false;
      if (String(resource.id || '') !== String(expected.id || '')) return false;
      if (String(resource.reference_id || '') !== String(expected.reference_id || '')) return false;
      if (!Array.isArray(resource.identity_aliases) || resource.identity_aliases.some(value => typeof value !== 'string')) return false;
      if (!Array.isArray(resource.index_aliases) || resource.index_aliases.some(value => !Number.isInteger(Number(value)) || Number(value) < 1)) return false;
      return true;
    }

    function projectedResourceMatchesRouteRef(resource = {}, routeRef = {}, type = '') {
      if (!resource || !routeRef || resource.key !== routeRef.key || resource.role !== routeRef.role || resource.source !== routeRef.source) return false;
      const routeId = type === 'image' ? routeRef.image_id : type === 'file' ? routeRef.file_id : routeRef.message_id;
      const routeReferenceId = type === 'image' ? routeRef.reference_id : '';
      return String(resource.id || '') === String(routeId || '')
        && String(resource.reference_id || '') === String(routeReferenceId || '')
        && Number(resource.index) === Number(routeRef.index);
    }

    function hasConsistentExecutionResources(route = {}, task = {}, expectedApi = '') {
      const projection = route.executionResources;
      if (!projection || typeof projection !== 'object' || Array.isArray(projection)) return false;
      if (projection.version !== executionResourcesVersion
          || projection.operation !== task.operation
          || projection.api !== expectedApi
          || projection.relation !== task.relation) return false;

      const expectedImages = task.resources.filter(resource => resource.type === 'image');
      const expectedFiles = task.resources.filter(resource => resource.type === 'file');
      const expectedMessages = task.resources.filter(resource => resource.type === 'message');
      const images = projection.images;
      const files = projection.files;
      const messages = projection.messages;
      if (!Array.isArray(images) || !Array.isArray(files) || !Array.isArray(messages)) return false;
      if (!sameOrderedResourceKeys(images, expectedImages)
          || !sameOrderedResourceKeys(files, expectedFiles)
          || !sameOrderedResourceKeys(messages, expectedMessages)) return false;
      if (images.some((resource, index) => !projectedResourceMatchesContract(resource, expectedImages[index], 'image'))) return false;
      if (files.some((resource, index) => !projectedResourceMatchesContract(resource, expectedFiles[index], 'file'))) return false;
      if (messages.some((resource, index) => !projectedResourceMatchesContract(resource, expectedMessages[index], 'message'))) return false;

      const routeImageRefs = Array.isArray(route.imageRefs) ? route.imageRefs : null;
      const routeFileRefs = Array.isArray(route.fileRefs) ? route.fileRefs : null;
      const routeMessageRefs = Array.isArray(route.messageRefs) ? route.messageRefs : null;
      if (!sameOrderedResourceKeys(routeImageRefs, images)
          || !sameOrderedResourceKeys(routeFileRefs, files)
          || !sameOrderedResourceKeys(routeMessageRefs, messages)) return false;
      if (images.some((resource, index) => !projectedResourceMatchesRouteRef(resource, routeImageRefs[index], 'image'))) return false;
      if (files.some((resource, index) => !projectedResourceMatchesRouteRef(resource, routeFileRefs[index], 'file'))) return false;
      if (messages.some((resource, index) => !projectedResourceMatchesRouteRef(resource, routeMessageRefs[index], 'message'))) return false;

      const targets = images.filter(resource => resource.role === 'target');
      const masks = images.filter(resource => resource.role === 'mask');
      const references = images.filter(resource => ['reference', 'style_reference'].includes(resource.role));
      const imageInputs = [...targets, ...references];
      return sameOrderedResourceKeys(projection.targets, targets)
        && sameOrderedResourceKeys(projection.masks, masks)
        && sameOrderedResourceKeys(projection.references, references)
        && sameOrderedResourceKeys(projection.imageInputs, imageInputs)
        && sameOrderedResourceKeys(projection.chatImages, images)
        && sameOrderedResourceKeys(projection.chatFiles, files)
        && sameOrderedResourceKeys(projection.selectedMessageRefs, messages);
    }

    function isRouteDispatchable(route = {}) {
      if (!route || typeof route !== 'object' || Array.isArray(route)) return false;
      if (route.needClarification === true || route.api === 'clarify' || route.dispatchAuthorized !== true) return false;
      const task = route.taskContract;
      if (!task || task.schema_version !== taskContractVersion) return false;
      if (!intentContract?.hasExactContractShape?.(task) || task.readiness !== 'ready' || route.readiness !== 'ready') return false;
      const expectedApi = intentContract?.contractApi?.(task) || '';
      if (!expectedApi || route.api !== expectedApi || route.operationApi !== expectedApi) return false;
      if (route.operationType !== task.operation || route.relation !== task.relation) return false;
      const expectedMode = intentContract?.contractMode?.(task) || '';
      if (!expectedMode || route.operationMode !== expectedMode) return false;
      return route.mode === expectedMode && hasConsistentExecutionResources(route, task, expectedApi);
    }

    return Object.freeze({
      EXECUTION_RESOURCES_VERSION: executionResourcesVersion,
      orderedResourceKeys,
      sameOrderedResourceKeys,
      projectedResourceMatchesContract,
      projectedResourceMatchesRouteRef,
      hasConsistentExecutionResources,
      isRouteDispatchable,
    });
  }

  const api = Object.freeze({ createRouteDispatchGate });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root?.[Symbol.for('chatui.module-registry.v1')]?.get('moduleRegistry')?.register('routeDispatchGate', api);
})(typeof globalThis !== 'undefined' ? globalThis : this);
