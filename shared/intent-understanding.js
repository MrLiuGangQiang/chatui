(function initChatUIIntentUnderstanding(root, factory) {
  'use strict';

  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  const registry = root?.[Symbol.for('chatui.module-registry.v1')]?.get('moduleRegistry');
  if (registry?.register) registry.register('intentUnderstanding', api);
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this), function createChatUIIntentUnderstanding() {
  'use strict';

  // understanding.v1 is the first thinking node of the intent pipeline. It only
  // extracts what the user asked for and what "this/那个/第2张" refers to. It
  // never maps to an operation; the deterministic Shape Compiler below derives
  // operation/task_shape/required roles from the closed kind enum.

  const UNDERSTANDING_VERSION = 'intent_understanding.v1';
  const ACTION_KINDS = Object.freeze({
    plain_text: 'plain_chat',
    web_search: 'web_search',
    file_read: 'file_qa',
    image_read: 'image_qa',
    ocr: 'ocr',
    image_compare: 'image_compare',
    multimodal_qa: 'multimodal_qa',
    image_generate: 'text_to_image',
    image_reference: 'image_reference_gen',
    image_edit: 'edit_image',
  });

  // kind -> required resource roles (type -> allowed roles). Text/image binding
  // stays deterministic; the model only names the candidate, never the role.
  const KIND_RESOURCE_ROLES = Object.freeze({
    plain_text: Object.freeze({ message: Object.freeze(['context']) }),
    web_search: Object.freeze({ message: Object.freeze(['context']) }),
    file_read: Object.freeze({ file: Object.freeze(['attachment']) }),
    image_read: Object.freeze({ image: Object.freeze(['source']) }),
    ocr: Object.freeze({ image: Object.freeze(['source']) }),
    image_compare: Object.freeze({ image: Object.freeze(['compare_a', 'compare_b']) }),
    multimodal_qa: Object.freeze({ image: Object.freeze(['source']), file: Object.freeze(['attachment']) }),
    image_generate: Object.freeze({}),
    image_reference: Object.freeze({ image: Object.freeze(['reference', 'style_reference']) }),
    image_edit: Object.freeze({ image: Object.freeze(['target']) }),
  });

  // Multiple actions that always stay on the image_plan path.
  const IMAGE_MULTI_KINDS = new Set(['image_generate', 'image_reference', 'image_edit']);
  const ACTION_FIELDS = Object.freeze(['index', 'kind', 'target', 'resolved_refs']);

  function stringValue(value = '') {
    return String(value ?? '').trim();
  }

  function validResolvedRef(ref = {}) {
    if (!ref || typeof ref !== 'object' || Array.isArray(ref)) return false;
    return /^(?:[ifm])?[1-9]\d*$/.test(stringValue(ref.candidate_key))
      && typeof ref.text === 'string';
  }

  function validAction(action = {}) {
    if (!action || typeof action !== 'object' || Array.isArray(action)) return false;
    if (!Number.isInteger(Number(action.index)) || Number(action.index) < 1) return false;
    if (!Object.prototype.hasOwnProperty.call(ACTION_KINDS, stringValue(action.kind))) return false;
    if (typeof action.target !== 'string') return false;
    const refs = Array.isArray(action.resolved_refs) ? action.resolved_refs : [];
    return refs.every(validResolvedRef);
  }

  function hasExactUnderstanding(value = {}) {
    return !!value && typeof value === 'object' && !Array.isArray(value)
      && value.schema_version === UNDERSTANDING_VERSION
      && ['new', 'followup', 'continuation'].includes(stringValue(value.dependency))
      && Array.isArray(value.actions)
      && value.actions.length <= 20
      && value.actions.every(validAction);
  }

  function assertUnderstanding(value = {}) {
    if (hasExactUnderstanding(value)) return true;
    const error = new TypeError('Invalid intent_understanding.v1');
    error.code = 'INTENT_UNDERSTANDING_INVALID';
    throw error;
  }

  function normalizeAction(action = {}) {
    if (!action || typeof action !== 'object' || Array.isArray(action)) return null;
    const kind = stringValue(action.kind);
    if (!Object.prototype.hasOwnProperty.call(ACTION_KINDS, kind)) return null;
    return {
      index: Number(action.index) || 0,
      kind,
      target: stringValue(action.target),
      resolved_refs: Array.isArray(action.resolved_refs)
        ? action.resolved_refs.map(ref => ({ candidate_key: stringValue(ref?.candidate_key), text: stringValue(ref?.text) }))
        : [],
    };
  }

  function operationForKind(kind = '') {
    return ACTION_KINDS[stringValue(kind)] || '';
  }

  function requiredResourceRoles(kind = '') {
    return KIND_RESOURCE_ROLES[stringValue(kind)] || Object.freeze({});
  }


  // A single image action can still describe several independent results (e.g.
  // "五个视角" or "正面、侧面、背面"). The route model must not collapse those
  // into one image; promote them to the image_plan branch deterministically so
  // the planner still expands every requested view/image into its own task.
  function parseChineseNumber(text = '') {
    const value = String(text).trim();
    if (/^\d+$/.test(value)) return Number(value);
    const digits = { '一': 1, '二': 2, '两': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9 };
    let total = 0;
    let section = 0;
    for (const char of value) {
      if (digits[char]) {
        section += digits[char];
      } else if (char === '十') {
        section = section || 1;
        section *= 10;
        total += section;
        section = 0;
      } else if (char === '百') {
        section = section || 1;
        section *= 100;
        total += section;
        section = 0;
      }
    }
    return total + section;
  }

  function explicitImageResultCount(text = '') {
    const value = stringValue(text);
    if (!value) return 0;
    const NUMBER = '([一二三四五六七八九十百两0-9]+)';
    // Units that denote an image file/version produced by the task. In-picture
    // subject units (只/匹/条/头/座...) are intentionally excluded.
    const RESULT_UNIT = '(?:张|幅|组|版|款|套|海报|图)';
    const RESULT_GE = '个\\s*(?:视角|版本|方案|样式|设计|海报|构图)';
    const OUTPUT_VERB = /(?:生成|画|绘制|制作|创建|设计|做出|产出|改成|改为|转成|变成|换成|得到)/;
    const OUTPUT_VERB_GLOBAL = /(?:生成|画|绘制|制作|创建|设计|做出|产出|改成|改为|转成|变成|换成|得到)/g;
    const clauses = value.split(/[，。；;！？!?\n]+/).map(item => item.trim()).filter(Boolean);
    const counts = [];

    // Bare "N个视角/版本/方案/样式/设计" is an output enumeration even when
    // the model wrote it into an action target without a verb.
    const bareGe = new RegExp(NUMBER + '\\s*' + RESULT_GE, 'g');
    for (const match of value.matchAll(bareGe)) counts.push(parseChineseNumber(match[1]));

    // Counts anchored AFTER the last output verb in each clause. This keeps
    // "参考两张图生成一张新图" at one result while still seeing the outputs.
    const anchored = [];
    for (const clause of clauses) {
      const verbs = [...clause.matchAll(OUTPUT_VERB_GLOBAL)];
      if (!verbs.length) continue;
      const tail = clause.slice(verbs[verbs.length - 1].index + verbs[verbs.length - 1][0].length);
      const unitRe = new RegExp(NUMBER + '\\s*' + RESULT_UNIT, 'g');
      for (const match of tail.matchAll(unitRe)) anchored.push(parseChineseNumber(match[1]));
      const geRe = new RegExp(NUMBER + '\\s*' + RESULT_GE, 'g');
      for (const match of tail.matchAll(geRe)) anchored.push(parseChineseNumber(match[1]));
    }
    for (const count of anchored) if (count >= 2) return count;
    counts.push(...anchored);

    // "把N张图改成/改为/变成" edits every listed target into its own output.
    const editTargets = new RegExp('把\\s*' + NUMBER + '\\s*' + RESULT_UNIT + '(?:图|图片|目标图)?\\s*(?:都|全部|分别)?(?:改成|改为|变成|换成)', 'g');
    for (const match of value.matchAll(editTargets)) {
      const count = parseChineseNumber(match[1]);
      if (count >= 2) return count;
    }

    // Deictic resource counts with “这/那” before the number: “把这两张图改成黑白” and
    // “分别参考这两张图各生成一张” both mean N independent results even though the
    // number is not adjacent to “把” or is only a deictic count.
    const deicticEdit = new RegExp('(?:\u628a|\u5c06)?\\s*(?:\u8fd9|\u90a3)\\s*' + NUMBER + '\\s*' + RESULT_UNIT + '(?:\u56fe|\u56fe\u7247|\u76ee\u6807\u56fe)?\\s*(?:\u90fd|\u5168\u90e8|\u5206\u522b)?\\s*(?:\u6539\u6210|\u6539\u4e3a|\u53d8\u6210|\u6362\u6210)', 'g');
    for (const match of value.matchAll(deicticEdit)) {
      const count = parseChineseNumber(match[1]);
      if (count >= 2) return count;
    }
    const deicticEach = new RegExp('(?:\u8fd9|\u90a3)\\s*' + NUMBER + '\\s*' + RESULT_UNIT + '(?:\u56fe|\u56fe\u7247|\u76ee\u6807\u56fe)?[^\u3002\uff01\uff1f!?\n]{0,24}?(?:\u5404|\u5206\u522b)\\s*(?:\u751f\u6210|\u53d8\u6210|\u6539\u6210)', 'g');
    for (const match of value.matchAll(deicticEach)) {
      const count = parseChineseNumber(match[1]);
      if (count >= 2) return count;
    }

    // 分别/各自/每个 enumeration: each listed item is an independent result.
    if (/分别|各自|每个|各个/.test(value)) {
      const unitTokens = [];
      for (const clause of clauses) {
        const verb = clause.match(OUTPUT_VERB);
        if (!verb) continue;
        const tail = clause.slice(verb.index + verb[0].length);
        const unitRe = new RegExp(NUMBER + '\\s*' + RESULT_UNIT, 'g');
        for (const match of tail.matchAll(unitRe)) unitTokens.push(parseChineseNumber(match[1]));
      }
      if (unitTokens.length >= 2) return unitTokens.length;
      const subjectItems = (value.match(/(?:只|匹|条|头|座)/g) || []).length;
      if (subjectItems >= 2) return subjectItems;
    }

    // Ordinal enumeration tied to an output verb: “把第1张和第5张改成…”.
    // A target plus mask/reference, or an explicit exclusion such as
    // “第一张不要改”, is one execution with auxiliary constraints—not an
    // independent multi-result request.
    const auxiliaryRoleOrExclusion = /(?:蒙版|遮罩|mask|参考图|参考图片|风格参考|配色参考|主体构图|水彩质感|作为(?:主体|构图|风格|配色|蒙版)|用第|采用第|reference|style_reference|不要改|不修改|保持不变|保留原样)/i.test(value);
    const independentOrdinalCue = /(?:分别|各自|逐张|每张|都|全部|独立|separately|respectively|each)/i.test(value);
    const explicitSingleOutput = /(?:生成|画|绘制|制作|创建|得到)\s*(?:一张|一幅|一个|一份|a\s+(?:new\s+)?(?:image|picture|poster))/i.test(value);
    if (OUTPUT_VERB.test(value) && (!auxiliaryRoleOrExclusion || independentOrdinalCue)
        && (!explicitSingleOutput || independentOrdinalCue)) {
      const ordinals = value.match(/第[一二三四五六七八九十百0-9]+[张幅个组版款套海报图]/g) || [];
      const distinct = new Set(ordinals.map(item => item.replace(/^第/, '')));
      if (distinct.size >= 2) return distinct.size;
    }

    // Explicit view enumeration with a pluralizer.
    const views = ['正面', '侧面', '背面', '俯视', '仰视', '左视', '右视', '前视', '后视'];
    const viewCount = views.filter(view => value.includes(view)).length;
    if (viewCount >= 2 && /(?:分别|各个|每个|多个|多张|多幅|多组|多图)/.test(value)) return viewCount;

    for (const count of counts) if (count >= 2) return count;
    return 0;
  }


  // Deterministic Shape Compiler: derive operation / task_shape / branch from
  // the extracted actions. The route model never decides task_shape again.
  // Highest explicit result count across raw input, resolved goal, and a
  // single-image action target. The Shape Compiler can promote a request to
  // image_plan from the target even when the raw input is an anaphoric
  // continuation such as "继续生成"; the image-plan count gate must use the
  // same evidence sources instead of looking at the raw input alone.
  function maxExplicitImageResultCount(input = '', goal = '', target = '') {
    return Math.max(
      explicitImageResultCount(stringValue(input)),
      explicitImageResultCount(stringValue(goal)),
      explicitImageResultCount(stringValue(target)),
    );
  }

  function actionIsNegationOnly(action = {}) {
    const target = stringValue(action?.target);
    return /(?:不要|别|不改|不修改|不动|保持(?:不变|原样)|保留(?:不变|原样)|不得修改|do\s+not|don't)/i.test(target)
      && !/(?:生成|画|绘制|制作|创建|修改|编辑|改成|改为|变成|换成|分析|总结|读取|查看|比较|识别|提取)/i.test(target);
  }

  function hasIndependentOutputCue(input = '') {
    const text = stringValue(input);
    return /(?:分别|各自|逐张|逐个|每张都|每个都|独立(?:生成|编辑|结果)|各生成|各修改|respectively|each|separately)/i.test(text);
  }

  function hasAuxiliaryResourceRoleCue(input = '') {
    return /(?:蒙版|遮罩|mask|参考图|参考图片|风格参考|配色参考|style_reference|reference)/i.test(stringValue(input));
  }

  function normalizeActionsForShape(actions = [], input = '') {
    const normalized = Array.isArray(actions) ? actions : [];
    if (normalized.length <= 1 || hasIndependentOutputCue(input)) return normalized;
    const usable = normalized.filter(action => !actionIsNegationOnly(action));
    const allImageEdits = usable.length > 0 && usable.every(action => action.kind === 'image_edit');
    // A target plus mask/reference is one edit execution. A negative clause is
    // also a constraint, not a second no-op action. Merge only when the input
    // does not explicitly request independent outputs.
    if (allImageEdits && (hasAuxiliaryResourceRoleCue(input) || usable.length < normalized.length)) {
      const first = usable[0];
      const refs = [];
      const seen = new Set();
      for (const action of usable) {
        for (const ref of Array.isArray(action.resolved_refs) ? action.resolved_refs : []) {
          const key = `${stringValue(ref.candidate_key)}|${stringValue(ref.text)}`;
          if (seen.has(key)) continue;
          seen.add(key);
          refs.push(ref);
        }
      }
      return [{ ...first, resolved_refs: refs }];
    }
    return normalized;
  }

  function compileUnderstandingShape(actions = [], input = '') {
    const normalized = normalizeActionsForShape(
      (Array.isArray(actions) ? actions : []).map(normalizeAction).filter(Boolean),
      input,
    );
    if (!normalized.length) {
      return Object.freeze({ taskShape: 'none', operation: '', branch: 'clarification' });
    }
    if (normalized.length === 1) {
      const kind = normalized[0].kind;
      if (IMAGE_MULTI_KINDS.has(kind)
          && (explicitImageResultCount(stringValue(input)) >= 2 || explicitImageResultCount(stringValue(normalized[0].target)) >= 2)) {
        return Object.freeze({
          taskShape: 'multi',
          operation: operationForKind(kind),
          requiredRoles: requiredResourceRoles(kind),
          branch: 'image_plan',
          actions: normalized,
        });
      }
      return Object.freeze({
        taskShape: 'single',
        operation: operationForKind(kind),
        requiredRoles: requiredResourceRoles(kind),
        branch: 'route',
        actions: normalized,
      });
    }
    const allImage = normalized.every(action => IMAGE_MULTI_KINDS.has(action.kind));
    if (allImage) {
      return Object.freeze({
        taskShape: 'multi',
        operation: operationForKind(normalized[0].kind),
        requiredRoles: requiredResourceRoles(normalized[0].kind),
        branch: 'image_plan',
        actions: normalized,
      });
    }
    return Object.freeze({
      taskShape: 'multi',
      operation: operationForKind(normalized[0].kind),
      requiredRoles: requiredResourceRoles(normalized[0].kind),
      branch: 'multi_task_plan',
      actions: normalized,
    });
  }

  // For kinds whose deterministic role is unambiguous, the understanding
  // resolved_refs are authoritative enough to compare against the planner's
  // concrete resource bindings. Ambiguous role families (compare_a/compare_b,
  // reference/style_reference) are intentionally skipped here and canonicalized
  // later by the deterministic compiler.
  function deterministicResourceRefsForAction(action = {}) {
    const kind = stringValue(action?.kind);
    const refs = Array.isArray(action?.resolved_refs) ? action.resolved_refs : [];
    if (!refs.length) return null;
    const rolesByType = requiredResourceRoles(kind);
    const result = [];
    for (const ref of refs) {
      const candidateKey = stringValue(ref?.candidate_key);
      const type = candidateKey.startsWith('i')
        ? 'image'
        : candidateKey.startsWith('f')
          ? 'file'
          : candidateKey.startsWith('m')
            ? 'message'
            : '';
      const roles = type ? rolesByType[type] || [] : [];
      if (!type || !Array.isArray(roles) || roles.length !== 1) return null;
      result.push({ candidate_key: candidateKey, role: roles[0] });
    }
    return result;
  }

  // Expected task projections used by the planner's 1:1 faithfulness check.
  function expectedPlanTasks(actions = []) {
    return (Array.isArray(actions) ? actions : []).map((action, index) => {
      const kind = stringValue(action?.kind);
      const expected = {
        index: index + 1,
        kind,
        operation: operationForKind(kind),
        resource_roles: requiredResourceRoles(kind),
      };
      const resourceRefs = deterministicResourceRefsForAction(action);
      if (Array.isArray(resourceRefs) && resourceRefs.length) expected.resource_refs = resourceRefs;
      return expected;
    });
  }

  const UNDERSTANDING_RESPONSE_FORMAT = Object.freeze({
    type: 'json_schema',
    json_schema: {
      name: 'chatui_intent_understanding_v1',
      strict: true,
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['schema_version', 'dependency', 'actions'],
        properties: {
          schema_version: { type: 'string', const: UNDERSTANDING_VERSION },
          dependency: { type: 'string', enum: ['new', 'followup', 'continuation'] },
          actions: {
            type: 'array',
            maxItems: 20,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['index', 'kind', 'target', 'resolved_refs'],
              properties: {
                // Numeric min/max bounds are rejected by OpenAI structured outputs; the local validator still enforces index >= 1.
                index: { type: 'integer' },
                kind: { type: 'string', enum: Object.keys(ACTION_KINDS) },
                target: { type: 'string' },
                resolved_refs: {
                  type: 'array',
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    required: ['candidate_key', 'text'],
                    properties: {
                      candidate_key: { type: 'string' },
                      text: { type: 'string' },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  });

  // 1:1 planner faithfulness: every extracted action must be covered by exactly
  // one plan task with the matching operation, and the planner must not invent
  // extra tasks. When the understanding node resolved unambiguous resource keys,
  // the concrete planner bindings must match them too; ambiguous roles are still
  // canonicalized later by the deterministic compiler.
  function planResourceFingerprint(task = {}) {
    const refs = Array.isArray(task?.resource_refs) ? task.resource_refs : [];
    return JSON.stringify(refs.map(ref => `${stringValue(ref?.candidate_key)}|${stringValue(ref?.role)}`).sort());
  }

  function planCoversExpected(plan = {}, expectedTasks = []) {
    const tasks = Array.isArray(plan?.tasks) ? plan.tasks : [];
    const expected = Array.isArray(expectedTasks) ? expectedTasks : [];
    if (!tasks.length || tasks.length !== expected.length) return false;
    const operations = list => list.map(item => stringValue(item?.operation)).sort();
    if (JSON.stringify(operations(tasks)) !== JSON.stringify(operations(expected))) return false;

    const operationValues = [...new Set(operations(expected))];
    for (const operation of operationValues) {
      const expectedGroup = expected.filter(item => stringValue(item?.operation) === operation);
      const taskGroup = tasks.filter(item => stringValue(item?.operation) === operation);
      if (expectedGroup.length !== taskGroup.length) return false;
      const hasResolvedResources = expectedGroup.some(item => Array.isArray(item?.resource_refs) && item.resource_refs.length);
      if (!hasResolvedResources) continue;
      const expectedFingerprints = expectedGroup.map(item => (
        Array.isArray(item?.resource_refs) && item.resource_refs.length
          ? planResourceFingerprint({ resource_refs: item.resource_refs })
          : '[]'
      )).sort();
      const taskFingerprints = taskGroup.map(item => planResourceFingerprint(item)).sort();
      if (JSON.stringify(expectedFingerprints) !== JSON.stringify(taskFingerprints)) return false;
    }
    return true;
  }

  return Object.freeze({
    UNDERSTANDING_VERSION,
    planCoversExpected,
    UNDERSTANDING_RESPONSE_FORMAT,
    ACTION_KINDS,
    KIND_RESOURCE_ROLES,
    IMAGE_MULTI_KINDS,
    hasExactUnderstanding,
    assertUnderstanding,
    normalizeAction,
    operationForKind,
    requiredResourceRoles,
    normalizeActionsForShape,
    compileUnderstandingShape,
    maxExplicitImageResultCount,
    explicitImageResultCount,
    expectedPlanTasks,
  });
});
