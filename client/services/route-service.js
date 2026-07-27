(function initChatUIRouteService(root) {
  'use strict';

const MAX_ROUTE_REPAIR_OUTPUT_CHARS = 12000;

// v5 separates the requested operation from execution readiness.  A route can
// therefore keep operation=image_reference_gen while explicitly stopping for
// a resource choice; readiness, not operation, controls whether it may run.
const ROUTE_SYSTEM_PROMPT_V5 = `你是 ChatUI 的任务路由器。你的唯一输出是严格的 task_contract.v5 JSON。不要回答用户，不要输出 Markdown、解释、代码围栏或任何未定义字段。

唯一结构：
{"schema_version":"task_contract.v5","readiness":"ready|needs_clarification","operation":"plain_chat|file_qa|multimodal_qa|image_qa|image_compare|ocr|text_to_image|image_reference_gen|edit_image","relation":"new|followup|correction|continuation","resources":[{"key":"r1","type":"image|file|text|message","source":"current|quoted|history|context","role":"source|target|reference|style_reference|mask|compare_a|compare_b|attachment|context","index":1,"id":"","reference_id":"","missing":false}],"directive":{"mode":"standalone|patch","base_resource_keys":[],"unmentioned_policy":"preserve|allow_change","operations":[{"op":"preserve|add|replace|remove","target":"","value":""}],"constraints":[]},"clarification":{"question":"","unresolved_resources":[{"key":"r2","type":"image|file|text|message","role":"source|target|reference|style_reference|mask|compare_a|compare_b|attachment|context","reason":"missing|ambiguous|unavailable","choices":[{"key":"c1","source":"current|quoted|history|context","index":1,"id":"","reference_id":"","label":""}]}]},"confidence":0,"review_reasons":[],"rationale":""}

一、输入边界与优先级
1. current_input 是本轮用户指令，允许为空；attachments 只代表本轮上传资源；context 只为明确指代提供候选，不能自行扩展任务；context.quoted_message 表示用户在界面显式引用的消息。证据优先级是：current_input 中的明确要求和本轮附件/显式引用 > clarification_context.v1 中本轮确认的选择 > 普通历史。
2. 一个语义完整、对象和约束自足的新请求必须按新任务处理，不得因历史中存在同类图片、文件、关键词或上一轮 operation 而继承资源。只有“上一张、那个文件、继续、还是不对”等明确依赖上下文的表达才使用历史。
3. clarification_context.v1 只是上一轮问题、用户回答和已选项的证据。必须重新判断 operation、relation、resources、directive 和 readiness；禁止复制 prior_task_contract、禁止仅修改 readiness、禁止让 continuation classifier 的结论授权执行。
4. auto_mode 缺省或 true 时按语义自由选择 operation。auto_mode=false 时 current_mode 是用户固定的产品执行族：chat 仅允许聊天/视觉理解类 operation，image 允许 text_to_image 与 image_reference_gen（两者交付物都是新图片），edit_image 允许 edit_image；image_reference_gen 虽使用图片编辑 multipart 传输，仍属于 image 产品模式。若明确任务与固定模式冲突，不得篡改任务去迎合模式；返回 needs_clarification，并用一个 type=text、role=source、reason=missing、choices=[] 的未决槽说明需要用户调整模式或指令。

二、operation 语义
5. plain_chat：普通文本问答、写作、代码或分析，且不需要读取文件。file_qa：只读取一个或多个可用文件。multimodal_qa：回答必须同时读取图片和文件。image_qa：描述、识别或分析图片；ocr：明确提取图片文字；image_compare：比较恰好两张图片。
6. text_to_image：仅凭文本生成图片，不消费任何图片。image_reference_gen：消费一张或多张已有图片作为 reference/style_reference，并以新图片为交付物，生成新的构图或版本；即使传输使用图片编辑接口，也不是修改原图。要求从图片反推、逆向生成、还原、提取或输出提示词时，交付物是文本，属于 image_qa；“生成提示词”绝不是“生成图片”。edit_image：修改明确的 target，可有最多一个 mask；reference/style_reference 不能伪装成 target。
7. 多个要求若能由同一 operation、同一组资源一次完成，可以合并为一个合同。若包含多个相互独立或跨执行族的正式任务，不得静默选择一项、不得部分执行：以用户首先明确提出的任务作为暂定 operation，只保留该任务已唯一确定的资源，readiness=needs_clarification，并增加 type=text、role=source、reason=missing、choices=[] 的未决槽，请用户一次选择或重述一个任务。

三、资源绑定与附件可用性
8. resources 只放已唯一确定且可用于正式请求的资源，missing 固定 false。图片和文件的 id/reference_id 是稳定身份，必须逐字复制候选；index 是本次候选表位置，也必须复制但不能替代身份。当前附件的 image/file 类型内索引使用 attachments.media_index，attachments.index/source_index 只是原上传顺序。文件 reference_id 必须为 ""。
9. 只根据候选元数据和用户明确指代绑定资源，不猜测图片或文件内容。任何 source=history|quoted|context 的资源或澄清 choice 都要求 relation 非 new，并且其 key 必须进入 patch.base_resource_keys。
10. 非图片附件只有 has_extracted_text=true 且 unsupported_reason 为空时才可作为 file 资源。has_extracted_text=false 或存在 unsupported_reason 的文件绝不能放入 resources 或 choices。若任务依赖它，保留真实 operation，使用 type=file、role=attachment、reason=unavailable、choices=[] 的未决槽，问题中明确要求重新上传可解析格式；若任务与它无关，直接忽略该附件。
11. current_input 为空但存在附件时，不猜用户目的：图片暂定 image_qa，文件暂定 file_qa，图片与文件混合暂定 multimodal_qa；已可用附件仍按真实身份放入 resources，同时增加 type=text、role=source、reason=missing、choices=[] 的未决槽询问要执行什么。只有不可用文件时按第 10 条处理；同时缺少指令时可以再增加文本未决槽。

四、readiness 与澄清
12. 只有唯一 operation、所有必需资源可用且唯一、固定模式兼容、任务可以由一次正式请求完成时，readiness=ready；此时 clarification.question="" 且 unresolved_resources=[]。
13. 必需资源缺失、候选歧义、附件不可用、目标不明确、固定模式冲突、附件无指令或跨执行族多任务时，readiness=needs_clarification。已确定资源留在 resources；未决项只放 unresolved_resources，绝不能替用户选候选或输出可执行状态。
14. reason=ambiguous 时 choices 至少两个，且每项必须复制真实候选的 source/index/id/reference_id；reason=missing 或 unavailable 时 choices=[]。question 和 choice.label 使用面向用户的自然语言，覆盖每个未决槽，不展示 r/c key。

五、relation 与 directive
15. relation 只描述对话关系：new=独立新任务；followup=基于已有内容追问或扩展；correction=指出前一结果错误并要求修正；continuation=继续尚未完成的同一任务。relation 不决定 directive。只使用 current 资源的请求也可以是 followup/correction/continuation；反之完整新任务即使历史相似仍是 new。
16. image_reference_gen 使用本轮 current 参考图时可以 relation=new；使用 history/quoted/context 图时必须非 new，并依据语义选择 followup、correction 或 continuation，绝不能一律写成 followup。
17. standalone 表示不依赖历史/引用/上下文基线：base_resource_keys=[]、operations=[]、unmentioned_policy=allow_change。只用 current 资源的理解类任务通常 standalone。patch 必须列出全部历史、引用或上下文资源；edit_image 和 image_reference_gen 始终 patch，并把全部 target/mask/reference/style_reference（包括 current）列入 base_resource_keys。needs_clarification 的 patch 还要包含作为基线的未决资源 key；文本指令槽不是基线。
18. directive 只记录用户明确表达的修改：add/replace 的 target、value 都为非空字符串；preserve/remove 的 target 非空且 value 必须严格为 ""；不要把推测内容写入 operations 或 constraints。

六、最终合同校验
19. 顶层恰好 10 个字段；schema_version 固定 task_contract.v5；confidence 为 0~1；review_reasons 无需复核时为 []；rationale 只写一行依据。resource.key 在全部资源/未决槽中唯一且形如 r1，choice.key 在各槽内唯一且形如 c1，index 为正整数。
20. operation 资源形状：plain_chat 不含 file，非当前图片只能是 reference/style_reference、历史消息只能是 context；file_qa 至少一 file(attachment)；multimodal_qa 同时有 image(source) 与 file(attachment)；image_qa/ocr 的图片均为 source；text_to_image 无 image/file；image_compare 恰两图 compare_a/compare_b；edit_image 仅 target/mask 且至少一 target；image_reference_gen 的图片均为 reference/style_reference。未决槽按假设被补齐后也必须满足该形状。`;

const ROUTE_OUTPUT_CONTRACT_CHECK_V5 = `输出前逐字段自检，空数组也必须输出 []：ready 的 clarification 必须为空；needs_clarification 必须保留真实/暂定 operation 和全部未决槽。不可解析文件不得进入 resources/choices；跨执行族多任务不得部分执行；完整新任务不得继承历史。image_reference_gen 的非 current 参考图 relation 必须非 new 并按语义选择 followup/correction/continuation，所有参考图均为 patch 基线；preserve/remove 的 value=""，add/replace 的 target/value 非空。只输出 task_contract.v5 JSON。`;
const ROUTE_SYSTEM_PROMPT_WITH_OUTPUT_CHECK_V5 = `${ROUTE_SYSTEM_PROMPT_V5}\n\n${ROUTE_OUTPUT_CONTRACT_CHECK_V5}`;

const INTENT_REVIEW_SYSTEM_PROMPT_V5 = `${ROUTE_SYSTEM_PROMPT_WITH_OUTPUT_CHECK_V5}\n\n你是独立审计器。输入可能包含 first_task_contract；只能校正字段和资源绑定，不能替用户消歧。返回一个完整 task_contract.v5。`;
const INTENT_REPAIR_SYSTEM_PROMPT_V5 = `你是 ChatUI 路由合同修复器。repair_invariants 是不可变边界：operation、relation、readiness，以及 resources/unresolved_resources 的类型、角色、来源和数量必须逐项保持；只可补齐结构字段或用候选元数据校正 id/reference_id/index。无法在该边界内修复就仍返回同语义的完整合同，绝不能改任务、改资源角色、增删资源、替用户选择或把澄清改为可执行。只输出 task_contract.v5 JSON。`;

function strictObject(properties) {
  return { type: 'object', additionalProperties: false, required: Object.keys(properties), properties };
}

const ROUTE_RESPONSE_FORMAT = Object.freeze({
  type: 'json_schema',
  json_schema: {
    name: 'chatui_task_contract_v5',
    strict: true,
    schema: strictObject({
      schema_version: { type: 'string', const: 'task_contract.v5' },
      readiness: { type: 'string', enum: ['ready', 'needs_clarification'] },
      operation: { type: 'string', enum: ['plain_chat', 'file_qa', 'multimodal_qa', 'image_qa', 'image_compare', 'ocr', 'text_to_image', 'image_reference_gen', 'edit_image'] },
      relation: { type: 'string', enum: ['new', 'followup', 'correction', 'continuation'] },
      resources: {
        type: 'array',
        items: strictObject({
          key: { type: 'string', pattern: '^r[1-9][0-9]*$' },
          type: { type: 'string', enum: ['image', 'file', 'text', 'message'] },
          source: { type: 'string', enum: ['current', 'quoted', 'history', 'context'] },
          role: { type: 'string', enum: ['source', 'target', 'reference', 'style_reference', 'mask', 'compare_a', 'compare_b', 'attachment', 'context'] },
          index: { type: 'integer', minimum: 1 },
          id: { type: 'string' },
          reference_id: { type: 'string' },
          missing: { type: 'boolean' },
        }),
      },
      directive: strictObject({
        mode: { type: 'string', enum: ['standalone', 'patch'] },
        base_resource_keys: { type: 'array', items: { type: 'string', pattern: '^r[1-9][0-9]*$' } },
        unmentioned_policy: { type: 'string', enum: ['preserve', 'allow_change'] },
        operations: { type: 'array', items: strictObject({ op: { type: 'string', enum: ['preserve', 'add', 'replace', 'remove'] }, target: { type: 'string' }, value: { type: 'string' } }) },
        constraints: { type: 'array', items: { type: 'string' } },
      }),
      clarification: strictObject({
        question: { type: 'string' },
        unresolved_resources: {
          type: 'array',
          items: strictObject({
            key: { type: 'string', pattern: '^r[1-9][0-9]*$' },
            type: { type: 'string', enum: ['image', 'file', 'text', 'message'] },
            role: { type: 'string', enum: ['source', 'target', 'reference', 'style_reference', 'mask', 'compare_a', 'compare_b', 'attachment', 'context'] },
            reason: { type: 'string', enum: ['missing', 'ambiguous', 'unavailable'] },
            choices: {
              type: 'array',
              items: strictObject({
                key: { type: 'string', pattern: '^c[1-9][0-9]*$' },
                source: { type: 'string', enum: ['current', 'quoted', 'history', 'context'] },
                index: { type: 'integer', minimum: 1 },
                id: { type: 'string' },
                reference_id: { type: 'string' },
                label: { type: 'string' },
              }),
            },
          }),
        },
      }),
      confidence: { type: 'number', minimum: 0, maximum: 1 },
      review_reasons: { type: 'array', items: { type: 'string' } },
      rationale: { type: 'string' },
    }),
  },
});
const intentContract = root?.ChatUICoreIntentContract
  || root?.ChatUICore?.intentContract
  || root?.window?.ChatUICoreIntentContract
  || root?.window?.ChatUICore?.intentContract
  || (typeof require === 'function' ? require('../core/intent-contract') : {});

const promptComposer = root?.ChatUIPromptComposerService
  || root?.ChatUIServices?.promptComposer
  || root?.window?.ChatUIPromptComposerService
  || root?.window?.ChatUIServices?.promptComposer
  || (typeof require === 'function' ? require('./prompt-composer-service') : {});

const preflightGuards = root?.ChatUICorePreflightGuards
  || root?.window?.ChatUICorePreflightGuards
  || (typeof require === 'function' ? require('../core/preflight-guards') : {});

function assertInputWithinUnifiedLimit(input = '') {
  const result = preflightGuards?.validateMessageSize?.(String(input || ''));
  if (!result || result.ok) return;
  const error = new RangeError(result.message || 'Message exceeds the configured input limit');
  error.code = result.code || 'message_too_many_characters';
  error.length = result.length;
  error.maxChars = result.maxChars;
  throw error;
}

function executionPrompt(input = '') {
  // The contract selects media and validates intent. It must not turn into model-facing patch text.
  assertInputWithinUnifiedLimit(input);
  const prompt = promptComposer?.composeExecutionPrompt?.(input);
  return typeof prompt === 'string' ? prompt : String(input || '').trim();
}

function cleanQuotedContent(text = '') {
  return String(text || '')
    .replace(/\[base64 image\]/gi, '')
    .replace(/\u8017\u65f6\uff1a[^\n]+/g, '')
    .replace(/RT\s+[^\n]+/gi, '')
    .replace(/TTFT\s+[^\n]+/gi, '')
    .replace(/^\[\u56fe\u7247(?:\u751f\u6210|\u7f16\u8f91|\u4fee\u6539)\u5b8c\u6210\]\s*/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function stripJsonFence(text = '') {
  return String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
}

function sortedSignatures(values = []) {
  return values.map(value => JSON.stringify(value)).sort();
}

function repairInvariantSnapshot(value = '') {
  try {
    if (typeof value === 'string' && value.length > MAX_ROUTE_REPAIR_OUTPUT_CHARS) return null;
    const raw = typeof value === 'string' ? JSON.parse(stripJsonFence(value)) : value;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    if (raw.schema_version !== 'task_contract.v5'
        || !Object.prototype.hasOwnProperty.call(raw, 'readiness')) return null;
    const task = raw;
    const operation = String(task?.operation || '');
    const relation = String(task?.relation || '');
    const readiness = task?.readiness;
    if (!['plain_chat', 'file_qa', 'multimodal_qa', 'image_qa', 'image_compare', 'ocr', 'text_to_image', 'image_reference_gen', 'edit_image'].includes(operation)
        || !['new', 'followup', 'correction', 'continuation'].includes(relation)
        || !['ready', 'needs_clarification'].includes(readiness)
        || !Array.isArray(task.resources)
        || !Array.isArray(task.clarification?.unresolved_resources)) return null;
    const resources = task.resources.map(resource => {
      const type = String(resource?.type || '');
      const source = String(resource?.source || '');
      const role = String(resource?.role || '');
      if (!type || !['current', 'quoted', 'history', 'context'].includes(source) || !role) throw new TypeError('incomplete resource invariant');
      return { type, source, role };
    });
    const unresolved = task.clarification.unresolved_resources.map(slot => {
      const type = String(slot?.type || '');
      const role = String(slot?.role || '');
      const reason = String(slot?.reason || '');
      if (!type || !role || !['missing', 'ambiguous', 'unavailable'].includes(reason) || !Array.isArray(slot?.choices)) throw new TypeError('incomplete unresolved invariant');
      const choiceSources = slot.choices.map(choice => {
        const source = String(choice?.source || '');
        if (!['current', 'quoted', 'history', 'context'].includes(source)) throw new TypeError('incomplete choice invariant');
        return source;
      }).sort();
      return { type, role, reason, choice_count: slot.choices.length, choice_sources: choiceSources };
    });
    return Object.freeze({
      operation,
      relation,
      readiness,
      resource_count: resources.length,
      resources: sortedSignatures(resources),
      unresolved_count: unresolved.length,
      unresolved: sortedSignatures(unresolved),
    });
  } catch {
    return null;
  }
}

function repairPreservesInvariants(invariants = null, repairedValue = null) {
  if (!invariants || !repairedValue) return false;
  const task = repairedValue?.taskContract || repairedValue;
  const repaired = repairInvariantSnapshot(task);
  if (!repaired) return false;
  return repaired.operation === invariants.operation
    && repaired.relation === invariants.relation
    && repaired.readiness === invariants.readiness
    && repaired.resource_count === invariants.resource_count
    && repaired.unresolved_count === invariants.unresolved_count
    && JSON.stringify(repaired.resources) === JSON.stringify(invariants.resources)
    && JSON.stringify(repaired.unresolved) === JSON.stringify(invariants.unresolved);
}

function routeReadiness(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
  if (value.readiness === 'ready' || value.readiness === 'needs_clarification') return value.readiness;
  const clarification = value.clarification;
  const declaresClarification = value.operation === 'clarify'
    || typeof clarification?.question === 'string' && !!clarification.question.trim()
    || typeof clarification?.resume_operation === 'string' && !!clarification.resume_operation.trim()
    || Array.isArray(clarification?.unresolved_resources) && clarification.unresolved_resources.length > 0;
  return declaresClarification ? 'needs_clarification' : 'ready';
}

function decodeTaskContract(value = {}) {
  return typeof intentContract?.normalizeContractVersion === 'function'
    ? intentContract.normalizeContractVersion(value)
    : value;
}

function readRouteReadiness(text = '') {
  try {
    return routeReadiness(JSON.parse(stripJsonFence(text)));
  } catch {
    return '';
  }
}

function mergeRouteReadinessRequirement(...values) {
  const readiness = values.filter(value => value === 'ready' || value === 'needs_clarification');
  if (readiness.includes('needs_clarification')) return 'needs_clarification';
  return readiness.includes('ready') ? 'ready' : '';
}

function routePlanReadiness(route = {}) {
  if (route?.taskContract) {
    const contractReadiness = routeReadiness(decodeTaskContract(route.taskContract));
    if (contractReadiness) return contractReadiness;
  }
  if (route?.needClarification === true || route?.api === 'clarify') return 'needs_clarification';
  return route && typeof route === 'object' ? 'ready' : '';
}

function routeSatisfiesReadiness(route = {}, requiredReadiness = '') {
  if (requiredReadiness !== 'needs_clarification') return !!route;
  return routePlanReadiness(route) === 'needs_clarification';
}

const EXECUTION_RESOURCES_VERSION = 'execution_resources.v1';

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
  if (projection.version !== EXECUTION_RESOURCES_VERSION
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
  if (!task || task.schema_version !== 'task_contract.v5') return false;
  if (!intentContract?.hasExactContractShape?.(task) || task.readiness !== 'ready' || route.readiness !== 'ready') return false;
  const expectedApi = intentContract?.contractApi?.(task) || '';
  if (!expectedApi || route.api !== expectedApi || route.operationApi !== expectedApi) return false;
  if (route.operationType !== task.operation || route.relation !== task.relation) return false;
  const expectedMode = intentContract?.contractMode?.(task) || '';
  if (!expectedMode || route.operationMode !== expectedMode) return false;
  return route.mode === expectedMode && hasConsistentExecutionResources(route, task, expectedApi);
}


function buildQuotedImagePlaceholders(images = []) {
  return (images || [])
    .map((item, index) => `[quoted_image index=${index + 1} id=${item.imageId || item.image_id || ''} name=${item.name || ''}]`)
    .join('\n');
}

function buildQuotedRouteContent({ text = '', images = [] } = {}) {
  return [cleanQuotedContent(text), buildQuotedImagePlaceholders(images)].filter(Boolean).join('\n') || '[quoted_message]';
}

function attachComposedPrompt(route = {}, taskContract = {}, options = {}) {
  const input = String(options.input || '').trim();
  let next = { ...route, taskContract };
  if (taskContract.operation === 'text_to_image') {
    next = { ...next, contextualImagePrompt: composeTextToImagePrompt(input, taskContract, options.context || {}) };
  } else if (taskContract.operation === 'image_reference_gen') {
    next = { ...next, editInstruction: executionPrompt(input) };
  } else if (taskContract.operation === 'edit_image') {
    next = { ...next, editInstruction: executionPrompt(input) };
  }
  return next;
}

function messageIdentity(message = {}) {
  return String(
    message?.display_item_id
    || message?.displayItemId
    || message?.id
    || message?.message_id
    || message?.messageId
    || ''
  );
}

function messageBody(message = {}) {
  const raw = Array.isArray(message?.content)
    ? message?.rawText || ''
    : message?.content || message?.rawText || '';
  const text = cleanQuotedContent(String(raw || '').trim())
    .replace(/\[quoted_image[^\]]*\]/gi, '')
    .replace(/\[quoted_message\]/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  // This is the compact-context sentinel, not user-authored prompt text.
  return /^\[quoted_message\]$/i.test(text) ? '' : text;
}

function boundMessageBody(resource = {}, context = {}) {
  if (resource?.type !== 'message' || resource?.missing) return '';
  if (typeof intentContract?.resolveMessageResource === 'function'
      && !intentContract.resolveMessageResource(resource, { context })) return '';
  const recent = Array.isArray(context?.recent_messages) ? context.recent_messages : [];
  const index = Number(resource.index);
  const id = String(resource.id || '');
  const quote = context?.quoted_message && typeof context.quoted_message === 'object'
    ? context.quoted_message
    : null;
  const quoteIndex = Number(quote?.index);
  const quoteId = messageIdentity(quote);

  // Prefer the explicitly selected message object whenever the binding points
  // at it. This applies to both source=quoted and the equivalent source=history
  // representation emitted by some route models, and keeps a quote binding
  // independent from whichever compact history slot carries its text.
  if (Number.isInteger(quoteIndex)
      && quoteIndex === index
      && (!id || !quoteId || id === quoteId)) {
    const quotedText = messageBody(quote);
    if (quotedText) return quotedText;
  }

  const matches = recent.filter(message => {
    const candidateIndex = Number(message?.index);
    if (candidateIndex !== index) return false;
    // compact quoted route contexts may carry the quote id in
    // `quoted_message` while omitting it from the corresponding history row;
    // mirror intent-contract.messageCandidates' exact index-scoped fallback.
    const candidateId = messageIdentity(message)
      || (candidateIndex === quoteIndex ? quoteId : '');
    return !id || candidateId === id;
  });
  if (matches.length !== 1) return '';
  return messageBody(matches[0]);
}

/**
 * Compose the execution prompt for a text-to-image contract that explicitly
 * binds one or more historical/quoted messages. The router contract selects
 * the message; this helper only copies the already-bound message text into the
 * image prompt and then appends the user's current instruction.
 */
function composeTextToImagePrompt(input = '', taskContract = {}, context = {}) {
  const currentPrompt = executionPrompt(input);
  if (taskContract?.operation !== 'text_to_image' || !Array.isArray(taskContract?.resources)) return currentPrompt;
  const messageResources = taskContract.resources
    .filter(resource => resource?.type === 'message' && !resource.missing);
  const seen = new Set(currentPrompt ? [currentPrompt] : []);
  const boundBodies = messageResources
    .map(resource => boundMessageBody(resource, context))
    .filter(Boolean);
  if (messageResources.length && !boundBodies.length) {
    throw new TypeError('Bound message resource has no usable text');
  }
  const messagePrompts = boundBodies
    .filter(text => !seen.has(text) && seen.add(text));
  if (!messagePrompts.length) return currentPrompt;
  const separator = currentPrompt ? '\n\n' : '';
  const referencePrompt = messagePrompts.join('\n\n').trimEnd();
  if (!referencePrompt) return currentPrompt;
  return executionPrompt(`${referencePrompt}${separator}${currentPrompt}`);
}

function isTaskContractResult(value = {}) {
  return typeof intentContract.hasExactContractShape === 'function'
    && intentContract.hasExactContractShape(decodeTaskContract(value));
}

function isClarificationCandidate(text = '') {
  return readRouteReadiness(text) === 'needs_clarification';
}

function bindExplicitQuotedMessage(task = {}, context = {}) {
  const quote = context?.quoted_message;
  if (!quote || typeof quote !== 'object') return task;
  // An explicit UI quote is already an unambiguous, user-selected message.
  // It is protocol data rather than a model inference: a plain-chat route
  // cannot legitimately discard it or turn it into an unrelated new task.
  // This does not infer anything from ordinary history and never changes the
  // operation or any media resource selected by the model.
  if (task?.operation !== 'plain_chat' || !Array.isArray(task?.resources)) return task;
  const directive = task?.directive;
  if (!directive || !Array.isArray(directive.base_resource_keys) || !Array.isArray(directive.operations) || !Array.isArray(directive.constraints)) return task;
  const index = Number(quote.index);
  if (!Number.isInteger(index) || index < 1) return task;
  const resources = [...task.resources];
  const bound = resources.find(resource => resource?.type === 'message' && resource?.source === 'history' && Number(resource?.index) === index && resource?.role === 'context' && resource?.missing === false);
  const key = bound?.key || (() => {
    const used = new Set(resources.map(resource => String(resource?.key || '')));
    let number = 1;
    while (used.has(`r${number}`)) number += 1;
    return `r${number}`;
  })();
  if (!bound) resources.push({
    key, type: 'message', source: 'history', role: 'context', index,
    id: String(messageIdentity(quote)), reference_id: '', missing: false,
  });
  const baseKeys = [...directive.base_resource_keys];
  if (!baseKeys.includes(key)) baseKeys.push(key);
  return {
    ...task,
    relation: 'followup',
    resources,
    directive: {
      ...directive,
      mode: 'patch',
      base_resource_keys: baseKeys,
      unmentioned_policy: 'preserve',
    },
  };
}

function inspectTaskContract(taskContract = {}, options = {}) {
  if (!isTaskContractResult(taskContract)) return { route: null, reason: 'contract_shape' };
  try {
    const executionPlan = intentContract.taskContractToExecutionPlan(taskContract, { ...options, requireCandidateMatch: true });
    return { route: attachComposedPrompt(executionPlan, taskContract, options), reason: '' };
  } catch (error) {
    const message = String(error?.message || '');
    return { route: null, reason: /resource/i.test(message) ? 'resource_binding' : 'contract_semantics' };
  }
}

function declaredClarificationQuestion(task = {}) {
  const question = typeof task?.clarification?.question === 'string' ? task.clarification.question.trim() : '';
  return question || '请补充完成当前任务所需的信息后继续。';
}

function nonExecutingClarificationRoute(task = {}, validationReason = 'contract_shape') {
  const operation = String(task?.operation || '');
  const operationApi = intentContract?.contractApi?.(task) || '';
  return {
    mode: 'chat',
    api: 'clarify',
    operationApi,
    readiness: 'needs_clarification',
    dispatchAuthorized: false,
    relation: String(task?.relation || ''),
    operationType: operation,
    resumeOperation: operation,
    resumeApi: operationApi,
    target: 'none',
    intent: 'clarify',
    needClarification: true,
    clarificationQuestion: declaredClarificationQuestion(task),
    clarificationSlots: [],
    confidence: Number.isFinite(task?.confidence) ? Math.max(0, Math.min(1, task.confidence)) : 0,
    evidence: typeof task?.rationale === 'string' ? task.rationale : '',
    selectedIndexes: [],
    selectedImageIndexes: [],
    selectedFileIndexes: [],
    selectedImageIds: [],
    selectedReferenceId: '',
    imageRefs: [],
    fileRefs: [],
    messageRefs: [],
    taskContract: null,
    localClarification: false,
    clarificationDegraded: true,
    clarificationValidationReason: String(validationReason || 'contract_shape'),
    requiresRerouteAfterClarification: true,
  };
}

function inspectDeclaredClarification(task = {}, options = {}) {
  const canonical = typeof intentContract?.canonicalizeClarificationContract === 'function'
    ? intentContract.canonicalizeClarificationContract(task, options)
    : task;
  const structured = inspectTaskContract(canonical, options);
  if (structured.route) return { ...structured, clarificationTerminal: true };
  return {
    route: nonExecutingClarificationRoute(decodeTaskContract(task), structured.reason),
    reason: '',
    clarificationTerminal: true,
    clarificationDegraded: true,
    clarificationValidationReason: structured.reason,
  };
}

function terminalClarificationRouteFromResult(text = '', options = {}) {
  try {
    const decoded = bindExplicitQuotedMessage(decodeTaskContract(JSON.parse(stripJsonFence(text))), options.context);
    if (routeReadiness(decoded) !== 'needs_clarification') return null;
    return inspectDeclaredClarification(decoded, options).route;
  } catch {
    return null;
  }
}

function inspectRouteResult(text = '', options = {}) {
  const value = String(text || '').trim();
  if (!value) return { route: null, reason: 'empty_response' };
  try {
    const decoded = bindExplicitQuotedMessage(decodeTaskContract(JSON.parse(stripJsonFence(value))), options.context);
    if (routeReadiness(decoded) === 'needs_clarification') return inspectDeclaredClarification(decoded, options);
    const taskContract = typeof intentContract?.canonicalizeContractBindings === 'function'
      ? intentContract.canonicalizeContractBindings(decoded, options)
      : decoded;
    return inspectTaskContract(taskContract, options);
  } catch (error) {
    return { route: null, reason: 'contract_semantics' };
  }
}

function parseRouteResult(text = '', options = {}) {
  return inspectRouteResult(text, options).route;
}

function createExplicitTextToImageRoute(input = '') {
  const prompt = String(input || '').trim();
  if (!prompt) return null;
  const taskContract = {
    schema_version: 'task_contract.v5',
    readiness: 'ready',
    operation: 'text_to_image',
    relation: 'new',
    resources: [{
      key: 'r1',
      type: 'text',
      source: 'current',
      role: 'source',
      index: 1,
      id: '',
      reference_id: '',
      missing: false,
    }],
    directive: {
      mode: 'standalone',
      base_resource_keys: [],
      unmentioned_policy: 'allow_change',
      operations: [],
      constraints: [],
    },
    clarification: { question: '', unresolved_resources: [] },
    confidence: 1,
    review_reasons: [],
    rationale: 'explicit force-image UI action',
  };
  const route = inspectTaskContract(taskContract, { input: prompt, attachments: [], context: {} }).route;
  return isRouteDispatchable(route) ? route : null;
}

function needsIntentReview(route = {}, context = {}) {
  if (!route?.taskContract) return false;
  return intentContract?.needsIntentReview ? intentContract.needsIntentReview(route.taskContract, context) : false;
}

function buildFileCandidatesFromAttachments(attachments = []) {
  return (attachments || [])
    .filter(item => item && !item.is_image)
    .map((item, index) => ({
      index: Number(item.media_index || item.mediaIndex) || index + 1,
      source_index: Number(item.source_index || item.sourceIndex) || index + 1,
      source: 'current',
      target: 'uploaded',
      file_id: item.file_id || item.id || item.attachmentId || item.attachment_id || '',
      name: item.name || 'attachment',
      type: item.type || '',
      size: Number(item.size) || 0,
      has_extracted_text: !!(item.has_extracted_text || item.hasExtractedText),
      unsupported_reason: item.unsupported_reason || item.unsupportedReason || '',
    }));
}

function compactRoutePayloadContext(context = {}, input = '', attachments = []) {
  const next = context && typeof context === 'object' ? { ...context } : {};
  const currentFiles = buildFileCandidatesFromAttachments(attachments);
  const current = String(input || '').trim();
  const messages = Array.isArray(next.recent_messages) ? [...next.recent_messages] : [];
  let currentMessageIndex = 0;
  if (current && messages.length) {
    const last = messages[messages.length - 1];
    const content = String(last?.content || '').trim();
    const duplicateCurrent = last?.role === 'user' && (content === current || content.startsWith(`${current}\n\n[image `) || content.startsWith(`${current}\n\n[file `));
    if (duplicateCurrent) {
      currentMessageIndex = Number(last?.index) || messages.length;
      messages.pop();
    }
  }
  const historicalFiles = Array.isArray(next.file_candidates)
    ? next.file_candidates.filter(candidate => Number(candidate?.message_index) !== currentMessageIndex)
    : [];
  next.file_candidates = currentFiles.length ? [...historicalFiles, ...currentFiles] : historicalFiles;
  next.recent_messages = messages;
  return next;
}

function compactRouteUserPayload({ input = '', attachments = [], context = {}, currentMode = 'chat', autoMode = true } = {}) {
  const currentInput = String(input || '');
  assertInputWithinUnifiedLimit(currentInput);
  const routeContext = compactRoutePayloadContext(context, currentInput, attachments);
  const payload = { current_input: currentInput };
  const normalizedMode = ['chat', 'image', 'edit_image'].includes(currentMode) ? currentMode : 'chat';
  if (autoMode === false) {
    payload.current_mode = normalizedMode;
    payload.auto_mode = false;
  }
  if (Array.isArray(attachments) && attachments.length) payload.attachments = attachments;
  const compactContext = Object.fromEntries(Object.entries(routeContext || {}).filter(([, value]) => {
    if (Array.isArray(value)) return value.length > 0;
    if (!value) return false;
    if (typeof value === 'object') return Object.keys(value).length > 0;
    return true;
  }));
  if (Object.keys(compactContext).length) payload.context = compactContext;
  return payload;
}

function buildRoutePayload({ model, input, attachments = [], context = {}, currentMode = 'chat', autoMode = true, systemPrompt = ROUTE_SYSTEM_PROMPT_WITH_OUTPUT_CHECK_V5, responseFormat = ROUTE_RESPONSE_FORMAT } = {}) {
  const userPayload = compactRouteUserPayload({ input, attachments, context, currentMode, autoMode });
  return {
    model,
    temperature: 0,
    ...(responseFormat ? { response_format: responseFormat } : {}),
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: JSON.stringify(userPayload) },
    ],
  };
}

function buildIntentReviewPayload({ model, input, attachments = [], context = {}, firstRoute = null, systemPrompt = INTENT_REVIEW_SYSTEM_PROMPT_V5, responseFormat = ROUTE_RESPONSE_FORMAT } = {}) {
  const payload = compactRouteUserPayload({ input, attachments, context, currentMode: 'chat', autoMode: true });
  if (firstRoute?.taskContract) payload.first_task_contract = firstRoute.taskContract;
  return {
    model,
    temperature: 0,
    ...(responseFormat ? { response_format: responseFormat } : {}),
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: JSON.stringify(payload) },
    ],
  };
}

function buildIntentRepairPayload({ model, input, attachments = [], context = {}, previousOutput = '', validationReason = 'contract_shape', expectedReadiness = '', responseFormat = ROUTE_RESPONSE_FORMAT } = {}) {
  const payload = compactRouteUserPayload({ input, attachments, context, currentMode: 'chat', autoMode: true });
  const repairInvariants = repairInvariantSnapshot(previousOutput);
  if (!repairInvariants) throw new TypeError('A complete task_contract.v5 semantic invariant is required for repair');
  payload.previous_route_output = String(previousOutput || '');
  payload.contract_validation_error = String(validationReason || 'contract_shape');
  payload.required_readiness = expectedReadiness || readRouteReadiness(previousOutput) || '';
  payload.repair_invariants = repairInvariants;
  return {
    model,
    temperature: 0,
    ...(responseFormat ? { response_format: responseFormat } : {}),
    messages: [
      { role: 'system', content: `${INTENT_REPAIR_SYSTEM_PROMPT_V5}\n\n${ROUTE_SYSTEM_PROMPT_WITH_OUTPUT_CHECK_V5}` },
      { role: 'user', content: JSON.stringify(payload) },
    ],
  };
}

function extractRouteText(response = {}) {
  return response && response.choices && response.choices[0] && response.choices[0].message && response.choices[0].message.content || response && response.output_text || '';
}

const api = Object.freeze({
  ROUTE_SYSTEM_PROMPT: ROUTE_SYSTEM_PROMPT_V5,
  ROUTE_OUTPUT_CONTRACT_CHECK: ROUTE_OUTPUT_CONTRACT_CHECK_V5,
  INTENT_REVIEW_SYSTEM_PROMPT: INTENT_REVIEW_SYSTEM_PROMPT_V5,
  INTENT_REPAIR_SYSTEM_PROMPT: INTENT_REPAIR_SYSTEM_PROMPT_V5,
  ROUTE_RESPONSE_FORMAT,
  cleanQuotedContent,
  buildQuotedImagePlaceholders,
  buildQuotedRouteContent,
  composeTextToImagePrompt,
  stripJsonFence,
  repairInvariantSnapshot,
  repairPreservesInvariants,
  routeReadiness,
  readRouteReadiness,
  mergeRouteReadinessRequirement,
  routePlanReadiness,
  routeSatisfiesReadiness,
  isRouteDispatchable,
  decodeTaskContract,
  needsIntentReview,
  isTaskContractResult,
  isClarificationCandidate,
  terminalClarificationRouteFromResult,
  inspectRouteResult,
  parseRouteResult,
  createExplicitTextToImageRoute,
  buildFileCandidatesFromAttachments,
  compactRoutePayloadContext,
  compactRouteUserPayload,
  buildRoutePayload,
  buildIntentReviewPayload,
  buildIntentRepairPayload,
  extractRouteText,
});

if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (root) root.ChatUIRouteService = api;
if (root?.window) root.window.ChatUIRouteService = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
