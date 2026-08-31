(function initChatUIRouteResourceBinding(root) {
  'use strict';

  const TARGET_ROLE_ALIASES = new Set([
    'target', 'target_image', 'edit_target', 'image_to_edit', 'base_image',
    'original_image', 'canvas', '目标图', '待编辑图', '编辑图', '原图', '底图',
  ]);
  const REFERENCE_ROLE_ALIASES = new Set([
    'reference', 'reference_image', 'ref', 'source_reference', 'content_reference',
    '参考', '参考图', '内容参考图',
  ]);
  const STYLE_REFERENCE_ROLE_ALIASES = new Set([
    'style_reference', 'style_ref', 'style', 'style_image', '风格参考', '风格参考图', '风格图',
  ]);
  const MASK_ROLE_ALIASES = new Set(['mask', 'mask_image', '蒙版', '遮罩']);
  const GENERIC_IMAGE_ROLE_ALIASES = new Set([
    'source', 'input', 'input_image', 'source_image', 'image', 'attached_image', 'upload_image',
    '输入图', '源图', '图片',
  ]);
  const FILE_ROLE_ALIASES = new Set(['attachment', 'input_file', 'source_file', 'file', 'document', '文件', '附件']);
  const MESSAGE_ROLE_ALIASES = new Set(['context', 'input_message', 'message', 'history_message', 'quoted_message', '消息', '上下文']);
  const COMPARE_A_ROLE_ALIASES = new Set(['compare_a', 'left', 'first', '对比图a', '左图']);
  const COMPARE_B_ROLE_ALIASES = new Set(['compare_b', 'right', 'second', '对比图b', '右图']);

  function createRouteResourceBinding({
    resourceIdentityModule = {},
    normalizedSource = value => String(value || 'context'),
    uniqueStrings = values => [...new Set(values || [])],
    uniqueIndexes = values => [...new Set((values || []).map(Number))],
    routeCompilationCandidateCatalog = () => [],
  } = {}) {
    function stringValue(value) {
      return String(value ?? '').trim();
    }

    function normalizeBindingResourceId(type = '', value = '') {
      const raw = stringValue(value);
      if (!raw || type === 'text') return raw;
      return resourceIdentityModule?.normalizeExplicitResourceId?.(type, raw)
        || (raw.startsWith(`res:${type}:`) ? raw : `res:${type}:${encodeURIComponent(raw)}`);
    }

    function bindingRoleToken(value = '') {
      return stringValue(value).toLowerCase().replace(/[\s-]+/g, '_');
    }

    function canonicalBindingRole(operation = '', type = '', role = '', { soleEditImage = false } = {}) {
      const token = bindingRoleToken(role);
      if (type === 'image') {
        // Read-only visual operations consume every selected image as evidence;
        // compare/edit/reference roles from a model proposal must not survive
        // into a source-only execution contract.
        if (['image_qa', 'ocr', 'multimodal_qa'].includes(operation)) return 'source';
        if (MASK_ROLE_ALIASES.has(token)) return 'mask';
        if (operation === 'image_reference_gen') {
          if (STYLE_REFERENCE_ROLE_ALIASES.has(token)) return 'style_reference';
          if (TARGET_ROLE_ALIASES.has(token) || REFERENCE_ROLE_ALIASES.has(token) || GENERIC_IMAGE_ROLE_ALIASES.has(token)) return 'reference';
        }
        if (STYLE_REFERENCE_ROLE_ALIASES.has(token)) return 'style_reference';
        if (TARGET_ROLE_ALIASES.has(token)) return 'target';
        if (soleEditImage && (REFERENCE_ROLE_ALIASES.has(token) || GENERIC_IMAGE_ROLE_ALIASES.has(token))) return 'target';
        if (REFERENCE_ROLE_ALIASES.has(token)) return 'reference';
        if (COMPARE_A_ROLE_ALIASES.has(token)) return 'compare_a';
        if (COMPARE_B_ROLE_ALIASES.has(token)) return 'compare_b';
        if (GENERIC_IMAGE_ROLE_ALIASES.has(token)) return 'source';
        const error = new TypeError(`Unsupported image binding role: ${stringValue(role) || '<missing>'}`);
        error.code = 'EXECUTION_BINDING_ROLE_INVALID';
        throw error;
      }
      if (type === 'file') {
        if (FILE_ROLE_ALIASES.has(token) || token === 'source') return 'attachment';
        const error = new TypeError(`Unsupported file binding role: ${stringValue(role) || '<missing>'}`);
        error.code = 'EXECUTION_BINDING_ROLE_INVALID';
        throw error;
      }
      if (type === 'message') {
        if (MESSAGE_ROLE_ALIASES.has(token) || token === 'source') return 'context';
        const error = new TypeError(`Unsupported message binding role: ${stringValue(role) || '<missing>'}`);
        error.code = 'EXECUTION_BINDING_ROLE_INVALID';
        throw error;
      }
      if (type === 'text') return 'source';
      return token;
    }

    function canonicalPlanBindings(plan = {}) {
      const operation = stringValue(plan.operation);
      const bindings = Array.isArray(plan.bindings) ? plan.bindings : [];
      const imageCount = bindings.filter(binding => stringValue(binding?.type) === 'image').length;
      const soleEditImage = operation === 'edit_image' && imageCount === 1;
      return bindings.map(binding => {
        const type = stringValue(binding?.type);
        return {
          ...binding,
          role: canonicalBindingRole(operation, type, binding?.role, { soleEditImage }),
        };
      });
    }

    function planBindingsWithinDirectiveScope(bindings = [], directive = null, { operationChanged = false } = {}) {
      if (operationChanged) return [];
      const list = Array.isArray(bindings) ? bindings : [];
      const scope = stringValue(directive?.resource_scope);
      if (!scope) return list;
      if (scope === 'none') return [];
      if (scope === 'current') return list.filter(binding => normalizedSource(binding?.source, 'context') === 'current');
      return [];
    }

    function candidateChoice(candidate = {}) {
      return {
        key: stringValue(candidate.candidate_key),
        source: stringValue(candidate.source),
        index: Number(candidate.index) || 1,
        id: stringValue(candidate.id),
        resource_id: stringValue(candidate.resource_id),
        reference_id: stringValue(candidate.reference_id),
        label: stringValue(candidate.label),
      };
    }

    function unresolvedResourceIssue({ type = '', role = '', reason = 'missing', candidates = [], key = '' } = {}) {
      return {
        key: stringValue(key),
        type: stringValue(type),
        role: stringValue(role),
        reason: ['missing', 'missing_source_text', 'ambiguous', 'unavailable'].includes(reason) ? reason : 'missing',
        choices: (Array.isArray(candidates) ? candidates : []).map(candidateChoice),
      };
    }

    function normalizeResourceClarificationIssues(issues = [], projectedResources = [], occupiedSlots = []) {
      const input = Array.isArray(issues) ? issues : [];
      const occupiedKeys = new Set([
        ...(Array.isArray(projectedResources) ? projectedResources : []),
        ...(Array.isArray(occupiedSlots) ? occupiedSlots : []),
      ].map(item => stringValue(item?.key)).filter(key => /^r[1-9]\d*$/.test(key)));
      const reservedExplicitKeys = new Set(input
        .map(issue => stringValue(issue?.key))
        .filter(key => /^r[1-9]\d*$/.test(key) && !occupiedKeys.has(key)));
      const assignedKeys = new Set();
      let nextIndex = 1;
      const nextKey = () => {
        while (occupiedKeys.has(`r${nextIndex}`)
            || reservedExplicitKeys.has(`r${nextIndex}`)
            || assignedKeys.has(`r${nextIndex}`)) nextIndex += 1;
        const key = `r${nextIndex}`;
        assignedKeys.add(key);
        nextIndex += 1;
        return key;
      };

      return input.map(issue => {
        const requestedKey = stringValue(issue?.key);
        const key = /^r[1-9]\d*$/.test(requestedKey)
            && !occupiedKeys.has(requestedKey)
            && !assignedKeys.has(requestedKey)
          ? requestedKey
          : nextKey();
        assignedKeys.add(key);
        return {
          key,
          type: stringValue(issue?.type),
          role: stringValue(issue?.role),
          reason: ['missing', 'missing_source_text', 'ambiguous', 'unavailable'].includes(issue?.reason) ? issue.reason : 'missing',
          choices: (Array.isArray(issue?.choices) ? issue.choices : []).map((choice, index) => ({
            ...choice,
            key: `c${index + 1}`,
          })),
        };
      });
    }

    function bindingForCandidate(candidate = {}, role = '', key = '') {
      return {
        key: key || candidate.candidate_key,
        type: candidate.type,
        role,
        resource_id: candidate.candidate_key || candidate.resource_id,
        source: candidate.source,
      };
    }

    function resolvePlanResources(plan = {}, options = {}) {
      const catalog = routeCompilationCandidateCatalog(options);
      const projected = [];
      const issues = [];
      const keys = new Set();
      const bindings = canonicalPlanBindings(plan);
      for (const rawBinding of bindings) {
        const key = stringValue(rawBinding?.key);
        const type = stringValue(rawBinding?.type);
        const role = stringValue(rawBinding?.role);
        const source = normalizedSource(rawBinding?.source, 'context');
        const rawResourceId = stringValue(rawBinding?.resource_id);
        const resourceId = normalizeBindingResourceId(type, rawResourceId);
        if (!/^r[1-9]\d*$/.test(key) || keys.has(key) || !role || !['image', 'file', 'message', 'text'].includes(type)) {
          const error = new TypeError('Invalid execution binding: ' + (key || '<missing>'));
          error.code = 'EXECUTION_RESOURCE_INVALID';
          throw error;
        }
        keys.add(key);
        if (type === 'text') {
          projected.push({
            key, type, source, role, index: 1, id: '', resource_id: resourceId,
            reference_id: '', identity_aliases: [], index_aliases: [1], missing: false,
          });
          continue;
        }
        const candidateKey = rawResourceId.replace(/^res:[a-z]+:/, '');
        const matches = catalog.filter(candidate => {
          if (candidate.type !== type) return false;
          const sourceMatches = candidate.source === source || (source === 'history' && candidate.source === 'quoted');
          if (!sourceMatches) return false;
          return candidate.resource_id === resourceId || candidate.candidate_key === candidateKey;
        });
        if (matches.length !== 1) {
          issues.push(unresolvedResourceIssue({
            key, type, role,
            reason: matches.length > 1 ? 'ambiguous' : 'missing',
            candidates: matches,
          }));
          continue;
        }
        const candidate = matches[0];
        if (candidate.availability === 'unavailable') {
          issues.push(unresolvedResourceIssue({ key, type, role, reason: 'unavailable' }));
          continue;
        }
        projected.push({
          key,
          type,
          source: candidate.source,
          role,
          index: Number(candidate.index),
          id: stringValue(candidate.id),
          resource_id: candidate.resource_id,
          reference_id: type === 'image' ? stringValue(candidate.reference_id) : '',
          identity_aliases: uniqueStrings(candidate.identity_aliases),
          index_aliases: uniqueIndexes(candidate.index_aliases),
          missing: false,
        });
      }
      return { catalog, projected, issues };
    }

    return Object.freeze({
      normalizeBindingResourceId,
      canonicalBindingRole,
      canonicalPlanBindings,
      planBindingsWithinDirectiveScope,
      candidateChoice,
      unresolvedResourceIssue,
      normalizeResourceClarificationIssues,
      bindingForCandidate,
      resolvePlanResources,
    });
  }

  const api = Object.freeze({ createRouteResourceBinding });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root?.[Symbol.for('chatui.module-registry.v1')]?.get('moduleRegistry')?.register('routeResourceBinding', api);
})(typeof globalThis !== 'undefined' ? globalThis : this);