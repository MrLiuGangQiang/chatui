(function initChatUICapabilityRegistry(root, factory) {
  'use strict';

  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  const registry = root?.[Symbol.for('chatui.module-registry.v1')]?.get('moduleRegistry');
  if (registry?.register) registry.register('capabilityRegistry', api);
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this), function createChatUICapabilityRegistry() {
  'use strict';

  const REGISTRY_VERSION = 'capability_registry.v1';
  const IMAGE_OPERATIONS = new Set(['text_to_image', 'image_reference_gen', 'edit_image']);
  const CHAT_OPERATIONS = new Set(['plain_chat', 'web_search', 'file_qa', 'multimodal_qa', 'image_qa', 'image_compare', 'ocr']);
  // Image dimensions are a user-facing generation setting: provider auto mode
  // is the default, and a size explicitly selected in the settings page is
  // forwarded on the generation/edit request. Textual dimensions stay part of
  // the creative prompt and never become route/plan arguments.
  const IMAGE_SIZE_DEFAULT = 'auto';
  const IMAGE_SIZES = Object.freeze(['auto', '1024x1024', '1024x1536', '1536x1024']);
  const IMAGE_QUALITIES = Object.freeze(['auto', 'low', 'medium', 'high', 'standard', 'hd']);
  const IMAGE_BACKGROUNDS = Object.freeze(['auto', 'transparent', 'opaque']);
  const IMAGE_OUTPUT_FORMATS = Object.freeze(['auto', 'png', 'jpeg', 'webp']);

  const IMAGE_ARGUMENTS = Object.freeze({
    prompt: Object.freeze({ type: 'string', required: true, minLength: 1 }),
    size: Object.freeze({ type: 'enum', values: IMAGE_SIZES, default: IMAGE_SIZE_DEFAULT, fixed: true }),
    quality: Object.freeze({ type: 'enum', values: IMAGE_QUALITIES, default: 'auto' }),
    background: Object.freeze({ type: 'enum', values: IMAGE_BACKGROUNDS, default: 'auto' }),
    output_format: Object.freeze({ type: 'enum', values: IMAGE_OUTPUT_FORMATS, default: 'auto' }),
  });

  const CHAT_ARGUMENTS = Object.freeze({
    prompt: Object.freeze({ type: 'string', required: false }),
  });

  function capability(operation, api, mode, argumentsSchema, options = {}) {
    return Object.freeze({
      operation,
      api,
      mode,
      arguments: argumentsSchema,
      // Design doc v2.7 6.7/7: each capability declares the changes path
      // family it accepts ('generation' | 'edit' | 'none') and the only legal
      // source of confirmation-style provider alternatives.
      changes_family: String(options.changesFamily || 'none'),
      equivalent_alternatives: Object.freeze(
        Array.isArray(options.equivalentAlternatives) ? options.equivalentAlternatives.map(item => Object.freeze({ ...item })) : [],
      ),
    });
  }

  const CAPABILITIES = Object.freeze({
    plain_chat: capability('plain_chat', 'chat', 'chat', CHAT_ARGUMENTS),
    web_search: capability('web_search', 'chat', 'chat', CHAT_ARGUMENTS),
    file_qa: capability('file_qa', 'chat', 'chat', CHAT_ARGUMENTS),
    multimodal_qa: capability('multimodal_qa', 'chat', 'chat', CHAT_ARGUMENTS),
    image_qa: capability('image_qa', 'chat', 'chat', CHAT_ARGUMENTS),
    image_compare: capability('image_compare', 'chat', 'chat', CHAT_ARGUMENTS),
    ocr: capability('ocr', 'chat', 'chat', CHAT_ARGUMENTS),
    text_to_image: capability('text_to_image', 'image_generation', 'image', IMAGE_ARGUMENTS, { changesFamily: 'generation' }),
    image_reference_gen: capability('image_reference_gen', 'image_edit', 'image', IMAGE_ARGUMENTS, { changesFamily: 'generation' }),
    edit_image: capability('edit_image', 'image_edit', 'edit_image', IMAGE_ARGUMENTS, {
      changesFamily: 'edit',
      equivalentAlternatives: [
        Object.freeze({
          operation: 'image_reference_gen',
          condition: 'provider_unsupported_mask',
        }),
      ],
    }),
  });


  // Explicit directives are user-language facts that the local compiler may
  // apply before it considers an LLM proposal. They deliberately carry no
  // executable arguments or identities: the compiler still resolves the
  // declared resource scope against the canonical candidate catalog.
  const EXPLICIT_ROUTE_DIRECTIVES = Object.freeze([
    Object.freeze({
      operation: 'web_search',
      relation: 'new',
      resource_scope: 'none',
      input_patterns: Object.freeze([
        /(?:\u8054\u7f51|\u4e0a\u7f51|\u7f51\u7edc)\s*(?:\u641c\u7d22|\u67e5\u8be2|\u67e5\u627e)/i,
        /(?:\u641c\u7d22|\u67e5\u8be2|\u67e5\u627e)\s*(?:\u7f51\u9875|\u7f51\u7edc|\u6700\u65b0)/i,
        /\bweb\s*search\b/i,
      ]),
      excluded_input_patterns: Object.freeze([]),
    }),
    Object.freeze({
      operation: 'ocr',
      relation: 'new',
      resource_scope: 'current',
      required_current_resource_type: 'image',
      input_patterns: Object.freeze([
        /(?:\u63d0\u53d6|\u8bc6\u522b|\u8bfb\u53d6|\u8bfb\u51fa|ocr|extract|recognize)\s*(?:\u56fe(?:\u7247)?(?:\u91cc|\u4e2d|\u4e0a)?\u7684?)?\s*(?:\u6587\u5b57|\u6587\u672c|\u5b57|text|words?|characters?)/i,
        /(?:\u56fe(?:\u7247)?|\u56fe\u50cf|\u7167\u7247|image|photo).{0,16}(?:\u6587\u5b57|\u6587\u672c|\u5b57|text|words?|characters?)/i,
      ]),
      excluded_input_patterns: Object.freeze([
        /(?:\u4e0a\u4e00\u5f20\u56fe(?:\u7247)?|\u4e4b\u524d\u7684?\u56fe(?:\u7247)?|\u521a\u624d\u7684?\u56fe(?:\u7247)?|\u4e0a\u6b21\u7684?\u56fe(?:\u7247)?|\u5386\u53f2\u56fe(?:\u7247)?|\u751f\u6210\u7684?\u56fe(?:\u7247)?|(?:previous|last|history|generated|that)\s+(?:image|photo))/i,
      ]),
    }),
    Object.freeze({
      // Asking for an image prompt is text authoring, not a request to call
      // an image-generation provider. Keep this ahead of the broad “再生成”
      // rule so “重新生成提示词” cannot accidentally become a picture job.
      operation: 'plain_chat',
      relation: 'followup',
      resource_scope: 'none',
      input_patterns: Object.freeze([
        /(?:^|[，,。！？\s])(?:请|帮我|给我|帮忙)?(?:重新|再|换(?:一个)?场景(?:后)?|换个场景(?:后)?|优化|改写|写|编写|生成|提供).{0,12}(?:(?:生图|绘图|画图|绘画|图片|图像)\s*)?(?:提示词|prompt)/i,
        /\b(?:write|create|generate|give|improve|rewrite)\b.{0,24}\b(?:image|art|drawing)?\s*prompt\b/i,
      ]),
      excluded_input_patterns: Object.freeze([
        /(?:提示词|prompt).{0,16}(?:生成|画|绘制|制作|创建).{0,8}(?:图片|图像|图|作品)/i,
        /\b(?:use|using|based on)\b.{0,24}\bprompt\b.{0,24}\b(?:generate|draw|create|make)\b.{0,12}\b(?:an?\s+)?image\b/i,
      ]),
    }),
    Object.freeze({
      // A standalone generation imperative carries enough semantics to avoid
      // an LLM classification call. This remains intentionally narrow: asking
      // for a prompt, an explanation, analysis, or an edit still goes through
      // the semantic router.
      operation: 'text_to_image',
      relation: 'new',
      resource_scope: 'none',
      input_patterns: Object.freeze([
        /^(?:\u8bf7|\u5e2e\u6211|\u7ed9\u6211|\u6211\u8981|\u6211\u60f3|\u60f3\u8981|\u80fd\u5426|\u53ef\u4ee5)?\s*(?:\u751f\u6210|\u753b|\u7ed8\u5236|\u521b\u4f5c|\u5236\u4f5c|\u521b\u5efa)\s*(?:\u4e00|\u4e2a|\u5f20|\u5e45|\u53ea|\u5957)?/i,
        /^(?:generate|draw|create)\b/i,
      ]),
      excluded_input_patterns: Object.freeze([
        /(?:\u63d0\u793a\u8bcd|prompt|\u6587\u6848|\u63cf\u8ff0|\u5206\u6790|\u89e3\u91ca|\u8bc6\u522b|ocr|\u63d0\u53d6|\u4fee\u6539|\u7f16\u8f91|\u66ff\u6362)/i,
        /(?:\u53c2\u8003|\u57fa\u4e8e|\u6309\u7167|\u4ee5).{0,24}(?:\u8fd9|\u90a3|\u4e0a\u4e00|\u4e4b\u524d|\u521a\u624d)?(?:\u5f20)?\u56fe(?:\u7247)?/i,
        /(?:\u753b|draw).{0,20}(?:\u91cc\u9762|\u4e2d\u7684?).{0,12}(?:\u662f\u4ec0\u4e48|\u4ec0\u4e48|what)/i,
      ]),
    }),
    Object.freeze({
      // “再画…” explicitly requests another generated result. It is a
      // conversational follow-up, but it does not authorize using a prior
      // image unless the user separately names that image as a reference.
      operation: 'text_to_image',
      relation: 'followup',
      resource_scope: 'none',
      input_patterns: Object.freeze([
        /^(?:\u518d|\u53e6\u5916|\u53e6|\u91cd\u65b0)\s*(?:\u753b|\u7ed8\u5236|\u751f\u6210|\u521b\u4f5c|\u5236\u4f5c)/i,
      ]),
      excluded_input_patterns: Object.freeze([
        /(?:\u53c2\u8003|\u57fa\u4e8e|\u6309\u7167|\u4ee5).{0,24}(?:\u8fd9|\u90a3|\u4e0a\u4e00|\u4e4b\u524d|\u521a\u624d)?(?:\u5f20)?\u56fe(?:\u7247)?/i,
        /(?:\u4fee\u6539|\u7f16\u8f91|\u66ff\u6362|\u628a).{0,24}(?:\u8fd9|\u90a3|\u4e0a\u4e00|\u4e4b\u524d|\u521a\u624d)?(?:\u5f20)?\u56fe(?:\u7247)?/i,
      ]),
    }),
  ]);


  const PRIOR_ORDINAL_RESOURCE_PATTERNS = Object.freeze({
    image: /(?:\u4e0a\u4e00\u5f20\u56fe(?:\u7247)?|\u4e4b\u524d\u7684?\u56fe(?:\u7247)?|\u521a\u624d\u7684?\u56fe(?:\u7247)?|\u4e0a\u6b21\u7684?\u56fe(?:\u7247)?|\u5386\u53f2\u56fe(?:\u7247)?|\u751f\u6210\u7684?\u56fe(?:\u7247)?|(?:previous|last|history|generated|that)\s+(?:image|photo))/i,
    file: /(?:(?:\u521a\u624d|\u4e4b\u524d|\u4e0a\u6b21|\u524d\u9762|\u4e0a\u8ff0)(?:\u6587\u4ef6|\u9644\u4ef6|\u6587\u6863)|(?:previous|last|history|that)\s+(?:file|document|pdf|spreadsheet|report))/i,
  });


  // With exactly one current upload, short deictic questions such as “这是什么”
  // refer to that upload unless the user explicitly points to an earlier or
  // quoted resource. This is a deterministic turn-boundary fact, not something
  // the route model may redirect to unrelated historical media.
  const CURRENT_UPLOAD_DEICTIC_PATTERNS = Object.freeze([
    /^(?:请|麻烦)?\s*(?:帮我)?\s*(?:这|这个|这是|这个是|它|它是|这里面|这个里面)\s*(?:是)?\s*(?:什么|啥|什么意思|什么东西|什么内容|什么文件|什么类型|做什么的|干什么的|怎么回事)\s*[。！？!?]*$/i,
    /^(?:请|麻烦)?\s*(?:帮我)?\s*(?:看|看看|查看|读|读一下|分析|分析一下|识别|说明|介绍|解释)(?:一下)?\s*(?:这|这个|它|这里面|这个里面)\s*[。！？!?]*$/i,
    /^(?:请|麻烦)?\s*(?:帮我)?\s*(?:看|看看|查看|读|读一下|分析|分析一下|识别|说明|介绍|解释)(?:一下)?\s*[。！？!?]*$/i,
    /^(?:what(?:'s|\s+is)\s+this|what\s+is\s+it|tell\s+me\s+what\s+this\s+is|take\s+a\s+look\s+at\s+this|(?:analy[sz]e|inspect|identify|explain)\s+this)[.!?]*$/i,
  ]);

  function currentUploadDirective(text = '', catalog = []) {
    const currentMedia = catalog.filter(candidate => (
      candidate?.source === 'current' && ['image', 'file'].includes(candidate?.type)
    ));
    if (currentMedia.length !== 1) return null;
    if (catalog.some(candidate => candidate?.source === 'quoted')) return null;
    if (Object.values(PRIOR_ORDINAL_RESOURCE_PATTERNS).some(pattern => pattern.test(text))) return null;
    if (!CURRENT_UPLOAD_DEICTIC_PATTERNS.some(pattern => pattern.test(text))) return null;
    return Object.freeze({
      operation: currentMedia[0].type === 'image' ? 'image_qa' : 'file_qa',
      relation: 'new',
      resource_scope: 'current',
    });
  }


  function resourceRequirement(type, roles, min = 0, max = Infinity) {
    return Object.freeze({
      type,
      roles: Object.freeze([...(Array.isArray(roles) ? roles : [roles])]),
      min,
      max,
    });
  }

  const OPTIONAL_MESSAGE_CONTEXT = resourceRequirement('message', ['context']);
  const RESOURCE_REQUIREMENTS = Object.freeze({
    plain_chat: Object.freeze([OPTIONAL_MESSAGE_CONTEXT]),
    web_search: Object.freeze([OPTIONAL_MESSAGE_CONTEXT]),
    file_qa: Object.freeze([
      resourceRequirement('file', ['attachment'], 1),
      OPTIONAL_MESSAGE_CONTEXT,
    ]),
    multimodal_qa: Object.freeze([
      resourceRequirement('image', ['source'], 1),
      resourceRequirement('file', ['attachment'], 1),
      OPTIONAL_MESSAGE_CONTEXT,
    ]),
    image_qa: Object.freeze([
      resourceRequirement('image', ['source'], 1),
      OPTIONAL_MESSAGE_CONTEXT,
    ]),
    image_compare: Object.freeze([
      resourceRequirement('image', ['compare_a'], 1, 1),
      resourceRequirement('image', ['compare_b'], 1, 1),
      OPTIONAL_MESSAGE_CONTEXT,
    ]),
    ocr: Object.freeze([
      resourceRequirement('image', ['source'], 1),
      OPTIONAL_MESSAGE_CONTEXT,
    ]),
    text_to_image: Object.freeze([OPTIONAL_MESSAGE_CONTEXT]),
    image_reference_gen: Object.freeze([
      resourceRequirement('image', ['reference', 'style_reference'], 1),
    ]),
    edit_image: Object.freeze([
      resourceRequirement('image', ['target'], 1, 1),
      resourceRequirement('image', ['reference']),
      resourceRequirement('image', ['style_reference']),
      resourceRequirement('image', ['mask'], 0, 1),
    ]),
  });

  function stringValue(value = '') {
    return String(value ?? '').trim();
  }

  function capabilityFor(operation = '') {
    return CAPABILITIES[stringValue(operation)] || null;
  }


  function resourceRequirementsFor(operation = '') {
    return RESOURCE_REQUIREMENTS[stringValue(operation)] || Object.freeze([]);
  }

  function explicitRouteDirectiveFor({ input = '', candidates = [] } = {}) {
    const text = stringValue(input);
    const catalog = Array.isArray(candidates) ? candidates : [];
    const uploadDirective = currentUploadDirective(text, catalog);
    if (uploadDirective) return uploadDirective;
    for (const directive of EXPLICIT_ROUTE_DIRECTIVES) {
      if (!directive.input_patterns.some(pattern => pattern.test(text))) continue;
      if (directive.excluded_input_patterns.some(pattern => pattern.test(text))) continue;
      if (directive.required_current_resource_type
          && !catalog.some(candidate => (
            candidate?.source === 'current'
            && candidate?.type === directive.required_current_resource_type
          ))) continue;
      return Object.freeze({
        operation: directive.operation,
        relation: directive.relation,
        resource_scope: directive.resource_scope,
      });
    }
    return null;
  }

  function ordinalResourceScopeFor({ input = '', type = '', candidates = [] } = {}) {
    const resourceType = stringValue(type);
    const catalog = Array.isArray(candidates) ? candidates : [];
    if (!catalog.some(candidate => candidate?.type === resourceType && candidate?.source === 'current')) return '';
    if (PRIOR_ORDINAL_RESOURCE_PATTERNS[resourceType]?.test(stringValue(input))) return '';
    return 'current';
  }

  function executionBindingIssues(operation = '', bindings = []) {
    const normalizedOperation = stringValue(operation);
    const requirements = resourceRequirementsFor(normalizedOperation);
    if (!capabilityFor(normalizedOperation)) {
      return Object.freeze([Object.freeze({ code: 'operation_unsupported', operation: normalizedOperation })]);
    }
    if (!Array.isArray(bindings)) {
      return Object.freeze([Object.freeze({ code: 'bindings_type', operation: normalizedOperation })]);
    }

    const issues = [];
    const normalized = bindings.map((binding, index) => ({
      index,
      type: stringValue(binding?.type),
      role: stringValue(binding?.role),
    }));
    for (const binding of normalized) {
      const allowed = requirements.some(requirement => (
        binding.type === requirement.type && requirement.roles.includes(binding.role)
      ));
      if (!allowed) {
        issues.push(Object.freeze({
          code: 'binding_unsupported',
          operation: normalizedOperation,
          index: binding.index,
          type: binding.type,
          role: binding.role,
        }));
      }
    }

    for (const requirement of requirements) {
      const count = normalized.filter(binding => (
        binding.type === requirement.type && requirement.roles.includes(binding.role)
      )).length;
      if (count < requirement.min) {
        issues.push(Object.freeze({
          code: 'binding_missing',
          operation: normalizedOperation,
          type: requirement.type,
          roles: requirement.roles,
          min: requirement.min,
          max: requirement.max,
          count,
        }));
      } else if (count > requirement.max) {
        issues.push(Object.freeze({
          code: 'binding_cardinality',
          operation: normalizedOperation,
          type: requirement.type,
          roles: requirement.roles,
          min: requirement.min,
          max: requirement.max,
          count,
        }));
      }
    }
    return Object.freeze(issues);
  }

  function validateExecutionBindings(operation = '', bindings = []) {
    return executionBindingIssues(operation, bindings).length === 0;
  }

  function assertExecutionBindings(operation = '', bindings = []) {
    const issues = executionBindingIssues(operation, bindings);
    if (!issues.length) return true;
    const error = new TypeError(`Invalid execution bindings for ${stringValue(operation) || '<missing>'}`);
    error.code = 'EXECUTION_BINDING_CONTRACT_INVALID';
    error.issues = issues;
    throw error;
  }

  function normalizeOutputFormat(value = '') {
    const text = stringValue(value).toLowerCase();
    return text === 'jpg' ? 'jpeg' : text;
  }

  function normalizeArgumentValue(name = '', value) {
    const text = stringValue(value);
    if (name === 'output_format') return normalizeOutputFormat(text);
    if (['size', 'quality', 'background'].includes(name)) return text.toLowerCase();
    return text;
  }

  function argumentError(name, code, value) {
    return Object.freeze({ name, code, value });
  }

  function validateArgument(name, value, spec = {}) {
    if (spec.type === 'string') {
      if (typeof value !== 'string') return argumentError(name, 'type', value);
      if (spec.required && value.trim().length < Number(spec.minLength || 0)) return argumentError(name, 'required', value);
      return null;
    }
    if (spec.type === 'enum') {
      return spec.values.includes(value) ? null : argumentError(name, 'unsupported_value', value);
    }
    if (spec.type === 'integer') {
      if (!Number.isInteger(value)) return argumentError(name, 'type', value);
      if (value < spec.min || value > spec.max) return argumentError(name, 'range', value);
      return null;
    }
    return argumentError(name, 'unknown_type', value);
  }

  function validateArguments(operation = '', argumentsValue = {}) {
    const registered = capabilityFor(operation);
    if (!registered || !argumentsValue || typeof argumentsValue !== 'object' || Array.isArray(argumentsValue)) return false;
    const names = Object.keys(registered.arguments);
    const required = names.filter(name => registered.arguments[name].required !== false);
    if (Object.keys(argumentsValue).some(key => !names.includes(key))) return false;
    if (!required.every(name => Object.prototype.hasOwnProperty.call(argumentsValue, name))) return false;
    return names.every(name => (
      !Object.prototype.hasOwnProperty.call(argumentsValue, name)
      || !validateArgument(name, argumentsValue[name], registered.arguments[name])
    ));
  }

  function normalizeParameterSyntax(input = '') {
    const original = stringValue(input);
    const analysis = [...original].map(char => {
      const code = char.charCodeAt(0);
      if (code === 0x3000) return ' ';
      if (code >= 0xff01 && code <= 0xff5e) return String.fromCharCode(code - 0xfee0);
      if (char === '✕' || char === '✖') return '×';
      return char;
    }).join('');
    return Object.freeze({ original, analysis });
  }

  const PARAMETER_NEGATION_SUFFIX = /(?:(?:不要|不用|无需|不需要|不想|不希望|不是|不能|不可(?:以)?|无法|不接受|不采用|不选择|不选|拒绝|别|避免|取消|去掉|排除|禁止|勿|非|无|不)(?:(?:再|使用|采用|用|要|选择|选|接受|允许|设为|设置为)\s*)*|(?:\bdo(?:es)?\s+not\b|\bdon[’']t\b|\bdoesn[’']t\b|\bcannot\b|\bcan[’']t\b|\bwon[’']t\b|\bwould\s+not\b|\bwouldn[’']t\b|\bshould\s+not\b|\bshouldn[’']t\b|\bmust\s+not\b|\bmustn[’']t\b|\bnot\b|\bwithout\b|\bavoid\b|\bexclude\b|\breject\b|\bno\b)(?:\s+(?:want|need|prefer|allow|accept|choose|select|use|using|set|have|make|be|with|a|an|the|to))*)\s*$/i;

  function negationPolarity(analysis = '', index = -1) {
    if (!(Number(index) >= 0)) return 'positive';
    const prefix = String(analysis || '').slice(Math.max(0, Number(index) - 72), Number(index));
    const clause = prefix.split(/[，,。.!！？?；;\n\r]/).at(-1) || '';
    return PARAMETER_NEGATION_SUFFIX.test(clause) ? 'negative' : 'positive';
  }

  function candidate(name, value, evidence, index = -1, end = -1, polarity = 'positive') {
    const start = Number(index);
    const normalizedEvidence = stringValue(evidence);
    const normalizedEnd = Number(end) > start ? Number(end) : start + normalizedEvidence.length;
    return Object.freeze({
      name,
      value: normalizeArgumentValue(name, value),
      evidence: normalizedEvidence,
      index: start,
      end: normalizedEnd,
      polarity: polarity === 'negative' ? 'negative' : 'positive',
    });
  }

  function candidateFromMatch(view, name, value, match) {
    if (!match || !stringValue(match[0])) return null;
    const index = Number(match.index);
    const end = index + String(match[0]).length;
    const evidence = view.original.slice(index, end) || match[0];
    return candidate(name, value, evidence, index, end, negationPolarity(view.analysis, index));
  }

  function addMatch(target, view, name, value, match) {
    const item = candidateFromMatch(view, name, value, match);
    if (item) target.push(item);
  }

  function collectPatternMatches(view, pattern, name, value) {
    const matches = [];
    const regex = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
    let match;
    while ((match = regex.exec(view.analysis))) {
      const item = candidateFromMatch(view, name, typeof value === 'function' ? value(match) : value, match);
      if (item) matches.push(item);
      if (!match[0]) regex.lastIndex += 1;
    }
    return matches;
  }

  function spansOverlap(left, right) {
    return left.index < right.end && right.index < left.end;
  }

  function removeShadowedParameterMatches(candidates = []) {
    const ranked = [...candidates].sort((left, right) => (
      (right.end - right.index) - (left.end - left.index)
      || left.index - right.index
      || left.name.localeCompare(right.name)
    ));
    const selected = [];
    for (const item of ranked) {
      const overlaps = selected.filter(existing => existing.name === item.name && spansOverlap(existing, item));
      if (!overlaps.length) {
        selected.push(item);
        continue;
      }
      const sameSpanConflict = overlaps.some(existing => (
        existing.index === item.index
        && existing.end === item.end
        && JSON.stringify(existing.value) !== JSON.stringify(item.value)
      ));
      if (sameSpanConflict) selected.push(item);
    }
    return selected.sort((left, right) => left.index - right.index || left.name.localeCompare(right.name));
  }


  function parseImageParameterCandidates(input = '', operation = '') {
    if (!IMAGE_OPERATIONS.has(operation)) return [];
    const view = normalizeParameterSyntax(input);
    const text = view.analysis;
    if (!text) return [];
    const result = [];

    [
      [/\b(?:low quality|draft quality)\b|(?:低质量|草稿质量|快速预览)/gi, 'low'],
      [/\b(?:medium quality)\b|(?:中等质量|标准质量)/gi, 'medium'],
      [/\b(?:high quality|high-quality)\b|(?:高质量|高清质量|精细质量|超清)/gi, 'high'],
      [/\b(?:hd quality)\b|(?:HD\s*质量)/gi, 'hd'],
    ].forEach(([pattern, value]) => result.push(...collectPatternMatches(view, pattern, 'quality', value)));

    [
      [/\btransparent background\b|(?:透明背景|背景透明|透明底|去底图)/gi, 'transparent'],
      [/\bopaque background\b|(?:不透明背景|背景不透明)/gi, 'opaque'],
    ].forEach(([pattern, value]) => result.push(...collectPatternMatches(view, pattern, 'background', value)));

    for (const match of text.matchAll(/(?:输出|导出|保存|格式|format|export)(?:为|成|\s|:：)*\b(png|jpe?g|webp)\b|\b(png|jpe?g|webp)\s*(?:格式|format)/gi)) {
      addMatch(result, view, 'output_format', match[1] || match[2], match);
    }


    return removeShadowedParameterMatches(result);
  }

  function normalizeDefaults(defaults = {}) {
    return {
      size: IMAGE_SIZE_DEFAULT,
      quality: normalizeArgumentValue('quality', defaults.quality || defaults.imageQuality || 'auto') || 'auto',
      background: normalizeArgumentValue('background', defaults.background || defaults.imageBackground || 'auto') || 'auto',
      output_format: normalizeArgumentValue('output_format', defaults.output_format || defaults.outputFormat || defaults.format || 'auto') || 'auto',
    };
  }

  function explicitArgumentValues(spec = {}) {
    if (spec.type === 'enum') return spec.values.filter(value => value !== 'auto');
    if (spec.type === 'integer') {
      return Array.from({ length: Math.max(0, spec.max - spec.min + 1) }, (_, index) => spec.min + index);
    }
    return [];
  }

  function distinctCandidateValues(items = []) {
    return [...new Set(items.map(item => JSON.stringify(item.value)))].map(value => JSON.parse(value));
  }

  function resolveExecutionArguments({ operation = '', input = '', prompt = input, defaults = {}, overrides = {} } = {}) {
    const registered = capabilityFor(operation);
    if (!registered) {
      return Object.freeze({ arguments: null, evidence: Object.freeze({}), conflicts: Object.freeze([]), invalid: Object.freeze([argumentError('operation', 'unsupported_operation', operation)]) });
    }
    const candidates = parseImageParameterCandidates(input, operation);
    const byName = new Map();
    for (const item of candidates) {
      const values = byName.get(item.name) || [];
      values.push(item);
      byName.set(item.name, values);
    }
    const normalizedDefaults = normalizeDefaults(defaults);
    const resolved = {};
    const evidence = {};
    const conflicts = [];
    const invalid = [];

    for (const [name, spec] of Object.entries(registered.arguments)) {
      if (name === 'prompt') {
        // The provider prompt and the text that controls provider parameters are
        // intentionally separate. Route/image-plan semantic context may enrich
        // the prompt, but only the raw user turn (or a structured planner field)
        // is allowed to choose count, quality, format, or background.
        resolved.prompt = stringValue(prompt);
        evidence.prompt = Object.freeze([]);
      } else if (spec.fixed) {
        // A fixed route/plan default keeps provider auto mode at the argument
        // layer; a size chosen in the settings page is applied to the provider
        // payload at execution time.
        resolved[name] = spec.default;
        evidence[name] = Object.freeze([]);
      } else {
        const hasOverride = overrides && Object.prototype.hasOwnProperty.call(overrides, name);
        const items = byName.get(name) || [];
        const positiveItems = items.filter(item => item.polarity !== 'negative');
        const negativeItems = items.filter(item => item.polarity === 'negative');
        const positiveValues = distinctCandidateValues(positiveItems);
        const negativeValues = distinctCandidateValues(negativeItems);
        const supportedValues = explicitArgumentValues(spec);
        const allowedAfterNegation = supportedValues.filter(value => !negativeValues.some(excluded => JSON.stringify(excluded) === JSON.stringify(value)));
        const evidenceItems = items.map(item => item.evidence);

        if (hasOverride) {
          resolved[name] = normalizeArgumentValue(name, overrides[name]);
          evidence[name] = Object.freeze(['clarification_answer.v1']);
        } else if (positiveValues.length > 1) {
          conflicts.push(Object.freeze({ name, values: Object.freeze(positiveValues), evidence: Object.freeze(evidenceItems) }));
          continue;
        } else if (positiveValues.length === 1) {
          const selected = positiveValues[0];
          const explicitlyExcluded = negativeValues.some(value => JSON.stringify(value) === JSON.stringify(selected));
          if (explicitlyExcluded) {
            conflicts.push(Object.freeze({
              name,
              values: Object.freeze(allowedAfterNegation),
              excludedValues: Object.freeze(negativeValues),
              evidence: Object.freeze(evidenceItems),
            }));
            continue;
          }
          resolved[name] = selected;
          evidence[name] = Object.freeze(evidenceItems);
        } else if (negativeValues.length) {
          if (allowedAfterNegation.length !== 1) {
            conflicts.push(Object.freeze({
              name,
              values: Object.freeze(allowedAfterNegation),
              excludedValues: Object.freeze(negativeValues),
              evidence: Object.freeze(evidenceItems),
            }));
            continue;
          }
          resolved[name] = allowedAfterNegation[0];
          evidence[name] = Object.freeze(evidenceItems);
        } else {
          resolved[name] = normalizedDefaults[name] ?? spec.default;
          evidence[name] = Object.freeze([]);
        }
      }
      const problem = validateArgument(name, resolved[name], spec);
      if (problem) invalid.push(problem);
    }

    return Object.freeze({
      arguments: conflicts.length || invalid.length ? null : Object.freeze({ ...resolved }),
      evidence: Object.freeze({ ...evidence }),
      conflicts: Object.freeze(conflicts),
      invalid: Object.freeze(invalid),
      candidates: Object.freeze(candidates),
    });
  }


  function choicesForArgument(name = '', values = null) {
    const labels = {
      size: { '1024x1024': '方图 1024 × 1024', '1024x1536': '竖图 1024 × 1536', '1536x1024': '横图 1536 × 1024' },
      quality: { low: '低质量', medium: '中等质量', high: '高质量', standard: '标准质量', hd: 'HD 质量' },
      background: { transparent: '透明背景', opaque: '不透明背景' },
      output_format: { png: 'PNG', jpeg: 'JPEG', webp: 'WebP' },
    };
    const registeredValues = name === 'size' ? IMAGE_SIZES
      : name === 'quality' ? IMAGE_QUALITIES
        : name === 'background' ? IMAGE_BACKGROUNDS
          : name === 'output_format' ? IMAGE_OUTPUT_FORMATS
              : [];
    const requested = Array.isArray(values) ? values : registeredValues;
    return [...new Set(requested.map(value => normalizeArgumentValue(name, value)))]
      .filter(value => value !== 'auto')
      .filter(value => !validateArgument(name, value, IMAGE_ARGUMENTS[name] || {}))
      .map(value => Object.freeze({ value, label: String(labels[name]?.[value] || value) }));
  }

  function clarificationQuestion(result = {}) {
    const conflicts = Array.isArray(result.conflicts) ? result.conflicts : [];
    const invalid = Array.isArray(result.invalid) ? result.invalid : [];
    if (conflicts.length) {
      const labels = { size: '图片尺寸', quality: '图片质量', background: '背景模式', output_format: '输出格式' };
      const hasEmptyDomain = conflicts.some(item => !Array.isArray(item.values) || item.values.length === 0);
      const hasExclusions = conflicts.some(item => Array.isArray(item.excludedValues) && item.excludedValues.length > 0);
      const details = conflicts.map(item => {
        const label = labels[item.name] || item.name;
        return Array.isArray(item.values) && item.values.length
          ? `${label}（${item.values.join(' / ')}）`
          : `${label}（可用选项均被排除）`;
      }).join('、');
      if (hasEmptyDomain) return `检测到图片参数冲突：${details}。请重新说明可接受的选项。`;
      if (hasExclusions) return `检测到图片参数冲突：${details}。请选择未被排除的一项。`;
      return `检测到图片参数冲突：${details}。请选择其中一项，或直接回复“自动”。`;
    }
    if (invalid.length) {
      const first = invalid[0];
      if (first.name === 'size') return '图片尺寸“' + first.value + '”不在当前支持范围内，请选择 auto、1024x1024、1024x1536 或 1536x1024。';
      return `图片参数 ${first.name} 的值“${first.value}”无效，请重新选择。`;
    }
    return '';
  }

  // Design doc v2.7 6.7: structured changes path families. The generation
  // family is bound by generation-style operations (text_to_image /
  // image_reference_gen), the edit family by edit_image only. Mixing families
  // is the model-hallucination path the doc forbids: edit_image must never
  // accept generation paths and vice versa.
  const CHANGES_FAMILY_GENERATION = 'generation';
  const CHANGES_FAMILY_EDIT = 'edit';
  const CHANGES_FAMILY_NONE = 'none';

  const GENERATION_CHANGES_PREFIXES = Object.freeze([
    'base_description',
    'subject',
    'style',
    'composition',
    'lighting',
    'background',
    'constraints',
    'output',
  ]);
  const EDIT_CHANGES_PREFIXES = Object.freeze([
    'modifications',
    'preserve_constraints',
    'output',
  ]);
  const CHANGES_OUTPUT_LEAVES = Object.freeze(['size', 'quality', 'background', 'format']);
  const FORBIDDEN_CHANGES_PREFIXES = Object.freeze([
    'prompt', 'request', 'operation', 'api', 'provider',
    'credentials', 'resource', 'resources', 'binding', 'bindings', 'lifecycle',
    '__proto__', 'prototype', 'constructor',
  ]);

  function changesPathSegments(path = '') {
    return String(path || '').split('.').map(segment => segment.trim()).filter(Boolean);
  }

  function changesFamilyForPath(path = '') {
    const first = changesPathSegments(path)[0];
    if (!first) return CHANGES_FAMILY_NONE;
    if (GENERATION_CHANGES_PREFIXES.includes(first)) return CHANGES_FAMILY_GENERATION;
    if (EDIT_CHANGES_PREFIXES.includes(first)) return CHANGES_FAMILY_EDIT;
    return CHANGES_FAMILY_NONE;
  }

  function changesFamilyForOperation(operation = '') {
    const registered = capabilityFor(operation);
    return registered?.changes_family || CHANGES_FAMILY_NONE;
  }

  function equivalentAlternativesFor(operation = '') {
    const registered = capabilityFor(operation);
    return registered?.equivalent_alternatives || Object.freeze([]);
  }

  function changesIssue(code, path, extra = {}) {
    return Object.freeze({ code, path, ...extra });
  }

  // Validate one changes batch against the operation family. Returns the
  // issues list (empty means valid). Covers: family compatibility, forbidden
  // prefixes, duplicate paths, parent/child conflicts and output-leaf shape.
  function validateChangesFamily(operation = '', changes = []) {
    const family = changesFamilyForOperation(operation);
    const items = Array.isArray(changes) ? changes : [];
    const issues = [];
    const seen = new Set();

    if (family === CHANGES_FAMILY_NONE && items.length) {
      return Object.freeze([changesIssue('changes_unsupported', '', { operation })]);
    }

    for (const change of items) {
      const path = String(change?.path || '');
      const segments = changesPathSegments(path);
      const first = segments[0];
      if (!first) {
        issues.push(changesIssue('changes_path_empty', path));
        continue;
      }
      if (FORBIDDEN_CHANGES_PREFIXES.includes(first)) {
        issues.push(changesIssue('changes_forbidden_prefix', path, { prefix: first }));
        continue;
      }
      const pathFamily = changesFamilyForPath(path);
      if (pathFamily === CHANGES_FAMILY_NONE || pathFamily !== family) {
        issues.push(changesIssue('changes_family_incompatible', path, { operation, family, pathFamily }));
        continue;
      }
      if (seen.has(path)) {
        issues.push(changesIssue('changes_path_duplicate', path));
        continue;
      }
      seen.add(path);
      if (first === 'output' && segments.length === 2 && !CHANGES_OUTPUT_LEAVES.includes(segments[1])) {
        issues.push(changesIssue('changes_output_leaf_invalid', path, { leaf: segments[1] }));
      }
    }

    for (const path of seen) {
      for (const other of seen) {
        if (path === other) continue;
        if (other.startsWith(`${path}.`)) {
          issues.push(changesIssue('changes_parent_child_conflict', other, { parent: path }));
        }
      }
    }

    return Object.freeze(issues);
  }

  function assertChangesFamilyCompatible(operation = '', changes = []) {
    const issues = validateChangesFamily(operation, changes);
    if (!issues.length) return true;
    const error = new TypeError(`Changes family incompatible for ${stringValue(operation) || '<missing>'}`);
    error.code = 'EXECUTION_CHANGES_FAMILY_INVALID';
    error.issues = issues;
    throw error;
  }

  return Object.freeze({
    REGISTRY_VERSION,
    CAPABILITIES,
    RESOURCE_REQUIREMENTS,
    IMAGE_OPERATIONS,
    CHAT_OPERATIONS,
    IMAGE_SIZE_DEFAULT,
    IMAGE_SIZES,
    IMAGE_QUALITIES,
    IMAGE_BACKGROUNDS,
    IMAGE_OUTPUT_FORMATS,
    CHANGES_FAMILY_GENERATION,
    CHANGES_FAMILY_EDIT,
    CHANGES_FAMILY_NONE,
    GENERATION_CHANGES_PREFIXES,
    EDIT_CHANGES_PREFIXES,
    FORBIDDEN_CHANGES_PREFIXES,
    capabilityFor,
    resourceRequirementsFor,
    explicitRouteDirectiveFor,
    ordinalResourceScopeFor,
    executionBindingIssues,
    validateExecutionBindings,
    assertExecutionBindings,
    normalizeArgumentValue,
    validateArgument,
    validateArguments,
    parseImageParameterCandidates,
    resolveExecutionArguments,
    choicesForArgument,
    clarificationQuestion,
    changesFamilyForPath,
    changesFamilyForOperation,
    equivalentAlternativesFor,
    validateChangesFamily,
    assertChangesFamilyCompatible,
  });
});
