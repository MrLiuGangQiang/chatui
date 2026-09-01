(function initChatUIRouteService(root) {
  'use strict';

  // ── New shared modules ──────────────────────────────────────────
  const dispatchContractModule = root?.[Symbol.for('chatui.module-registry.v1')]?.get('dispatchContract')
    || root?.ChatUIDispatchContract
    || (typeof require === 'function' ? require('../../shared/dispatch-contract') : {});
  const capabilityRegistry = root?.[Symbol.for('chatui.module-registry.v1')]?.get('capabilityRegistry')
    || root?.ChatUICapabilityRegistry
    || (typeof require === 'function' ? require('../../shared/capability-registry') : {});
  const routeIntentModule = root?.[Symbol.for('chatui.module-registry.v1')]?.get('routeIntent')
    || root?.ChatUIRouteIntent
    || (typeof require === 'function' ? require('../../shared/route-intent') : {});
  const routeRepairModule = root?.[Symbol.for('chatui.module-registry.v1')]?.get('routeRepair')
    || (typeof require === 'function' ? require('../../shared/route-repair') : {});
  const routePromptsModule = root?.[Symbol.for('chatui.module-registry.v1')]?.get('routePrompts')
    || (typeof require === 'function' ? require('./route-prompts') : {});
  const routeSemanticNormalizerModule = root?.[Symbol.for('chatui.module-registry.v1')]?.get('routeSemanticNormalizer')
    || (typeof require === 'function' ? require('./route-semantic-normalizer') : {});
  const routeMemoryRetrievalModule = root?.[Symbol.for('chatui.module-registry.v1')]?.get('routeMemoryRetrieval')
    || (typeof require === 'function' ? require('./route-memory-retrieval') : {});
  const routeCandidatesModule = root?.[Symbol.for('chatui.module-registry.v1')]?.get('routeCandidates')
    || (typeof require === 'function' ? require('./route-candidates') : {});
  const routeResourceBindingModule = root?.[Symbol.for('chatui.module-registry.v1')]?.get('routeResourceBinding')
    || (typeof require === 'function' ? require('./route-resource-binding') : {});
  const routeImagePlanCompilerModule = root?.[Symbol.for('chatui.module-registry.v1')]?.get('routeImagePlanCompiler')
    || (typeof require === 'function' ? require('./route-image-plan-compiler') : {});
  const imagePlanModule = root?.[Symbol.for('chatui.module-registry.v1')]?.get('imagePlan')
    || root?.ChatUIImagePlan
    || (typeof require === 'function' ? require('../../shared/image-plan') : {});
  const multiTaskPlanModule = root?.[Symbol.for('chatui.module-registry.v1')]?.get('multiTaskPlan')
    || (typeof require === 'function' ? require('../../shared/multi-task-plan') : {});
  const intentUnderstandingModule = root?.[Symbol.for('chatui.module-registry.v1')]?.get('intentUnderstanding')
    || (typeof require === 'function' ? require('../../shared/intent-understanding') : {});
  const intentClaimsModule = root?.[Symbol.for('chatui.module-registry.v1')]?.get('intentClaims')
    || (typeof require === 'function' ? require('../../shared/intent-claims') : {});
  const semanticIntentModule = root?.[Symbol.for('chatui.module-registry.v1')]?.get('semanticIntent')
    || (typeof require === 'function' ? require('../../shared/semantic-intent') : {});
  const intentCriticModule = root?.[Symbol.for('chatui.module-registry.v1')]?.get('intentCritic')
    || (typeof require === 'function' ? require('../../shared/intent-critic') : {});
  const imageInstructionModule = root?.[Symbol.for('chatui.module-registry.v1')]?.get('imageInstruction')
    || root?.ChatUIImageInstruction
    || (typeof require === 'function' ? require('../../shared/image-instruction') : {});
  const taskContinuityModule = root?.[Symbol.for('chatui.module-registry.v1')]?.get('taskContinuity')
      || (typeof require === 'function' ? require('../../shared/task-continuity') : {});
  const responsesOutputModule = root?.[Symbol.for('chatui.module-registry.v1')]?.get('responsesOutput')
    || (typeof require === 'function' ? require('../../shared/responses-output') : {});
  const taskConstantsModule = root?.[Symbol.for('chatui.module-registry.v1')]?.get('taskConstants')
    || root?.ChatUITaskConstants
    || (typeof require === 'function' ? require('../../shared/task-constants') : {});
  const resourceIdentityModule = root?.[Symbol.for('chatui.module-registry.v1')]?.get('resourceIdentity')
    || root?.ChatUICore?.resourceIdentity
    || (typeof require === 'function' ? require('../core/resource-identity') : {});
  const preflightGuards = root?.ChatUICorePreflightGuards
    || root?.window?.ChatUICorePreflightGuards
    || (typeof require === 'function' ? require('../core/preflight-guards') : {});
  const chatService = root?.ChatUIChatService
    || root?.ChatUIServices?.chat
    || (typeof require === 'function' ? require('./chat-service') : {});

  const attachmentsModule = root?.ChatUICoreAttachments
    || root?.ChatUICore?.attachments
    || (typeof require === 'function' ? require('../core/attachments') : {});

  const {
    hasExactDispatchContract,
    compileDispatchContract,
    withArguments,
    bindingEvidenceFromMedia,
    assertBindingEvidence,
  } = dispatchContractModule;
  const {
    capabilityFor,
    resourceRequirementsFor,
    assertExecutionBindings,
    parseImageParameterCandidates,
    resolveExecutionArguments,
    clarificationQuestion,
    choicesForArgument,
    explicitRouteDirectiveFor,
    ordinalResourceScopeFor,
    equivalentAlternativesFor,
    assertChangesFamilyCompatible,
  } = capabilityRegistry;
  const {
    MAX_CLARIFICATION_ROUNDS = 3,
    MAX_MODEL_CALLS = 6,
  } = taskConstantsModule;
  const {
    ROUTE_INTENT_VERSION = 'route_intent.v3',
    ROUTE_INTENT_RESPONSE_FORMAT,
    ROUTE_INTENT_MAX_RESOURCE_REFS = 16,
    ROUTE_INTENT_MAX_GOAL_LENGTH = 1000,
    routeIntentResponseFormatForCandidates,
    hasExactRouteIntent,
    hasExactLegacyRouteIntentV2,
    adaptLegacyRouteIntentV2,
    routeIntentTaskShape,
    routeIntentGoalMode,
    resourceTypeForCandidateKey,
  } = routeIntentModule;
  const {
    ROUTE_REPAIR_VERSION = 'route_repair.v1',
    ROUTE_REPAIR_RESPONSE_FORMAT,
    routeRepairResponseFormatForCandidates,
    hasExactRouteRepair,
    normalizeRouteRepair,
    adaptLegacyRouteIntentRepair,
    applyRouteRepair,
  } = routeRepairModule;
  const {
    IMAGE_PLAN_VERSION = 'image_plan.v1',
    IMAGE_PLAN_MAX_TASKS = 5,
    IMAGE_PLAN_ABSOLUTE_MAX_TASKS = 50,
    IMAGE_PLAN_RESPONSE_FORMAT,
    hasExactImagePlan,
    assertImagePlan,
  } = imagePlanModule;
  const {
    MULTI_TASK_PLAN_VERSION = 'multi_task_plan.v1',
    MULTI_TASK_PLAN_MAX_TASKS = 8,
    MULTI_TASK_PLAN_RESPONSE_FORMAT,
    hasExactMultiTaskPlan,
    assertMultiTaskPlan,
  } = multiTaskPlanModule;
  const {
    UNDERSTANDING_VERSION = 'intent_understanding.v1',
    UNDERSTANDING_RESPONSE_FORMAT,
    ACTION_KINDS,
    hasExactUnderstanding,
    assertUnderstanding,
    compileUnderstandingShape,
    explicitImageResultCount,
    maxExplicitImageResultCount,
    expectedPlanTasks,
    planCoversExpected,
    operationForKind,
    requiredResourceRoles,
  } = intentUnderstandingModule;
  const {
    SEMANTIC_INTENT_VERSION = 'semantic_intent.v1',
    buildSemanticIntent,
    hasExactSemanticIntent,
  } = semanticIntentModule;
  const {
    INTENT_CRITIC_VERSION = 'intent_critic.v1',
    INTENT_CRITIC_RESPONSE_FORMAT,
    hasExactIntentCritic,
    normalizeIntentCritic,
    localCritic,
  } = intentCriticModule;

  const {
    IMAGE_INSTRUCTION_VERSION = 'image_instruction.v1',
    IMAGE_INSTRUCTION_RESPONSE_FORMAT,
    hasExactImageInstruction,
    hasUnresolvedImageInstructionReference,
  } = imageInstructionModule;
  const {
    TASK_CONTINUITY_VERSION = 'task_continuity.v1',
    hasExactTaskContinuity,
    normalizeOptionalTaskContinuity,
    taskContinuityFromExecution,
    transitionTaskContinuity,
    renderTaskContinuity,
  } = taskContinuityModule;
  const { responseOutputText } = responsesOutputModule;
  if (typeof routePromptsModule?.createRoutePromptSet !== 'function') {
    throw new TypeError('Route prompt module is unavailable');
  }
  const {
    ROUTE_EVIDENCE_PRIORITY,
    ROUTE_SYSTEM_PROMPT,
    UNDERSTAND_SYSTEM_PROMPT_LINES,
    ROUTE_NODE_SYSTEM_PROMPT_LINES,
    ROUTE_NODE_SYSTEM_PROMPT_COMPACT_LINES,
    ROUTE_NODE_SYSTEM_PROMPT_SIMPLE_LINES,
    IMAGE_PLAN_SYSTEM_PROMPT,
    MULTI_TASK_PLAN_SYSTEM_PROMPT,
    IMAGE_INSTRUCTION_SYSTEM_PROMPT,
    ROUTE_REPAIR_SYSTEM_PROMPT,
    INTENT_CRITIC_SYSTEM_PROMPT,
  } = routePromptsModule.createRoutePromptSet({
    imagePlanAbsoluteMaxTasks: IMAGE_PLAN_ABSOLUTE_MAX_TASKS,
  });

  // ── Schema versions ─────────────────────────────────────────────
  const { buildResponsesPayload } = chatService;

  function intentReasoningPayloadOptions(intentReasoning = null) {
    const value = intentReasoning && typeof intentReasoning === 'object' && !Array.isArray(intentReasoning)
      ? intentReasoning
      : {};
    if (value.enabled !== true) return { noReasoning: true };
    const allowed = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
    const effort = allowed.has(String(value.effort || '').trim().toLowerCase())
      ? String(value.effort).trim().toLowerCase()
      : 'medium';
    return { reasoning: { effort, summary: 'auto' } };
  }

  const DISPATCH_CONTRACT_VERSION = 'dispatch_contract.v1';
  const EXECUTION_RESOURCE_PROJECTION_VERSION = 'execution_resources.v2';
  const VALID_RESOURCE_SOURCES = new Set(['current', 'quoted', 'history', 'context']);
  const VALID_RELATIONS = new Set(['new', 'followup', 'continuation']);
  const IMAGE_RELATION_OPERATIONS = new Set(['text_to_image', 'image_reference_gen', 'edit_image']);
  // Every image execution persists a structured text task state. Only plain
  // generation and editing can amend an earlier text state; reference generation
  // starts a replacement text state because its selected image is the baseline.
  const IMAGE_TASK_STATE_OPERATIONS = new Set(['text_to_image', 'image_reference_gen', 'edit_image']);
  const IMAGE_TASK_AMEND_OPERATIONS = new Set(['text_to_image', 'edit_image']);
  const READ_ONLY_RESOURCE_OPERATIONS = new Set(['file_qa', 'multimodal_qa', 'image_qa', 'image_compare', 'ocr']);
  const ELLIPTICAL_ORDINAL_REMAINDER_PATTERN = /^(?:(?:\u90a3|\u90a3\u4e48|\u8fd8\u6709|\u518d\u770b|\u518d\u8bf4|and|what\s+about)\s*)?(?:\u5462|\u600e\u4e48\u6837|\u5982\u4f55|\u53c8\u5982\u4f55|what\s+about)?[\s,.!?\u3002\uff0c\uff01\uff1f\u3001;\uff1b:\uff1a]*$/i;
  const EXPLICIT_RELATION_CORRECTION_PATTERN = /(?:\u4e0d\u5bf9|\u4e0d\u6ee1\u610f|\u9519\u4e86|\u9009\u9519|\u6539\u7528|\u6362\u7528|\u7ea0\u6b63|\u4fee\u6b63|\bwrong\b|\bnot right\b|\binstead\b)/i;
  // A rejection such as “不是这个图” explicitly invalidates the previously
  // assumed image target. It is an ambiguity signal, not an editing detail:
  // the user must choose the replacement target from recoverable images.
  const REJECTED_IMAGE_TARGET_PATTERN = /(?:\u4e0d\u662f(?:\u8fd9\u4e2a|\u8fd9\u5f20|\u90a3\u4e2a|\u90a3\u5f20)?(?:\u56fe|\u56fe\u7247|\u56fe\u50cf|\u7167\u7247)?|\u4e0d\u8981(?:\u8fd9\u4e2a|\u8fd9\u5f20|\u90a3\u4e2a|\u90a3\u5f20)?(?:\u56fe|\u56fe\u7247|\u56fe\u50cf|\u7167\u7247)?|\u4e0d\u7528(?:\u8fd9\u4e2a|\u8fd9\u5f20|\u90a3\u4e2a|\u90a3\u5f20)?(?:\u56fe|\u56fe\u7247|\u56fe\u50cf|\u7167\u7247)?|\u9009\u9519|\u6362\u4e00\u5f20(?:\u56fe|\u56fe\u7247|\u56fe\u50cf|\u7167\u7247)?|\u53e6\u4e00\u5f20(?:\u56fe|\u56fe\u7247|\u56fe\u50cf|\u7167\u7247)?)/i;
  const IMAGE_TARGET_CLARIFICATION_PATTERN = /(?:\u76ee\u6807(?:\u56fe\u7247|\u56fe\u50cf|\u56fe)|(?:\u7f16\u8f91|\u4fee\u6539|\u5904\u7406).{0,12}(?:\u54ea\u5f20|\u54ea\u4e00\u5f20)(?:\u56fe\u7247|\u56fe\u50cf|\u56fe)?|(?:\u54ea\u5f20|\u54ea\u4e00\u5f20)(?:\u56fe\u7247|\u56fe\u50cf|\u56fe).{0,12}(?:\u7f16\u8f91|\u4fee\u6539|\u5904\u7406))/i;
  const EXPLICIT_TASK_ADVICE_ACCEPTANCE_PATTERN = /(?:\u6309(?:\u7167)?(?:\u4f60(?:\u521a\u624d|\u4e0a\u4e00\u8f6e)?\u7684)?\u5efa\u8bae|\u7167\u4f60\u8bf4\u7684|\u6839\u636e(?:\u4f60(?:\u521a\u624d|\u4e0a\u4e00\u8f6e)?\u7684)?\u5efa\u8bae)/i;
  const EXPLICIT_PRIOR_SPEC_ACCEPTANCE_PATTERN = /(?:沿用|保留|继续使用)[^。！？!\r\n]{0,40}(?:上一版|上次|之前)[^。！？!\r\n]{0,32}(?:完整|文字|户型)?(?:要求|规范|方案)/i;
  const CURRENT_RESOURCE_REPLACEMENT_PATTERN = /(?:选错|改用|换用|重新上传|重新选择|换成这张|使用这张原图|use this image|wrong image)/i;
  const READ_ONLY_FILE_ACTION_PATTERN = /(?:\u603b\u7ed3|\u6982\u62ec|\u6458\u8981|\u63d0\u70bc|\u5206\u6790|\u8bfb\u53d6|\u67e5\u770b|\u68c0\u67e5|\u63d0\u53d6|\bsummari[sz]e\b|\banaly[sz]e\b|\bread\b|\bextract\b|\binspect\b)/i;
  const RESOURCE_CATALOG_METADATA = Symbol('chatui.resource-catalog-metadata');

  const EMPTY_IMAGE_ANALYSIS_GOAL = '请分析所有已上传图片，分别说明每张图片的主要内容。';
  const EMPTY_FILE_ANALYSIS_GOAL = '请阅读并概括所有已上传文件的主要内容。';
  const EMPTY_MULTIMODAL_ANALYSIS_GOAL = '请结合分析所有已上传图片和文件，说明各自内容及其关联。';
  // The model proposes a relation, but the execution boundary owns strong
  // discourse facts that can be derived deterministically from the current
  // input plus an available image lineage. Keep these cues narrow: generic
  // words such as "再" must not turn an independent generation into a
  // continuation, and non-visual follow-ups such as file QA remain followups.
  const CONTINUATION_RELATION_PATTERN = /(?:\u7ee7\u7eed|\u63a5\u7740|\u5ef6\u7eed|\u6cbf\u7528|\bcontinue(?:d|s|ing)?\b)/i;
  // Short ordinal/deictic replies are structurally incomplete without prior
  // conversation. The router may still classify their operation, but the local
  // trust boundary owns the fact that they are conversational follow-ups.
  const TEXTUAL_DISCOURSE_FOLLOWUP_PATTERN = /^(?:(?:第\s*(?:[1-9]\d*|[一二两三四五六七八九十百]+)\s*(?:条|项|个|点|句|段|种|部分|选项|答案|方案|消息|回复|回答))|(?:前者|后者|这个|那个|这条|那条|上一个|下一个|前一个|后一个|上一条|下一条|刚才那个|上面那个|都要|都可以|为什么|什么意思|详细一点|详细点|展开说说|继续说|然后呢|还有呢|哪一个|哪个好))(?:呢|吧)?[。！？!?]*$|(?:上面|上述|前面|刚才|之前|上一条|这条|那条|前者|后者).{0,18}(?:消息|回复|回答|内容|文本|选项|答案|方案|意思|多少|几个|哪个|为什么|怎么)/i;
  // A short request such as “性能方面呢” supplies only a dimension of the
  // immediately preceding topic. It is not a standalone task description.
  const SHORT_ASPECT_FOLLOWUP_PATTERN = /^(?:[\u4e00-\u9fffA-Za-z0-9+/#-]{0,16})(?:性能|优缺点|价格|安全性|稳定性|兼容性|速度|内存|耗电|质量|效果|方面)(?:呢|怎么样|怎样|如何)?[。！？!?]*$/i;
  // An ordinal after a visual-review continuation (for example, \"再识别一下第八张\")
  // can name an item *inside* the already-bound image. It is not necessarily a
  // selector for the eighth image in the session-wide resource catalog.
  const VISUAL_REVIEW_CONTINUATION_PATTERN = /(?:\u518d|\u91cd\u65b0|\u7ee7\u7eed|\u63a5\u7740|\u518d\u6b21).{0,8}(?:\u8bc6\u522b|\u67e5\u770b|\u770b|\u5206\u6790|\u8bfb\u53d6|\u63d0\u53d6|\u5224\u65ad|\u786e\u8ba4|ocr)/i;
  const EXPLICIT_IMAGE_RESOURCE_ORDINAL_PATTERN = /(?:\u5386\u53f2|\u4e4b\u524d|\u4e0a\u6b21|\u521a\u624d|\u524d\u9762|previous|last|history)\s*.*?(?:\u7b2c\s*(?:[1-9]\d*|[\u4e00\u4e8c\u4e24\u4e09\u56db\u4e94\u516d\u4e03\u516b\u4e5d\u5341]+)|(?:image|photo|\u56fe\u7247|\u56fe\u50cf|\u7167\u7247)\s*\d+)/i;
  // An explicit historical-image phrase establishes the resource scope even
  // when the intent model abstains and returns no resource_refs. Without this
  // boundary normalization, relation=new excludes history candidates and the
  // user sees the misleading "no available image" fallback instead of an
  // image-choice clarification.
  const HISTORICAL_IMAGE_REFERENCE_PATTERN = /(?:\u5386\u53f2|\u4e4b\u524d|\u6b64\u524d|\u4ee5\u524d|\u524d\u9762|\u4e0a\u6b21|\u521a\u624d|\u8fc7\u53bb|previous|last|history)[^\u3002\uff01\uff1f!?\n]{0,24}(?:\u56fe\u7247|\u56fe\u50cf|\u7167\u7247|\u56fe|image|photo)/i;
  const IMAGE_GENERATION_INTENT_PATTERN = /(?:\u751f\u6210|\u753b|\u7ed8\u5236|\u5236\u4f5c|\u521b\u5efa|\bgenerate\b|\bdraw\b|\bcreate\b)/i;
  // A request that explicitly names a historical text prompt/description has a
  // semantic source dependency. It is never safe to treat the current turn as
  // the complete generation prompt merely because the route model omitted a
  // matching mN/context resource reference.
  const HISTORICAL_TEXT_PROMPT_REFERENCE_PATTERN = /(?:(?:\u5386\u53f2|\u4e4b\u524d|\u6b64\u524d|\u4ee5\u524d|\u524d\u9762|\u4e0a\u9762|\u4e0a\u8ff0|\u5148\u524d|\u8fc7\u5f80|\u4e0a\u6b21|\u521a\u624d).{0,18}(?:\u63d0\u793a\u8bcd|prompt|\u753b\u9762\u63cf\u8ff0|\u63cf\u8ff0|\u6587\u6848|\u6587\u672c|\u6307\u4ee4))|(?:(?:\u63d0\u793a\u8bcd|prompt|\u753b\u9762\u63cf\u8ff0|\u63cf\u8ff0|\u6587\u6848|\u6587\u672c|\u6307\u4ee4).{0,18}(?:\u5386\u53f2|\u4e4b\u524d|\u6b64\u524d|\u4ee5\u524d|\u524d\u9762|\u4e0a\u9762|\u4e0a\u8ff0|\u5148\u524d|\u8fc7\u5f80|\u4e0a\u6b21|\u521a\u624d))/i;
  // A framing request such as “the woman needs a full-body view” is a visual edit when it names one recoverable historical subject.
  const VISUAL_REFRAME_REQUEST_PATTERN = /(?:\u5168\u8eab(?:\u56fe|\u7167|\u50cf)?|\u534a\u8eab(?:\u56fe|\u7167|\u50cf)?|\u8fd1\u666f|\u8fdc\u666f|\u5168\u666f|\u7279\u5199|\u8096\u50cf|\u6b63\u9762|\u4fa7\u9762|\u80cc\u9762|\u7ad9\u59ff|\u5750\u59ff|\u6784\u56fe|\u955c\u5934|\u89c6\u89d2|\u6bd4\u4f8b|\bfull[ -]?body\b|\bhalf[ -]?body\b|\bclose[ -]?up\b|\bportrait\b)/i;
  const CANONICAL_BINDING_ROLES = Object.freeze([
    'target', 'reference', 'style_reference', 'mask',
    'source', 'attachment', 'context', 'compare_a', 'compare_b',
  ]);
  // Prompt definitions are composed by client/services/route-prompts.js.

  // ── Helpers ──────────────────────────────────────────────────────
  function stringValue(v) { return String(v ?? '').trim(); }

  function stripJsonFence(text) {
    return String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  }

  function assertInputWithinUnifiedLimit(input) {
    if (typeof preflightGuards.assertMessageSize !== 'function') {
      const error = new Error('Message size policy is unavailable');
      error.code = 'MESSAGE_SIZE_POLICY_UNAVAILABLE';
      throw error;
    }
    preflightGuards.assertMessageSize(input);
  }

  if (typeof routeMemoryRetrievalModule?.createRouteMemoryRetriever !== 'function') {
    throw new TypeError('Route memory retrieval module is unavailable');
  }
  const IMAGE_MEMORY_RETRIEVAL_POLICY = routeMemoryRetrievalModule.IMAGE_MEMORY_RETRIEVAL_POLICY;
  const { selectImageMemoryCards } = routeMemoryRetrievalModule.createRouteMemoryRetriever({
    policy: IMAGE_MEMORY_RETRIEVAL_POLICY,
    sharedCandidateTokens,
  });
  if (typeof routeCandidatesModule?.createCanonicalCandidateDirectory !== 'function') {
    throw new TypeError('Canonical route candidate module is unavailable');
  }
  const {
    identityValue,
    uniqueStrings,
    uniqueIndexes,
    normalizedSource,
    resourceTypeFor,
    canonicalResourceId,
    candidateIndex,
    buildResourceCandidates,
  } = routeCandidatesModule.createCanonicalCandidateDirectory({
    resourceIdentityModule,
    attachmentsModule,
    validResourceSources: VALID_RESOURCE_SOURCES,
    selectImageMemoryCards,
    resourceCatalogMetadata: RESOURCE_CATALOG_METADATA,
  });
  if (typeof routeResourceBindingModule?.createRouteResourceBinding !== 'function') {
    throw new TypeError('Route resource binding module is unavailable');
  }
  const {
    normalizeBindingResourceId,
    canonicalBindingRole,
    canonicalPlanBindings,
    planBindingsWithinDirectiveScope,
    candidateChoice,
    unresolvedResourceIssue,
    normalizeResourceClarificationIssues,
    bindingForCandidate,
    resolvePlanResources,
  } = routeResourceBindingModule.createRouteResourceBinding({
    resourceIdentityModule,
    normalizedSource,
    uniqueStrings,
    uniqueIndexes,
    routeCompilationCandidateCatalog,
  });
  if (typeof routeImagePlanCompilerModule?.createRouteImagePlanCompiler !== 'function') {
    throw new TypeError('Route image-plan compiler module is unavailable');
  }
  const {
    shouldRequestImagePlan,
    compileImagePlan,
  } = routeImagePlanCompilerModule.createRouteImagePlanCompiler({
    imagePlanVersion: IMAGE_PLAN_VERSION,
    imagePlanMaxTasks: IMAGE_PLAN_MAX_TASKS,
    assertImagePlan,
    imageOperations: IMAGE_RELATION_OPERATIONS,
    validRelations: VALID_RELATIONS,
    resourceTypeForCandidateKey,
    bindingForCandidate,
    routeCompilationCandidateCatalog,
    isMetaInstructionGoal,
    hasUnresolvedImageInstructionReference,
    compileLocalRoute,
  });
  // The route model is allowed to select only resources from this catalog. The
  // canonical resource ID is identity; source and indexes are provenance and
  // presentation locators used only to recover the selected object later.
  const buildRouteResourceCandidates = ({ attachments = [], context = {}, input = '', currentTurn = null } = {}) => (
    buildResourceCandidates(attachments, contextBeforeCurrentTurn(context, currentTurn), input)
  );

  function buildRouteContext(context = {}) {
    const result = {};
    for (const key of [
      'recent_messages',
      'quoted_message',
      'pending_task',
      'latest_assistant_image_result',
      // resource_candidates is the canonical catalog used for bindings.
      // Do not send image/file candidate arrays a second time inside context;
      // they are large and duplicate the same IDs and labels.
      'last_generated_image',
      'latest_uploaded_image',
      'latest_image_reference',
      'recent_image_references',
      'recent_uploaded_image_references',
      'previous_execution',
      'delivery_evidence',
      'previous_resource_execution',
      'previous_visual_execution',
      'conversation_focus',
      'conversation_continuity',
      'clarification_context',
      'route_memory',
    ]) {
      if (context?.[key] !== undefined) result[key] = context[key];
    }
    return result;
  }

  // The model never needs durable resource identities. Candidate keys are
  // the complete model-facing resource selector; all longer identities stay
  // local for persistence, recovery, and dispatch-contract verification.
  const WIRE_CONTEXT_IDENTITY_FIELDS = new Set([
    'id', 'image_id', 'imageId', 'file_id', 'fileId', 'message_id', 'messageId',
    'attachment_id', 'attachmentId', 'resource_id', 'resourceId',
    'reference_id', 'referenceId', 'result_reference_id', 'resultReferenceId',
    'selected_reference_id', 'selectedReferenceId', 'display_item_id', 'displayItemId',
    'route_resource_id', 'routeResourceId', 'identity_aliases', 'identityAliases',
    'route_id_aliases', 'routeIdAliases',
  ]);

  function compactWireContextIdentities(value) {
    if (Array.isArray(value)) return value.map(compactWireContextIdentities);
    if (!value || typeof value !== 'object') return value;
    const next = {};
    for (const [key, child] of Object.entries(value)) {
      if (WIRE_CONTEXT_IDENTITY_FIELDS.has(key)) continue;
      next[key] = compactWireContextIdentities(child);
    }
    return next;
  }

  function compactWireOptional(value) {
    if (Array.isArray(value)) {
      const next = value.map(compactWireOptional).filter(item => item !== undefined);
      return next.length ? next : undefined;
    }
    if (!value || typeof value !== 'object') {
      return value === '' || value === null || value === undefined ? undefined : value;
    }
    const next = {};
    for (const [key, child] of Object.entries(value)) {
      const compacted = compactWireOptional(child);
      if (compacted !== undefined) next[key] = compacted;
    }
    return Object.keys(next).length ? next : undefined;
  }

  // Candidate publication is deliberately semantic-free. The route model must
  // receive the complete bounded evidence set and decide whether a turn refers
  // to text, images, files, prior execution, or none of them. Canonical resource
  // identities remain local and only short candidate keys cross the boundary.

  function contextBeforeCurrentTurn(context = {}, currentTurn = null) {
    const currentIndex = Number(currentTurn?.messageIndex);
    if (!Number.isInteger(currentIndex) || currentIndex < 1 || !Array.isArray(context?.recent_messages)) return context;
    return {
      ...context,
      recent_messages: context.recent_messages.filter(message => {
        const index = Number(message?.index);
        return !Number.isInteger(index) || index < currentIndex;
      }),
    };
  }

  function compactWirePreviousExecution(previous = {}) {
    if (!previous || typeof previous !== 'object') return undefined;
    const family = stringValue(previous.family);
    const taskState = typeof taskContinuityFromExecution === 'function'
      ? taskContinuityFromExecution(previous)
      : null;
    const resolvedGoal = taskState && typeof renderTaskContinuity === 'function'
      ? renderTaskContinuity(taskState)
      : stringValue(previous.resolved_goal || previous.resolvedGoal || previous.input);
    const input = family === 'edit' ? stringValue(previous.input) : '';
    return compactWireOptional({
      operation: previous.operation || '',
      family,
      result_kind: previous.result_kind || '',
      source_message_index: Number(previous.source_message_index) || 0,
      source_user_message_index: Number(previous.source_user_message_index) || 0,
      input,
      ...(taskState ? { task_state: taskState } : { resolved_goal: resolvedGoal }),
    });
  }

  function executionBindingIdentitySet(binding = {}, type = '') {
    const nativeId = type === 'image'
      ? binding?.image_id || binding?.imageId || binding?.id
      : binding?.file_id || binding?.fileId || binding?.id;
    return new Set(uniqueStrings([
      binding?.resource_id,
      binding?.resourceId,
      nativeId,
      binding?.reference_id,
      binding?.referenceId,
      ...(Array.isArray(binding?.identity_aliases) ? binding.identity_aliases : []),
      ...(Array.isArray(binding?.identityAliases) ? binding.identityAliases : []),
    ]));
  }

  function executionCandidateIdentitySet(candidate = {}) {
    return new Set(uniqueStrings([
      candidate?.resource_id,
      candidate?.id,
      candidate?.reference_id,
      ...(Array.isArray(candidate?.identity_aliases) ? candidate.identity_aliases : []),
    ]));
  }

  function candidateForExecutionBinding(binding = {}, type = '', resourceCatalog = []) {
    const bindingIdentities = executionBindingIdentitySet(binding, type);
    if (!bindingIdentities.size) return null;
    const matches = (Array.isArray(resourceCatalog) ? resourceCatalog : []).filter(candidate => {
      if (candidate?.type !== type) return false;
      return [...executionCandidateIdentitySet(candidate)].some(identity => bindingIdentities.has(identity));
    });
    return matches.length === 1 ? matches[0] : null;
  }

  function compactWirePreviousResourceExecution(previous = {}, resourceCatalog = []) {
    if (!previous || typeof previous !== 'object') return undefined;
    const images = Array.isArray(previous.images) ? previous.images : [];
    const files = Array.isArray(previous.files) ? previous.files : [];
    const imageCount = Number(previous.image_count) || images.length;
    const fileCount = Number(previous.file_count) || files.length;
    if (!images.length && !files.length) return undefined;
    if (imageCount !== images.length || fileCount !== files.length) return undefined;

    const bindings = [
      ...images.map(binding => ({ binding, type: 'image' })),
      ...files.map(binding => ({ binding, type: 'file' })),
    ];
    const usedKeys = new Set();
    const resourceRefs = [];
    for (const item of bindings) {
      const candidate = candidateForExecutionBinding(item.binding, item.type, resourceCatalog);
      const candidateKey = stringValue(candidate?.candidate_key);
      if (!candidateKey || usedKeys.has(candidateKey)) return undefined;
      usedKeys.add(candidateKey);
      resourceRefs.push({ candidate_key: candidateKey, type: item.type });
    }

    return compactWireOptional({
      operation: previous.operation || '',
      resource_refs: resourceRefs,
      source_message_index: Number(previous.source_message_index) || 0,
      response_message_index: Number(previous.response_message_index) || 0,
    });
  }

  function compactWireLabel(value = '', limit = 160) {
    return stringValue(value).slice(0, limit);
  }

  // Clarification state is durable application data. The router only needs the
  // unresolved semantic choices and already resolved facts; media identities,
  // question prose and duplicate pending-task data stay on the client.
  function compactWireClarificationSlot(slot = {}) {
    const choices = Array.isArray(slot?.choices) ? slot.choices.slice(0, 4).map(choice => ({
      key: compactWireLabel(choice?.key, 24),
      type: compactWireLabel(choice?.type, 24),
      role: compactWireLabel(choice?.role, 32),
      source: compactWireLabel(choice?.source, 24),
      index: Number(choice?.index) || 0,
      label: compactWireLabel(choice?.label || choice?.value, 120),
    })) : [];
    return compactWireOptional({
      key: compactWireLabel(slot?.key, 24),
      type: compactWireLabel(slot?.type, 24),
      role: compactWireLabel(slot?.role, 32),
      parameter_name: compactWireLabel(slot?.parameter_name || slot?.parameterName, 48),
      choices,
    });
  }

  function compactWireParameters(parameters = {}) {
    if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) return undefined;
    const next = {};
    for (const [key, value] of Object.entries(parameters).slice(0, 6)) {
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        next[compactWireLabel(key, 48)] = compactWireLabel(value, 160);
      }
    }
    return next;
  }

  function compactWireClarificationResources(resources = []) {
    return (Array.isArray(resources) ? resources : []).slice(0, 8).map(resource => ({
      resource_key: compactWireLabel(resource?.resource_key || resource?.key, 24),
      type: compactWireLabel(resource?.type, 24),
      role: compactWireLabel(resource?.role, 32),
      source: compactWireLabel(resource?.source, 24),
      index: Number(resource?.index) || 0,
      label: compactWireLabel(resource?.label, 120),
    }));
  }

  function compactWireClarificationContext(value = {}) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const unresolved = Array.isArray(value.unresolved_resources)
      ? value.unresolved_resources.slice(0, 4).map(compactWireClarificationSlot)
      : [];
    const plan = value.multi_task_plan && typeof value.multi_task_plan === 'object'
      ? Array.isArray(value.multi_task_plan.tasks) ? value.multi_task_plan.tasks : []
      : [];
    return compactWireOptional({
      base_task: compactWireLabel(value.base_task || value?.pending_task?.base_input, 480),

      operation: compactWireLabel(value.operation, 48),
      relation: compactWireLabel(value.relation, 32),
      unresolved_resources: unresolved,
      selected_choices: Array.isArray(value.selected_choices)
        ? value.selected_choices.slice(0, 6).map(item => compactWireLabel(item, 120))
        : [],
      free_text: compactWireLabel(value.free_text, 120),
      selected_parameters: compactWireParameters(value.selected_parameters),
      established_resources: compactWireClarificationResources(value.established_resources),
      selected_resources: compactWireClarificationResources(value.selected_resources),
      answer_complete: value.answer_complete === true,
      multi_task_plan: plan.length
        ? {
            schema_version: String(value.multi_task_plan.schema_version || 'multi_task_plan.v1'),
            tasks: plan.slice(0, 8).map((task, index) => ({
              index: index + 1,
              key: compactWireLabel(task.key, 16),
              operation: compactWireLabel(task.operation, 32),
              description: compactWireLabel(task.description, 120),
              goal: compactWireLabel(task.goal, 400),
              resource_refs: Array.isArray(task.resource_refs)
                ? task.resource_refs.slice(0, 8).map(ref => ({ candidate_key: compactWireLabel(ref.candidate_key, 16), role: compactWireLabel(ref.role, 32) }))
                : [],
            })),
          }
        : undefined,
    });
  }


  function clarificationResourceFacts(value = {}) {
    const clarification = value?.clarification_context && typeof value.clarification_context === 'object'
      ? value.clarification_context
      : value;
    return [
      ...(Array.isArray(clarification?.established_resources) ? clarification.established_resources : []),
      ...(Array.isArray(clarification?.selected_resources) ? clarification.selected_resources : []),
    ];
  }

  function compactWireRouteContext(context = {}, input = '', resourceCatalog = []) {
    // The context has already been bounded structurally by buildRouteContext and
    // trimRouteContextToSize. Do not run a second lexical intent classifier here:
    // every remaining fact is evidence for the intent model, never a local route
    // decision. Canonical identities and verbose execution text stay local.
    const bounded = buildRouteContext(context);
    const previousResourceExecution = compactWirePreviousResourceExecution(
      bounded.previous_resource_execution,
      resourceCatalog,
    );
    const raw = compactWireContextIdentities(bounded);
    const includeTextContext = Array.isArray(raw.recent_messages) && raw.recent_messages.length > 0;
    const next = {};
    const put = (key, value) => {
      const compacted = compactWireOptional(value);
      if (compacted !== undefined) next[key] = compacted;
    };

    if (includeTextContext) {
      put('recent_messages', raw.recent_messages.map(message => ({
        index: Number(message?.index) || 1,
        role: message?.role || '',
        content: String(message?.content || ''),
      })));
    }
    if (raw.quoted_message) {
      put('quoted_message', {
        index: Number(raw.quoted_message.index) || 1,
        role: raw.quoted_message.role || '',
        content: String(raw.quoted_message.content || ''),
      });
    }
    if (raw.route_memory) {
      put('route_memory', raw.route_memory.map(item => ({
        input: compactWireLabel(item?.input, 160),
        operation: stringValue(item?.operation),
        relation: stringValue(item?.relation),
        task_shape: stringValue(item?.task_shape),
        confidence: Number(item?.confidence) || 0,
        source: stringValue(item?.source),
      })));
    }
    if (raw.clarification_context) {
      put('clarification_context', compactWireClarificationContext(raw.clarification_context));
    } else if (raw.pending_task) {
      put('pending_task', {
        original_text: compactWireLabel(raw.pending_task.original_text || raw.pending_task.base_input, 320),
        operation: raw.pending_task.operation || '',
        relation: raw.pending_task.relation || '',
      });
    }

    if (raw.last_generated_image) {
      put('last_generated_image', {
        count: Number(raw.last_generated_image.count) || 0,
      });
    }
    // latest_uploaded_image / latest_image_reference are aggregate counts
    // the model can already observe through resource_candidates.
    if (raw.previous_execution) put('previous_execution', compactWirePreviousExecution(raw.previous_execution));
    if (raw.delivery_evidence) put('delivery_evidence', {
      schema_version: String(raw.delivery_evidence.schema_version || 'delivery_evidence.v1'),
      actual_image_result: raw.delivery_evidence.actual_image_result?.available === true
        ? {
            available: true,
            operation: String(raw.delivery_evidence.actual_image_result.operation || ''),
            family: String(raw.delivery_evidence.actual_image_result.family || ''),
          }
        : { available: false },
      assistant_image_claim: {
        present: raw.delivery_evidence.assistant_image_claim?.present === true,
        verified: raw.delivery_evidence.assistant_image_claim?.verified === true,
      },
      image_delivery_confirmed: raw.delivery_evidence.image_delivery_confirmed === true,
    });
    // Read-only image/file operations persist the exact resources that produced
    // the preceding answer. Project those durable identities onto the current
    // bounded catalog so the model can reuse application state without seeing IDs.
    if (previousResourceExecution) put('previous_resource_execution', previousResourceExecution);
    // A grouped priority view helps the intent model follow the
    // from-near-to-far anchors without parsing the whole catalog. It only
    // republishes facts already present; it never removes or reorders
    // resource_candidates and never makes a semantic decision.
    const currentAttachments = (Array.isArray(resourceCatalog) ? resourceCatalog : [])
      .filter(candidate => candidate?.source === 'current' && ['image', 'file'].includes(candidate?.type));
    if (currentAttachments.length) {
      put('current_attachments', currentAttachments.map(candidate => ({
        type: candidate.type,
        index: Number(candidate.index) || 1,
        label: compactWireLabel(candidate.label, 160),
      })));
    }

    if (raw.conversation_focus?.kind) {
      put('conversation_focus', {
        kind: raw.conversation_focus.kind,
      });
    }
    // conversation_continuity duplicates information the model can
    // already infer from recent_messages and conversation_focus.
    return next;
  }

  function wireResourceCandidates(attachments = [], context = {}, input = '') {
    // buildResourceCandidates receives only current/quoted resources, the
    // bounded image/file catalogs, bounded message history, and any separately
    // retrieved image-memory cards. Publish that catalog unchanged. Filtering it
    // again by keywords, focus, or inferred lineage would make local code a
    // second intent model and could hide the exact resource the model must bind.
    return buildResourceCandidates(attachments, context, input);
  }

  function routeCompilationCandidateCatalog(options = {}) {
    if (Array.isArray(options.candidateCatalog)) return options.candidateCatalog;
    return buildResourceCandidates(
      options.attachments,
      options.context,
      options.input || options.current_input || '',
    );
  }

  function modelRouteCandidateCatalog(options = {}) {
    const input = stringValue(options.input || options.current_input);
    const priorContext = contextBeforeCurrentTurn(options.context || {}, options.currentTurn);
    return wireResourceCandidates(options.attachments, priorContext, input);
  }

  function exactEllipticalOrdinalRelationConstraint(input = '', context = {}, resourceCatalog = []) {
    const previous = compactWirePreviousResourceExecution(context?.previous_resource_execution, resourceCatalog);
    const previousOperation = stringValue(previous?.operation);
    if (!previous || !READ_ONLY_RESOURCE_OPERATIONS.has(previousOperation)) return [];

    const selectors = typedIndexSelectors(input);
    if (selectors.length !== 1 || selectors[0].kind !== 'index') return [];
    const selector = selectors[0];
    const compatible = selector.type === 'image'
      ? ['image_qa', 'image_compare', 'ocr', 'multimodal_qa'].includes(previousOperation)
      : selector.type === 'file' && ['file_qa', 'multimodal_qa'].includes(previousOperation);
    if (!compatible) return [];

    const matches = resourceCatalog.filter(candidate => (
      candidate?.type === selector.type
      && (Number(candidate.index) === selector.index
        || (Array.isArray(candidate.index_aliases) && candidate.index_aliases.includes(selector.index)))
    ));
    if (matches.length !== 1) return [];

    const text = stringValue(input);
    const remainder = `${text.slice(0, selector.start)} ${text.slice(selector.end)}`.trim();
    if (!ELLIPTICAL_ORDINAL_REMAINDER_PATTERN.test(remainder)) return [];

    // A durable read-only execution anchor plus a syntactically bare ordinal
    // determines discourse continuation before generation. This narrows only
    // the relation domain; operation, resource role, and resolved goal remain
    // model-owned. Concrete actions leave non-particle text and are not narrowed.
    return ['continuation'];
  }

  function exactUnavailableReadOnlyContinuationConstraint(input = '', context = {}, resourceCatalog = []) {
    const text = stringValue(input);
    if (!text || context?.quoted_message || EXPLICIT_RELATION_CORRECTION_PATTERN.test(text)
        || !CONTINUATION_RELATION_PATTERN.test(text)) return [];
    const unavailable = resourceCatalog.filter(candidate => (
      candidate?.availability === 'unavailable'
      && ['history', 'context'].includes(candidate?.source)
    ));
    if (unavailable.length !== 1) return [];
    const [candidate] = unavailable;
    const readOnlyRequest = candidate.type === 'file'
      ? READ_ONLY_FILE_ACTION_PATTERN.test(text)
      : candidate.type === 'image' && READ_ONLY_VISUAL_REQUEST_PATTERN.test(text);
    return readOnlyRequest ? ['continuation'] : [];
  }

  function exactHistoricalFollowupRelationConstraint(input = '', context = {}, resourceCatalog = []) {
    const text = stringValue(input);
    if (!text || context?.quoted_message) return [];
    const candidates = Array.isArray(resourceCatalog) ? resourceCatalog : [];
    const hasAvailableNonCurrent = candidates.some(candidate => (
      candidate?.source !== 'current' && candidate?.availability !== 'unavailable'
    ));
    const explicitHistory = /(?:刚才|之前|上次|上一轮|上一版|上一个|上一张|这张|那张|历史|前面|previous|last|earlier|history)/i.test(text);
    const correction = EXPLICIT_RELATION_CORRECTION_PATTERN.test(text)
      || /(?:修改|改成|改为|换成|解释|说明|总结|分析|提取|查看|read|summari[sz]e|explain)/i.test(text);
    if (explicitHistory && correction
        && (hasAvailableNonCurrent || context?.previous_execution || context?.previous_resource_execution)) return ['followup'];
    return [];
  }

  function exactRouteRelationConstraint(input = '', context = {}, resourceCatalog = []) {
    const ordinal = exactEllipticalOrdinalRelationConstraint(input, context, resourceCatalog);
    if (ordinal.length) return ordinal;
    // An unavailable read-only anchor has a stronger continuation meaning: the
    // user is retrying the same resource task, not opening a new discourse turn.
    const unavailableContinuation = exactUnavailableReadOnlyContinuationConstraint(input, context, resourceCatalog);
    if (unavailableContinuation.length) return unavailableContinuation;
    const historicalFollowup = exactHistoricalFollowupRelationConstraint(input, context, resourceCatalog);
    if (historicalFollowup.length) return historicalFollowup;
    return [];
  }

  function exactGoalModeConstraint(input = '', context = {}) {
    const previous = context?.previous_execution;
    const taskState = typeof taskContinuityFromExecution === 'function'
      ? taskContinuityFromExecution(previous || {})
      : null;
    if (!taskState) return ['replace'];
    // Selecting a newly uploaded/reselected resource replaces the prior visual
    // base. It is a follow-up speech act, but it is not a textual amendment of
    // the old task state.
    if (CURRENT_RESOURCE_REPLACEMENT_PATTERN.test(stringValue(input))) return ['replace'];
    // Explicitly accepting the prior assistant's advice is a task amendment,
    // not a fresh replacement. Constrain only amend-capable image families;
    // reference generation must keep its replacement baseline semantics.
    if ((EXPLICIT_TASK_ADVICE_ACCEPTANCE_PATTERN.test(stringValue(input))
        || EXPLICIT_PRIOR_SPEC_ACCEPTANCE_PATTERN.test(stringValue(input)))
        && IMAGE_TASK_AMEND_OPERATIONS.has(stringValue(previous?.operation))) {
      return ['amend'];
    }
    return [];
  }

  function exactCurrentInputGoalConstraint(input = '', context = {}, resourceCatalog = []) {
    const goal = stringValue(input);
    if (!goal || goal.length > ROUTE_INTENT_MAX_GOAL_LENGTH) return [];
    const hasHistoricalState = !!(
      context?.quoted_message
      || context?.pending_task
      || context?.clarification_context
      || context?.previous_execution
      || context?.previous_resource_execution
      || (Array.isArray(context?.recent_messages) && context.recent_messages.length)
    );
    const hasNonCurrentResource = resourceCatalog.some(candidate => candidate?.source !== 'current');
    if (!hasHistoricalState && !hasNonCurrentResource) return [goal];

    const previous = context?.previous_execution;
    const previousResultReference = stringValue(previous?.result_reference_id);
    const exactPriorEditResult = previous?.operation === 'edit_image'
      && previous?.family === 'edit'
      && previous?.result_kind === 'image'
      && previousResultReference
      && resourceCatalog.some(candidate => (
        candidate?.type === 'image'
        && stringValue(candidate.reference_id) === previousResultReference
      ));
    if (exactPriorEditResult && isConcreteImageEditRequest(goal, resourceCatalog)) return [goal];
    return [];
  }

  // The wire catalog uses the shortest possible resource keys. bindings
  // returned by the route model reference these keys; resolvePlanResources
  // maps them back to the canonical catalog locally.
  function compactWireResourceCandidate(candidate = {}) {
    const next = {
      candidate_key: stringValue(candidate.candidate_key),
      type: candidate.type,
      source: candidate.source,
      label: compactWireLabel(candidate.label, 144),
      availability: candidate.availability === 'unavailable' ? 'unavailable' : 'available',
    };
    if (Number(candidate.message_index) > 0) next.message_index = Number(candidate.message_index);
    if (Number(candidate.chronological_index) > 0) next.chronological_index = Number(candidate.chronological_index);
    if (Number(candidate.generation_index) > 0) next.generation_index = Number(candidate.generation_index);
    if (Number(candidate.generation_recency_index) > 0) next.generation_recency_index = Number(candidate.generation_recency_index);
    if (Number(candidate.generation_image_index) > 0) next.generation_image_index = Number(candidate.generation_image_index);
    if (Number(candidate.generation_image_count) > 0) next.generation_image_count = Number(candidate.generation_image_count);
    if (candidate.unavailable_reason) next.unavailable_reason = stringValue(candidate.unavailable_reason).slice(0, 160);
    return next;
  }

  function compactResourceCatalogMetadata(catalog = []) {
    const metadata = catalog?.[RESOURCE_CATALOG_METADATA];
    if (!metadata?.image_memory?.truncated) return null;
    return metadata;
  }

  function compactIntentClaims(input = '', context = {}) {
    const claims = typeof intentClaimsModule.extractClaims === 'function'
      ? intentClaimsModule.extractClaims(input)
      : [];
    // image_ranking_question is an image-scoped claim: the lexical extractor
    // cannot see the conversation focus, so a text-topic ranking question
    // ("哪个协议效果最好") must not publish an image operation directive.
    const textFocus = stringValue(context?.conversation_focus?.kind) === 'text';
    return claims
      .filter(claim => !(textFocus && stringValue(claim?.type) === 'image_ranking_question'))
      .map(claim => ({
        id: stringValue(claim?.id),
        type: stringValue(claim?.type),
        text: stringValue(claim?.text).slice(0, 240),
        critical: claim?.critical === true,
        ...(claim?.value && typeof claim.value === 'object' ? {
          value: {
            index: Number(claim.value.index) || 0,
            type: stringValue(claim.value.type),
            operation: stringValue(claim.value.operation),
            no_media_binding: claim.value.no_media_binding === true,
          },
        } : {}),
      })).filter(claim => claim.id && claim.text).slice(0, 16);
  }

  function semanticIntentForRoute(input = '', understanding = null, context = {}) {
    if (typeof buildSemanticIntent !== 'function') return null;
    const semantic = buildSemanticIntent({
      input,
      understanding,
      claims: typeof intentClaimsModule.extractClaims === 'function' ? intentClaimsModule.extractClaims(input) : [],
      context,
    });
    return typeof hasExactSemanticIntent !== 'function' || hasExactSemanticIntent(semantic) ? semantic : null;
  }

  function undeliveredGenerationEvidence(input = '', context = {}) {
    const delivered = context?.delivery_evidence?.actual_image_result?.available === true
      || context?.delivery_evidence?.image_delivery_confirmed === true;
    const priorGeneration = (Array.isArray(context?.recent_messages) ? context.recent_messages : [])
      .some(message => message?.role === 'user' && /(?:生成|画|绘制|制作|创建|generate|draw|create)/i.test(String(message?.content || message?.rawText || '')));
    const visualConstraint = /(?:户型|平面图|堂屋|入户门|双开门|背景|构图|布局|颜色|色调|材质|风格|尺寸|比例|卧室|餐厅|卫生间|visual|layout|door|background|composition|style|size)/i.test(stringValue(input));
    return !delivered && priorGeneration && visualConstraint
      ? { undelivered_generation_followup: true, reason: '上一轮明确请求生成图片但尚未验证交付，本轮是视觉约束延续。' }
      : null;
  }

  function deterministicOperationKeysForInput(input = '', context = {}, resourceCatalog = []) {
    const text = stringValue(input);
    const catalog = Array.isArray(resourceCatalog) ? resourceCatalog : [];
    // Explicit web retrieval is as deterministic as an explicit image/edit verb.
    // Reuse the shared capability directive so the schema tightening and the
    // compiler's later operation override stay on one boundary.
    const explicitDirective = explicitRouteDirectiveFor({ input: text, candidates: catalog });
    if (explicitDirective?.operation === 'web_search') return ['web_search'];
    // conversation_focus=text 且输入没有显式媒体/动作词汇时，是文字话题续问，
    // 不因历史图片/文件候选存在而收窄为媒体操作。
    const focusText = stringValue(context?.conversation_focus?.kind) === 'text';
    const explicitMediaOrAction = /(?:图片|图像|照片|图|文件|附件|文档|生成|画|绘制|制作|创建|修改|编辑|改成|改为|变成|换成|参考|比较|分析|总结|提取|识别|翻译|解释|搜索|检索|web\s*search|ocr)/i.test(text);
    if (focusText && !explicitMediaOrAction && text.length <= 40) return ['plain_chat'];
    const allImages = catalog.filter(candidate => candidate?.type === 'image');
    const allFiles = catalog.filter(candidate => candidate?.type === 'file');
    const images = allImages.filter(candidate => candidate?.availability !== 'unavailable');
    const files = allFiles.filter(candidate => candidate?.availability !== 'unavailable');
    const visualCue = /(?:图片|图像|照片|这张图|那张图|目标图|原图|背景|前景|主体|构图|颜色|色彩|光线|材质|风格|蒙版|遮罩|image|photo|picture|background|subject|composition|color|style|mask)/i.test(text);
    const promptAuthoring = /(?:提示词|prompt|描述词|绘图提示)/i.test(text)
      && !/(?:生成一张|生成图片|画一张|绘制一张|创建图片|create\s+(?:an?\s+)?image|generate\s+(?:an?\s+)?image)/i.test(text);
    const explicitlyNoImage = /(?:不要|(?<!分)别|不(?=要|会|再|需要|用|能)|无需|不用|不需要)[^。！？!\r\n]{0,8}(?:生成|画|创建|制作)[^。！？!\r\n]{0,8}(?:图片|图像|海报|image|picture)/i.test(text);
    const hasJointMedia = images.length > 0 && files.length > 0;
    if ((promptAuthoring || explicitlyNoImage) && !images.length) return ['plain_chat'];
    const mentionsImage = /(?:图片|图像|照片|图中|image|photo|picture)/i.test(text);
    const mentionsFile = /(?:文件|文档|说明|合同|报告|pdf|附件|file|document|report)/i.test(text);
    const excludesImage = /(?:不|不要|别|无需|不用|不需要)[^。！？!\r\n]{0,10}(?:分析|读取|查看|使用|处理)?(?:图片|图像|照片|图|image|photo|picture)/i.test(text);
    const excludesFile = /(?:不|不要|别|无需|不用|不需要)[^。！？!\r\n]{0,10}(?:分析|读取|查看|使用|处理)?(?:文件|文档|附件|说明|合同|报告|pdf|file|document|report)/i.test(text);
    if (hasJointMedia && !excludesImage && !excludesFile
        && (/(?:图文|图片和文件|图和文件|联合分析|结合图片|结合文件|multimodal|both)/i.test(text)
          || (mentionsImage && mentionsFile))) return ['multimodal_qa'];
    if (images.length && typeof intentClaimsModule.hasImageRankingQuestion === 'function'
        && intentClaimsModule.hasImageRankingQuestion(text)
        && typeof intentClaimsModule.hasExplicitComparison === 'function'
        && !intentClaimsModule.hasExplicitComparison(text)) return ['image_qa'];
    if (typeof intentClaimsModule.isHistoricalTextQuestion === 'function'
        && intentClaimsModule.isHistoricalTextQuestion(text)) return ['plain_chat'];
    const fileReadCue = /(?:读|阅读|分析|总结|提取|查找|查看|风险|条款|read|summari[sz]e|extract)/i.test(text);
    const fileNoun = /(?:文件|附件|文档|合同|报告|pdf|表格|材料|file|document|report)/i.test(text);
    const multiActionCue = /(?:先|再|然后|之后|接着|同时|最后|first|then|after|and then)/i.test(text);
    if (fileReadCue && !excludesFile && (fileNoun || multiActionCue) && (!visualCue || fileNoun)) return ['file_qa'];
    if (images.length && /(?:逆向|反向|看图写|生成)?[^。！？!\r\n]{0,12}(?:提示词|prompt)/i.test(text)) return ['image_qa'];
    if (images.length && excludesFile && /(?:描述|分析|查看|看图|图片|图中|外观|describe|analy[sz]e|inspect)/i.test(text)) return ['image_qa'];
    if (images.length && /(?:识字|文字提取|OCR|ocr|读出图片文字|(?:提取|识别|读取)[^。！？!\r\n]{0,20}(?:文字|名称|金额|日期|号码|字))/i.test(text)) return ['ocr'];
    if (images.length && /(?:参考图|参考图片|参考[^。！？!\r\n]{0,36}|风格图|配色图|沿用[^。！？!\r\n]{0,20}(?:参考|配色|风格)|基于[^。！？!\r\n]{0,30}(?:参考图|这张图|这张|图片|配色|风格)|(?:用|采用|取)[^。！？!\r\n]{0,60}(?:第\s*[一二两三四五六七八九十\d]+张|这张|图片|主体|构图|风格|质感))/i.test(text)
        && /(?:生成|新图|新版本|海报|再出|制作|改为|create|generate)/i.test(text)
        && !/(?:修改|编辑|改成|变成|换成|edit|change|modify)/i.test(text)) return ['image_reference_gen'];
    if (images.length && visualCue && /(?:修改|编辑|改成|改为|变成|换成|把[^。！？!\r\n]{0,24}改|edit|change|modify)/i.test(text)) return ['edit_image'];
    if (images.length && /(?:看图|查看图片|分析图片|描述图片|图片中|图里|image|photo|picture)/i.test(text)
        && !/(?:生成|画|制作|修改|编辑|参考|识字|文字提取|OCR|读出图片文字|提取[^。！？!\r\n]{0,12}(?:文字|名称|金额|日期))/i.test(text)) return ['image_qa'];
    const visualGenerationCue = /(?:画|图片|图像|海报|插画|壁纸|视觉|image|picture|photo|illustration|poster|wallpaper|draw)/i.test(text);
    if (visualGenerationCue && /(?:生成|画|绘制|制作|创建|generate|draw|create)/i.test(text)
        && !fileReadCue
        && !/(?:修改|编辑|改成|参考图|参考图片|配色图|风格图)/i.test(text)) return ['text_to_image'];
    return null;
  }

  function deterministicResourceKeysForInput(input = '', context = {}, resourceCatalog = []) {
    const text = stringValue(input);
    const quoted = hasQuotedEvidence(context);
    const focusText = stringValue(context?.conversation_focus?.kind) === 'text';
    const explicitMediaOrHistory = /(?:第\s*[一二两三四五六七八九十\d]+\s*(?:张|幅|个|份)?|图片|图像|照片|图|文件|附件|文档|上一张|这张|那张|上一条|这条|那条|引用|quoted|history|previous|image|photo|picture|file|document)/i.test(text);
    const historicalTextOnly = typeof intentClaimsModule.isHistoricalTextQuestion === 'function'
      && intentClaimsModule.isHistoricalTextQuestion(text);
    if (quoted || (!historicalTextOnly && !(focusText && !explicitMediaOrHistory))) return null;

    // A text-focused turn may still need the body of a previous message even
    // when the user refers to it by subject (for example, "the database table")
    // rather than by a literal "previous message" cue. Narrow only the media
    // side of the catalog here; message context remains a model-owned semantic
    // choice and must not be disabled by keyword absence.
    return (Array.isArray(resourceCatalog) ? resourceCatalog : [])
      .filter(candidate => candidate?.type === 'message' && candidate?.availability !== 'unavailable')
      .map(candidate => stringValue(candidate.candidate_key))
      .filter(Boolean);
  }

  // ── Payload builder ──────────────────────────────────────────────
  const UNDERSTAND_SYSTEM_PROMPT = Array.isArray(UNDERSTAND_SYSTEM_PROMPT_LINES)
    ? UNDERSTAND_SYSTEM_PROMPT_LINES.join('\n')
    : ROUTE_SYSTEM_PROMPT;
  const ROUTE_NODE_SYSTEM_PROMPT = Array.isArray(ROUTE_NODE_SYSTEM_PROMPT_LINES)
    ? ROUTE_NODE_SYSTEM_PROMPT_LINES.join('\n')
    : ROUTE_SYSTEM_PROMPT;
  const ROUTE_NODE_SYSTEM_PROMPT_COMPACT = Array.isArray(ROUTE_NODE_SYSTEM_PROMPT_COMPACT_LINES)
    ? ROUTE_NODE_SYSTEM_PROMPT_COMPACT_LINES.join('\n')
    : ROUTE_NODE_SYSTEM_PROMPT;
  const ROUTE_NODE_SYSTEM_PROMPT_SIMPLE = Array.isArray(ROUTE_NODE_SYSTEM_PROMPT_SIMPLE_LINES)
    ? ROUTE_NODE_SYSTEM_PROMPT_SIMPLE_LINES.join('\n')
    : ROUTE_NODE_SYSTEM_PROMPT;
  function buildRoutePayload({ model, input, attachments = [], context = {}, currentMode = 'chat', autoMode = true, currentTurn = null, systemPrompt, responseFormat, understanding = null, intentReasoning = null } = {}) {
    assertInputWithinUnifiedLimit(stringValue(input));
    const priorContext = contextBeforeCurrentTurn(context, currentTurn);
    const resourceCatalog = wireResourceCandidates(attachments, priorContext, input);
    const catalogMetadata = compactResourceCatalogMetadata(resourceCatalog);
    // Deterministic relation constraints are stronger than model-written
    // understanding.dependency. Resolve them first so the evidence and the
    // response schema can never carry contradictory relation authorities.
    const allowedRelations = exactRouteRelationConstraint(input, priorContext, resourceCatalog);
    const reconciledUnderstandingDependency = allowedRelations.length === 1
      ? allowedRelations[0]
      : reconcileUnderstandingDependency(understanding, resourceCatalog, priorContext);
    const compactClaims = compactIntentClaims(input, priorContext);
    const userPayload = {
      current_input: stringValue(input),
      evidence_priority: ROUTE_EVIDENCE_PRIORITY,
      resource_candidates: resourceCatalog.map(compactWireResourceCandidate),
      context: compactWireRouteContext(priorContext, input, resourceCatalog),
    };
    if (compactClaims.length) userPayload.intent_claims = compactClaims;
    if (catalogMetadata) userPayload.resource_catalog = catalogMetadata;
    // Some OpenAI-compatible gateways translate Chat Completions structured
    // output into Responses `text.format=json_object` and inspect only the
    // user input for the required JSON keyword. Keep the marker in the
    // machine-readable user envelope, not only in the system prompt.
    userPayload.output_format = 'json';
    if (currentMode && autoMode === false) userPayload.current_mode = currentMode;
    if (currentMode && autoMode === false) userPayload.auto_mode = false;
    if (currentTurn && typeof currentTurn === 'object') userPayload.current_turn = currentTurn;
    if (understanding && typeof understanding === 'object') {
      userPayload.understanding = {
        schema_version: stringValue(understanding.schema_version) || UNDERSTANDING_VERSION,
        dependency: reconciledUnderstandingDependency,
        actions: (Array.isArray(understanding.actions) ? understanding.actions : []).map(action => ({
          index: Number(action?.index) || 0,
          kind: stringValue(action?.kind),
          target: stringValue(action?.target),
          resolved_refs: (Array.isArray(action?.resolved_refs) ? action.resolved_refs : []).map(ref => ({
            candidate_key: stringValue(ref?.candidate_key),
            text: stringValue(ref?.text),
          })),
        })),
      };
    }

    const semanticIntent = (understanding || intentReasoning?.enabled === true)
      ? semanticIntentForRoute(input, understanding, priorContext)
      : null;
    if (semanticIntent) userPayload.semantic_intent = semanticIntent;

    const allowedGoals = exactCurrentInputGoalConstraint(input, priorContext, resourceCatalog);
    const allowedGoalModes = exactGoalModeConstraint(input, priorContext);
    // Operation is decided once by the route model. Do not project local
    // keyword policies or understanding-derived enums into the route schema.
    const allowedOperations = null;
    if (allowedRelations.length === 1) {
      userPayload.relation_policy = {
        allowed_relations: allowedRelations,
        reason: '当前输入的明确历史依赖或纠正语义已确定 relation；不得选择其它 relation。',
      };
    }
    const allowedResourceKeys = deterministicResourceKeysForInput(input, priorContext, resourceCatalog);
    if (Array.isArray(allowedResourceKeys)) {
      userPayload.resource_policy = {
        allowed_candidate_keys: allowedResourceKeys,
        reason: allowedResourceKeys.length
          ? '当前是文字语义问题；禁止绑定图片/文件，但允许模型在确有历史正文依赖时选择 message=context。'
          : '当前输入没有可用的历史消息正文候选，因此不得绑定 resource_candidates。',
      };
    }
    const requestResponseFormat = typeof routeIntentResponseFormatForCandidates === 'function'
      ? routeIntentResponseFormatForCandidates(resourceCatalog, {
        allowedRelations,
        allowedGoals,
        allowedGoalModes,
        ...(Array.isArray(allowedResourceKeys) ? { allowedResourceKeys } : {}),
      })
      : ROUTE_INTENT_RESPONSE_FORMAT;
    if (typeof buildResponsesPayload !== 'function') throw new Error('Responses payload service is unavailable');
    // This is a non-streaming semantic routing request. Deny tool execution.
    // The default remains a no-reasoning fast path, while high-risk callers may
    // pass intentReasoning to request a bounded reasoning summary under the same
    // absolute deadline. Gateways that reject the reasoning parameter strip it
    // via the compatibility fallback instead of failing the route.
    return buildResponsesPayload(model, [
      { role: 'system', content: systemPrompt || ROUTE_SYSTEM_PROMPT },
      { role: 'user', content: JSON.stringify(userPayload) },
    ], {
      stream: false,
      ...intentReasoningPayloadOptions(intentReasoning),
      toolChoice: 'none',
      responseFormat: responseFormat || requestResponseFormat,
    });
  }

  function buildImagePlanPayload({ model, input, goal = '', attachments = [], context = {}, currentTurn = null, expectedTaskCount = 0, systemPrompt, responseFormat, intentReasoning = null } = {}) {
    assertInputWithinUnifiedLimit(stringValue(input));
    const executionGoal = stringValue(goal);
    if (!executionGoal) {
      const error = new TypeError('Image planning requires a materialized execution instruction');
      error.code = 'IMAGE_PLAN_INSTRUCTION_REQUIRED';
      throw error;
    }
    const priorContext = contextBeforeCurrentTurn(context, currentTurn);
    const resourceCatalog = wireResourceCandidates(attachments, priorContext, input);
    const catalogMetadata = compactResourceCatalogMetadata(resourceCatalog);
    const userPayload = {
      current_input: stringValue(input),
      route_goal: executionGoal,
      evidence_priority: ROUTE_EVIDENCE_PRIORITY,
      resource_candidates: resourceCatalog.map(compactWireResourceCandidate),
      context: compactWireRouteContext(priorContext, input, resourceCatalog),
    };
    if (catalogMetadata) userPayload.resource_catalog = catalogMetadata;
    if (Number.isSafeInteger(Number(expectedTaskCount)) && Number(expectedTaskCount) >= 2) {
      userPayload.expected_task_count = Number(expectedTaskCount);
    }
    // Keep the JSON-mode marker in the user message as well as the system
    // prompt for gateways that discard system messages during translation.
    userPayload.output_format = 'json';
    if (typeof buildResponsesPayload !== 'function') throw new Error('Responses payload service is unavailable');
    return buildResponsesPayload(model, [
      { role: 'system', content: systemPrompt || IMAGE_PLAN_SYSTEM_PROMPT },
      { role: 'user', content: JSON.stringify(userPayload) },
    ], {
      stream: false,
      ...intentReasoningPayloadOptions(intentReasoning),
      responseFormat: responseFormat || IMAGE_PLAN_RESPONSE_FORMAT,
    });
  }
  // One bounded repair round for the image-plan node: keep the same goal and
  // expected task count, append the rejected plan, and ask for a corrected
  // image_plan.v1. This prevents a planner that returns one task from silently
  // collapsing an explicitly requested multi-image request (e.g. five views).
  function buildImagePlanRepairPayload({ model, input, goal = '', attachments = [], context = {}, currentTurn = null, expectedTaskCount = 0, rejectedPlan = null, intentReasoning = null } = {}) {
    const payload = buildImagePlanPayload({ model, input, goal, attachments, context, currentTurn, expectedTaskCount, intentReasoning });
    payload.input.push({
      role: 'user',
      content: JSON.stringify({
        repair_request: {
          rejected_plan: rejectedPlan,
          expected_task_count: Number.isSafeInteger(Number(expectedTaskCount)) && Number(expectedTaskCount) >= 2 ? Number(expectedTaskCount) : null,
          instruction: '任务数必须等于 expected_task_count；只修复缺失或多余的任务，逐项补全或删除，并保持每个 task 独立完整。只输出 json。',
        },
      }),
    });
    return payload;
  }

  // A non-image multi-intent route cannot be represented by one dispatch
  // contract. Plan it into independently executable tasks; the user then
  // chooses one task per turn instead of being asked to invent a merge.
  function shouldRequestMultiTaskPlan(route = {}) {
    const operation = stringValue(route?.operationType || route?.dispatchContract?.operation || '');
    if (IMAGE_RELATION_OPERATIONS.has(operation)) return false;
    return stringValue(route?.taskShape) === 'multi'
      && route?.multiTask === true
      && route?.needClarification === true
      && route?.readiness === 'needs_clarification'
      && !Array.isArray(route?.multiTaskPlanCompiled);
  }

  function buildMultiTaskPlanPayload({ model, input, goal = '', attachments = [], context = {}, currentTurn = null, systemPrompt, responseFormat, intentReasoning = null } = {}) {
    assertInputWithinUnifiedLimit(stringValue(input));
    const executionGoal = stringValue(goal);
    if (!executionGoal) {
      const error = new TypeError('Multi-task planning requires a resolved user goal');
      error.code = 'MULTI_TASK_PLAN_GOAL_REQUIRED';
      throw error;
    }
    const priorContext = contextBeforeCurrentTurn(context, currentTurn);
    const resourceCatalog = wireResourceCandidates(attachments, priorContext, input);
    const catalogMetadata = compactResourceCatalogMetadata(resourceCatalog);
    const userPayload = {
      current_input: stringValue(input),
      route_goal: executionGoal,
      evidence_priority: ROUTE_EVIDENCE_PRIORITY,
      resource_candidates: resourceCatalog.map(compactWireResourceCandidate),
      context: compactWireRouteContext(priorContext, input, resourceCatalog),
    };
    if (catalogMetadata) userPayload.resource_catalog = catalogMetadata;
    userPayload.output_format = 'json';
    if (typeof buildResponsesPayload !== 'function') throw new Error('Responses payload service is unavailable');
    return buildResponsesPayload(model, [
      { role: 'system', content: systemPrompt || MULTI_TASK_PLAN_SYSTEM_PROMPT },
      { role: 'user', content: JSON.stringify(userPayload) },
    ], {
      stream: false,
      ...intentReasoningPayloadOptions(intentReasoning),
      responseFormat: responseFormat || MULTI_TASK_PLAN_RESPONSE_FORMAT,
    });
  }

  function buildMultiTaskPlanRepairPayload({ model, input, goal = '', attachments = [], context = {}, currentTurn = null, rejectedPlan = null, expectedSummary = [], intentReasoning = null } = {}) {
    const payload = buildMultiTaskPlanPayload({ model, input, goal, attachments, context, currentTurn, intentReasoning });
    payload.input.push({
      role: 'user',
      content: JSON.stringify({
        repair_request: {
          rejected_output: JSON.stringify(rejectedPlan ?? null),
          expected_tasks: (Array.isArray(expectedSummary) ? expectedSummary : []).map(item => ({
            operation: stringValue(item?.operation),
            resource_roles: item?.resource_roles || {},
            resource_refs: Array.isArray(item?.resource_refs) ? item.resource_refs : [],
          })),
          reasons: ['plan_not_faithful'],
          instruction: '只修正任务拆分：每个 expected_task 必须有且仅有一个 operation 匹配的 task，且 resource_refs 的 candidate_key/role 集合必须一致，不得遗漏或新增任务或资源；其余字段保持不变。只输出 json。',
        },
      }),
    });
    return payload;
  }

  function inspectMultiTaskPlan(text = '', options = {}) {
    try {
      const raw = JSON.parse(stringValue(text).replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim());
      if (typeof hasExactMultiTaskPlan !== 'function' || !hasExactMultiTaskPlan(raw)) return { plan: null };
      return { plan: raw };
    } catch {
      return { plan: null };
    }
  }

  // Planner/selector models emit unstable roles for a plan-declared resource
  // ("target"/"context" instead of "attachment" for a file_qa file). The
  // operation's canonical requirement wins, so the compiled task binds the
  // resource deterministically regardless of the emitted role.
  function planTaskRefs(task = {}) {
    return (Array.isArray(task?.resource_refs) ? task.resource_refs : [])
      .map(ref => {
        const candidateKey = stringValue(ref.candidate_key);
        const type = resourceTypeForCandidateKey?.(candidateKey)
          || (candidateKey.startsWith('i') ? 'image' : candidateKey.startsWith('f') ? 'file' : 'message');
        return { candidate_key: candidateKey, role: canonicalTaskBindingRole(stringValue(task.operation), type, stringValue(ref.role)) };
      });
  }

  function compilePlanTask(task = {}, options = {}) {
    const intent = JSON.stringify({
      operation: stringValue(task.operation),
      relation: stringValue(options.relation) || 'new',
      goal: stringValue(task.goal),
      goal_mode: 'replace',
      task_shape: 'single',
      resource_refs: planTaskRefs(task),
    });
    return inspectModelRouteResult(intent, {
      input: stringValue(task.goal),
      attachments: options.attachments || [],
      context: options.context || {},
      ...(options.routeCompilationOptions || {}),
      currentTurn: options.currentTurn || null,
    });
  }

  function compileMultiTaskPlan(plan = {}, options = {}) {
    const tasks = Array.isArray(plan?.tasks) ? plan.tasks : [];
    if (!tasks.length) return { ok: false, items: [] };
    const items = [];
    for (const task of tasks) {
      const inspected = compilePlanTask(task, options);
      if (!inspected?.route) return { ok: false, items, reason: inspected?.reason || 'task_compile_failed' };
      items.push({ task, route: inspected.route });
    }
    return { ok: true, items };
  }

  // A task selector ("1", "任务二", "第2个任务") is a deterministic lookup into
  // the already-generated multi-task plan. Resolving it locally avoids the
  // intent model mis-mapping the number to a different task.
  function compileSelectedPlanTask(plan = {}, index = 0, options = {}) {
    const tasks = Array.isArray(plan?.tasks) ? plan.tasks : [];
    const task = tasks[index - 1];
    if (!task) return { ok: false, reason: 'task_not_found' };
    const inspected = compilePlanTask(task, options);
    if (!inspected?.route) return { ok: false, reason: inspected?.reason || 'task_compile_failed' };
    return { ok: true, route: inspected.route };
  }




  function imageOperationForRoute(route = {}) {
    return stringValue(route?.operationType || route?.dispatchContract?.operation || route?.intent);
  }

  function isImagePlanningEnvelope(route = {}) {
    return IMAGE_RELATION_OPERATIONS.has(imageOperationForRoute(route))
      && route?.readiness === 'ready'
      && route?.needClarification !== true
      && stringValue(route?.taskShape) === 'multi'
      && route?.dispatchAuthorized !== true
      && !route?.dispatchContract;
  }

  function hasRouteResourceBindings(route = {}) {
    const collections = [
      route?.resources,
      route?.imageRefs,
      route?.fileRefs,
      route?.messageRefs,
      route?.dispatchContract?.bindings,
    ];
    if (collections.some(collection => Array.isArray(collection) && collection.length > 0)) return true;

    const projection = route?.executionResources;
    if (!projection || typeof projection !== 'object') return false;
    return [
      projection.images,
      projection.files,
      projection.messages,
      projection.targets,
      projection.masks,
      projection.references,
      projection.imageInputs,
      projection.chatImages,
      projection.chatFiles,
      projection.selectedMessageRefs,
    ].some(collection => Array.isArray(collection) && collection.length > 0);
  }

  // A newly requested text-to-image task that is already self-contained has no
  // conversational state for the instruction materializer to resolve.  Passing
  // it through another model only repeats the route model's canonical goal and
  // adds an avoidable provider call.  Keep this predicate deliberately narrow:
  // edits, follow-ups, amendments, named/history references, and every bound
  // resource continue through materialization.
  function isSelfContainedNewImageRoute(route = {}) {
    if (imageOperationForRoute(route) !== 'text_to_image') return false;
    if (stringValue(route?.relation) !== 'new') return false;
    if ((stringValue(route?.goalMode) || 'replace') !== 'replace') return false;
    if (route?.readiness !== 'ready' || route?.needClarification === true) return false;
    if (hasRouteResourceBindings(route)) return false;

    const instruction = stringValue(
      route?.userGoal
      || route?.executionPrompt
      || route?.resolvedImageGoal
      || route?.dispatchContract?.arguments?.prompt,
    );
    return Boolean(instruction) && !hasUnresolvedImageInstructionReference(instruction);
  }

  function requiresImageInstructionMaterialization(route = {}) {
    if (isSelfContainedNewImageRoute(route)) return false;
    const operation = imageOperationForRoute(route);
    const finalImageExecution = IMAGE_RELATION_OPERATIONS.has(operation)
      && route?.readiness === 'ready'
      && route?.needClarification !== true
      && route?.dispatchAuthorized === true
      && typeof hasExactDispatchContract === 'function'
      && hasExactDispatchContract(route?.dispatchContract);
    if (finalImageExecution) return true;
    // An image_plan envelope is a planning container split into child tasks by
    // compileImagePlan. It is only materialized when it carries an unresolved
    // named reference (e.g. "按方案A") that must be resolved into a concrete
    // instruction before planning; a self-contained multi-image request goes
    // straight to image_plan so its full set of actions is not collapsed.
    if (isImagePlanningEnvelope(route)) {
      const goal = stringValue(route?.userGoal || route?.executionPrompt || route?.dispatchContract?.arguments?.prompt || '');
      return hasUnresolvedImageInstructionReference(goal);
    }
    return false;
  }

  function buildImageInstructionPayload({ model, input, route = {}, attachments = [], context = {}, currentTurn = null, repair = null, systemPrompt, responseFormat } = {}) {
    if (!requiresImageInstructionMaterialization(route)) {
      const error = new TypeError('Image instruction materialization requires a ready image route');
      error.code = 'IMAGE_INSTRUCTION_ROUTE_INVALID';
      throw error;
    }
    if (!IMAGE_INSTRUCTION_RESPONSE_FORMAT) {
      const error = new TypeError('Image instruction protocol is unavailable');
      error.code = 'IMAGE_INSTRUCTION_PROTOCOL_UNAVAILABLE';
      throw error;
    }
    assertInputWithinUnifiedLimit(stringValue(input));
    const priorContext = contextBeforeCurrentTurn(context, currentTurn);
    const resourceCatalog = wireResourceCandidates(attachments, priorContext, input);
    const catalogMetadata = compactResourceCatalogMetadata(resourceCatalog);
    const resolvedTask = stringValue(
      route.userGoal
      || route.executionPrompt
      || route.dispatchContract?.arguments?.prompt
      || input,
    );
    const userPayload = {
      // The raw request is evidence for resolving references, never text to
      // copy into the provider instruction. resolved_task is the semantic
      // authority produced by the route stage.
      user_request_evidence: stringValue(input),
      resolved_task: resolvedTask,
      operation: imageOperationForRoute(route),
      relation: stringValue(route.relation),
      goal_mode: stringValue(route.goalMode) || 'replace',
      task_shape: stringValue(route.taskShape) || 'single',
      evidence_priority: ROUTE_EVIDENCE_PRIORITY,
      resource_candidates: resourceCatalog.map(compactWireResourceCandidate),
      context: compactWireRouteContext(priorContext, input, resourceCatalog),
      output_format: 'json',
    };
    if (catalogMetadata) userPayload.resource_catalog = catalogMetadata;
    if (repair && typeof repair === 'object') {
      userPayload.repair = {
        rejection_reason: stringValue(repair.reason),
        rejected_instruction: stringValue(repair.instruction),
      };
    }
    if (typeof buildResponsesPayload !== 'function') throw new Error('Responses payload service is unavailable');
    return buildResponsesPayload(model, [
      { role: 'system', content: systemPrompt || IMAGE_INSTRUCTION_SYSTEM_PROMPT },
      { role: 'user', content: JSON.stringify(userPayload) },
    ], {
      stream: false,
      noReasoning: true,
      toolChoice: 'none',
      responseFormat: responseFormat || IMAGE_INSTRUCTION_RESPONSE_FORMAT,
    });
  }

  function inspectImageInstructionResult(text = '', { userRequestEvidence = '', resolvedTask = '' } = {}) {
    const parsedResult = parseRouteJson(text);
    if (!parsedResult.parsed) return { materialization: null, reason: parsedResult.reason, parseError: parsedResult.parseError || '' };
    const materialization = parsedResult.parsed;
    if (typeof hasExactImageInstruction !== 'function' || !hasExactImageInstruction(materialization)) {
      return { materialization: null, reason: 'image_instruction_invalid' };
    }
    const instruction = stringValue(materialization.instruction);
    const source = stringValue(userRequestEvidence);
    const task = stringValue(resolvedTask);
    // The materializer may read source evidence to resolve references, but it
    // must never emit that evidence as a preamble followed by a second prompt.
    // This is a structural contract check against echoing, not a keyword list.
    const echoedSource = materialization.status === 'ready'
      && source
      && source !== task
      && (instruction === source || (instruction.startsWith(source) && /^\s*(?:\r?\n){1,}/.test(instruction.slice(source.length))));
    if (echoedSource) {
      return { materialization: null, reason: 'image_instruction_echoed_source_request', rejectedInstruction: instruction };
    }
    if (materialization.status === 'ready' && hasUnresolvedImageInstructionReference(instruction)) {
      return { materialization: null, reason: 'image_instruction_not_standalone', rejectedInstruction: instruction };
    }
    return { materialization, reason: '' };
  }

  function imageTargetClarificationSlot(route = {}, { input = '', attachments = [], context = {} } = {}) {
    const operation = imageOperationForRoute(route);
    if (operation !== 'edit_image') return null;

    // A materializer is allowed to say that it cannot determine the target,
    // but it must not turn that semantic ambiguity into a free-form assistant
    // message. Rebuild the full recoverable pool solely for this non-executable
    // clarification so every visible image can be selected explicitly.
    const candidates = buildResourceCandidates(attachments, context, input, {
      includeAllImageMemoryCards: true,
    }).filter(candidate => candidate.type === 'image' && candidate.availability !== 'unavailable');
    const selectedTargetIds = new Set((Array.isArray(route.resources) ? route.resources : [])
      .filter(resource => resource?.type === 'image' && resource?.role === 'target')
      .map(resource => stringValue(resource.resource_id || resource.resourceId))
      .filter(Boolean));
    const replacementCandidates = candidates.filter(candidate => !selectedTargetIds.has(stringValue(candidate.resource_id)));
    const choices = replacementCandidates.length ? replacementCandidates : candidates;
    if (!candidates.length) return null;

    return normalizeResourceClarificationIssues([unresolvedResourceIssue({
      key: nextClarificationResourceKey(route),
      type: 'image',
      role: 'target',
      reason: 'ambiguous',
      candidates: choices,
    })], Array.isArray(route.resources) ? route.resources : [])[0] || null;
  }

  function shouldClarifyImageTarget(route = {}, input = '', clarification = '') {
    if (imageOperationForRoute(route) !== 'edit_image') return false;
    return REJECTED_IMAGE_TARGET_PATTERN.test(stringValue(input))
      || IMAGE_TARGET_CLARIFICATION_PATTERN.test(stringValue(clarification));
  }

  function clarifyImageInstructionRoute(route = {}, clarification = '', options = {}) {
    const targetSlot = shouldClarifyImageTarget(route, options.input, clarification)
      ? imageTargetClarificationSlot(route, options)
      : null;
    if (targetSlot) {
      return clarifyRoute(route, {
        question: '没有明确要编辑哪张图片，请从下列图片中选择目标图片。',
        slots: [targetSlot],
      });
    }
    return clarifyRoute(route, {
      question: stringValue(clarification) || '无法将本轮图片需求整理为完整的执行指令，请明确要采用的内容或直接补充完整要求。',
      slots: [{ key: 'r1', type: 'text', role: 'source', reason: 'missing', choices: [] }],
    });
  }

  function applyMaterializedImageInstruction(route = {}, instruction = '', { context = {} } = {}) {
    if (!requiresImageInstructionMaterialization(route)) {
      const error = new TypeError('Image instruction materialization can only update a ready image route');
      error.code = 'IMAGE_INSTRUCTION_ROUTE_INVALID';
      throw error;
    }
    const materializedInstruction = stringValue(instruction);
    if (!materializedInstruction) {
      const error = new TypeError('Materialized image instruction is missing');
      error.code = 'IMAGE_INSTRUCTION_MISSING';
      throw error;
    }
    const operation = imageOperationForRoute(route);
    const planningEnvelope = isImagePlanningEnvelope(route);
    if (typeof transitionTaskContinuity !== 'function' || typeof renderTaskContinuity !== 'function') {
      throw new TypeError('Task continuity protocol is unavailable');
    }
    const goalMode = stringValue(route.goalMode) || 'replace';
    const imageTaskState = transitionTaskContinuity({
      goalMode,
      goal: materializedInstruction,
      previousExecution: context?.previous_execution || null,
    });
    const executionPrompt = operation === 'text_to_image'
      ? renderTaskContinuity(imageTaskState)
      : materializedInstruction;
    let dispatchContract = null;
    if (!planningEnvelope) {
      if (typeof withArguments !== 'function') {
        throw new TypeError('Dispatch contract materializer is unavailable');
      }
      dispatchContract = withArguments(route.dispatchContract, { prompt: executionPrompt });
    }
    return {
      ...route,
      userGoal: materializedInstruction,
      executionPrompt,
      imageTaskState,
      resolvedImageGoal: renderTaskContinuity(imageTaskState),
      contextualImagePrompt: executionPrompt,
      editInstruction: ['edit_image', 'image_reference_gen'].includes(operation) ? materializedInstruction : '',
      dispatchContract,
      instructionMaterialization: Object.freeze({
        schema_version: IMAGE_INSTRUCTION_VERSION,
        status: 'ready',
      }),
    };
  }

  // ── Response parsing ────────────────────────────────────────────
  function extractRouteText(response = {}) {
    // Route recognition receives both native Responses envelopes and the
    // non-streaming Chat Completions compatibility fallback. The transport
    // envelope is interpreted by the same shared fact source as the server
    // proxy and live evaluator, so top-level Responses request metadata such as
    // `text.format` can never be mistaken for assistant output.
    const extracted = responseOutputText(response);
    if (stringValue(extracted)) return String(extracted);

    // A few structured-output adapters expose the parsed value directly rather
    // than duplicating it in output_text. It is still subjected to the exact
    // route-intent validator below; this only normalizes its transport shape.
    const parsed = response?.output_parsed ?? response?.parsed;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      try { return JSON.stringify(parsed); } catch {}
    }
    return '';
  }

  function parseRouteJson(text = '') {
    const value = stringValue(text);
    if (!value) return { parsed: null, reason: 'empty_response' };
    try {
      return { parsed: JSON.parse(stripJsonFence(value)), reason: '' };
    } catch (error) {
      return {
        parsed: null,
        reason: 'model_json_parse_failure',
        parseError: String(error.message).slice(0, 200),
      };
    }
  }

  if (typeof routeSemanticNormalizerModule?.createRouteSemanticNormalizer !== 'function') {
    throw new TypeError('Route semantic normalizer module is unavailable');
  }
  const {
    normalizeImageAmendmentGoal,
    reconcileModelIntent,
  } = routeSemanticNormalizerModule.createRouteSemanticNormalizer({
    maxGoalLength: ROUTE_INTENT_MAX_GOAL_LENGTH,
    imageRelationOperations: IMAGE_RELATION_OPERATIONS,
    imageTaskStateOperations: IMAGE_TASK_STATE_OPERATIONS,
    imageGenerationIntentPattern: IMAGE_GENERATION_INTENT_PATTERN,
    taskContinuityFromExecution,
    renderTaskContinuity,
  });
  // Strict gateways narrow the goal_mode enum to ['replace'] when no
  // previous task state exists, but some OpenAI-compatible providers (e.g.
  // Qwen) ignore the strict enum and return "amend" anyway. Amending without
  // a base task state is meaningless: degrade to replace and keep the goal
  // intact so the request still executes instead of failing the route.
  function normalizeAmendWithoutBase(intent = {}, options = {}) {
    if (stringValue(intent.goal_mode) !== 'amend') return intent;
    const previous = options.context?.previous_execution;
    const hasPrevious = !!previous && (
      typeof taskContinuityFromExecution !== 'function' || !!taskContinuityFromExecution(previous)
    );
    if (hasPrevious) return intent;
    return Object.freeze({ ...intent, goal_mode: 'replace' });
  }

  // The capability registry declares explicit route directives as user-language
  // facts. A declared web_search lookup (e.g. “查查最新信息”) cannot be
  // downgraded to plain_chat by a weak model proposal: only the operation
  // follows the directive; goal, relation, resources and task shape remain
  // model-owned. Local file/image lookups are excluded by the directive itself.
  function reconcileExplicitWebSearchDirective(intent = {}, options = {}) {
    if (!intent || stringValue(intent?.operation) === 'web_search') return intent;
    const input = stringValue(options?.input);
    const catalog = Array.isArray(options?.candidateCatalog) ? options.candidateCatalog : [];
    const directive = typeof explicitRouteDirectiveFor === 'function'
      ? explicitRouteDirectiveFor({ input, candidates: catalog })
      : null;
    if (!directive || directive.operation !== 'web_search') return intent;
    return Object.freeze({ ...intent, operation: 'web_search' });
  }

  function goalModeForIntent(intent = {}) {
    const goalMode = typeof routeIntentGoalMode === 'function'
      ? routeIntentGoalMode(intent)
      : stringValue(intent.goal_mode);
    if (!['replace', 'amend'].includes(goalMode)) {
      const error = new TypeError(`Unsupported route goal mode: ${goalMode || '<missing>'}`);
      error.code = 'ROUTE_GOAL_MODE_INVALID';
      throw error;
    }
    return goalMode;
  }

  function imageTaskContinuityForIntent(intent = {}, options = {}) {
    const operation = stringValue(intent.operation);
    const goalMode = goalModeForIntent(intent);
    if (!IMAGE_TASK_STATE_OPERATIONS.has(operation)) {
      if (goalMode !== 'replace') {
        const error = new TypeError(`${operation || '<missing>'} cannot amend an image task state`);
        error.code = 'ROUTE_GOAL_MODE_OPERATION_MISMATCH';
        throw error;
      }
      return null;
    }
    if (goalMode === 'amend' && !IMAGE_TASK_AMEND_OPERATIONS.has(operation)) {
      const error = new TypeError(`${operation} cannot amend an image task state`);
      error.code = 'ROUTE_GOAL_MODE_OPERATION_MISMATCH';
      throw error;
    }
    if (typeof transitionTaskContinuity !== 'function' || typeof renderTaskContinuity !== 'function') {
      throw new TypeError('Task continuity protocol is unavailable');
    }
    const goal = stringValue(intent.goal).slice(0, ROUTE_INTENT_MAX_GOAL_LENGTH);
    return transitionTaskContinuity({
      goalMode,
      goal: goalMode === 'amend' && !modelOwnsRouteSemantics(options)
        ? normalizeImageAmendmentGoal(goal, options)
        : goal,
      previousExecution: options.context?.previous_execution || null,
    });
  }

  function resolvedImageGoalForIntent(intent = {}, options = {}, taskState = null) {
    const operation = stringValue(intent.operation);
    const goal = stringValue(intent.goal).slice(0, ROUTE_INTENT_MAX_GOAL_LENGTH);
    if (!IMAGE_TASK_STATE_OPERATIONS.has(operation)) return goal;
    const state = taskState || imageTaskContinuityForIntent(intent, options);
    return renderTaskContinuity(state);
  }

  // Provider prompts must be natural task instructions. The raw user message
  // remains available in the conversation/context pipeline, while the route
  // model's resolved goal is the concise, self-contained instruction sent to
  // the downstream model. Never inject an internal routing envelope into a
  // provider-facing prompt.
  // A task-selection expression ("3", "任务2", "做任务1", "第2个任务") is only a
  // pointer to a previously generated multi-task plan. It is never the real
  // instruction, so the route model’s resolved goal must become the provider prompt.
  const CHINESE_NUMERAL_VALUE = Object.freeze({
    '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9, '十': 10,
  });
  function chineseNumeralValue(text = '') {
    const single = CHINESE_NUMERAL_VALUE[stringValue(text)];
    if (single) return single;
    const match = /^([一二三四五六七八九]?)十([一二三四五六七八九])?$/.exec(stringValue(text));
    if (!match) return 0;
    const tens = match[1] ? CHINESE_NUMERAL_VALUE[match[1]] : 1;
    const ones = match[2] ? CHINESE_NUMERAL_VALUE[match[2]] : 0;
    return tens * 10 + ones;
  }

  function isTaskSelectionInput(input = "") {
    const text = stringValue(input);
    if (!text) return false;
    if (/^[1-9]\d*$/.test(text)) return true;
    return /^(?:(?:做|执行|选择|处理)(?:\s*任务)?\s*|任务\s*|选\s*)?(?:\s*第)?[1-9]\d*(?:\s*(?:个|项|号)\s*(?:任务)?)?$/.test(text)
      || /^(?:(?:做|执行|选择|处理)(?:\s*任务)?\s*|任务\s*|选\s*)?(?:\s*第)?[一二三四五六七八九十]+(?:\s*(?:个|项|号)\s*(?:任务)?)?$/.test(text);
  }
  // A task-selection turn ("1", "任务2", "做任务1") chooses one
  // task the multi-task planner already compiled. That plan task is the authority
  // for which resources it binds: the user picked an existing task, so the
  // selector model must not silently drop or re-decide resource_refs. If the
  // model omits a plan-declared binding, restore it deterministically, or a
  // file/image-bound task falls back to a redundant "which file" prompt.
  function selectedMultiTaskIndex(input = "") {
    const text = stringValue(input);
    const arabic = text.match(/[1-9]\d*/);
    if (arabic) return Number(arabic[0]);
    const chinese = text.match(/[一二三四五六七八九十]+/);
    return chinese ? chineseNumeralValue(chinese[0]) : 0;
  }

  function multiTaskPlanForIntent(options = {}) {
    const plan = options.context?.multi_task_plan || options.context?.clarification_context?.multi_task_plan;
    return plan && Array.isArray(plan.tasks) && plan.tasks.length ? plan : null;
  }

  // A plan-declared binding is the authority for which candidate the selected
  // task uses, but the planner/selector models emit unstable roles for the same
  // resource ("target"/"context" instead of "attachment" for a file_qa file).
  // The operation's canonical requirement wins, so the binding is deterministic:
  // file_qa/multimodal_qa bind files as attachment, image_qa/ocr/multimodal_qa
  // bind images as source.
  function canonicalTaskBindingRole(operation = '', type = '', role = '') {
    if (type === 'file') {
      return (operation === 'file_qa' || operation === 'multimodal_qa') ? 'attachment' : stringValue(role);
    }
    if (type === 'image' && (operation === 'image_qa' || operation === 'ocr' || operation === 'multimodal_qa')) {
      return 'source';
    }
    return stringValue(role);
  }

  function reconcileSelectedTaskBindings(intent = {}, options = {}) {
    const input = stringValue(options.input || options.current_input);
    if (!isTaskSelectionInput(input)) return intent;
    const plan = multiTaskPlanForIntent(options);
    if (!plan) return intent;
    const index = selectedMultiTaskIndex(input);
    const task = plan.tasks[index - 1];
    if (!task || task.operation !== stringValue(intent.operation)) return intent;
    const planRefs = Array.isArray(task.resource_refs) ? task.resource_refs : [];
    if (!planRefs.length) return intent;
    const modelRefs = Array.isArray(intent.resource_refs) ? intent.resource_refs : [];
    const modelKeys = new Set(modelRefs.map(ref => stringValue(ref.candidate_key)));
    const missing = planRefs.filter(ref => !modelKeys.has(stringValue(ref.candidate_key)));
    const operation = stringValue(intent.operation);
    const merged = [...modelRefs, ...missing];
    const resource_refs = merged.map(ref => {
      const candidateKey = stringValue(ref.candidate_key);
      const type = resourceTypeForCandidateKey?.(candidateKey)
        || (candidateKey.startsWith('i') ? 'image' : candidateKey.startsWith('f') ? 'file' : 'message');
      return { candidate_key: candidateKey, role: canonicalTaskBindingRole(operation, type, stringValue(ref.role)) };
    });
    const rolesUnchanged = resource_refs.every((ref, i) => (
      stringValue(ref.role) === stringValue(merged[i]?.role)
      && stringValue(ref.candidate_key) === stringValue(merged[i]?.candidate_key)
    ));
    // Only a no-op selection (model already bound every plan key with the
    // canonical role) may keep the intent untouched; restored plan refs must
    // always be merged back so the binding reaches the compiler.
    if (!missing.length && rolesUnchanged) return intent;
    return { ...intent, resource_refs };
  }
  function executionPromptForIntent(intent = {}, options = {}, taskState = null) {
    const input = stringValue(options.input || options.current_input);
    const operation = stringValue(intent.operation);
    const goal = stringValue(intent.goal);
    if (!goal) return input;
    // Chat-family providers receive the user's literal instruction. The route
    // goal is routing metadata only; it must never rewrite a text question or
    // drop exact wording before the final model sees the conversation.
    if (operation === 'web_search') {
      // Search goals are the route node's normalized query. Short follow-ups
      // such as "尼泊尔情况呢" otherwise lose the inherited event/topic
      // before the search-capable chat model can execute them.
      return (stringValue(intent.relation) !== 'new' || input.length <= 24) ? goal : input;
    }
    if (capabilityFor(operation)?.api === 'chat') {
      // A multi-task clarification answer uses the raw input only as a task
      // selector ("3"); the model-selected task goal is the real instruction
      // and must be the provider prompt. Otherwise keep the raw input verbatim.
      const plan = options.context?.multi_task_plan || options.context?.clarification_context?.multi_task_plan;
      if (plan && Array.isArray(plan.tasks) && plan.tasks.length) return goal || input;
      if (isTaskSelectionInput(input) && goal && goal !== input) return goal;
      return input || goal;
    }
    if (operation === 'text_to_image') {
      const state = taskState || imageTaskContinuityForIntent(intent, options);
      return renderTaskContinuity(state);
    }
    // An edit request sends only the current edit instruction because the bound
    // target image carries the visual baseline. The structured task state is
    // persisted separately for future text-only redesigns and revisions.
    if (operation === 'edit_image' || operation === 'image_reference_gen') return goal;
    if (!input || goal === input) return goal || input;
    if (stringValue(intent.relation) === 'new'
        && !(Array.isArray(intent.resource_refs) && intent.resource_refs.length)) return input;
    // The resolved model goal is the provider instruction. Preserve raw input
    // only when it is materially longer than the bounded goal, so explicit tail
    // constraints are not lost; keep the supplement plain and human-readable.
    if (input.length > ROUTE_INTENT_MAX_GOAL_LENGTH && !goal.includes(input)) {
      return `${goal}\n\n补充要求：\n${input}`;
    }
    return goal;
  }

  function modelOwnsRouteSemantics(options = {}) {
    const authority = stringValue(options.semanticAuthority);
    return authority === ROUTE_INTENT_VERSION || authority === IMAGE_PLAN_VERSION;
  }

  const LOCAL_ROUTE_TRANSFORM_POLICY = Object.freeze({
    model_owned: Object.freeze({ allowedSemanticFields: Object.freeze([]) }),
    local_compiler: Object.freeze({ allowedSemanticFields: Object.freeze(['operation', 'relation']) }),
  });

  function recordSemanticNormalization(options = {}, change = {}) {
    const field = stringValue(change.field);
    const from = stringValue(change.from);
    const to = stringValue(change.to);
    const reason = stringValue(change.reason);
    if (!field || !reason || from === to) return;
    options.recordSemanticNormalization?.(Object.freeze({ field, from, to, reason }));
  }

  function semanticNormalizationEvidence(original = {}, finalValue = {}, options = {}, records = []) {
    const policy = modelOwnsRouteSemantics(options)
      ? LOCAL_ROUTE_TRANSFORM_POLICY.model_owned
      : LOCAL_ROUTE_TRANSFORM_POLICY.local_compiler;
    const allowed = new Set(policy.allowedSemanticFields);
    const state = {
      operation: stringValue(original.operation),
      relation: stringValue(original.relation),
    };
    const normalizedRecords = [];
    for (const record of records) {
      const field = stringValue(record?.field);
      if (!allowed.has(field)) {
        const error = new TypeError(`Semantic normalization is not allowed for ${field || 'unknown'}`);
        error.code = 'ROUTE_SEMANTIC_NORMALIZATION_FORBIDDEN';
        throw error;
      }
      if (state[field] !== stringValue(record.from)) {
        const error = new TypeError(`Semantic normalization chain is inconsistent for ${field}`);
        error.code = 'ROUTE_SEMANTIC_NORMALIZATION_UNDECLARED';
        throw error;
      }
      const normalized = Object.freeze({
        field,
        from: state[field],
        to: stringValue(record.to),
        reason: stringValue(record.reason),
      });
      state[field] = normalized.to;
      normalizedRecords.push(normalized);
    }
    const finalSemantic = {
      operation: stringValue(finalValue.operation),
      relation: stringValue(finalValue.relation),
    };
    for (const field of ['operation', 'relation']) {
      if (state[field] !== finalSemantic[field]) {
        const error = new TypeError(`Semantic normalization for ${field} lacks declared evidence`);
        error.code = 'ROUTE_SEMANTIC_NORMALIZATION_UNDECLARED';
        throw error;
      }
    }
    const normalizedFrom = {};
    for (const field of ['operation', 'relation']) {
      const originalValue = stringValue(original[field]);
      if (originalValue !== finalSemantic[field]) normalizedFrom[field] = originalValue;
    }
    const reasons = [...new Set(normalizedRecords.map(record => record.reason))];
    return Object.freeze({
      normalizedFrom: Object.keys(normalizedFrom).length ? Object.freeze(normalizedFrom) : null,
      normalizationReason: reasons.join(','),
      normalizationChanges: Object.freeze(normalizedRecords),
    });
  }

  function modelBindingAllowed(operation = '', candidateType = '', role = '') {
    if (typeof resourceRequirementsFor !== 'function') return false;
    return resourceRequirementsFor(operation).some(requirement => (
      requirement.type === candidateType && requirement.roles.includes(role)
    ));
  }


  function clarificationAlreadyResolvedFor(requirement = {}, context = {}) {
    const resolution = resolvedClarificationContext(context);
    if (!resolution) return false;
    return clarificationResourceFacts(resolution).some(resource => (
      stringValue(resource?.type) === requirement.type
      && requirement.roles.includes(stringValue(resource?.role))
    ));
  }

  function forcedModelBindingIssues(operation = '', validBindings = [], invalidRefs = [], options = {}) {
    const issues = [];
    for (const requirement of requiredResourceSpecs(operation)) {
      const satisfied = validBindings.some(binding => (
        binding.type === requirement.type && requirement.roles.includes(binding.role)
      ));
      if (satisfied || clarificationAlreadyResolvedFor(requirement, options.context || {})) continue;
      const relatedInvalidRef = invalidRefs.some(ref => (
        requirement.roles.includes(ref.role) || ref.type === requirement.type
      ));
      if (!relatedInvalidRef) continue;

      // An incompatible model ref never authorizes a hidden resource. The
      // full recoverable pool is exposed only as non-executable clarification
      // choices so the user can explicitly select a new canonical binding.
      const allCandidates = buildResourceCandidates(
        options.attachments,
        options.context,
        options.input || options.current_input || '',
        { includeAllImageMemoryCards: requirement.type === 'image' },
      ).filter(candidate => candidate.type === requirement.type);
      const available = allCandidates.filter(candidate => candidate.availability !== 'unavailable');
      const unavailable = allCandidates.filter(candidate => candidate.availability === 'unavailable');
      issues.push(unresolvedResourceIssue({
        type: requirement.type,
        role: requirement.role,
        reason: available.length ? 'ambiguous' : unavailable.length ? 'unavailable' : 'missing',
        candidates: available,
      }));
    }
    return issues;
  }

  function forcedModelAbstentionIssues(operation = '', validBindings = [], resourceRefs = [], options = {}) {
    if (Array.isArray(resourceRefs) && resourceRefs.length) return [];
    const priorContext = contextBeforeCurrentTurn(options.context || {}, options.currentTurn);
    const visibleMessageIndexes = new Set((Array.isArray(priorContext?.recent_messages) ? priorContext.recent_messages : [])
      .map(message => Number(message?.index))
      .filter(index => Number.isInteger(index) && index >= 1));
    const fullCatalog = buildResourceCandidates(
      options.attachments,
      priorContext,
      options.input || options.current_input || '',
    );
    const issues = [];
    for (const requirement of requiredResourceSpecs(operation)) {
      if (requirement.type !== 'file') continue;
      const satisfied = validBindings.some(binding => (
        binding.type === requirement.type && requirement.roles.includes(binding.role)
      ));
      if (satisfied || clarificationAlreadyResolvedFor(requirement, priorContext)) continue;
      const visibleCandidates = candidatePoolFor(requirement.type, fullCatalog, stringValue(options.relation || 'followup'))
        .filter(candidate => candidate.source !== 'history'
          || visibleMessageIndexes.has(Number(candidate.message_index)));
      const available = visibleCandidates.filter(candidate => candidate.availability !== 'unavailable');
      if (available.length > 1) {
        issues.push(unresolvedResourceIssue({
          type: requirement.type,
          role: requirement.role,
          reason: 'ambiguous',
          candidates: available,
        }));
      }
    }
    return issues;
  }
  function emptyCurrentAttachmentSetDefault(intent = {}, options = {}) {
    const input = Object.prototype.hasOwnProperty.call(options, 'input')
      ? stringValue(options.input)
      : stringValue(options.current_input);
    if (input || options.context?.quoted_message) return { intent, applied: false };
    const catalog = routeCompilationCandidateCatalog(options);
    const currentMedia = catalog.filter(candidate => (
      candidate?.source === 'current' && ['image', 'file'].includes(candidate?.type)
    ));
    const availableMedia = currentMedia.filter(candidate => candidate.availability !== 'unavailable');
    if (!currentMedia.length
        || availableMedia.length !== currentMedia.length
        || currentMedia.length > ROUTE_INTENT_MAX_RESOURCE_REFS) {
      return { intent, applied: false };
    }
    const currentImages = currentMedia.filter(candidate => candidate.type === 'image');
    const currentFiles = currentMedia.filter(candidate => candidate.type === 'file');
    const operation = currentImages.length && currentFiles.length
      ? 'multimodal_qa'
      : currentImages.length
        ? 'image_qa'
        : 'file_qa';
    const goal = operation === 'multimodal_qa'
      ? EMPTY_MULTIMODAL_ANALYSIS_GOAL
      : operation === 'image_qa'
        ? EMPTY_IMAGE_ANALYSIS_GOAL
        : EMPTY_FILE_ANALYSIS_GOAL;
    return {
      applied: true,
      intent: {
        ...intent,
        operation,
        relation: 'new',
        goal,
        goal_mode: 'replace',
        task_shape: 'single',
        resource_refs: currentMedia.map(candidate => ({
          candidate_key: candidate.candidate_key,
          role: candidate.type === 'image' ? 'source' : 'attachment',
        })),
      },
    };
  }

  // An empty submission with current attachments carries no textual task
  // ambiguity. Compile the canonical inspection route before calling a route
  // model so a provider cannot turn an otherwise deterministic upload into an
  // invalid empty-goal response or omit part of the submitted media set.
  function compileEmptyCurrentAttachmentSetRoute(options = {}) {
    const defaulted = emptyCurrentAttachmentSetDefault({}, options);
    if (!defaulted.applied) return { route: null, reason: '' };
    return compileRouteIntent(defaulted.intent, options);
  }

  // The model proposes resource roles, but the operation's canonical binding
  // role wins deterministically: read-only image operations bind images as
  // source, file_qa/multimodal_qa bind files as attachment, and
  // image_reference_gen maps target/source onto reference. Without this, a
  // model that names the exact images with an off-by-one role label (e.g.
  // target on image_qa) would have its already-resolved refs rejected and the
  // user re-asked to select them.
  function canonicalModelRefRole(operation = '', type = '', role = '') {
    const canonical = canonicalTaskBindingRole(operation, type, role);
    if (canonical !== role) return canonical;
    try {
      return canonicalBindingRole(operation, type, role);
    } catch {
      return canonical;
    }
  }

  // When the model planner returns an invalid or unfaithful plan, build a
  // deterministic plan straight from the (reconciled) understanding actions so
  // the user still gets selectable task options instead of a rejection.
  function buildFallbackMultiTaskPlan(actions = [], options = {}) {
    const input = stringValue(options?.input);
    const tasks = (Array.isArray(actions) ? actions : []).filter(Boolean).slice(0, 8).map((action, index) => {
      const kind = stringValue(action?.kind);
      const operation = operationForKind(kind);
      const goal = stringValue(action?.target) || input || ('任务 ' + (index + 1));
      const resource_refs = (Array.isArray(action?.resolved_refs) ? action.resolved_refs : []).map(ref => {
        const candidateKey = stringValue(ref?.candidate_key);
        const type = resourceTypeForCandidateKey?.(candidateKey) || (candidateKey.startsWith('f') ? 'file' : candidateKey.startsWith('i') ? 'image' : 'message');
        const role = type === 'file' ? 'attachment' : type === 'image' ? 'source' : 'context';
        return { candidate_key: candidateKey, role };
      });
      return { key: 't' + (index + 1), operation, description: goal.slice(0, 118) || ('任务 ' + (index + 1)), goal, resource_refs };
    });
    return { schema_version: 'multi_task_plan.v1', tasks };
  }

  // The user's uploaded/preview order is the authoritative image order.
  // candidate_key uses the upload index (i1, i2, ...), so ordering the refs by
  // that index keeps the execution request identical to the order the user saw,
  // and lets the role guide name each image by the same order. The image model
  // proves reliable when the role guide and the submitted image order agree.
  function imageRefCandidateOrder(ref = {}) {
    const key = String(ref?.candidate_key || '');
    const match = key.match(/(\d+)$/);
    return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
  }

  function orderImageInputRefs(resourceRefs = []) {
    return [...(Array.isArray(resourceRefs) ? resourceRefs : [])]
      .sort((left, right) => {
        const difference = imageRefCandidateOrder(left) - imageRefCandidateOrder(right);
        return difference || 0;
      });
  }

  function routeIntentToDraft(intent = {}, options = {}) {
    const operation = stringValue(intent.operation);
    const catalog = routeCompilationCandidateCatalog(options);
    const byCandidateKey = new Map(catalog.map(candidate => [candidate.candidate_key, candidate]));
    const bindings = [];
    const invalidRefs = [];
    // Preserve the user's upload order: see orderImageInputRefs.
    const orderedRefs = operation === 'edit_image'
      ? orderImageInputRefs(intent.resource_refs || [])
      : (intent.resource_refs || []);
    for (const [index, ref] of orderedRefs.entries()) {
      const candidateKey = stringValue(ref.candidate_key);
      const candidate = byCandidateKey.get(candidateKey);
      const type = candidate?.type
        || resourceTypeForCandidateKey?.(candidateKey)
        || (candidateKey.startsWith('i') ? 'image' : candidateKey.startsWith('f') ? 'file' : 'message');
      const role = stringValue(ref.role);
      const canonicalRole = canonicalModelRefRole(operation, type, role);
      if (modelBindingAllowed(operation, type, canonicalRole)) {
        if (candidate) {
          bindings.push(bindingForCandidate(candidate, canonicalRole, `r${bindings.length + 1}`));
        } else {
          // Preserve an unknown but type/role-compatible key as unresolved
          // evidence. Resource validation may clarify it, but it may not change
          // the model-selected operation, relation, goal, or task shape.
          bindings.push({
            key: `r${bindings.length + 1}`,
            type,
            role: canonicalRole,
            resource_id: candidateKey,
            source: 'context',
          });
        }
      } else {
        invalidRefs.push({ index, candidate_key: candidateKey, type, role: canonicalRole });
      }
    }
    return {
      plan: {
        operation,
        relation: stringValue(intent.relation),
        arguments: {},
        bindings,
        constraints: [],
      },
      forcedClarificationIssues: [
        ...forcedModelBindingIssues(operation, bindings, invalidRefs, options),
        ...forcedModelAbstentionIssues(operation, bindings, intent.resource_refs, {
          ...options,
          relation: stringValue(intent.relation),
        }),
      ],
    };
  }

  // When the user explicitly quoted a message but the route model omitted a
  // message binding, the execution plan would be compiled with
  // context_policy.quoted=false while the final chat payload still contains the
  // quoted block. That exact mismatch is rejected as
  // EXECUTION_CONTEXT_QUOTE_MISMATCH. If a quoted message candidate is
  // published, bind it deterministically for chat-family operations.
  function reconcileQuotedMessageBinding(intent = {}, options = {}) {
    const catalog = Array.isArray(options.candidateCatalog) ? options.candidateCatalog : [];
    const quotedCandidate = catalog.find(candidate => (
      stringValue(candidate?.type) === 'message'
      && stringValue(candidate?.source) === 'quoted'
    ));
    if (!quotedCandidate) return intent;
    const operation = stringValue(intent.operation);
    if (!modelBindingAllowed(operation, 'message', 'context')) return intent;
    const refs = Array.isArray(intent.resource_refs) ? intent.resource_refs : [];
    const candidateKey = stringValue(quotedCandidate.candidate_key);
    if (refs.some(ref => stringValue(ref.candidate_key) === candidateKey)) return intent;
    // If another quoted resource already anchors the turn (for example a
    // quoted image in image_qa), do not add a redundant message-context
    // binding. The quote is already represented in the execution plan.
    const alreadyQuotedBinding = refs.some(ref => {
      const candidate = catalog.find(item => stringValue(item?.candidate_key) === stringValue(ref?.candidate_key));
      return stringValue(candidate?.source) === 'quoted';
    });
    if (alreadyQuotedBinding) return intent;
    return { ...intent, resource_refs: [...refs, { candidate_key: candidateKey, role: 'context' }] };
  }

  function compileRouteIntent(intent = {}, options = {}) {
    try {
      // The route model may select only candidates that crossed its request
      // boundary. Local deterministic compilers can still use the full catalog
      // when they run explicitly, but a model proposal cannot resurrect hidden
      // history resources during binding, supplementation, or clarification.
      const candidateCatalog = modelRouteCandidateCatalog(options);
      const scopedOptions = { ...options, candidateCatalog };
      // With no user text, the complete usable current attachment set has one
      // protocol-defined default: inspect everything submitted in this turn. A
      // model-selected subset would silently discard uploaded images or files.
      const defaulted = emptyCurrentAttachmentSetDefault(intent, scopedOptions);
      let effectiveIntent = defaulted.intent;
      effectiveIntent = reconcileSelectedTaskBindings(
        normalizeAmendWithoutBase(reconcileModelIntent(effectiveIntent, options, candidateCatalog), options),
        options,
      );
      effectiveIntent = reconcileQuotedMessageBinding(effectiveIntent, { ...scopedOptions, candidateCatalog });
      effectiveIntent = reconcileExplicitWebSearchDirective(effectiveIntent, scopedOptions);
      const goal = stringValue(effectiveIntent.goal).slice(0, ROUTE_INTENT_MAX_GOAL_LENGTH);
      const goalMode = goalModeForIntent(effectiveIntent);
      const taskState = imageTaskContinuityForIntent(effectiveIntent, options);
      const resolvedImageGoal = resolvedImageGoalForIntent(effectiveIntent, options, taskState);
      const draft = routeIntentToDraft(effectiveIntent, scopedOptions);
      const taskShape = (options.taskShapeOverride === 'single' || options.taskShapeOverride === 'multi')
        ? options.taskShapeOverride
        : (typeof routeIntentTaskShape === 'function'
          ? routeIntentTaskShape(effectiveIntent)
          : stringValue(effectiveIntent.task_shape));
      const route = compileLocalRoute(draft.plan, {
        ...scopedOptions,
        planningImageTasks: options.understandingBranch === 'image_plan'
          ? true
          : options.understandingBranch === 'multi_task_plan'
            ? false
            : taskShape === 'multi' && IMAGE_RELATION_OPERATIONS.has(stringValue(effectiveIntent.operation)),
        taskShape,
        goalMode,
        imageTaskState: taskState,
        semanticAuthority: ROUTE_INTENT_VERSION,
        forcedClarificationIssues: draft.forcedClarificationIssues,
        userGoal: goal,
        resolvedImageGoal,
        executionInput: executionPromptForIntent(effectiveIntent, options, taskState),
        // Execution envelopes retain raw user wording for transparent routing,
        // while image providers receive only the canonical task continuity goal.
        ...(stringValue(effectiveIntent.operation) === 'text_to_image'
          ? { providerPrompt: resolvedImageGoal }
          : {}),
      });
      const compiledRoute = route ? {
        ...route,
        taskShape,
        ...(defaulted.applied ? { inputDefault: 'all_current_attachments' } : {}),
      } : null;
      return {
        route: compiledRoute,
        reason: '',
      };
    } catch (error) {
      return {
        route: null,
        reason: 'route_compilation_failed',
        error: String(error.message).slice(0, 200),
      };
    }
  }

  // Deterministic complexity gate: run the understand node only when the input
  // needs deictic resolution or can contain several ordered actions. Simple
  // instructions keep the single-call route path.
  function shouldRunUnderstanding(input = '', attachments = [], context = {}) {
    const text = stringValue(input);
    // Quoted evidence must take the understand -> route path even when the
    // current input is empty. The simple-path prompt is only safe when there
    // is no quoted anchor to resolve.
    const quoted = !!context?.quoted_message
      || Array.isArray(context?.file_candidates) && context.file_candidates.some(item => stringValue(item?.source) === 'quoted')
      || Array.isArray(context?.image_candidates) && context.image_candidates.some(item => stringValue(item?.source) === 'quoted');
    if (quoted) return true;
    if (!text) return false;
    // A single current attachment is ordinary evidence for the route model;
    // it does not by itself justify a second semantic model call. Escalate
    // only when there are multiple resources or explicit contextual/deictic
    // complexity below.
    if (Array.isArray(attachments) && attachments.length > 1) return true;
    if (/(?:这个|那个|它|这张|那幅|上一张|第[一二三四五六七八九十\d]+[张幅个]|最近话题)/.test(text)) return true;
    // An active execution/focus turns short anaphoric continuations into a
    // contextual routing problem. Let the understanding node resolve them
    // against the previous task and its resources instead of treating them as
    // standalone simple text.
    const contextualContinuity = !!(context?.previous_execution || context?.previous_resource_execution || context?.conversation_focus);
    const anaphoricOnly = /^(?:这个|那个|它|这|那|哪个|什么|怎么样|效果|呢)/.test(text)
      && !/(?:生成|画|绘制|制作|创建|设计|改成|改为|变成|换成|修改|编辑|参考|比较|分析|总结|统计|写|做|读|看|识别|提取|翻译|解释)/.test(text);
    if (contextualContinuity && text.length <= 40 && anaphoricOnly) return true;
    return /(?:先|再|然后|之后|接着|同时|分别|既要|又要|最后|首先|第一步)/.test(text);
  }

  function buildUnderstandingPayload({ model, input, attachments = [], context = {}, currentTurn = null, intentReasoning = null } = {}) {
    assertInputWithinUnifiedLimit(stringValue(input));
    const priorContext = contextBeforeCurrentTurn(context, currentTurn);
    const resourceCatalog = wireResourceCandidates(attachments, priorContext, input);
    const catalogMetadata = compactResourceCatalogMetadata(resourceCatalog);
    const compactClaims = compactIntentClaims(input, priorContext);
    const userPayload = {
      current_input: stringValue(input),
      evidence_priority: ROUTE_EVIDENCE_PRIORITY,
      resource_candidates: resourceCatalog.map(compactWireResourceCandidate),
      context: compactWireRouteContext(priorContext, input, resourceCatalog),
    };
    if (compactClaims.length) userPayload.intent_claims = compactClaims;
    if (catalogMetadata) userPayload.resource_catalog = catalogMetadata;
    userPayload.output_format = 'json';
    if (currentTurn && typeof currentTurn === 'object') userPayload.current_turn = currentTurn;
    const systemPrompt = Array.isArray(UNDERSTAND_SYSTEM_PROMPT_LINES) && UNDERSTAND_SYSTEM_PROMPT_LINES.length
      ? UNDERSTAND_SYSTEM_PROMPT_LINES.join('\n')
      : ROUTE_SYSTEM_PROMPT;
    if (typeof buildResponsesPayload !== 'function') throw new Error('Responses payload service is unavailable');
    return buildResponsesPayload(model, [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: JSON.stringify(userPayload) },
    ], {
      stream: false,
      ...intentReasoningPayloadOptions(intentReasoning),
      responseFormat: UNDERSTANDING_RESPONSE_FORMAT,
    });
  }

  // The critic is a read-only semantic coverage check. It receives the
  // normalized route proposal and deterministic claim inventory, but never an
  // execution contract or provider credentials.
  function buildIntentCriticPayload({ model, input, attachments = [], context = {}, currentTurn = null, understanding = null, route = null, rawRoute = null, intentReasoning = null } = {}) {
    assertInputWithinUnifiedLimit(stringValue(input));
    const priorContext = contextBeforeCurrentTurn(context, currentTurn);
    const resourceCatalog = wireResourceCandidates(attachments, priorContext, input);
    const catalogMetadata = compactResourceCatalogMetadata(resourceCatalog);
    const claims = typeof intentClaimsModule.extractClaims === 'function'
      ? intentClaimsModule.extractClaims(input)
      : [];
    const userPayload = {
      current_input: stringValue(input),
      claims,
      semantic_intent: semanticIntentForRoute(input, understanding, priorContext),
      understanding: understanding && typeof understanding === 'object' ? understanding : null,
      route: rawRoute && typeof rawRoute === 'object' ? rawRoute : {
        operation: stringValue(route?.operationType || route?.operation || route?.intent),
        relation: stringValue(route?.relation),
        goal: stringValue(route?.userGoal || route?.goal),
        goal_mode: stringValue(route?.goalMode || route?.goal_mode),
        task_shape: stringValue(route?.taskShape || route?.task_shape),
        resources: Array.isArray(route?.resources) ? route.resources.map(resource => ({
          type: stringValue(resource?.type),
          role: stringValue(resource?.role),
          source: stringValue(resource?.source),
          index: Number(resource?.index) || 0,
        })) : [],
      },
      resource_candidates: resourceCatalog.map(compactWireResourceCandidate),
      context: compactWireRouteContext(priorContext, input, resourceCatalog),
      evidence_priority: ROUTE_EVIDENCE_PRIORITY,
      output_format: 'json',
    };
    if (catalogMetadata) userPayload.resource_catalog = catalogMetadata;
    if (typeof buildResponsesPayload !== 'function') throw new Error('Responses payload service is unavailable');
    return buildResponsesPayload(model, [
      { role: 'system', content: INTENT_CRITIC_SYSTEM_PROMPT },
      { role: 'user', content: JSON.stringify(userPayload) },
    ], {
      stream: false,
      ...intentReasoningPayloadOptions(intentReasoning),
      responseFormat: INTENT_CRITIC_RESPONSE_FORMAT,
    });
  }

  function inspectIntentCriticResult(text = '') {
    const parsed = parseRouteJson(text);
    if (!parsed.parsed) return { critic: null, reason: parsed.reason, parseError: parsed.parseError || '' };
    if (typeof hasExactIntentCritic !== 'function' || !hasExactIntentCritic(parsed.parsed)) {
      return { critic: null, reason: 'intent_critic_invalid' };
    }
    return { critic: normalizeIntentCritic(parsed.parsed), reason: '' };
  }

  function currentInputContainsConcreteRequirements(input = '') {
    const text = stringValue(input);
    const hasAction = /(?:生成|画|绘制|制作|创建|修改|编辑|改成|改为|换成|总结|分析|解释|说明|提取|判断|generate|draw|create|edit|summari[sz]e|explain)/i.test(text);
    const hasConcreteConstraint = /(?:\d+(?:\.\d+)?\s*(?:米|m|张|幅|个|条)|中央|堂屋|入口|进门|卧室|卫生间|厕所|餐厅|通行|分隔|不相邻|不放在一起|主体|构图|颜色|材质|风格|保持|保留|不要|不使用|不参照|必须)/i.test(text);
    return hasAction && hasConcreteConstraint;
  }

  function intentCriticSemanticIssues(critic = {}, options = {}) {
    const normalized = typeof normalizeIntentCritic === 'function' ? normalizeIntentCritic(critic) : critic;
    if (!normalized || normalized.verdict === 'accept') return [];
    const route = options.route && typeof options.route === 'object' ? options.route : {};
    const input = stringValue(options.input);
    const context = options.context && typeof options.context === 'object' ? options.context : {};
    const catalog = Array.isArray(options.resourceCatalog) ? options.resourceCatalog : [];
    const reasons = Array.isArray(normalized.reasons) ? normalized.reasons : [];
    const filtered = reasons.filter(reason => {
      const code = stringValue(reason?.code);
      const field = stringValue(reason?.field).toLowerCase();
      const operation = stringValue(route.operationType || route.operation || route.intent);
      const goalMode = stringValue(route.goalMode || route.goal_mode);
      const relation = stringValue(route.relation);
      const allowedOperations = deterministicOperationKeysForInput(input, context, catalog);
      const allowedRelations = exactRouteRelationConstraint(input, context, catalog);
      const allowedGoalModes = exactGoalModeConstraint(input, context);
      if ((field.endsWith('operation') || field === 'operation' || code === 'route_operation_mismatch')
          && Array.isArray(allowedOperations) && allowedOperations.length === 1
          && operation === allowedOperations[0]) return false;
      if ((field.endsWith('goal_mode') || field === 'goalmode')
          && ((allowedGoalModes.length === 1 && goalMode === allowedGoalModes[0])
            || (goalMode === 'replace' && operation === 'image_reference_gen')
            || (goalMode === 'replace' && !taskContinuityFromExecution?.(context.previous_execution || {}))
            || (goalMode === 'amend' && IMAGE_TASK_AMEND_OPERATIONS.has(operation)
              && EXPLICIT_PRIOR_SPEC_ACCEPTANCE_PATTERN.test(input)))) return false;
      if ((field.endsWith('relation') || field === 'relation')
          && allowedRelations.length === 1 && relation === allowedRelations[0]) return false;
      if ((field.includes('resource') || code === 'route_resource_mismatch')
          && deterministicResourceKeysForInput(input, context, catalog)?.length === 0
          && (!Array.isArray(route.resources) || route.resources.length === 0)) return false;
      if (code === 'route_dependency_lost'
          && currentInputContainsConcreteRequirements(input)
          && (!Array.isArray(normalized.ambiguous_bindings) || normalized.ambiguous_bindings.length === 0)
          && (!Array.isArray(normalized.missing_claims)
            || normalized.missing_claims.every(item => !/(缺少|未提供|无法恢复|历史指向|此前)/i.test(String(item))))) {
        return false;
      }
      return true;
    });
    if (filtered.length) return filtered;
    // A critic must not overturn a deterministic contract that already proves
    // the disputed field correct. Treat an unsupported critique as accepted
    // rather than burning the entire bounded repair budget.
    return [];
  }

  // A semantic route repair is a constrained proposal against an exact v3
  // baseline. It is deliberately a different protocol from route_intent.v3:
  // the model declares changed_fields and the local compiler applies only those
  // fields to the trusted baseline.
  function buildRouteRepairPayload({ model, input, attachments = [], context = {}, currentTurn = null, rejectedOutput = '', baseIntent = null, reasons = [], systemPrompt, understanding = null, currentMode = 'chat', autoMode = true, intentReasoning = null } = {}) {
    const hasBase = typeof hasExactRouteIntent === 'function' && hasExactRouteIntent(baseIntent || {});
    const priorContext = contextBeforeCurrentTurn(context, currentTurn);
    const resourceCatalog = wireResourceCandidates(attachments, priorContext, input);
    const repairFormat = hasBase && typeof routeRepairResponseFormatForCandidates === 'function'
      ? routeRepairResponseFormatForCandidates(resourceCatalog)
      : null;
    const payload = buildRoutePayload({
      model,
      input,
      attachments,
      context,
      currentTurn,
      ...(hasBase ? { systemPrompt: ROUTE_REPAIR_SYSTEM_PROMPT } : { systemPrompt }),
      understanding,
      currentMode,
      autoMode,
      intentReasoning,
      ...(repairFormat ? { responseFormat: repairFormat } : {}),
    });
    const repairReasons = (Array.isArray(reasons) ? reasons : []).map(item => (
      item && typeof item === 'object'
        ? { code: stringValue(item.code), field: stringValue(item.field), message: stringValue(item.message) }
        : stringValue(item)
    ));
    payload.input.push({
      role: 'user',
      content: JSON.stringify({
        repair_request: {
          protocol: hasBase ? ROUTE_REPAIR_VERSION : ROUTE_INTENT_VERSION,
          base_route_intent: hasBase ? baseIntent : undefined,
          rejected_output: stringValue(rejectedOutput).slice(0, 8000),
          reasons: repairReasons,
          allowed_fields: hasBase ? [...routeRepairAllowedFields(repairReasons)] : undefined,
          instruction: hasBase
            ? '只输出 route_repair.v1；changed_fields 必须只列出实际修改字段，未列出的字段必须与 base_route_intent 完全一致。'
            : '只修复 reasons 指出的语义问题；只输出 route_intent.v3 JSON。',
        },
      }),
    });
    return payload;
  }

  function inspectRouteRepairResult(text = '', { baseIntent = null } = {}) {
    const parsed = parseRouteJson(text);
    if (!parsed.parsed) return { repair: null, reason: parsed.reason, parseError: parsed.parseError || '' };
    if (typeof hasExactRouteRepair === 'function' && hasExactRouteRepair(parsed.parsed)) {
      return { repair: normalizeRouteRepair(parsed.parsed), reason: '', protocol: ROUTE_REPAIR_VERSION };
    }
    // Compatibility adapter for gateways that ignore the repair schema and
    // return a complete route_intent.v3 object. It is never applied wholesale:
    // derive the declared diff locally, then run the same field-permission and
    // baseline-preservation checks as a native route_repair.v1 response.
    if (typeof adaptLegacyRouteIntentRepair === 'function') {
      try {
        const adapted = adaptLegacyRouteIntentRepair(parsed.parsed, baseIntent || {});
        if (adapted) return { repair: adapted, reason: '', protocol: ROUTE_INTENT_VERSION };
      } catch {}
    }
    return { repair: null, reason: 'route_repair_invalid' };
  }

  const ROUTE_REPAIR_ALL_FIELDS = Object.freeze([
    'operation', 'relation', 'goal', 'goal_mode', 'resource_refs', 'task_shape',
  ]);

  function routeRepairAllowedFields(reasons = []) {
    const allowed = new Set();
    for (const item of Array.isArray(reasons) ? reasons : []) {
      const reason = item && typeof item === 'object' ? item : { code: stringValue(item), field: '' };
      const code = stringValue(reason.code);
      const field = stringValue(reason.field).toLowerCase().replace(/-/g, '_');
      if (code === 'route_intent_invalid' || code === 'intent_critic_invalid') {
        ROUTE_REPAIR_ALL_FIELDS.forEach(value => allowed.add(value));
        continue;
      }
      // The declared field is authoritative. Reason-code wording can mention a
      // resource while the actual repair authority is relation (for example,
      // "new with non-current resource"). Do not widen a patch by substring.
      if (field === 'operation') {
        ['operation', 'relation', 'goal', 'goal_mode', 'resource_refs', 'task_shape'].forEach(value => allowed.add(value));
      } else if (field === 'resource_refs') {
        ['resource_refs', 'operation', 'relation'].forEach(value => allowed.add(value));
      } else if (field === 'goal_mode' || field === 'goalmode') {
        ['goal_mode', 'goal'].forEach(value => allowed.add(value));
      } else if (field === 'goal') {
        allowed.add('goal');
      } else if (field === 'relation') {
        allowed.add('relation');
      } else if (field === 'task_shape' || field === 'taskshape') {
        allowed.add('task_shape');
      } else if (code.includes('operation')) {
        ['operation', 'relation', 'goal', 'goal_mode', 'resource_refs', 'task_shape'].forEach(value => allowed.add(value));
      } else if (code.includes('binding') || code.includes('resource')) {
        ['resource_refs', 'operation', 'relation'].forEach(value => allowed.add(value));
      } else if (code.includes('goal_mode')) {
        ['goal_mode', 'goal'].forEach(value => allowed.add(value));
      } else if (code.includes('goal')) {
        allowed.add('goal');
      } else if (code.includes('relation')) {
        allowed.add('relation');
      } else if (code.includes('task_shape')) {
        allowed.add('task_shape');
      }
    }
    return allowed;
  }

  function routeRepairValuesEqual(left, right, field) {
    if (field === 'resource_refs') return JSON.stringify(left || []) === JSON.stringify(right || []);
    return stringValue(left) === stringValue(right);
  }

  function applyRouteRepairResult(baseIntent = {}, repair = {}, reasons = []) {
    if (typeof hasExactRouteIntent !== 'function' || !hasExactRouteIntent(baseIntent)) {
      return { intent: null, reason: 'route_repair_base_invalid' };
    }
    if (typeof hasExactRouteRepair !== 'function' || !hasExactRouteRepair(repair)) {
      return { intent: null, reason: 'route_repair_invalid' };
    }
    const changed = new Set(repair.changed_fields);
    const allowed = routeRepairAllowedFields(reasons);
    for (const field of changed) {
      if (!allowed.has(field)) return { intent: null, reason: 'route_repair_field_unauthorized', field };
    }
    for (const field of ROUTE_REPAIR_ALL_FIELDS) {
      if (changed.has(field)) continue;
      if (!routeRepairValuesEqual(repair[field], baseIntent[field], field)) {
        return { intent: null, reason: 'route_repair_undeclared_change', field };
      }
    }
    try {
      const intent = applyRouteRepair(baseIntent, repair);
      return { intent, reason: '', changedFields: [...changed] };
    } catch (error) {
      return { intent: null, reason: String(error?.code || 'route_repair_result_invalid') };
    }
  }

  // One bounded repair round for the understand node itself: append the
  // rejected output and its failure reason, then ask for a corrected
  // understanding.v1 object while preserving the caller's reasoning budget.
  function buildUnderstandingRepairPayload({ model, input, attachments = [], context = {}, currentTurn = null, rejectedOutput = '', reasons = [], intentReasoning = null } = {}) {
    const payload = buildUnderstandingPayload({ model, input, attachments, context, currentTurn, intentReasoning });
    payload.input.push({
      role: 'user',
      content: JSON.stringify({
        repair_request: {
          rejected_output: stringValue(rejectedOutput).slice(0, 8000),
          reasons: (Array.isArray(reasons) ? reasons : []).map(item => stringValue(item)),
          instruction: '只修复 reasons 指出的问题，其余保持不变。只输出 json。',
        },
      }),
    });
    return payload;
  }

  // The understanding node may label a text-only request as a resource task
  // ("统计引用消息的字数" → file_read) when the catalog contains none of the
  // required resource types. Such a kind can never execute and would drag the
  // route node into file_qa/image_qa with a message bound as a file. Reconcile
  // deterministically to plain_text (message refs stay as context evidence).
  // When a candidate of the required type exists, the kind is left untouched:
  // a missing binding stays a binding concern, not a kind change.
  const READ_RESOURCE_KINDS = Object.freeze(new Set(['file_read', 'image_read', 'ocr']));

  function reconcileUnderstandingKinds(understanding = {}, resourceCatalog = [], context = {}) {
    if (!understanding || typeof understanding !== 'object') return understanding;
    const actions = Array.isArray(understanding.actions) ? understanding.actions : [];
    if (!actions.length) return understanding;
    const typeExists = type => (Array.isArray(resourceCatalog) ? resourceCatalog : [])
      .some(candidate => stringValue(candidate?.type) === type && candidate?.availability !== 'unavailable');
    let changed = false;
    const reconciled = actions.map(action => {
      const kind = stringValue(action?.kind);
      const refTypes = new Set((Array.isArray(action?.resolved_refs) ? action.resolved_refs : [])
        .map(ref => resourceTypeForCandidateKey?.(stringValue(ref?.candidate_key)) || ''));
      const hasMessageRef = refTypes.has('message');
      // plain_text may only carry message/context evidence. A bound file or
      // image ref means the model under-classified a resource task (e.g.
      // "总结引言.docx" as plain_text); promote it so the multi-task plan
      // expects the matching resource operation instead of failing 1:1.
      if (kind === 'plain_text') {
        if (refTypes.has('file') && typeExists('file')) { changed = true; return { ...action, kind: 'file_read' }; }
        if (refTypes.has('image') && typeExists('image')) { changed = true; return { ...action, kind: 'image_read' }; }
        return action;
      }
      if (!READ_RESOURCE_KINDS.has(kind)) return action;
      const requiredTypes = Object.keys(requiredResourceRoles(kind) || {}).filter(type => type !== 'message');
      if (!requiredTypes.length) return action;
      const impossible = hasMessageRef && requiredTypes.every(type => !refTypes.has(type) && !typeExists(type));
      if (!impossible) return action;
      changed = true;
      return { ...action, kind: 'plain_text' };
    });
    return changed ? { ...understanding, actions: reconciled } : understanding;
  }

  function inspectUnderstandingResult(text = '', options = {}) {
    try {
      const raw = JSON.parse(stringValue(text).replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim());
      if (typeof hasExactUnderstanding !== 'function' || !hasExactUnderstanding(raw)) return { understanding: null, reason: 'intent_understanding_invalid' };
      const priorContext = contextBeforeCurrentTurn(options.context || {}, options.currentTurn);
      const resourceCatalog = wireResourceCandidates(options.attachments, priorContext, options.input || '');
      const reconciledKinds = reconcileUnderstandingKinds(raw, resourceCatalog, options.context || {});
      return { understanding: reconciledKinds, reason: '' };
    } catch {
      return { understanding: null, reason: 'intent_understanding_parse_failed' };
    }
  }

  function extractExactRouteIntent(text = '') {
    const parsed = parseRouteJson(text);
    if (!parsed.parsed || typeof hasExactRouteIntent !== 'function' || !hasExactRouteIntent(parsed.parsed)) return null;
    return parsed.parsed;
  }

  function inspectModelRouteResult(text = '', options = {}) {
    const parsedResult = parseRouteJson(text);
    if (!parsedResult.parsed) return parsedResult;
    let intent = parsedResult.parsed;
    if (typeof hasExactRouteIntent !== 'function' || !hasExactRouteIntent(intent)) {
      if (typeof hasExactLegacyRouteIntentV2 === 'function'
          && typeof adaptLegacyRouteIntentV2 === 'function'
          && hasExactLegacyRouteIntentV2(intent)) {
        const previousTaskState = typeof taskContinuityFromExecution === 'function'
          ? taskContinuityFromExecution(options.context?.previous_execution || {})
          : null;
        intent = adaptLegacyRouteIntentV2(intent, { hasPreviousTaskState: !!previousTaskState });
      } else {
        const looksLikeRouteIntent = ['operation', 'relation', 'goal', 'goal_mode', 'resource_refs']
          .some(field => Object.prototype.hasOwnProperty.call(intent || {}, field));
        return {
          route: null,
          reason: looksLikeRouteIntent ? 'route_intent_invalid' : 'route_intent_required',
        };
      }
    }
    return compileRouteIntent(intent, options);
  }

  function hasQuotedEvidence(context = {}) {
    return !!context?.quoted_message
      || (Array.isArray(context?.image_candidates) && context.image_candidates.some(item => stringValue(item?.source) === 'quoted'))
      || (Array.isArray(context?.file_candidates) && context.file_candidates.some(item => stringValue(item?.source) === 'quoted'));
  }

  // Deterministic reconciliation: local quoted/history facts beat model-written
  // understanding.dependency before the route node maps it. This prevents the
  // route repair loop from receiving two contradictory authorities (copy the
  // dependency verbatim vs. fix a locally provable followup contradiction).
  function reconcileUnderstandingDependency(understanding = {}, resourceCatalog = [], context = {}) {
    if (!understanding || typeof understanding !== 'object') return 'new';
    if (hasQuotedEvidence(context)) return 'followup';
    const sourceByKey = new Map();
    for (const candidate of resourceCatalog) {
      const key = stringValue(candidate?.candidate_key);
      if (!key || sourceByKey.has(key)) continue;
      sourceByKey.set(key, stringValue(candidate?.source));
    }
    const dependency = stringValue(understanding.dependency);
    const actions = Array.isArray(understanding.actions) ? understanding.actions : [];
    for (const action of actions) {
      const refs = Array.isArray(action?.resolved_refs) ? action.resolved_refs : [];
      for (const ref of refs) {
        const source = sourceByKey.get(stringValue(ref?.candidate_key));
        // A non-current resource proves this is not a brand-new turn, but it
        // does not by itself decide between followup and continuation. Only
        // promote an explicitly new dependency; preserve continuation.
        if (source && source !== 'current' && dependency === 'new') return 'followup';
      }
    }
    return dependency || 'new';
  }

  // Node-3 semantic validation: only deterministic contradictions are retryable.
  // Semantic decisions stay with the model; these checks repair clear
  // inconsistencies against local evidence without inventing a new route.
  function routeIntentSemanticIssues(route = {}, options = {}) {
    const issues = [];
    if (!route || typeof route !== 'object') return issues;
    if (route.needClarification === true || route.readiness !== 'ready') return issues;
   const relation = stringValue(route.relation);
    const goal = stringValue(route.userGoal);
    const goalMode = stringValue(route.goalMode) || 'replace';
    const context = options.context || {};
    const resources = Array.isArray(route.resources) ? route.resources : [];

    const quotedEvidencePresent = hasQuotedEvidence(context);
    if (quotedEvidencePresent && relation !== 'followup') {
      issues.push({
        code: 'quoted_evidence_requires_followup',
        field: 'relation',
        message: '本轮存在 quoted 引用证据时，quoted 正文作事实属于 followup 且压过继续语义，relation 不得为 new/continuation。',
      });
    }

    const hasNonCurrentResource = resources.some(resource => stringValue(resource?.source)
      && stringValue(resource.source) !== 'current');
    if (relation === 'new' && hasNonCurrentResource) {
      issues.push({
        code: 'relation_new_with_noncurrent_resource',
        field: 'relation',
        message: '存在非 current 的历史/引用资源时 relation 不得为 new，应按资源依赖改为 followup 或 continuation。',
      });
    }

    // Whether an amend has an inheritable base must mean exactly what the
    // execution pipeline means. A previous image execution may carry an
    // explicit task_state, or a legacy resolved_goal/input from which
    // taskContinuityFromExecution derives the base state. Checking only the
    // raw task_state field rejected legitimate amends and sent the repair
    // loop into an unsatisfiable amend_requires_previous_task_state cycle
    // that ended in route_intent_invalid ("意图模型返回了无效的任务结构").
    const previousExecution = context.previous_execution && typeof context.previous_execution === 'object'
      ? context.previous_execution
      : null;
    let hasPreviousTaskState = false;
    if (previousExecution) {
      try {
        hasPreviousTaskState = typeof taskContinuityFromExecution !== 'function'
          || !!taskContinuityFromExecution(previousExecution);
      } catch {
        hasPreviousTaskState = false;
      }
    }
    if (goalMode === 'amend' && !hasPreviousTaskState) {
      issues.push({
        code: 'amend_requires_previous_task_state',
        field: 'goal_mode',
        message: 'goal_mode=amend 必须有可继承的前序图片 task_state；没有前序状态时应改为 replace 并输出完整 goal。',
      });
    }

    return issues;
  }

  // Raw-intent deterministic contradiction check, run before the compiled
  // route (a clarification route hides these from routeIntentSemanticIssues).
  // file_qa/multimodal_qa cannot consume a message as a file: a message ref
  // may only carry role=context, and a file-requiring operation must bind a
  // real fN file. These are model errors, so they enter the repair loop
  // instead of asking the user for a file.
  function routeIntentSemanticIssuesForIntent(rawText = '', options = {}) {
    const parsed = parseRouteJson(rawText);
    if (!parsed.parsed) return [];
    const intent = parsed.parsed;
    if (typeof hasExactRouteIntent !== 'function' || !hasExactRouteIntent(intent)) return [];
    const issues = [];
    const operation = stringValue(intent.operation);
    const refs = Array.isArray(intent.resource_refs) ? intent.resource_refs : [];
    const input = stringValue(options.input);
    if (['plain_chat', 'web_search'].includes(operation)
        && refs.some(ref => ['image', 'file'].includes(resourceTypeForCandidateKey?.(stringValue(ref?.candidate_key))))) {
      issues.push({
        code: 'route_resource_mismatch',
        field: 'resource_refs',
        message: '文字任务不应绑定图片或文件资源。',
      });
    }
    for (const ref of refs) {
      const candidateKey = stringValue(ref.candidate_key);
      const type = resourceTypeForCandidateKey?.(candidateKey) || '';
      const role = stringValue(ref.role);
      if (type === 'message' && role !== 'context') {
        issues.push({ code: 'route_message_ref_role_invalid', field: 'resource_refs', message: `消息 ${candidateKey} 只能绑定 role=context；${role} 是文件/图片角色。若本轮只涉及引用消息文字，请改用 plain_chat 并把 ${candidateKey} 绑定为 context。` });
      }
    }
    if (['file_qa', 'multimodal_qa'].includes(operation) && refs.length > 0
        && !refs.some(ref => resourceTypeForCandidateKey?.(stringValue(ref.candidate_key)) === 'file')) {
      issues.push({ code: 'route_operation_requires_file', field: 'operation', message: `${operation} 必须绑定 f=attachment 文件；当前 resource_refs 没有文件。若本轮只引用消息/历史文字，请改用 plain_chat 并绑定 mN=context。` });
    }
    return issues;
  }

  const ROUTE_MEMORY_MAX_ITEMS = 6;

  function normalizeRouteMemoryItem(item = {}) {
    return {
      input: stringValue(item?.input),
      operation: stringValue(item?.operation),
      relation: stringValue(item?.relation),
      task_shape: stringValue(item?.task_shape),
      confidence: Number(item?.confidence) || 0,
      source: stringValue(item?.source),
    };
  }

  // Session-scoped route memory keeps the last few resolved route decisions so
  // later turns can reuse them as low-priority evidence instead of resolving
  // the same resource/task from scratch. It is bounded and never persisted to
  // the provider; it only travels as compact routing context.
  function recordRouteMemory(session = {}, item = {}) {
    const next = normalizeRouteMemoryItem(item);
    if (!next.operation) return Array.isArray(session?.routeMemory) ? session.routeMemory : [];
    const previous = Array.isArray(session?.routeMemory) ? session.routeMemory : [];
    const deduped = previous.filter(existing => (
      normalizeRouteMemoryItem(existing).operation !== next.operation
      || normalizeRouteMemoryItem(existing).input !== next.input
    ));
    return [next, ...deduped].slice(0, ROUTE_MEMORY_MAX_ITEMS);
  }

  function routeMemoryContext(session = {}) {
    return (Array.isArray(session?.routeMemory) ? session.routeMemory : [])
      .slice(0, ROUTE_MEMORY_MAX_ITEMS)
      .map(item => {
        const normalized = normalizeRouteMemoryItem(item);
        return Object.freeze({
          input: normalized.input.slice(0, 160),
          operation: normalized.operation,
          relation: normalized.relation,
          task_shape: normalized.task_shape,
          confidence: normalized.confidence,
          source: normalized.source,
        });
      });
  }

  function confidenceForRouteSource(source = '') {
    const normalized = stringValue(source || 'unknown');
    if (['deterministic', 'empty_current_attachment_set', 'multi_task_selector'].includes(normalized)) return 0.98;
    if (normalized === 'primary_model') return 0.85;
    if (normalized === 'primary_repair') return 0.76;
    if (normalized === 'fallback_model') return 0.70;
    if (normalized === 'fallback_repair') return 0.62;
    if (['invalid_model_output', 'route_models_unavailable'].includes(normalized)) return 0.10;
    return 0.50;
  }

  // Local decision metadata for the compiled route. It is deliberately derived
  // from the route outcome and the evidence that produced it; the route model
  // still owns operation/goal/resource semantics, but this score lets callers
  // and audits distinguish a deterministic answer from a repaired fallback.
  function buildRouteDecision(route = {}, options = {}) {
    const source = stringValue(options.source || route.source || 'unknown');
    let confidence = confidenceForRouteSource(source);
    const evidence = [];

    if (source) evidence.push(Object.freeze({ type: 'source', value: source }));
    const actions = options.understandingShape && Array.isArray(options.understandingShape.actions)
      ? options.understandingShape.actions
      : [];
    if (actions.length) evidence.push(Object.freeze({ type: 'understanding_actions', value: actions.length }));
    if (options.context?.quoted_message) evidence.push(Object.freeze({ type: 'context', value: 'quoted' }));

    const resources = Array.isArray(route?.resources) ? route.resources : [];
    if (resources.length) evidence.push(Object.freeze({ type: 'bound_resources', value: resources.length }));

    const taskShape = stringValue(route?.taskShape);
    if (taskShape) evidence.push(Object.freeze({ type: 'task_shape', value: taskShape }));

    const outcome = stringValue(route?.outcome);
    if (outcome) evidence.push(Object.freeze({ type: 'outcome', value: outcome }));

    if (route?.needClarification === true || route?.readiness === 'needs_clarification' || route?.api === 'clarify') {
      confidence = Math.min(confidence, 0.42);
    }
    if (taskShape === 'multi') {
      confidence = Math.min(confidence, 0.78);
    }
    if (['transient_error', 'configuration_error', 'invalid_model_output', 'cancelled'].includes(outcome)) {
      confidence = Math.min(confidence, 0.20);
    }

    return Object.freeze({
      confidence: Math.round(confidence * 100) / 100,
      evidence: Object.freeze(evidence),
      source,
    });
  }

  function inspectImagePlanResult(text = '', options = {}) {
    const parsedResult = parseRouteJson(text);
    if (!parsedResult.parsed) return { plan: null, reason: parsedResult.reason, parseError: parsedResult.parseError || '' };
    if (typeof hasExactImagePlan !== 'function' || !hasExactImagePlan(parsedResult.parsed)) {
      return { plan: null, reason: 'image_plan_invalid' };
    }
    return { plan: parsedResult.parsed, reason: '' };
  }

  function assertExecutableBindings(operation = '', bindings = []) {
    if (typeof assertExecutionBindings !== 'function') {
      const error = new TypeError('Shared execution binding validator is unavailable');
      error.code = 'EXECUTION_BINDING_VALIDATOR_UNAVAILABLE';
      throw error;
    }
    return assertExecutionBindings(operation, bindings);
  }

  function buildExecutionResourceProjection(plan = {}, resources = [], registered = {}) {
    const images = resources.filter(resource => resource.type === 'image');
    const files = resources.filter(resource => resource.type === 'file');
    const messages = resources.filter(resource => resource.type === 'message');
    return Object.freeze({
      version: EXECUTION_RESOURCE_PROJECTION_VERSION,
      operation: stringValue(plan.operation),
      api: stringValue(registered.api),
      relation: stringValue(plan.relation),
      images,
      files,
      messages,
      targets: images.filter(resource => resource.role === 'target'),
      masks: images.filter(resource => resource.role === 'mask'),
      references: images.filter(resource => ['reference', 'style_reference'].includes(resource.role)),
      imageInputs: images.filter(resource => ['target', 'reference', 'style_reference'].includes(resource.role)),
      chatImages: images,
      chatFiles: files,
      selectedMessageRefs: messages,
    });
  }

  const VAGUE_VISUAL_PATTERNS = /(?:复杂一点|更丰富|丰富一点|再精致|精致一点|更高级|高级一点|更有层次|细节多一点|做得更丰富|再加强|加强一点|质感|氛围|more complex|denser|more nuanced)/i;
  const CONCRETE_CHANGE_PATTERNS = /(?:把[^，。]*改成|改成|变成|添加|增加|加入|替换|换成|换(?:一)?下|改为|加上|\badd\b|\breplace\b|\bremove\b|make (?:the |this )?(?:background|subject|composition|color|material|杯子|猫|主体|背景|构图|色彩|材质))/i;
  const READ_ONLY_VISUAL_REQUEST_PATTERN = /(?:比较|对比|差异|区别|有什么不同|分析|描述|说明|识别|提取|读取|观察|查看|是什么|有什么|\bcompare\b|\bcontrast\b|\bdifferences?\b|\banaly[sz]e\b|\bdescribe\b|\bidentify\b|\bextract\b|\bread\b|\bwhat\b)/i;
  const VISUAL_MUTATION_TARGET_PATTERNS = /(?:背景|前景|主体|画面|构图|颜色|色彩|光线|材质|风格|天空|人物|服装|衣服|文字|图标|标志|边框|阴影|background|foreground|subject|composition|colou?r|lighting|material|style|sky|clothing|text|icon|logo)/i;
  const EXPLICIT_TEXT_SUBJECT_PATTERNS = /(?:上一段|这段|上文|文本|markdown|\bmd\b)/i;
  const EXPLICIT_IMAGE_SUBJECT_PATTERNS = /(?:上一张图|这张图|那张图|这张图片|上一张图片|那张图片|刚才的图|生成的图|原图|图片|图像|照片)/i;
  const EXPLICIT_FILE_RESOURCE_PATTERNS = /(?:(?:刚才|之前|上次|前面|上述|这|那)(?:个|份|篇)?(?:文件|附件|文档|pdf|表格|报告|合同|材料|纪要)|(?:当前|本轮)?附件|(?:attached|uploaded|previous|this|that)\s+(?:file|document|pdf|spreadsheet|report))/i;
  const PRIOR_FILE_RESOURCE_PATTERNS = /(?:(?:刚才|之前|上次|前面|上述|那个|那份|那篇)(?:文件|附件|文档|pdf|表格|报告|合同|材料|纪要)|(?:previous|that)\s+(?:file|document|pdf|spreadsheet|report))/i;
  const GENERATIVE_IMAGE_OPERATIONS = new Set(['text_to_image', 'image_reference_gen']);
  const EMPTY_GENERATION_PATTERNS = /^(?:生成|画|绘制|做|制作|创建)(?:一张|一个|张|幅|个)?(?:图|图片|图像|海报|插画|壁纸)?[的]?$/i;
  const VAGUE_GENERATION_REQUEST_PATTERN = /^(?:(?:请|请你|帮我|请帮我|给我|麻烦(?:你)?|please)\s*)?(?:生成|画|绘制|做|制作|创建|设计)\s*(?:(?:一张|一幅|一个|一件|张|幅|个)\s*)?(?:(?:产品|商品|宣传|营销)?海报|图片|图像|图|插画|壁纸|东西|logo|标志|图标)?\s*[的]?\s*[。.!！?？]?$/i;

  function isInsufficientTextToImageRequest(input = '') {
    const text = stringValue(input);
    return EMPTY_GENERATION_PATTERNS.test(text) || VAGUE_GENERATION_REQUEST_PATTERN.test(text);
  }
  // The multi-image planner is itself an instruction-materialization boundary.
  // It must not emit a task that merely points at earlier conversation text.
  const META_INSTRUCTION_GOAL_PATTERN = /^(?:基于\s*(?:这个|那个|上述|以上|上一条|前一条|前面的|之前的|这条|那条)\s*(?:生成|继续|重做|再生成)[\s\S]*|基于\s*(?:上一条|前一条|上面的|之前的)[\s\S]*?提示词[\s\S]*|参考\s*(?:上述|以上|上一条|前一条)[\s\S]*|继续生成[。.。]?)$/i;

  function isMetaInstructionGoal(goal = '') {
    return META_INSTRUCTION_GOAL_PATTERN.test(stringValue(goal));
  }
  const SUBJECT_CLARIFICATION_QUESTION = '你想继续处理哪一个？请选择本轮要处理的对象（文字回复或图片），也可以直接补充说明。';
  const VISUAL_DETAIL_QUESTION = '你希望具体调整图片的哪一部分（主体细节、背景和环境、构图层次或色彩和材质）？也可以直接告诉我具体怎么改。';

  function isVagueVisualContinuation(input = '') {
    const text = stringValue(input);
    return VAGUE_VISUAL_PATTERNS.test(text) && !CONCRETE_CHANGE_PATTERNS.test(text);
  }

  function isReadOnlyVisualRequest(input = '') {
    const text = stringValue(input);
    return READ_ONLY_VISUAL_REQUEST_PATTERN.test(text) && !CONCRETE_CHANGE_PATTERNS.test(text);
  }

  function imageArgumentDefaults(prompt = '') {
    return {
      prompt: stringValue(prompt),
      size: 'auto',
      quality: 'auto',
      background: 'auto',
      output_format: 'auto',
    };
  }

  function subjectChoiceSlots() {
    return [{
      key: 'p1',
      type: 'parameter',
      role: 'argument',
      reason: 'ambiguous',
      parameter_name: 'followup_subject',
      parameter_label: '要调整的对象',
      choices: [
        { key: 'v1', label: '上一段 Markdown 输出', value: 'text' },
        { key: 'v2', label: '上一张图片', value: 'image' },
      ],
    }];
  }

  function visualDetailSlots() {
    return [{ key: 'r2', type: 'text', role: 'source', reason: 'missing', choices: [] }];
  }

  // ── v2.7 §11.5 semantic_choice: enumerable semantic ambiguity → candidate list ──
  // The domains below are schematic; the mechanism is generic. A domain matches
  // an open-ended semantic ask (换颜色 / 换风格), the candidate list is a bounded
  // deterministic enumeration (≤6, no confidence, no recommended flag), and the
  // slot stays protocol-compatible with clarification_selection.v1.1 (pN/vN keys).
  // When the user already named a concrete value, the domain does not fire and the
  // request keeps its normal route; when nothing enumerates (改得好看点), the
  // caller falls back to semantic_text via visualDetailSlots().
  const SEMANTIC_CHOICE_DOMAINS = Object.freeze([
    Object.freeze({
      name: 'color',
      label: '颜色',
      question: '想换成哪种颜色？',
      pattern: /(?:换|改成|变成|调成|调|染|用什么)(?:个|成|为)?(?:颜色|色彩|色调)|colou?r/i,
      candidates: () => [
        { value: 'red', label: '红色', swatch_ref: 'color:#ff0000' },
        { value: 'blue', label: '蓝色', swatch_ref: 'color:#0000ff' },
        { value: 'green', label: '绿色', swatch_ref: 'color:#00ff00' },
        { value: 'yellow', label: '黄色', swatch_ref: 'color:#ffff00' },
        { value: 'black', label: '黑色', swatch_ref: 'color:#000000' },
        { value: 'white', label: '白色', swatch_ref: 'color:#ffffff' },
      ],
    }),
    Object.freeze({
      name: 'style',
      label: '风格',
      question: '想换成什么风格？',
      pattern: /(?:换|改成|变成|调成|用什么)(?:个|成|为)?(?:风格|画风|样式)|style/i,
      candidates: () => [
        { value: 'watercolor', label: '水彩' },
        { value: 'oil', label: '油画' },
        { value: 'anime', label: '动漫' },
        { value: 'realistic', label: '写实' },
        { value: 'minimal', label: '极简' },
      ],
    }),
  ]);

  function detectSemanticChoice(input = '', context = {}) {
    const text = stringValue(input);
    for (const domain of SEMANTIC_CHOICE_DOMAINS) {
      if (!domain.pattern.test(text)) continue;
      const candidates = typeof domain.candidates === 'function' ? domain.candidates(context) : [];
      if (!Array.isArray(candidates) || !candidates.length) continue;
      // The user already named a concrete value; do not ask for what is given.
      if (candidates.some(candidate => text.includes(String(candidate.label))
        || text.includes(String(candidate.value)))) continue;
      return Object.freeze({
        domain,
        slot: Object.freeze({
          key: 'p1',
          type: 'parameter',
          interaction: 'semantic_choice',
          role: 'argument',
          reason: 'ambiguous',
          parameter_name: domain.name,
          parameter_label: domain.label,
          question: domain.question,
          min_select: 1,
          max_select: 1,
          allow_free_text: true,
          choices: Object.freeze(candidates.slice(0, 6).map((candidate, index) => Object.freeze({
            key: `v${index + 1}`,
            value: candidate.value,
            label: candidate.label,
            swatch_ref: String(candidate.swatch_ref || ''),
          }))),
        }),
      });
    }
    return null;
  }

  function clarifyRoute(route, { question, slots }) {
    return {
      ...route,
      mode: 'chat',
      api: 'clarify',
      target: 'none',
      intent: 'clarify',
      needClarification: true,
      dispatchAuthorized: false,
      readiness: 'needs_clarification',
      operationApi: 'chat',
      operationMode: 'chat',
      clarificationQuestion: stringValue(question),
      clarificationSlots: Array.isArray(slots) ? slots : [],
      executionResources: null,
      dispatchContract: null,
      localClarification: true,
    };
  }

  const CANDIDATE_MATCH_STOP_CHARS = new Set(
    '一二三四五六七八九十张个只条幅辆的了吗呢在是都把和与要不清这那图画作为成再上下大小中里新旧'.split(''),
  );
  const CANDIDATE_MATCH_STOP_WORDS = new Set([
    'the', 'and', 'with', 'from', 'this', 'that', 'these', 'those', 'image', 'photo', 'picture',
    'older', 'previous', 'change', 'make', 'into', 'about', 'there', 'where', 'which', 'your',
  ]);

  function sharedCandidateTokens(input = '', candidate = {}) {
    const text = stringValue(input);
    if (!text) return [];
    // The provider prompt and the user-facing image description may use
    // different languages. Consider every compact semantic description so
    // historical images remain recoverable by what the user sees.
    const descriptions = uniqueStrings([
      candidate.semantic_text,
      candidate.description,
      candidate.label,
      candidate.prompt,
      ...(Array.isArray(candidate.labels) ? candidate.labels : []),
    ]).filter(Boolean);
    if (!descriptions.length) return [];
    const exact = descriptions.find(description => text.includes(description));
    if (exact) return [exact];
    const haystack = descriptions.join(' ');
    // CJK single-character overlap is a strong subject signal for Chinese
    // inputs once generic quantifier/function words are removed; ASCII uses
    // word boundaries.
    const tokens = new Set();
    for (const char of haystack) {
      if (/[\u4e00-\u9fff]/.test(char)
          && !CANDIDATE_MATCH_STOP_CHARS.has(char)
          && text.includes(char)) tokens.add(char);
    }
    if (tokens.size) return [...tokens];
    return haystack.split(/[^A-Za-z0-9]+/).filter(Boolean)
      .filter(word => word.length >= 3
        && !CANDIDATE_MATCH_STOP_WORDS.has(word.toLowerCase())
        && text.toLowerCase().includes(word.toLowerCase()));
  }

  function historicalVisualReframeMatches(input = '', catalog = []) {
    const text = stringValue(input);
    if (!text || !VISUAL_REFRAME_REQUEST_PATTERN.test(text)) return [];
    if (EXPLICIT_TEXT_SUBJECT_PATTERNS.test(text)
        || /(?:提示词|prompt|文案|描述)/i.test(text)
        || isReadOnlyVisualRequest(text)
        || IMAGE_GENERATION_INTENT_PATTERN.test(text)) return [];
    return (Array.isArray(catalog) ? catalog : []).filter(candidate => (
      (candidate?.type === 'image' || candidate?.image_id || candidate?.imageId)
      && ['quoted', 'history', 'context'].includes(candidate.source)
      && candidate.availability !== 'unavailable'
      && sharedCandidateTokens(text, candidate).length > 0
    ));
  }

  function ambiguousImageChoiceSlots(route = null, { input = '', context = {} } = {}) {
    if (!route || !['image_reference_gen', 'edit_image'].includes(stringValue(route.operationType))) return null;
    const boundResourceIds = new Set(
      (Array.isArray(route.resources) ? route.resources : [])
        .filter(resource => resource.type === 'image')
        .map(resource => stringValue(resource.resource_id || resource.resourceId)),
    );
    const candidates = Array.isArray(context?.image_candidates) ? context.image_candidates : [];
    const unbound = candidates.filter(candidate => !boundResourceIds.has(bindingResourceIdFor(candidate)));
    if (unbound.length < 2) return null;
    const matched = unbound.filter(candidate => sharedCandidateTokens(input, candidate).length > 0);
    if (matched.length < 2) return null;
    return [{
      key: 'r' + ((Array.isArray(route.resources) ? route.resources.length : 0) + 1),
      type: 'image',
      role: 'reference',
      reason: 'ambiguous',
      choices: matched.map((candidate, index) => ({
        key: `c${index + 1}`,
        source: stringValue(candidate.source) || 'history',
        index: Number(candidate.index) || index + 1,
        id: stringValue(candidate.image_id),
        resource_id: bindingResourceIdFor(candidate),
        reference_id: stringValue(candidate.reference_id),
        label: stringValue(candidate.prompt || candidate.description || `候选图片 ${index + 1}`),
      })),
    }];
  }

  function resolvedMessageBindingCandidates(route = {}, context = {}) {
    const bindings = (Array.isArray(route?.dispatchContract?.bindings) ? route.dispatchContract.bindings : [])
      .filter(binding => stringValue(binding?.type) === 'message' && stringValue(binding?.role) === 'context');
    if (!bindings.length) return [];
    const recent = Array.isArray(context?.recent_messages) ? context.recent_messages : [];
    const quoted = context?.quoted_message && typeof context.quoted_message === 'object'
      ? [context.quoted_message]
      : [];
    const byResourceId = new Map();
    for (const message of [...recent, ...quoted]) {
      const resourceId = canonicalResourceId('message', message);
      if (resourceId && !byResourceId.has(resourceId)) byResourceId.set(resourceId, message);
    }
    const seen = new Set();
    const candidates = [];
    for (const binding of bindings) {
      const resourceId = normalizeBindingResourceId('message', binding.resource_id);
      const message = byResourceId.get(resourceId);
      const content = stringValue(message?.content || message?.rawText || '').trim();
      if (!content || seen.has(content)) continue;
      seen.add(content);
      candidates.push(content);
    }
    return candidates;
  }

  function hasHistoricalTextPromptReference(input = '') {
    return HISTORICAL_TEXT_PROMPT_REFERENCE_PATTERN.test(stringValue(input));
  }

  function historicalTextPromptCandidates(context = {}) {
    const recent = Array.isArray(context?.recent_messages) ? context.recent_messages : [];
    const seen = new Set();
    const candidates = [];
    for (const message of recent) {
      // "历史提示词" refers to prior authored prompt text, which is presented
      // to the user as assistant output. Do not silently reinterpret arbitrary
      // old user instructions as the intended source.
      if (stringValue(message?.role) !== 'assistant') continue;
      const content = stringValue(message?.content || message?.rawText || '').trim();
      if (!content || seen.has(content)) continue;
      seen.add(content);
      candidates.push(content);
    }
    return candidates;
  }

  function clarificationDescriptionChoices(context = {}) {
    const slots = Array.isArray(context?.clarification_context?.unresolved_resources)
      ? context.clarification_context.unresolved_resources
      : [];
    return slots
      .filter(slot => stringValue(slot?.type) === 'text' && stringValue(slot?.role) === 'source')
      .flatMap(slot => Array.isArray(slot?.choices) ? slot.choices : [])
      .map(choice => stringValue(choice?.label || choice?.value))
      .filter(Boolean);
  }

  function selectedDescriptionFromContext(context = {}, candidates = []) {
    const labels = Array.isArray(context?.clarification_context?.selected_choices)
      ? context.clarification_context.selected_choices
      : [];
    const label = stringValue(labels[0] || '').trim();
    if (!label) return '';
    const available = [...(Array.isArray(candidates) ? candidates : []), ...clarificationDescriptionChoices(context)]
      .map(candidate => stringValue(candidate).trim())
      .filter(Boolean);
    const exact = available.find(candidate => candidate === label);
    if (exact) return exact;
    const prefix = label.slice(0, 40);
    const byPrefix = available.find(candidate => candidate.startsWith(prefix));
    return byPrefix || '';
  }

  function isBareClarificationSelector(input = '') {
    const text = stringValue(input);
    return /^(?:第\s*)?(?:[1-9]\d*|[一二三四五六七八九十])(?:\s*(?:个|条|项|号|选项|候选))?[。．、.]?$/.test(text)
      || /^[cv][1-9]\d*$/i.test(text);
  }

  function selectedDescriptionPrompt(context = {}, selected = '', input = '') {
    const description = stringValue(selected);
    if (!description) return '';
    const clarificationContext = context?.clarification_context || {};
    const baseTask = stringValue(
      clarificationContext.base_task
      || clarificationContext.pending_task?.base_input
      || context?.pending_task?.original_text,
    );
    const current = stringValue(input);
    const instruction = isBareClarificationSelector(current) ? baseTask : current;
    return [description, instruction && instruction !== description ? instruction : ''].filter(Boolean).join('\n\n');
  }

  function nextClarificationResourceKey(route = {}) {
    const used = new Set((Array.isArray(route?.resources) ? route.resources : [])
      .map(resource => stringValue(resource?.key))
      .filter(key => /^r[1-9]\d*$/.test(key)));
    let index = 1;
    while (used.has(`r${index}`)) index += 1;
    return `r${index}`;
  }

  function setResolvedImagePrompt(route = null, prompt = '') {
    if (!route) return route;
    const resolved = stringValue(prompt);
    if (!resolved) return route;
    route.contextualImagePrompt = resolved;
    if (route.dispatchContract
        && typeof hasExactDispatchContract === 'function'
        && hasExactDispatchContract(route.dispatchContract)
        && typeof dispatchContractModule.withArguments === 'function') {
      route.dispatchContract = dispatchContractModule.withArguments(route.dispatchContract, { prompt: resolved });
    }
    return route;
  }
  function routeHasBoundImage(route = {}) {
    const bindings = Array.isArray(route?.dispatchContract?.bindings)
      ? route.dispatchContract.bindings
      : [];
    const resources = Array.isArray(route?.resources) ? route.resources : [];
    return [...bindings, ...resources].some(resource => (
      stringValue(resource?.type) === 'image'
      && ['target', 'reference', 'style_reference'].includes(stringValue(resource?.role))
    ));
  }

  function bindingResourceIdFor(candidate = {}) {
    const declared = stringValue(candidate.resource_id || candidate.resourceId);
    if (declared) return declared;
    const imageId = stringValue(candidate.image_id || candidate.imageId || candidate.id);
    return imageId ? `res:image:${encodeURIComponent(imageId)}` : '';
  }

  function previousImageCandidate(context = {}, previousExecution = null) {
    if (!previousExecution) return null;
    const candidates = Array.isArray(context?.image_candidates) ? context.image_candidates : [];
    return candidates.find(candidate => (
      stringValue(candidate.reference_id) === stringValue(previousExecution.result_reference_id)
      || stringValue(candidate.resource_id) === stringValue(previousExecution.result_reference_id)
    )) || candidates.find(candidate => stringValue(candidate.image_id) === stringValue(previousExecution.result_reference_id)) || null;
  }

  // ── Execution invariants (always enforced) ─────────────────────
  // Corrections/continuations of a completed image execution must never
  // downgrade to chat, and a generate-family correction cannot bind the
  // result as an edit target. This protects execution continuity on every
  // path, including model-owned routes that skip the local guess layer.
  function applyLocalExecutionInvariants(route = null, { input = '', context = {}, proposedPrompt = '', allowVagueGeneration = false } = {}) {
    if (!route) return route;
    const text = stringValue(input);
    const previousExecution = context?.previous_execution || null;
    const planOp = stringValue(route.operationType);
    const planApi = stringValue(route.api);
    const relation = stringValue(route.relation);
    const previousImage = previousImageCandidate(context, previousExecution);
    const selectedDescription = selectedDescriptionFromContext(context, []);
    const plannedImagePrompt = stringValue(proposedPrompt || route.dispatchContract?.arguments?.prompt || route.contextualImagePrompt);
    const resolvedContinuationPrompt = (resolvedRoute = route) => {
      if (selectedDescription) return selectedDescriptionPrompt(context, selectedDescription, text);
      // A target/reference image is the continuity carrier. Repeating the
      // previous generation prompt changes the user's current instruction.
      if (routeHasBoundImage(resolvedRoute)) return text;
      if (isBareClarificationSelector(text)
          && plannedImagePrompt
          && !isBareClarificationSelector(plannedImagePrompt)) return plannedImagePrompt;
      return `${stringValue(previousExecution?.input)}\n\n${text}`.trim();
    };

    // ── Execution-family continuity: corrections/continuations of a
    //    completed image execution must never downgrade to chat, and
    //    generate-family corrections cannot bind the result as target ─
    if (previousExecution && ['continuation'].includes(relation)) {
      const family = stringValue(previousExecution.family);
      if (family === 'generate') {
        // A generated result must never become an edit target, but it is a
        // valid reference for the next generation. Reuse that image instead
        // of serializing every earlier instruction into the next provider
        // prompt. The image is the visual state; this turn's text is only the
        // delta requested by the user.
        const needsReferenceBinding = planApi === 'chat'
          || planOp === 'text_to_image'
          || (planOp === 'image_reference_gen' && !routeHasBoundImage(route));
        if (needsReferenceBinding && previousImage) {
          const basePlan = {
            operation: 'image_reference_gen',
            relation,
            arguments: imageArgumentDefaults(text),
            bindings: [{
              key: 'r1', type: 'image', role: 'reference',
              resource_id: bindingResourceIdFor(previousImage),
              source: stringValue(previousImage.source) || 'history',
            }],
            constraints: [],
          };
          const rebuilt = compileLocalRoute(basePlan, { input, attachments: [], context, allowVagueGeneration });
          if (rebuilt) {
            setResolvedImagePrompt(rebuilt, resolvedContinuationPrompt(rebuilt));
            rebuilt.editInstruction = '';
            return rebuilt;
          }
        }
        // If the actual previous image is no longer recoverable, retain the
        // existing text-only fallback rather than fabricating an image binding.
      }
      if (family === 'edit' && (planApi === 'chat' || (planOp === 'edit_image' && !(route.resources || []).some(resource => resource.role === 'target')))) {
        if (previousImage) {
          const basePlan = {
            operation: 'edit_image',
            relation,
            arguments: imageArgumentDefaults(text),
            bindings: [{ key: 'r1', type: 'image', role: 'target', resource_id: bindingResourceIdFor(previousImage), source: stringValue(previousImage.source) || 'history' }],
            constraints: [],
          };
          const rebuilt = compileLocalRoute(basePlan, { input, attachments: [], context });
          if (rebuilt) {
            setResolvedImagePrompt(rebuilt, resolvedContinuationPrompt(rebuilt));
            return rebuilt;
          }
        }
      }
    }

    return route;
  }

  function applyLocalRouteGuesses(route = null, { input = '', context = {}, proposedPrompt = '', allowVagueGeneration = false } = {}) {
    if (!route) return route;
    const text = stringValue(input);
    const previousExecution = context?.previous_execution || null;
    const focus = context?.conversation_focus || null;
    const clarificationContext = context?.clarification_context || null;
    const selectedSubject = stringValue(clarificationContext?.selected_parameters?.followup_subject);
    const planOp = stringValue(route.operationType);
    const planApi = stringValue(route.api);
    const relation = stringValue(route.relation);
    const isImageContinuationOp = ['image_reference_gen', 'edit_image'].includes(planOp);
    const previousImage = previousImageCandidate(context, previousExecution);
    const selectedDescription = selectedDescriptionFromContext(context, []);
    const plannedImagePrompt = stringValue(proposedPrompt || route.dispatchContract?.arguments?.prompt || route.contextualImagePrompt);
    const resolvedContinuationPrompt = (resolvedRoute = route) => {
      if (selectedDescription) return selectedDescriptionPrompt(context, selectedDescription, text);
      // A target/reference image is the continuity carrier. Repeating the
      // previous generation prompt changes the user's current instruction.
      if (routeHasBoundImage(resolvedRoute)) return text;
      if (isBareClarificationSelector(text)
          && plannedImagePrompt
          && !isBareClarificationSelector(plannedImagePrompt)) return plannedImagePrompt;
      return `${stringValue(previousExecution?.input)}\n\n${text}`.trim();
    };

    // ── Subject selection from a prior clarification answer ─────────
    if (selectedSubject === 'text') {
      if (planApi === 'chat') return route;
      return compileLocalRoute({
        operation: 'plain_chat',
        relation: relation || 'followup',
        arguments: { prompt: text },
        bindings: [],
        constraints: [],
      }, { input, attachments: [], context, skipLocalRouteGates: true, allowVagueGeneration });
    }
    if (selectedSubject === 'image') {
      if (planApi === 'image_edit' || planOp === 'image_reference_gen') {
        return clarifyRoute(route, { question: VISUAL_DETAIL_QUESTION, slots: visualDetailSlots() });
      }
      // "上一张图片" resolves to the previous execution result when it is
      // still current, otherwise to the most recent image candidate.
      const subjectImage = previousImage
        || (Array.isArray(context?.image_candidates) ? context.image_candidates[0] : null);
      const basePlan = {
        operation: 'image_reference_gen',
        relation: relation || 'followup',
        arguments: imageArgumentDefaults(text),
        bindings: subjectImage
          ? [{ key: 'r1', type: 'image', role: 'reference', resource_id: bindingResourceIdFor(subjectImage), source: stringValue(subjectImage.source) || 'history' }]
          : [],
        constraints: [],
      };
      const rebuilt = compileLocalRoute(basePlan, { input, attachments: [], context });
      return rebuilt && rebuilt.needClarification
        ? rebuilt
        : clarifyRoute(rebuilt || route, { question: VISUAL_DETAIL_QUESTION, slots: visualDetailSlots() });
    }

    // ── Explicit subject words win over the computed focus ─────────
    if (EXPLICIT_TEXT_SUBJECT_PATTERNS.test(text)) {
      if (planApi === 'chat') return route;
      return compileLocalRoute({
        operation: 'plain_chat',
        relation: relation || 'followup',
        arguments: { prompt: text },
        bindings: [],
        constraints: [],
      }, { input, attachments: [], context, skipLocalRouteGates: true });
    }
    if (EXPLICIT_IMAGE_SUBJECT_PATTERNS.test(text) && isVagueVisualContinuation(text)) {
      if (planOp === 'image_reference_gen' || planOp === 'edit_image') {
        return clarifyRoute(route, { question: VISUAL_DETAIL_QUESTION, slots: visualDetailSlots() });
      }
      if (previousImage) {
        const basePlan = {
          operation: 'image_reference_gen',
          relation: relation || 'followup',
          arguments: imageArgumentDefaults(text),
          bindings: [{ key: 'r1', type: 'image', role: 'reference', resource_id: bindingResourceIdFor(previousImage), source: stringValue(previousImage.source) || 'history' }],
          constraints: [],
        };
        const rebuilt = compileLocalRoute(basePlan, { input, attachments: [], context });
        return rebuilt ? clarifyRoute(rebuilt, { question: VISUAL_DETAIL_QUESTION, slots: visualDetailSlots() }) : route;
      }
    }

    // ── Ambiguous computed focus → clickable subject choices ───────
    if (focus?.kind === 'ambiguous' && isImageContinuationOp) {
      return clarifyRoute(route, { question: SUBJECT_CLARIFICATION_QUESTION, slots: subjectChoiceSlots() });
    }

    // ── Text focus shadows older image continuations ───────────────
    if (focus?.kind === 'text'
        && isImageContinuationOp
        && !isConcreteImageEditRequest(text, context?.image_candidates || [])
        && !historicalVisualReframeMatches(text, context?.image_candidates || []).length) {
      return compileLocalRoute({
        operation: 'plain_chat',
        relation: relation || 'followup',
        arguments: { prompt: text },
        bindings: [],
        constraints: [],
      }, { input, attachments: [], context, skipLocalRouteGates: true });
    }

    // ── Vague visual continuation keeps the previous image bound but
    //    fails closed until the user specifies concrete visual changes ─
    if ((planOp === 'image_reference_gen' || planOp === 'edit_image')
        && (previousExecution || focus?.kind === 'image')) {
      // v2.7 §11.5 semantic_choice: an enumerable semantic ask (换个颜色 /
      // 换成什么风格) gets a deterministic candidate list instead of a bare
      // text slot. detectSemanticChoice already skips inputs that name a
      // concrete candidate value, so a hit is an open-ended enumerable ask and
      // must not additionally require the vague-visual pattern (those patterns
      // describe intensity tweaks, not semantic domains). Non-enumerable asks
      // (改得好看点) keep the semantic_text fallback below.
      const semanticChoice = detectSemanticChoice(text, context);
      if (semanticChoice) {
        return clarifyRoute(route, { question: semanticChoice.slot.question, slots: [semanticChoice.slot] });
      }
      if (isVagueVisualContinuation(text)) {
        return clarifyRoute(route, { question: VISUAL_DETAIL_QUESTION, slots: visualDetailSlots() });
      }
    }

    // Text-only generate continuations retain their prior prompt as context.
    // When an image is bound, the image carries continuity and the current
    // instruction remains the complete provider prompt.
    if (previousExecution?.family === 'generate'
        && ['continuation'].includes(relation)
        && ['text_to_image', 'image_reference_gen'].includes(planOp)) {
      setResolvedImagePrompt(route, resolvedContinuationPrompt());
      route.editInstruction = '';
    }

    // ── Ambiguous unbound subject candidates clarify before dispatch ─
    if (route.readiness === 'ready' && route.dispatchAuthorized) {
      const ambiguousSlots = ambiguousImageChoiceSlots(route, { input: text, context });
      if (ambiguousSlots) {
        const choices = ambiguousSlots[0].choices;
        const question = `你提到的图片不止一张，请选择要使用哪一张（${choices.map(choice => stringValue(choice.label)).join('、')}），也可以直接描述图片特征。`;
        return clarifyRoute(route, { question, slots: ambiguousSlots });
      }
    }
    // ── Image prompt assembly: pass-through, compose, or clarify ────
    // The route model identifies referenced messages with mN/context bindings.
    // The app resolves those bindings against recent_messages, verifies the
    // content still exists, then applies the prompt policy:
    //   - no binding              -> pass through
    //   - 1 bound candidate       -> compose
    //   - >1 bound candidates     -> clarify with choices; selected -> compose
    //   - bound but unavailable   -> clarify (the referent is gone)
    if (planOp === 'text_to_image' && route.readiness === 'ready') {
      const messageBindings = (Array.isArray(route.dispatchContract?.bindings) ? route.dispatchContract.bindings : [])
        .filter(binding => stringValue(binding?.type) === 'message' && stringValue(binding?.role) === 'context');
      const boundCandidates = resolvedMessageBindingCandidates(route, context);
      const hasBoundMessageReference = messageBindings.length > 0;
      const hasImplicitHistoricalReference = !hasBoundMessageReference && hasHistoricalTextPromptReference(text);
      const inferredHistoricalCandidates = hasImplicitHistoricalReference
        ? historicalTextPromptCandidates(context)
        : [];
      if (hasBoundMessageReference || selectedDescription || hasImplicitHistoricalReference) {
        // The model can name exact mN message candidates, but an explicit request
        // for a historical prompt must still fail closed when it supplied none.
        // This makes clarification a local execution invariant rather than a
        // best-effort model behavior.
        const candidates = hasBoundMessageReference
          ? boundCandidates
          : inferredHistoricalCandidates;
        const selected = selectedDescription || selectedDescriptionFromContext(context, candidates);
        if (selected) {
          setResolvedImagePrompt(route, selectedDescriptionPrompt(context, selected, text));
        } else if (candidates.length === 1) {
          setResolvedImagePrompt(route, `${candidates[0]}\n\n${text}`);
        } else if (candidates.length > 1) {
          const slots = [{
            key: nextClarificationResourceKey(route), type: 'text', role: 'source', reason: 'ambiguous',
            choices: candidates.map((label, index) => ({
              key: `c${index + 1}`, source: 'history', index: index + 1, id: '',
              resource_id: '', reference_id: '', label,
            })),
          }];
          return clarifyRoute(route, {
            question: '检测到多个相关描述，请选择要基于哪一条生成图片：',
            slots,
          });
        } else {
          return clarifyRoute(route, {
            question: '引用的历史内容已不可用，请直接提供画面描述（主体、场景、风格等）。',
            slots: [{ key: 'r1', type: 'text', role: 'source', reason: 'missing', choices: [] }],
          });
        }
      }
    }
    // ── text_to_image must describe content before dispatch ────────
    if (planOp === 'text_to_image'
        && route.readiness === 'ready'
        && allowVagueGeneration !== true
        && isInsufficientTextToImageRequest(text)) {
      return clarifyRoute(route, { question: '你想生成什么样的图片？请补充画面内容描述，例如主体、场景和风格。', slots: [{ key: 'r1', type: 'text', role: 'source', reason: 'missing', choices: [] }] });
    }

    return route;
  }

  function sanitizeRouteDraft(plan = {}, options = {}) {
    const op = stringValue(plan.operation);
    const bindings = Array.isArray(plan.bindings) ? plan.bindings : [];
    if (op !== 'text_to_image' || !bindings.length) return plan;
    const previous = options.context?.previous_execution || null;
    const relation = stringValue(plan.relation);
    const familyCorrection = previous?.family === 'generate'
      && ['continuation'].includes(relation);
    // text_to_image may bind historical messages as evidence, but a
    // generate-family correction/continuation must never bind the previous
    // image as an edit target.
    const kept = familyCorrection
      ? bindings.filter(binding => stringValue(binding.type) === 'message')
      : bindings;
    if (kept.length === bindings.length) return plan;
    return { ...plan, bindings: kept };
  }

  function requiredResourceSpecs(operation = '') {
    if (typeof resourceRequirementsFor !== 'function') return [];
    return resourceRequirementsFor(operation)
      .filter(requirement => Number(requirement.min) > 0)
      .map(requirement => ({
        ...requirement,
        role: requirement.roles[0],
      }));
  }

  function candidatePoolFor(type = '', catalog = [], relation = 'new') {
    const allowedSources = relation === 'new'
      ? new Set(['current', 'quoted'])
      : new Set(['current', 'quoted', 'history', 'context']);
    return catalog.filter(candidate => candidate.type === type && allowedSources.has(candidate.source));
  }

  function chineseOrdinalValue(value = '') {
    const text = stringValue(value);
    if (/^[1-9]\d*$/.test(text)) return Number(text);
    const digits = { '零': 0, '一': 1, '二': 2, '两': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9 };
    if (text === '十') return 10;
    if (text.includes('十')) {
      const [left, right] = text.split('十');
      const tens = left ? digits[left] : 1;
      const ones = right ? digits[right] : 0;
      return Number.isInteger(tens) && Number.isInteger(ones) ? tens * 10 + ones : 0;
    }
    return digits[text] || 0;
  }

  function resourceSelectorIsExcluded(input = '', selector = {}) {
    const text = stringValue(input);
    const start = Math.max(0, Number(selector.start) || 0);
    const end = Math.max(start, Number(selector.end) || start);
    const before = text.slice(Math.max(0, start - 24), start);
    const after = text.slice(end, end + 32);
    const negatedBefore = /(?:不要|别|无需|不必|不用|不需要)\s*(?:修改|编辑|改动|改变|处理|动|改)?\s*$|(?:do\s+not|don't|dont)\s+(?:edit|change|touch)\s+(?:the\s+)?$/i;
    const negatedAfter = /^\s*(?:(?:不要|别|无需|不必|不用|不需要)\s*(?:修改|编辑|改动|改变|处理|动|改)(?:任何内容|任何东西)?(?=\s*(?:[，,。.!！？;；]|$))|(?:保持|维持|保留)\s*(?:不变|原样)|(?:do\s+not|don't|dont)\s+(?:edit|change|touch)(?=\s*(?:[,.;!?]|$))|(?:unchanged|as[- ]is)\b)/i;
    return negatedBefore.test(before) || negatedAfter.test(after);
  }

  function typedIndexSelectors(input = '') {
    const text = stringValue(input);
    const selectors = [];
    const add = (match, type, value) => {
      const index = chineseOrdinalValue(value);
      if (!type || !Number.isInteger(index) || index < 1 || index > 99) return;
      const start = Number(match.index) || 0;
      const end = start + String(match[0] || '').length;
      if (/[x×*]/i.test(text.slice(end, end + 1))) return;
      selectors.push({ kind: 'index', type, index, start, end, raw: String(match[0] || '') });
    };

    for (const match of text.matchAll(/第\s*([1-9]\d*|[一二两三四五六七八九十]+)\s*(张|幅|个|份|篇|号)?\s*(图片|图像|照片|图|文件|附件|文档)?/gi)) {
      const noun = String(match[3] || '').toLowerCase();
      const measure = String(match[2] || '');
      const type = /^(?:图片|图像|照片|图)$/.test(noun) || ['张', '幅'].includes(measure)
        ? 'image'
        : /^(?:文件|附件|文档)$/.test(noun) || ['份', '篇'].includes(measure)
          ? 'file'
          : '';
      add(match, type, match[1]);
    }
    for (const match of text.matchAll(/(?:图片|图像|照片|图|image|photo)\s*(?:#|编号|序号)?\s*([1-9]\d*)/gi)) {
      add(match, 'image', match[1]);
    }
    for (const match of text.matchAll(/(?:文件|附件|文档|file|document)\s*(?:#|编号|序号)?\s*([1-9]\d*)/gi)) {
      add(match, 'file', match[1]);
    }
    for (const match of text.matchAll(/([1-9]\d*)(?:st|nd|rd|th)\s+(image|photo|file|document)\b/gi)) {
      add(match, /file|document/i.test(match[2]) ? 'file' : 'image', match[1]);
    }

    const addRelative = (match, type, edge, offset = 1) => {
      if (!type || !Number.isInteger(offset) || offset < 1) return;
      const start = Number(match.index) || 0;
      const end = start + String(match[0] || '').length;
      selectors.push({ kind: 'relative', type, edge, offset, start, end, raw: String(match[0] || '') });
    };
    for (const match of text.matchAll(/最后\s*(?:一|1)?\s*(张|幅)?\s*(?:图片|图像|照片|图)?/gi)) {
      addRelative(match, 'image', 'end');
    }
    for (const match of text.matchAll(/\blast\s+(?:the\s+)?(image|photo)\b/gi)) {
      addRelative(match, 'image', 'end');
    }

    const seen = new Set();
    return selectors
      .sort((left, right) => left.start - right.start || left.end - right.end)
      .filter(selector => !resourceSelectorIsExcluded(text, selector))
      .filter(selector => {
        const key = `${selector.type}|${selector.index}|${selector.start}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
  }

  function explicitIndexFromInput(input = '', type = '') {
    const indexes = [...new Set(typedIndexSelectors(input)
      .filter(selector => selector.kind === 'index' && (!type || selector.type === type))
      .map(selector => selector.index))];
    return indexes.length === 1 ? indexes[0] : 0;
  }

  // Resource selection is a set expression, not a single ordinal. Keep the
  // parser independent from any one operation so edit, reference, compare,
  // and clarification paths all interpret the same language consistently.
  function selectionScopeCandidates(input = '', candidates = []) {
    const list = Array.isArray(candidates) ? candidates.filter(Boolean) : [];
    const text = stringValue(input);
    const prior = /(?:上一条|上一个|之前|刚才|上次|历史|生成的|previous|last|history|generated|that)\s*(?:消息|结果|图片|图像|image|photo|picture)?/i.test(text);
    const current = list.filter(candidate => candidate.source === 'current');
    if (!prior && current.length) return current;
    // Without an explicit historical reference, preserve the established
    // ordinal semantics: a numbered resource may address any available
    // history item. Historical-group narrowing is only applied when the user
    // says which prior result/message to use (e.g. “上一条消息中的第一张”).
    if (!prior) return list;
    const historical = list.filter(candidate => candidate.source !== 'current');
    if (!historical.length) return current;
    const latestMessage = Math.max(...historical.map(candidate => Number(candidate.message_index) || 0));
    if (latestMessage > 0) {
      const latest = historical.filter(candidate => (Number(candidate.message_index) || 0) === latestMessage);
      if (latest.length) return latest;
    }
    const latestReference = historical.find(candidate => candidate.reference_id)?.reference_id || '';
    return latestReference
      ? historical.filter(candidate => candidate.reference_id === latestReference)
      : historical;
  }

  function imageSelectionIndexes(input = '', candidates = []) {
    const text = stringValue(input);
    const imageCandidates = selectionScopeCandidates(input, (Array.isArray(candidates) ? candidates : [])
      .filter(candidate => candidate?.type === 'image'));
    if (!text || !imageCandidates.length) return [];
    const ordered = [...new Set(imageCandidates
      .map(candidate => Number(candidate.index))
      .filter(index => Number.isInteger(index) && index >= 1))].sort((a, b) => a - b);
    const allPattern = /(?:全都要|全部|所有(?:的)?|每(?:一张|张)|都要|all|every|each)/i;
    const selected = new Set();
    if (allPattern.test(text)) ordered.forEach(index => selected.add(index));
    const addRange = (left, right) => {
      const start = Math.min(left, right);
      const end = Math.max(left, right);
      ordered.filter(index => index >= start && index <= end).forEach(index => selected.add(index));
    };
    const ordinal = value => chineseOrdinalValue(value);
    const rangePatterns = [
      /第?\s*([1-9]\d*|[一二两三四五六七八九十百]+)\s*(?:张|幅|个)?\s*(?:到|至|-|~|～)\s*第?\s*([1-9]\d*|[一二两三四五六七八九十百]+)\s*(?:张|幅|个)?/giu,
      /(?:from\s+)?(?:the\s+)?([1-9]\d*)\s*(?:st|nd|rd|th)?\s*(?:to|through|-)\s*(?:the\s+)?([1-9]\d*)\s*(?:st|nd|rd|th)?/giu,
    ];
    for (const pattern of rangePatterns) {
      for (const match of text.matchAll(pattern)) {
        const left = ordinal(match[1]);
        const right = ordinal(match[2]);
        if (left > 0 && right > 0) addRange(left, right);
      }
    }
    return [...selected].sort((a, b) => a - b);
  }

  function hasExplicitMultiImageSelection(input = '', candidates = []) {
    const text = stringValue(input);
    const indexes = typedIndexSelectors(text).filter(selector => selector.type === 'image');
    return imageSelectionIndexes(text, candidates).length > 1
      || indexes.length > 1
      || /(?:全都要|全部|所有|每张|每一张|都要|分别|各自|逐张|all|every|each|\u5206\u522b|\u5404\u81ea|\u9010\u5f20|\u5168\u90e8|\u6bcf\u4e00\u5f20|[\u4e00\u4e8c\u4e09\u56db\u4e94\u516d\u4e03\u516b\u4e5d\u5341\d]+\u5f20|multiple images)/i.test(text);
  }

  function escapedRegExp(value = '') {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function explicitTokenPosition(input = '', token = '', { shortKey = false } = {}) {
    const text = String(input || '');
    const value = stringValue(token);
    if (!text || !value) return -1;
    if (shortKey) {
      const match = new RegExp(`(^|[^A-Za-z0-9_-])${escapedRegExp(value)}(?![A-Za-z0-9_-])`, 'i').exec(text);
      return match ? match.index + match[1].length : -1;
    }
    if (/^\d+$/.test(value) || value.length < 4) return -1;
    const match = new RegExp(
      `(^|[^A-Za-z0-9._:%/-])${escapedRegExp(value)}(?![A-Za-z0-9._:%/-])`,
      'i',
    ).exec(text);
    return match ? match.index + match[1].length : -1;
  }

  function strongCandidateLabelPosition(input = '', candidate = {}) {
    const text = String(input || '').toLowerCase();
    if (!text) return -1;
    const labels = uniqueStrings([candidate.filename, candidate.label]);
    for (const label of labels) {
      const normalized = label.toLowerCase().replace(/\s+/g, ' ').trim();
      if (normalized.length < 4 || /^(?:image|file|message)\s+\d+$/i.test(normalized)) continue;
      const position = text.indexOf(normalized);
      if (position >= 0) return position;
    }
    return -1;
  }

  function previousVisualContinuationCandidates(input = '', selector = {}, catalog = [], context = {}) {
    if (selector?.type !== 'image' || !VISUAL_REVIEW_CONTINUATION_PATTERN.test(stringValue(input))) return null;
    // "第八张图片" and "历史第八张" explicitly select a catalog resource.
    // Keep that meaning intact; only the bare ordinal is eligible to refer to
    // a sub-item of the previous visual input.
    if (EXPLICIT_IMAGE_RESOURCE_ORDINAL_PATTERN.test(stringValue(input))
        || /(?:\u56fe\u7247|\u56fe\u50cf|\u7167\u7247|\u56fe|image|photo)/i.test(stringValue(selector?.raw))) return null;
    const previous = context?.previous_visual_execution;
    const images = Array.isArray(previous?.images) ? previous.images : [];
    if (previous?.schema_version !== 'previous_visual_execution.v1'
        || !['image_qa', 'ocr', 'multimodal_qa'].includes(stringValue(previous?.operation))
        || Number(previous?.image_count) !== images.length
        || !images.length) return null;
    const candidates = [];
    const seen = new Set();
    for (const binding of images) {
      const referenceId = stringValue(binding?.reference_id || binding?.referenceId);
      const bindingIndex = Number(binding?.index);
      if (!referenceId) continue;
      for (const candidate of catalog) {
        if (candidate?.type !== 'image' || stringValue(candidate.reference_id) !== referenceId) continue;
        if (Number.isInteger(bindingIndex) && bindingIndex >= 1
            && Number(candidate.index) !== bindingIndex
            && !(candidate.index_aliases || []).includes(bindingIndex)) continue;
        const key = `${candidate.source}|${candidate.resource_id}`;
        if (!seen.has(key)) { seen.add(key); candidates.push(candidate); }
      }
    }
    return { candidates, mustClarify: Number(previous?.image_count) !== 1 };
  }

  function explicitCandidateSelections(input = '', catalog = [], context = {}) {
    const selectors = typedIndexSelectors(input);
    const selected = [];
    const issues = [];
    const addSelected = (candidate, start = Number.MAX_SAFE_INTEGER, kind = 'identity') => {
      if (!candidate || selected.some(item => item.candidate.resource_id === candidate.resource_id && item.candidate.source === candidate.source)) return;
      selected.push({ candidate, start, kind });
    };

    const imageCandidates = selectionScopeCandidates(input, catalog.filter(candidate => candidate.type === 'image'));
    const allIndexes = imageSelectionIndexes(input, imageCandidates);
    if (allIndexes.length) {
      const byIndex = new Map(allIndexes.map(index => [index, true]));
      for (const candidate of imageCandidates) {
        if (byIndex.has(Number(candidate.index))) addSelected(candidate, 0, 'set_expression');
      }
    }

    for (const selector of selectors) {
      const continuationScope = selector.kind === 'index'
        ? previousVisualContinuationCandidates(input, selector, catalog, context)
        : null;
      if (continuationScope) {
        const continuationCandidates = continuationScope.candidates;
        if (!continuationScope.mustClarify && continuationCandidates.length === 1) {
          addSelected(continuationCandidates[0], selector.start, 'previous_visual_continuation');
        } else {
          issues.push(unresolvedResourceIssue({
            type: 'image', role: 'source',
            reason: continuationScope.mustClarify || continuationCandidates.length > 1 ? 'ambiguous' : 'missing',
            candidates: continuationCandidates,
          }));
        }
        continue;
      }
      // Ordinals such as “the first and third image” are scoped to the current
      // upload whenever one is present. History commonly also starts at 1, so
      // combining sources here turns an explicit user selection into a bogus
      // ambiguity. An explicit prior-image phrase remains free to select history.
      const scope = selectionScopeCandidates(input, catalog.filter(candidate => candidate.type === selector.type));
      const orderedIndexes = [...new Set(scope
        .map(candidate => Number(candidate.index))
        .filter(index => Number.isInteger(index) && index >= 1))]
        .sort((left, right) => left - right);
      const relativePosition = selector.kind === 'relative'
        ? selector.edge === 'start' ? selector.offset - 1 : orderedIndexes.length - selector.offset
        : -1;
      const selectorIndex = selector.kind === 'relative'
        ? orderedIndexes[relativePosition] || 0
        : selector.index;
      const matches = scope.filter(candidate => selectorIndex >= 1 && (
        Number(candidate.index) === selectorIndex
        || (candidate.index_aliases || []).includes(selectorIndex)
      ));
      if (matches.length === 1) addSelected(matches[0], selector.start, selector.kind);
      else issues.push(unresolvedResourceIssue({
        type: selector.type,
        role: selector.type === 'file' ? 'attachment' : 'source',
        reason: matches.length > 1 ? 'ambiguous' : 'missing',
        candidates: matches,
      }));
    }

    const rangeIndexes = imageSelectionIndexes(input, imageCandidates);
    if (rangeIndexes.length) {
      const byIndex = new Map(rangeIndexes.map(index => [index, true]));
      for (const candidate of imageCandidates) {
        if (byIndex.has(Number(candidate.index))) addSelected(candidate, 0, 'set_expression');
      }
    }

    const directKeys = [];
    for (const match of String(input || '').matchAll(/(?:^|[^A-Za-z0-9_-])([if][1-9]\d*)(?![A-Za-z0-9_-])/gi)) {
      directKeys.push({ key: match[1].toLowerCase(), start: (match.index || 0) + String(match[0]).indexOf(match[1]) });
    }
    for (const direct of directKeys) {
      const match = catalog.find(candidate => candidate.candidate_key === direct.key);
      if (match) addSelected(match, direct.start, 'candidate_key');
      else issues.push(unresolvedResourceIssue({
        type: direct.key.startsWith('i') ? 'image' : 'file',
        role: direct.key.startsWith('i') ? 'source' : 'attachment',
        reason: 'missing',
      }));
    }

    const explicitIdentities = [];
    for (const match of String(input || '').matchAll(/res:(image|file):[^\s,，。;；!?！？]+/gi)) {
      explicitIdentities.push({
        type: match[1].toLowerCase(),
        value: match[0].replace(/[)\]}>，。;；!?！？]+$/g, ''),
        start: match.index || 0,
      });
    }
    for (const match of String(input || '').matchAll(/(?:image|photo|图片|图像|file|document|文件|附件)\s*(?:id|ID|编号)\s*[:#=：]?\s*([A-Za-z0-9._:%/-]{3,})/gi)) {
      explicitIdentities.push({
        type: /^(?:file|document|文件|附件)/i.test(match[0]) ? 'file' : 'image',
        value: match[1],
        start: match.index || 0,
      });
    }
    for (const identity of explicitIdentities) {
      const matches = catalog.filter(candidate => candidate.type === identity.type && uniqueStrings([
        candidate.candidate_key,
        candidate.resource_id,
        candidate.id,
        candidate.reference_id,
        ...(candidate.identity_aliases || []),
      ]).some(token => token.toLowerCase() === identity.value.toLowerCase()));
      if (matches.length) {
        const sourceRank = { current: 0, quoted: 1, history: 2, context: 3 };
        const preferred = [...matches].sort((left, right) => (
          (sourceRank[left.source] ?? 9) - (sourceRank[right.source] ?? 9)
        ))[0];
        addSelected(preferred, identity.start, 'identity');
      } else {
        issues.push(unresolvedResourceIssue({
          type: identity.type,
          role: identity.type === 'file' ? 'attachment' : 'source',
          reason: 'missing',
        }));
      }
    }

    for (const candidate of catalog.filter(item => ['image', 'file'].includes(item.type))) {
      const identityTokens = uniqueStrings([
        candidate.resource_id,
        candidate.id,
        candidate.reference_id,
        ...(candidate.identity_aliases || []),
      ]);
      let position = explicitTokenPosition(input, candidate.candidate_key, { shortKey: true });
      if (position < 0) {
        for (const token of identityTokens) {
          position = explicitTokenPosition(input, token);
          if (position >= 0) break;
        }
      }
      if (position < 0) position = strongCandidateLabelPosition(input, candidate);
      if (position >= 0) addSelected(candidate, position, 'identity');
    }

    const available = selected.filter(item => item.candidate.availability !== 'unavailable');
    for (const item of selected.filter(entry => entry.candidate.availability === 'unavailable')) {
      issues.push(unresolvedResourceIssue({
        type: item.candidate.type,
        role: item.candidate.type === 'file' ? 'attachment' : 'source',
        reason: 'unavailable',
        candidates: [item.candidate],
      }));
    }
    return {
      selected: available.sort((left, right) => left.start - right.start),
      issues,
    };
  }

  function selectorBindingRoles(operation = '', type = '') {
    if (type === 'file') return ['file_qa', 'multimodal_qa'].includes(operation) ? ['attachment'] : [];
    if (type !== 'image') return [];
    if (operation === 'edit_image') return ['target'];
    if (operation === 'image_reference_gen') return ['reference', 'style_reference'];
    if (operation === 'image_compare') return ['compare_a', 'compare_b'];
    if (['image_qa', 'ocr', 'multimodal_qa'].includes(operation)) return ['source'];
    return [];
  }

  function rekeyBindings(bindings = []) {
    return bindings.map((binding, index) => ({ ...binding, key: `r${index + 1}` }));
  }

  function reconcileExplicitResourceSelectors(plan = {}, catalog = [], input = '', context = {}) {
    const operation = stringValue(plan.operation);
    const resolved = explicitCandidateSelections(input, catalog, context);
    let bindings = Array.isArray(plan.bindings) ? [...plan.bindings] : [];
    const issues = resolved.issues.map(issue => {
      const roles = selectorBindingRoles(operation, issue.type);
      return roles.length ? { ...issue, role: roles[0] } : issue;
    });
    const byType = new Map();
    for (const item of resolved.selected) {
      const list = byType.get(item.candidate.type) || [];
      list.push(item.candidate);
      byType.set(item.candidate.type, list);
    }

    for (const [type, candidates] of byType.entries()) {
      const roles = selectorBindingRoles(operation, type);
      if (!roles.length) continue;
      bindings = bindings.filter(binding => !(binding.type === type && roles.includes(binding.role)));

      if (operation === 'edit_image' && type === 'image') {
        if (candidates.length !== 1 && !hasExplicitMultiImageSelection(input, catalog)) {
          issues.push(unresolvedResourceIssue({
            type: 'image', role: 'target', reason: 'ambiguous', candidates,
          }));
          continue;
        }
        for (const candidate of candidates) bindings.push(bindingForCandidate(candidate, 'target'));
        continue;
      }

      if (operation === 'image_compare' && type === 'image') {
        if (candidates.length !== 2) {
          issues.push(unresolvedResourceIssue({
            type: 'image', role: 'compare_a', reason: 'ambiguous', candidates,
          }));
          continue;
        }
        bindings.push(bindingForCandidate(candidates[0], 'compare_a'));
        bindings.push(bindingForCandidate(candidates[1], 'compare_b'));
        continue;
      }

      const role = operation === 'image_reference_gen'
        && /(?:风格|配色|色调|style|palette)/i.test(stringValue(input))
        ? 'style_reference'
        : roles[0];
      for (const candidate of candidates) bindings.push(bindingForCandidate(candidate, role));
    }

    const issueTypes = new Set(issues.map(issue => issue.type));
    for (const type of issueTypes) {
      const roles = selectorBindingRoles(operation, type);
      if (roles.length) bindings = bindings.filter(binding => !(binding.type === type && roles.includes(binding.role)));
    }
    return { plan: { ...plan, bindings: rekeyBindings(bindings) }, issues };
  }

  function supplementUnambiguousBindings(plan = {}, catalog = [], input = '', relation = 'new', blockedIssues = []) {
    const operation = stringValue(plan.operation);
    const bindings = Array.isArray(plan.bindings) ? [...plan.bindings] : [];
    const blocked = Array.isArray(blockedIssues) ? blockedIssues : [];
    const boundTypes = new Set(bindings.map(binding => String(binding.type || '') + ':' + String(binding.role || '')));
    const addFor = (type, role, candidates) => {
      if (boundTypes.has(type + ':' + role) || candidates.length !== 1) return;
      bindings.push(bindingForCandidate(candidates[0], role, 'r' + (bindings.length + 1)));
      boundTypes.add(type + ':' + role);
    };
    for (const spec of requiredResourceSpecs(operation)) {
      if (blocked.some(issue => issue?.type === spec.type && spec.roles.includes(issue?.role))) continue;
      if (bindings.some(binding => binding.type === spec.type && spec.roles.includes(
        canonicalBindingRole(operation, binding.type, binding.role, {
          soleEditImage: operation === 'edit_image' && bindings.filter(item => item.type === 'image').length === 1,
        }),
      ))) continue;
      let pool = candidatePoolFor(spec.type, catalog, relation);
      const explicitIndex = explicitIndexFromInput(input, spec.type);
      if (explicitIndex) pool = pool.filter(candidate => Number(candidate.index) === explicitIndex);
      // A named subject may recover an older image only when it produces one
      // clear match. Two plausible matches still go to the image chooser.
      if (!explicitIndex && spec.type === 'image' && operation === 'edit_image' && pool.length > 1) {
        const subjectMatches = pool.filter(candidate => sharedCandidateTokens(input, candidate).length > 0);
        if (subjectMatches.length === 1) pool = subjectMatches;
      }
      if (operation === 'image_compare' && pool.length === 2) {
        const role = spec.role === 'compare_a' ? 'compare_a' : 'compare_b';
        const candidate = pool.find(item => Number(item.index) === (role === 'compare_a' ? 1 : 2)) || pool[role === 'compare_a' ? 0 : 1];
        if (candidate) {
          bindings.push(bindingForCandidate(candidate, role, 'r' + (bindings.length + 1)));
          boundTypes.add(spec.type + ':' + role);
        }
      } else if (pool.length === 1) {
        addFor(spec.type, spec.role, pool);
      }
    }
    return { ...plan, bindings };
  }

  function isConcreteImageEditRequest(input = '', catalog = []) {
    const text = stringValue(input);
    if (!CONCRETE_CHANGE_PATTERNS.test(text)) return false;
    if (EXPLICIT_TEXT_SUBJECT_PATTERNS.test(text)) return false;
    if (EXPLICIT_IMAGE_SUBJECT_PATTERNS.test(text)) return true;
    if (!VISUAL_MUTATION_TARGET_PATTERNS.test(text)) return false;

    // A concrete visual change (for example, “把背景改成雪山”) is an image
    // editing request even when the user omits “this image”.  The compiler
    // never guesses the target: one available image is bound, multiple images
    // produce a chooser, and no image produces an upload/select request.
    // This makes model-outage fallback useful without weakening safety.
    const hasImageCandidate = catalog.some(candidate => (
      candidate.type === 'image' || candidate.image_id || candidate.imageId
    ));
    if (hasImageCandidate) return true;

    // With no image in context, retain the visual-edit interpretation so the
    // user receives a precise request for a target image instead of a generic
    // chat answer. Explicit text references were rejected above.
    if (!IMAGE_GENERATION_INTENT_PATTERN.test(text)) return true;

    return false;
  }

  function isExplicitFileResourceRequest(input = '') {
    return EXPLICIT_FILE_RESOURCE_PATTERNS.test(stringValue(input));
  }

  function hasCurrentCandidates(catalog = [], type = '') {
    return catalog.some(candidate => candidate?.type === type && candidate?.source === 'current');
  }

  function shouldPreferCurrentSourceForOrdinal(input = '', type = '', catalog = []) {
    return typeof ordinalResourceScopeFor === 'function'
      && ordinalResourceScopeFor({ input, type, candidates: catalog }) === 'current';
  }

  function normalizeProvisionalRelation(operation = '', relation = 'new', input = '', catalog = []) {
    if (relation !== 'new') return relation;
    const text = stringValue(input);
    if (operation === 'file_qa') {
      const hasCurrentFile = catalog.some(candidate => candidate.type === 'file' && candidate.source === 'current');
      if (!hasCurrentFile && PRIOR_FILE_RESOURCE_PATTERNS.test(text)) return 'followup';
      return relation;
    }
    if (operation !== 'edit_image') return relation;
    const historicalImages = catalog.filter(candidate => candidate.type === 'image'
      && ['quoted', 'history', 'context'].includes(candidate.source));
    if (!historicalImages.length) return relation;
    if (isConcreteImageEditRequest(text, catalog)
        || historicalImages.some(candidate => sharedCandidateTokens(text, candidate).length > 0)) return 'followup';
    return relation;
  }

  function resolvedClarificationContext(context = {}) {
    const value = context?.clarification_context;
    if (!value || value.schema_version !== 'clarification_context.v4' || value.answer_complete !== true) return null;
    return value;
  }

  function resolvedClarificationResourceFacts(context = {}) {
    const resolution = resolvedClarificationContext(context);
    if (!resolution) return [];
    const facts = [];
    const positionsByKey = new Map();
    // Established bindings are the base plan; a structured answer may replace
    // the same slot key, so selected resources are applied last.
    for (const resource of clarificationResourceFacts(resolution)) {
      if (!resource || typeof resource !== 'object') continue;
      const key = stringValue(resource.resource_key || resource.key);
      if (key && positionsByKey.has(key)) {
        facts[positionsByKey.get(key)] = resource;
      } else {
        if (key) positionsByKey.set(key, facts.length);
        facts.push(resource);
      }
    }
    return facts;
  }

  // A completed clarification can carry the resources from its parent route.
  // When the user selects one task from a mixed multi-task plan, those parent
  // resources are broader than the selected task's execution contract. Keep
  // only resource families that the selected operation is allowed to consume;
  // otherwise an image_qa task can inherit the sibling file (or vice versa) and
  // fail contract validation even though its own plan binding is correct.
  function clarificationResourceTypeAllowed(operation = '', type = '') {
    const op = stringValue(operation);
    const resourceType = stringValue(type);
    if (['image_qa', 'ocr'].includes(op)) {
      return ['image', 'message'].includes(resourceType);
    }
    if (op === 'image_compare') return ['image', 'message'].includes(resourceType);
    if (op === 'file_qa') return ['file', 'message'].includes(resourceType);
    if (op === 'multimodal_qa') return ['image', 'file', 'message'].includes(resourceType);
    if (['image_reference_gen', 'edit_image'].includes(op)) return resourceType === 'image';
    if (['plain_chat', 'web_search', 'text_to_image'].includes(op)) {
      return ['message', 'text'].includes(resourceType);
    }
    // Unknown operations must fail through the normal contract validator rather
    // than silently discarding evidence at this boundary.
    return true;
  }

  function clarificationBindingsFor(operation = '', context = {}) {
    const resources = resolvedClarificationResourceFacts(context)
      .filter(resource => clarificationResourceTypeAllowed(operation, resource?.type));
    const reservedKeys = new Set(resources
      .map(resource => stringValue(resource?.resource_key || resource?.key))
      .filter(key => /^r[1-9]\d*$/.test(key)));
    let nextIndex = 1;
    const nextKey = () => {
      while (reservedKeys.has(`r${nextIndex}`)) nextIndex += 1;
      const key = `r${nextIndex}`;
      reservedKeys.add(key);
      nextIndex += 1;
      return key;
    };
    return resources.map(resource => {
      const type = stringValue(resource?.type);
      const requestedKey = stringValue(resource?.resource_key || resource?.key);
      return {
        key: /^r[1-9]\d*$/.test(requestedKey) ? requestedKey : nextKey(),
        type,
        role: canonicalBindingRole(operation, type, resource?.role),
        resource_id: normalizeBindingResourceId(type, resource?.resource_id || resource?.resourceId),
        source: normalizedSource(resource?.source, 'context'),
      };
    }).filter(binding => binding.type && binding.role && binding.resource_id);
  }

  function mergeClarificationBindings(plan = {}, context = {}) {
    const resolved = clarificationBindingsFor(plan.operation, context);
    if (!resolved.length) return plan;
    const resolvedKeys = new Set(resolved.map(binding => binding.key));
    const resolvedRoles = new Set(resolved.map(binding => `${binding.type}|${binding.role}`));
    const retained = (Array.isArray(plan.bindings) ? plan.bindings : []).filter(binding => (
      !resolvedKeys.has(stringValue(binding?.key))
      && !resolvedRoles.has(`${stringValue(binding?.type)}|${stringValue(binding?.role)}`)
    ));
    return {
      ...plan,
      bindings: canonicalPlanBindings({ operation: plan.operation, bindings: [...retained, ...resolved] }),
    };
  }

  function normalizeRouteDraft(plan = {}, options = {}, catalog = []) {
    // The caller's current input is authoritative, including an intentional
    // empty string. Falling back with `||` would let a malformed or fabricated
    // model arguments.prompt turn an attachment-only turn into a different
    // textual request at the trust boundary.
    const input = Object.prototype.hasOwnProperty.call(options, 'input')
      ? stringValue(options.input)
      : stringValue(plan.arguments?.prompt || '');
    const proposedOperation = stringValue(plan.operation);

    // route_intent.v3 owns operation, relation, goal, goal mode, resource selection, and task shape.
    // The local compiler validates and projects those semantics; it must not
    // reinterpret current_input with a second, regex-based intent system.
    if (modelOwnsRouteSemantics(options)) {
      if (!capabilityFor(proposedOperation)) throw new TypeError('Unsupported operation: ' + proposedOperation);
      return {
        operation: proposedOperation,
        relation: VALID_RELATIONS.has(stringValue(plan.relation)) ? stringValue(plan.relation) : 'new',
        arguments: { prompt: input },
        constraints: (Array.isArray(plan.constraints) ? plan.constraints : []).map(stringValue).filter(Boolean),
        bindings: canonicalPlanBindings({
          operation: proposedOperation,
          bindings: Array.isArray(plan.bindings) ? plan.bindings : [],
        }),
      };
    }

    const clarificationResolution = resolvedClarificationContext(options.context);
    const selectedFollowupSubject = stringValue(clarificationResolution?.selected_parameters?.followup_subject);
    let operation = selectedFollowupSubject === 'text'
      ? 'plain_chat'
      : selectedFollowupSubject === 'image'
        ? stringValue(clarificationResolution?.operation) || 'image_reference_gen'
        : stringValue(clarificationResolution?.operation) || proposedOperation;
    if (!capabilityFor(operation)) operation = 'plain_chat';
    // The model proposes an operation, but the local execution boundary owns
    // deterministic resource semantics. A concrete visual mutation cannot be
    // dispatched through a read-only image operation, and an explicit prior
    // file reference cannot degrade to ordinary chat.
    const historicalVisualMatches = historicalVisualReframeMatches(input, catalog);
    if ((isConcreteImageEditRequest(input, catalog) || historicalVisualMatches.length)
        && !IMAGE_GENERATION_INTENT_PATTERN.test(input)
        && operation !== 'image_reference_gen') operation = 'edit_image';
    if (operation === 'plain_chat' && isExplicitFileResourceRequest(input)) operation = 'file_qa';

    // Explicit directives are declared by the shared capability registry.
    // They state non-executable user facts (operation, relation, and resource
    // scope); this compiler remains responsible for binding real resources.
    const explicitDirective = typeof explicitRouteDirectiveFor === 'function'
      ? explicitRouteDirectiveFor({ input, candidates: catalog })
      : null;
    if (explicitDirective?.operation) operation = explicitDirective.operation;

    const media = catalog.filter(candidate => ['image', 'file'].includes(candidate.type));
    if (!input && !(Array.isArray(plan.bindings) && plan.bindings.length) && media.length === 1) {
      operation = media[0].type === 'image' ? 'image_qa' : 'file_qa';
    }
    const operationChanged = operation !== proposedOperation;
    const clarificationRelation = stringValue(clarificationResolution?.relation);
    const proposedRelation = VALID_RELATIONS.has(clarificationRelation)
      ? clarificationRelation
      : VALID_RELATIONS.has(stringValue(plan.relation)) ? stringValue(plan.relation) : 'new';
    const provisional = {
      operation,
      relation: explicitDirective?.relation || normalizeProvisionalRelation(operation, proposedRelation, input, catalog),
      arguments: { prompt: input },
      constraints: (Array.isArray(plan.constraints) ? plan.constraints : []).map(stringValue).filter(Boolean),
      // Bindings belong to the operation that produced them. If the trust
      // boundary deterministically changes that operation, discard those stale
      // roles and rebuild only from unambiguous local candidates. Carrying a
      // read-only `source` binding into edit_image would authorize the wrong
      // resource or conceal an ambiguity. A directive with the same operation
      // only constrains resource provenance: model selections already resolved
      // from the published candidate catalog remain authoritative when they are
      // inside that scope, including multiple resources for roles whose shared
      // capability cardinality permits them.
      bindings: canonicalPlanBindings({
        operation,
        bindings: planBindingsWithinDirectiveScope(plan.bindings, explicitDirective, { operationChanged }),
      }),
    };
    const relationOverride = relationOverrideForInput(provisional, catalog, options);
    if (relationOverride && relationOverride !== provisional.relation) provisional.relation = relationOverride;
    let supplemented = supplementUnambiguousBindings(
      provisional,
      catalog,
      input,
      provisional.relation,
      options.forcedClarificationIssues,
    );
    supplemented = mergeClarificationBindings(supplemented, options.context);
    if (operation === 'image_reference_gen' && /(?:配色|色调)/i.test(input)) {
      supplemented = {
        ...supplemented,
        bindings: (supplemented.bindings || []).map(binding => (
          binding.type === 'image' && binding.role === 'reference'
            ? { ...binding, role: 'style_reference' }
            : binding
        )),
      };
    }
    const quote = options.context?.quoted_message && typeof options.context.quoted_message === 'object'
      ? catalog.find(candidate => candidate.type === 'message' && candidate.source === 'quoted')
      : null;
    if (quote && ['text_to_image', 'plain_chat'].includes(operation)
        && !supplemented.bindings.some(binding => binding.type === 'message')) {
      supplemented.bindings = [
        ...(supplemented.bindings || []),
        bindingForCandidate(quote, 'context', 'r' + ((supplemented.bindings || []).length + 1)),
      ];
    }
    return supplemented;
  }

  function hasImageLineage(resources = [], options = {}) {
    if (resources.some(resource => resource?.type === 'image')) return true;
    if (options.context?.previous_execution?.result_reference_id) return true;
    return Array.isArray(options.context?.image_candidates)
      && options.context.image_candidates.some(candidate => candidate?.type === 'image' || candidate?.image_id || candidate?.imageId);
  }

  function relationOverrideForInput(plan = {}, resources = [], options = {}) {
    const operation = stringValue(plan.operation);
    const input = stringValue(plan.input || plan.arguments?.prompt || options.input);
    if (!input) return '';
    if (operation === 'plain_chat' && (TEXTUAL_DISCOURSE_FOLLOWUP_PATTERN.test(input) || SHORT_ASPECT_FOLLOWUP_PATTERN.test(input))) {
      const priorContext = contextBeforeCurrentTurn(options.context || {}, options.currentTurn);
      const hasPriorConversation = (Array.isArray(priorContext?.recent_messages) ? priorContext.recent_messages : [])
        .some(message => ['user', 'assistant'].includes(stringValue(message?.role))
          && !!stringValue(message?.content || message?.rawText));
      if (hasPriorConversation) return 'followup';
    }
    if (!IMAGE_RELATION_OPERATIONS.has(operation) || !hasImageLineage(resources, options)) return '';
    if (CONTINUATION_RELATION_PATTERN.test(input)) return 'continuation';
    return '';
  }

  function canonicalRelationForPlan(plan = {}, resources = [], options = {}) {
    let relation = VALID_RELATIONS.has(stringValue(plan.relation)) ? stringValue(plan.relation) : 'new';
    if (modelOwnsRouteSemantics(options)) return relation;
    const operation = stringValue(plan.operation);
    const input = stringValue(plan.input || plan.arguments?.prompt || options.input);
    const explicitHistoricalImage = IMAGE_RELATION_OPERATIONS.has(operation)
      && (EXPLICIT_IMAGE_RESOURCE_ORDINAL_PATTERN.test(input)
        || HISTORICAL_IMAGE_REFERENCE_PATTERN.test(input));
    if (relation === 'new' && explicitHistoricalImage) relation = 'followup';
    const override = relationOverrideForInput(plan, resources, options);
    if (override) relation = override;
    if (relation === 'new' && resources.some(resource => ['quoted', 'history', 'context'].includes(resource.source))) relation = 'followup';
    if (relation === 'new' && options.context?.quoted_message && resources.some(resource => resource.type === 'message')) relation = 'followup';
    return relation;
  }

  function resourceRequirementIssues(operation = '', relation = 'new', projected = [], catalog = [], options = {}) {
    const issues = [];
    for (const spec of requiredResourceSpecs(operation)) {
      const selected = projected.filter(resource => (
        resource.type === spec.type && spec.roles.includes(resource.role)
      ));
      if (selected.length >= spec.min && selected.length <= spec.max) continue;
      // A multi-task edit uses one target per child task. The parent route is
      // only a planning envelope, so defer the target max-cardinality check
      // until each planned child is compiled.
      if (options.planningImageTasks && operation === 'edit_image'
          && spec.type === 'image' && spec.roles.includes('target')
          && selected.length > spec.max) continue;
      const pool = candidatePoolFor(spec.type, catalog, relation);
      const available = pool.filter(candidate => candidate.availability !== 'unavailable');
      const unavailable = pool.filter(candidate => candidate.availability === 'unavailable');
      if (!selected.length && !available.length && unavailable.length) {
        issues.push(unresolvedResourceIssue({ type: spec.type, role: spec.role, reason: 'unavailable' }));
      } else if (!selected.length && available.length > 1) {
        issues.push(unresolvedResourceIssue({ type: spec.type, role: spec.role, reason: 'ambiguous', candidates: available }));
      } else {
        issues.push(unresolvedResourceIssue({ type: spec.type, role: spec.role, reason: 'missing' }));
      }
    }
    return issues;
  }

  function ambiguityIssues(operation = '', input = '', projected = [], catalog = [], relation = 'new') {
    if (operation !== 'edit_image') return [];
    const target = projected.find(resource => resource.type === 'image' && resource.role === 'target');
    if (!target) return [];
    const candidates = candidatePoolFor('image', catalog, relation).filter(candidate => candidate.availability !== 'unavailable');
    if (candidates.length < 2) return [];
    const explicitIndex = explicitIndexFromInput(input, 'image');
    if (explicitIndex && Number(target.index) === explicitIndex) return [];
    const matched = candidates.filter(candidate => sharedCandidateTokens(input, candidate).length > 0);
    if (matched.length >= 2) return [unresolvedResourceIssue({ key: target.key, type: 'image', role: 'target', reason: 'ambiguous', candidates: matched })];
    // A bare demonstrative referent (“这张/那个”) over multiple current candidates is
    // ambiguous, but an explicit ordinal/count/all selection is not.
    const text = stringValue(input);
    const genericReferent = /(?:\u8fd9\u5f20|\u90a3\u5f20|\u8fd9\u4e2a|\u90a3\u4e2a|\u56fe\u7247|\u56fe\u50cf)/.test(text);
    const explicitSelection = /(?:\u7b2c[\u4e00\u4e8c\u4e09\u56db\u4e94\u516d\u4e03\u516b\u4e5d\u5341\u767e\d]+|\u5168\u90e8|\u90fd|\u5206\u522b|\u4e24\u5f20|\u4e09\u5f20|[\u4e00\u4e8c\u4e09\u56db\u4e94\u516d\u4e03\u516b\u4e5d\u5341\u4e24\d]+\u5f20)/.test(text);
    if (genericReferent && candidates.length >= 2 && !explicitSelection) {
      return [unresolvedResourceIssue({ key: target.key, type: 'image', role: 'target', reason: 'ambiguous', candidates })];
    }
    return [];
  }

  // Input completeness is independent of operation selection. A deictic
  // source phrase is not source evidence and must remain a text clarification
  // until the user supplies text, a quoted message, or a file.
  function missingTextSourceForInput(input = '', context = {}, catalog = []) {
    const text = stringValue(input);
    if (!text) return false;
    const sourceCue = /(?:\u4e0b\u9762(?:\u8fd9\u6bb5|\u8fd9\u7bc7)?(?:\u8bdd|\u6587\u5b57|\u5185\u5bb9)?|\u4ee5\u4e0b(?:\u8fd9\u6bb5|\u8fd9\u7bc7)?(?:\u8bdd|\u6587\u5b57|\u5185\u5bb9)?|\u8fd9\u6bb5(?:\u8bdd|\u6587\u5b57|\u5185\u5bb9)|the following text|the text below|following passage)/i.test(text);
    if (!sourceCue || hasQuotedEvidence(context)) return false;
    // "下面这段文字：实际正文" is self-contained. A source cue only blocks
    // dispatch when it is genuinely deictic, not when the current input already
    // carries the text to transform after a delimiter.
    const inlineSource = /[：:]\s*(?:[“"'‘「『]|[^\s：:])/.test(text);
    if (inlineSource) return false;
    return !(Array.isArray(catalog) ? catalog : []).some(candidate => {
      if (candidate?.availability === 'unavailable') return false;
      if (candidate?.type === 'file') return true;
      // The current user turn is the instruction, not the referenced source.
      // Only a quoted/history/context message can satisfy the deictic source.
      return candidate?.type === 'message' && stringValue(candidate?.source) !== 'current';
    });
  }

  function crossApiMultiTask(input = '') {
    const text = stringValue(input);
    if (!text) return false;
    const first = /(?:先|首先|第一步).*(?:总结|概括|解释|分析|提取|读取|识别)/s.test(text);
    const second = /(?:再|然后|之后|并根据|并据此|同时).*(?:生成|画|绘制|制作|创建|海报|图片|插画)/s.test(text);
    const reverse = /(?:生成|画|制作|创建).*(?:再|然后|之后).*(?:总结|解释|分析|提取)/s.test(text);
    return (first && second) || reverse;
  }

  function manualModeIssue(operation = '', options = {}) {
    if (options.autoMode !== false) return null;
    const mode = stringValue(options.currentMode || 'chat');
    const allowed = mode === 'image'
      ? ['text_to_image', 'image_reference_gen']
      : mode === 'edit_image'
        ? ['edit_image', 'image_reference_gen']
        : ['plain_chat', 'web_search', 'file_qa', 'multimodal_qa', 'image_qa', 'image_compare', 'ocr'];
    return allowed.includes(operation) ? null : unresolvedResourceIssue({ type: 'text', role: 'source', reason: 'missing' });
  }

  function clarificationQuestionForIssues(issues = [], { operation = '', multiTask = false, manual = false } = {}) {
    if (multiTask) return '本轮请求包含多个不同执行任务，一次只能执行一个。请重新描述你本次要执行的那个任务。';
    if (manual) return '当前处于固定模式，本轮请求与当前模式不一致。请确认是否切换到合适的模式后再继续。';
    const first = issues[0];
    if (!first) return '';
    if (first.reason === 'unavailable') return '所需资源当前不可用，请重新上传可读取的文件或图片后继续。';
    if (first.type === 'image' && first.role === 'target') {
      if (first.reason === 'ambiguous' && Array.isArray(first.choices) && first.choices.length) {
        return '没有明确要编辑哪张图片，请从下列图片中选择目标图片。';
      }
      return '没有找到可用图片，请重新上传或选择一张图片。';
    }
    if (first.type === 'file' && first.reason === 'ambiguous' && Array.isArray(first.choices) && first.choices.length) {
      return '没有明确要使用哪个文件，请从下列文件中选择。';
    }
    if (first.reason === 'missing_source_text') return '\u8bf7\u5148\u63d0\u4f9b\u9700\u8981\u5904\u7406\u7684\u6587\u672c\uff0c\u6216\u7c98\u8d34\u6216\u5f15\u7528\u90a3\u6bb5\u6587\u672c\u540e\u518d\u7ee7\u7eed\u3002';
    if (first.reason === 'ambiguous') return '匹配到多个候选资源，请选择要使用的对象后继续。';
    if (first.type === 'text' && ['text_to_image', 'image_reference_gen'].includes(operation)) return '你想生成什么样的图片？请补充画面内容描述，例如主体、场景和风格。';
    if (first.type === 'text') return '请补充本轮要执行的具体问题或指令。';
    if (first.type === 'image') return '请提供或选择本轮要使用的图片。';
    if (first.type === 'file') return '请提供或选择本轮要使用的文件。';
    return '请补充本轮执行所需的信息。';
  }

  // v2.7 section 8.1 Attachment Modality Preflight. Preflight only validates
  // or deterministically normalizes the resource modality; it never re-runs
  // keyword intent detection. When the model proposes a read-only analysis
  // operation whose domain disagrees with the sole current attachment, and the
  // selector unambiguously points at that attachment, normalize the operation
  // to the matching analysis operation (visual → document or document →
  // visual). create/transform/reference/edit operations, mixed image+file
  // attachments, unresolved selectors, family changes and user-vs-resource
  // conflicts are never normalized: those cases keep the original operation so
  // the regular clarification flow explains the owned resource types and the
  // executable paths instead of overwriting the Intent with keyword rules.
  function normalizeAttachmentModality(plan = {}, catalog = [], input = '', options = {}) {
    if (modelOwnsRouteSemantics(options)) return plan;
    const operation = stringValue(plan.operation);
    // Only analysis operations (answer/inspect/extract) are eligible.
    // image_compare needs two images and multimodal_qa needs image+file
    // together; a sole attachment cannot satisfy either, so they stay on the
    // resource-requirement clarification path instead of being rewritten.
    const VISUAL_SINGLE_ANALYSIS = new Set(['image_qa', 'ocr']);
    if (!VISUAL_SINGLE_ANALYSIS.has(operation) && operation !== 'file_qa') return plan;
    const currentMedia = catalog.filter(candidate => candidate.source === 'current'
      && (candidate.type === 'image' || candidate.type === 'file'));
    // A deterministic normalization requires exactly one current attachment.
    if (currentMedia.length !== 1) return plan;
    const attachment = currentMedia[0];
    const attachmentType = stringValue(attachment.type);
    // The selector must unambiguously point at that attachment.
    const bindings = Array.isArray(plan.bindings) ? plan.bindings : [];
    if (bindings.length !== 1) return plan;
    const binding = bindings[0];
    if (stringValue(binding.type) !== attachmentType) return plan;
    const bindingResourceId = stringValue(binding.resource_id);
    const candidateKey = bindingResourceId.replace(/^res:[a-z]+:/, '');
    const selectorMatches = bindingResourceId === stringValue(attachment.resource_id)
      || (candidateKey && candidateKey === stringValue(attachment.candidate_key));
    if (!selectorMatches) return plan;
    const text = stringValue(input);
    if (VISUAL_SINGLE_ANALYSIS.has(operation) && attachmentType === 'file') {
      // The user explicitly asked for an image while the only attachment is a
      // document: that is a user-vs-resource conflict, not a model domain
      // slip. Keep the conflict visible so the clarification explains it.
      if (EXPLICIT_IMAGE_SUBJECT_PATTERNS.test(text)) return plan;
      // visual + inspect → document + inspect
      return { ...plan, operation: 'file_qa' };
    }
    if (operation === 'file_qa' && attachmentType === 'image') {
      if (EXPLICIT_FILE_RESOURCE_PATTERNS.test(text)) return plan;
      // document + inspect → visual + inspect
      return { ...plan, operation: 'image_qa' };
    }
    return plan;
  }

  function taskContinuityForCompiledRoute(operation = '', args = {}, executionInput = '', options = {}) {
    if (!IMAGE_TASK_STATE_OPERATIONS.has(operation)) return null;
    const hasExplicitTaskState = Object.prototype.hasOwnProperty.call(options, 'imageTaskState')
      && options.imageTaskState !== null
      && options.imageTaskState !== undefined;
    if (hasExplicitTaskState) {
      if (typeof normalizeOptionalTaskContinuity !== 'function') {
        throw new TypeError('Task continuity protocol is unavailable');
      }
      return normalizeOptionalTaskContinuity(options.imageTaskState);
    }
    if (typeof transitionTaskContinuity !== 'function') {
      throw new TypeError('Task continuity protocol is unavailable');
    }
    const goalMode = stringValue(options.goalMode) || 'replace';
    if (goalMode === 'amend' && !IMAGE_TASK_AMEND_OPERATIONS.has(operation)) {
      const error = new TypeError(`${operation} cannot amend an image task state`);
      error.code = 'ROUTE_GOAL_MODE_OPERATION_MISMATCH';
      throw error;
    }
    const goal = stringValue(options.resolvedImageGoal || args.prompt || executionInput);
    return transitionTaskContinuity({
      goalMode,
      goal,
      previousExecution: options.context?.previous_execution || null,
    });
  }

  function compileLocalRoute(plan, options = {}) {
    const input = Object.prototype.hasOwnProperty.call(options, 'input')
      ? stringValue(options.input)
      : stringValue(plan?.arguments?.prompt || '');
    const normalizationChanges = [];
    const normalizationOptions = {
      ...options,
      input,
      recordSemanticNormalization: change => normalizationChanges.push(change),
    };
    const originalSemantic = {
      operation: stringValue(plan?.operation),
      relation: stringValue(plan?.relation),
    };
    const initialCatalog = routeCompilationCandidateCatalog(normalizationOptions);
    const sanitizedPlan = sanitizeRouteDraft(plan, normalizationOptions);
    const provisionalPlan = normalizeRouteDraft(sanitizedPlan, normalizationOptions, initialCatalog);
    recordSemanticNormalization(normalizationOptions, {
      field: 'operation',
      from: originalSemantic.operation,
      to: provisionalPlan.operation,
      reason: 'local_route_draft_resolution',
    });
    recordSemanticNormalization(normalizationOptions, {
      field: 'relation',
      from: originalSemantic.relation,
      to: provisionalPlan.relation,
      reason: 'local_route_draft_resolution',
    });
    const selectorResult = modelOwnsRouteSemantics(options)
      ? { plan: provisionalPlan, issues: [] }
      : reconcileExplicitResourceSelectors(provisionalPlan, initialCatalog, input, options.context || {});
    // A completed clarification answer is an authoritative resource decision.
    // Apply it on both the local and model-owned route paths; otherwise a
    // valid model reroute that omits the previously selected media reopens the
    // same missing-image clarification.
    const clarifiedPlan = mergeClarificationBindings(selectorResult.plan, options.context || {});
    const planValue = normalizeAttachmentModality(clarifiedPlan, initialCatalog, input, normalizationOptions);
    recordSemanticNormalization(normalizationOptions, {
      field: 'operation',
      from: provisionalPlan.operation,
      to: planValue.operation,
      reason: 'attachment_modality_alignment',
    });
    const op = stringValue(planValue.operation);
    const registered = capabilityFor(op);
    if (!registered) throw new TypeError('Unsupported operation: ' + op);

    const clarificationResolution = resolvedClarificationContext(options.context);
    const selectedParameters = clarificationResolution?.selected_parameters || {};
    // v2.7 section 11.1 rule 10: a single per-task counter. Every round that
    // consumes a completed clarification answer advances the counter; the
    // counter travels on the returned route so the caller can persist it in
    // the task state and feed it back through options.context.
    const priorRounds = Number(options.context?.clarification_rounds) || 0;
    const consumingAnswer = !!clarificationResolution;
    const clarificationRounds = consumingAnswer ? priorRounds + 1 : priorRounds;
    const clarificationExhausted = clarificationRounds > MAX_CLARIFICATION_ROUNDS;
    const clarificationOverrides = Object.fromEntries(
      Object.entries(selectedParameters).filter(([name]) => Object.prototype.hasOwnProperty.call(registered.arguments, name)),
    );
    const argumentOverrides = {
      ...clarificationOverrides,
      ...(options.overrides || {}),
    };
    const resolved = resolvePlanResources(planValue, options);
    let projectedResources = resolved.projected;
    const relation = canonicalRelationForPlan(planValue, projectedResources, normalizationOptions);
    recordSemanticNormalization(normalizationOptions, {
      field: 'relation',
      from: provisionalPlan.relation,
      to: relation,
      reason: 'relation_context_alignment',
    });
    const normalizationEvidence = semanticNormalizationEvidence(originalSemantic, { operation: op, relation }, normalizationOptions, normalizationChanges);
    const normalizedPlan = relation === planValue.relation ? planValue : { ...planValue, relation };
    const executionInput = modelOwnsRouteSemantics(options)
      ? stringValue(options.executionInput) || input
      : registered.api === 'chat'
        ? stringValue(options.executionInput) || input
        : input;
    // Parameter extraction has a narrower authority than the provider prompt.
    // It must read the raw user turn only; route-model wording is advisory and
    // can never turn a requested value into a conflicting/excluded parameter.
    const parameterInput = Object.prototype.hasOwnProperty.call(options, 'parameterInput')
      ? stringValue(options.parameterInput)
      : input;
    const providerPrompt = Object.prototype.hasOwnProperty.call(options, 'providerPrompt')
      ? stringValue(options.providerPrompt)
      : executionInput;
    const argResult = resolveExecutionArguments({
      operation: op,
      input: parameterInput,
      prompt: providerPrompt,
      defaults: options.defaults || {},
      overrides: argumentOverrides,
    });
    const args = argResult.arguments || { prompt: executionInput };
    const imageTaskState = taskContinuityForCompiledRoute(op, args, executionInput, options);
    const goalMode = stringValue(options.goalMode) || 'replace';
    const operationRequirements = typeof resourceRequirementsFor === 'function'
      ? resourceRequirementsFor(op)
      : [];
    const forcedIssues = (Array.isArray(options.forcedClarificationIssues) ? options.forcedClarificationIssues : [])
      .filter(issue => {
        const requirement = operationRequirements.find(item => (
          item.type === issue?.type && item.roles.includes(issue?.role)
        ));
        if (!requirement) return false;
        return !projectedResources.some(resource => (
          resource.type === requirement.type && requirement.roles.includes(resource.role)
        ));
      });
    const forcedRequirementKeys = new Set(forcedIssues.map(issue => `${issue.type}|${issue.role}`));
    const planningImageTasks = options.planningImageTasks || (
      !modelOwnsRouteSemantics(options)
      && op === 'edit_image'
      && hasExplicitMultiImageSelection(input, resolved.catalog)
    );
    const requirementIssues = resourceRequirementIssues(op, relation, projectedResources, resolved.catalog, {
      ...options,
      planningImageTasks,
    }).filter(issue => !forcedRequirementKeys.has(`${issue.type}|${issue.role}`));
    const missingSourceText = op === 'plain_chat'
      && missingTextSourceForInput(input, options.context || {}, resolved.catalog);
    const issues = [
      ...selectorResult.issues,
      ...resolved.issues,
      ...forcedIssues,
      ...requirementIssues,
    ];
    if (missingSourceText) {
      issues.push(unresolvedResourceIssue({ type: 'text', role: 'source', reason: 'missing_source_text' }));
    }
    if (!modelOwnsRouteSemantics(options)) {
      issues.push(...ambiguityIssues(op, input, projectedResources, resolved.catalog, relation));
    }

    const ambiguousKeys = new Set(issues.filter(issue => issue.reason === 'ambiguous' && issue.key).map(issue => issue.key));
    if (ambiguousKeys.size) projectedResources = projectedResources.filter(resource => !ambiguousKeys.has(resource.key));

    const manualIssue = manualModeIssue(op, options);
    if (manualIssue) issues.push(manualIssue);
    if (!executionInput) issues.push(unresolvedResourceIssue({ type: 'text', role: 'source', reason: 'missing' }));
    // A generation request with no subject (“生成”) cannot dispatch; clarify what to create.
    if (GENERATIVE_IMAGE_OPERATIONS.has(op)
        && options.allowVagueGeneration !== true
        && isInsufficientTextToImageRequest(executionInput)) {
      issues.push(unresolvedResourceIssue({ type: 'text', role: 'source', reason: 'missing' }));
    }
    // route_intent.v3 can authorize exactly one operation. Even when the model
    // owns the semantic proposal, a request that explicitly chains tasks from
    // different API families cannot be represented by one dispatch contract.
    // This is a protocol-capacity guard, not a competing route decision: keep
    // the proposed operation/resources visible, but block execution and ask the
    // user to split or restate the task instead of silently dropping one half.
    const multiTask = options.understandingBranch === 'multi_task_plan'
      ? true
      : modelOwnsRouteSemantics(options)
        ? stringValue(options.taskShape) === 'multi'
          && !IMAGE_RELATION_OPERATIONS.has(op)
        : crossApiMultiTask(input || executionInput);
    if (multiTask) issues.push(unresolvedResourceIssue({ type: 'text', role: 'source', reason: 'missing' }));

    const uniqueIssues = [];
    const issueKeys = new Set();
    for (const issue of issues) {
      const signature = [issue.type, issue.role, issue.reason, JSON.stringify(issue.choices || [])].join('|');
      if (issueKeys.has(signature)) continue;
      issueKeys.add(signature);
      uniqueIssues.push(issue);
    }

    const canonicalResourceIssues = normalizeResourceClarificationIssues(uniqueIssues, projectedResources)
      .map(issue => missingSourceText && issue.type === 'text' && issue.role === 'source'
        ? { ...issue, reason: 'missing_source_text' }
        : issue);
    const argumentProblems = [
      ...(argResult.conflicts || []),
      ...(argResult.invalid || []),
    ];
    // Clarification answer keys are protocol identifiers, not domain values.
    // Keep the argument name/value on the slot and choice payload, respectively,
    // so the shared answer protocol can remain strict and stable across the UI,
    // session persistence, and route replay boundaries.
    const usedParameterKeys = new Set(
      canonicalResourceIssues.map(issue => stringValue(issue?.key)).filter(key => /^p[1-9]\d*$/.test(key)),
    );
    let nextParameterKey = 1;
    const nextParameterSlotKey = () => {
      while (usedParameterKeys.has(`p${nextParameterKey}`)) nextParameterKey += 1;
      const key = `p${nextParameterKey}`;
      usedParameterKeys.add(key);
      nextParameterKey += 1;
      return key;
    };
    const argumentClarificationSlots = argumentProblems.map(problem => ({
      key: nextParameterSlotKey(),
      type: 'parameter',
      role: 'argument',
      reason: problem.code === 'ambiguous' || (argResult.conflicts || []).includes(problem) ? 'ambiguous' : 'missing',
      parameter_name: stringValue(problem.name),
      parameter_label: stringValue(problem.name),
      choices: choicesForArgument(problem.name, problem.values).map((choice, index) => ({
        key: `v${index + 1}`,
        source: 'clarification',
        label: choice.label,
        value: choice.value,
      })),
    }));
    const clarificationSlots = [
      ...canonicalResourceIssues,
      ...argumentClarificationSlots,
    ];
    const hasProblem = canonicalResourceIssues.length > 0 || argumentProblems.length > 0;
    // v2.7 section 6.7: changes paths must stay within the operation's
    // changes family. The client owns the primary gate; the server re-checks
    // body.changes defensively at dispatch-contract validation time. A
    // mismatched family never reaches execution: it degrades to a semantic
    // clarification instead of guessing.
    const changesValue = planValue.changes || options.changes || null;
    let changesFamilyInvalid = false;
    if (changesValue && typeof assertChangesFamilyCompatible === 'function') {
      // The v2.7 changes wire shape is an array of { path, op, value }. A
      // non-array is a protocol violation and must fail closed, never be
      // silently treated as an empty batch.
      if (!Array.isArray(changesValue)) {
        changesFamilyInvalid = true;
      } else {
        try {
          assertChangesFamilyCompatible(op, changesValue);
        } catch (error) {
          changesFamilyInvalid = true;
        }
      }
    }
    // v2.7 section 7.1: confirmation-style alternative. When the provider
    // cannot serve the planned operation but the registry declares an
    // equivalent alternative, ask for confirmation instead of silently
    // degrading to plain_chat. The caller re-runs the Intent Gate with the
    // alternative operation after the user confirms.
    const providerCapabilities = options.providerCapabilities || null;
    let providerAlternativePending = null;
    let providerUnsupported = false;
    if (providerCapabilities && !hasProblem && !changesFamilyInvalid && !clarificationExhausted) {
      const providerSpec = providerCapabilities?.operations?.[op] || providerCapabilities?.capabilities?.[op];
      if (providerSpec && providerSpec.supported === false) {
        const alternatives = (typeof equivalentAlternativesFor === 'function' ? equivalentAlternativesFor(op) : []) || [];
        if (alternatives.length) providerAlternativePending = alternatives[0];
        else providerUnsupported = true;
      }
    }
    const hasBlockingIssue = hasProblem
      || changesFamilyInvalid
      || providerUnsupported
      || !!providerAlternativePending
      || clarificationExhausted;
    let finalClarificationQuestion = '';
    if (clarificationExhausted) {
      finalClarificationQuestion = '本轮澄清次数已达上限，为避免循环询问，请切换显式模式或重新描述需求后再试。';
    } else if (changesFamilyInvalid) {
      finalClarificationQuestion = '当前变更描述与任务类型不兼容，请重新描述要修改的内容。';
    } else if (providerAlternativePending) {
      finalClarificationQuestion = `当前服务商不支持「${op}」操作，是否改用等效的「${providerAlternativePending.operation}」操作？`;
    } else if (providerUnsupported) {
      finalClarificationQuestion = `当前服务商不支持「${op}」操作，且没有等效替代，请更换操作方式后重试。`;
    } else {
      finalClarificationQuestion = clarificationQuestionForIssues(canonicalResourceIssues, {
        operation: op,
        multiTask: multiTask === true,
        manual: !!manualIssue,
      }) || (argumentProblems.length ? clarificationQuestion(argResult) : '');
    }

    let finalDispatchContract = null;
    let executionResources = null;
    // A multi-shaped image route is a planning envelope, never an executable
    // single-image route. Child contracts are the only dispatch authority after
    // image_plan.v1 resolves independent prompts and resource roles.
    const planningOnly = planningImageTasks && IMAGE_RELATION_OPERATIONS.has(op);
    if (!hasBlockingIssue && !planningOnly) {
      try {
        const executionBindings = projectedResources.map(resource => ({
          key: resource.key,
          type: resource.type,
          role: resource.role,
          resource_id: resource.resource_id,
          source: resource.source,
        }));
        assertExecutableBindings(op, executionBindings);
        finalDispatchContract = compileDispatchContract({
          operation: op,
          relation,
          input: executionInput,
          prompt: providerPrompt,
          parameterInput,
          defaults: options.defaults || {},
          overrides: argumentOverrides,
          bindings: executionBindings,
          constraints: normalizedPlan.constraints || [],
        });
        executionResources = buildExecutionResourceProjection(normalizedPlan, projectedResources, registered);
      } catch (error) {
        const [safeIssue] = normalizeResourceClarificationIssues(
          [unresolvedResourceIssue({ type: 'text', role: 'source', reason: 'missing' })],
          projectedResources,
          clarificationSlots,
        );
        clarificationSlots.push(safeIssue);
        finalClarificationQuestion = '当前请求的资源角色组合无法安全执行，请重新选择资源后继续。';
      }
    }

    const images = projectedResources.filter(resource => resource.type === 'image');
    const files = projectedResources.filter(resource => resource.type === 'file');
    const messages = projectedResources.filter(resource => resource.type === 'message');
    const imageRefs = images.map(resource => ({
      key: resource.key,
      role: resource.role,
      image_id: resource.id,
      resource_id: resource.resource_id,
      index: resource.index,
      source: resource.source,
      target: resource.source === 'current' ? 'uploaded' : 'previous',
      reference_id: resource.reference_id,
      identity_aliases: [...resource.identity_aliases],
      index_aliases: [...resource.index_aliases],
    }));
    const fileRefs = files.map(resource => ({
      key: resource.key,
      role: resource.role,
      file_id: resource.id,
      resource_id: resource.resource_id,
      index: resource.index,
      source: resource.source,
      identity_aliases: [...resource.identity_aliases],
      index_aliases: [...resource.index_aliases],
    }));
    const messageRefs = messages.map(resource => ({
      key: resource.key,
      role: resource.role,
      message_id: resource.id,
      resource_id: resource.resource_id,
      index: resource.index,
      source: resource.source,
    }));
    const selectedImageIndexes = uniqueIndexes(imageRefs.map(resource => resource.index));
    const selectedFileIndexes = uniqueIndexes(fileRefs.map(resource => resource.index));
    const targetRef = imageRefs.find(resource => resource.role === 'target');
    const routeTarget = op === 'text_to_image' || op === 'image_reference_gen'
      ? 'new'
      : op === 'edit_image'
        ? targetRef?.target || 'none'
        : 'none';

    const compiledRoute = {
      taskShape: stringValue(options.taskShape) || (planningOnly ? 'multi' : 'single'),
      multiTask: multiTask === true,
      mode: hasBlockingIssue || (!finalDispatchContract && !planningOnly) ? 'chat' : registered.mode,
      api: hasBlockingIssue || (!finalDispatchContract && !planningOnly) ? 'clarify' : registered.api,
      target: hasBlockingIssue || (!finalDispatchContract && !planningOnly) ? 'none' : routeTarget,
      intent: hasBlockingIssue || (!finalDispatchContract && !planningOnly) ? 'clarify' : op,
      needClarification: hasBlockingIssue || (!finalDispatchContract && !planningOnly),
      dispatchAuthorized: !!finalDispatchContract && !hasBlockingIssue,
      readiness: (finalDispatchContract && !hasBlockingIssue) || planningOnly ? 'ready' : 'needs_clarification',
      operationType: op,
      operationApi: registered.api,
      operationMode: registered.mode,
      relation,
      goalMode,
      userGoal: stringValue(options.userGoal),
      executionPrompt: executionInput,
      ...(imageTaskState ? {
        imageTaskState,
        resolvedImageGoal: renderTaskContinuity(imageTaskState),
      } : {}),
      confidence: 1,
      resources: projectedResources.map(resource => ({ ...resource })),
      imageRefs,
      fileRefs,
      messageRefs,
      selectedIndexes: selectedImageIndexes,
      selectedImageIndexes,
      selectedFileIndexes,
      selectedImageIds: imageRefs.map(resource => resource.image_id).filter(Boolean),
      selectedReferenceId: imageRefs.find(resource => resource.reference_id)?.reference_id || '',
      usePreviousImage: imageRefs.some(resource => resource.source !== 'current'),
      contextualImagePrompt: args.prompt || input,
      editInstruction: ['edit_image', 'image_reference_gen'].includes(op) ? (args.prompt || input) : '',
      evidence: 'dispatch_contract.v1',
      executionResources,
      localClarification: hasBlockingIssue || !finalDispatchContract,
      dispatchContract: finalDispatchContract,
      argumentResult: argResult,
      clarificationQuestion: finalClarificationQuestion,
      clarificationSlots,
      clarificationRounds,
      maxClarificationRounds: MAX_CLARIFICATION_ROUNDS,
      clarificationExhausted,
      changesFamilyInvalid,
      providerAlternative: providerAlternativePending,
      providerUnsupported,
      semanticAuthority: options.semanticAuthority || '',
      normalizedFrom: normalizationEvidence.normalizedFrom,
      normalizationReason: normalizationEvidence.normalizationReason,
      normalizationChanges: normalizationEvidence.normalizationChanges,
    };
    if (options.skipLocalRouteGates === true) return compiledRoute;
    // A model-owned v3 route has already made the semantic decision. The
    // legacy execution-family invariant layer may validate/repair locally
    // authored drafts, but it must not add a resource or change operation for
    // a route whose `resource_refs` and operation came from the strict model
    // contract. Otherwise `resource_refs=[]` would be only advisory.
    const modelOwned = modelOwnsRouteSemantics(options);
    const invariantRoute = modelOwned
      ? compiledRoute
      : applyLocalExecutionInvariants(compiledRoute, {
        input,
        context: options.context || {},
        proposedPrompt: stringValue(plan?.arguments?.prompt),
        allowVagueGeneration: options.allowVagueGeneration === true,
      });
    if (modelOwned) return invariantRoute;
    return applyLocalRouteGuesses(invariantRoute, {
      input,
      context: options.context || {},
      proposedPrompt: stringValue(plan?.arguments?.prompt),
      allowVagueGeneration: options.allowVagueGeneration === true,
    });
  }

  // ── Dispatch ────────────────────────────────────────────────────
  function isCompiledImageBatchDispatchable(route = {}) {
    const compiled = route?.imagePlanCompiled;
    if (!compiled || compiled.kind !== 'batch'
        || !Array.isArray(compiled.items) || compiled.items.length <= 1) return false;
    return compiled.items.every(item => (
      item?.route
      && isRouteDispatchable(item.route)
      && hasExactDispatchContract?.(item.dispatchContract)
      && item.dispatchContract === item.route.dispatchContract
    ));
  }

  function isRouteDispatchable(route = {}) {
    if (isCompiledImageBatchDispatchable(route)) return true;
    if (!route || route.needClarification || route.api === 'clarify' || !route.dispatchAuthorized) return false;
    if (route.readiness !== 'ready') return false;
    if (!route.operationType || !route.api) return false;
    const projection = route.executionResources;
    if (!projection || projection.version !== EXECUTION_RESOURCE_PROJECTION_VERSION) return false;
    if (projection.operation !== route.operationType || projection.api !== route.api || projection.relation !== route.relation) return false;
    if (!hasExactDispatchContract?.(route.dispatchContract)
        || route.dispatchContract.operation !== route.operationType
        || route.dispatchContract.api !== route.api
        || route.dispatchContract.relation !== route.relation) return false;
    try {
      const projectedBindings = typeof bindingEvidenceFromMedia === 'function'
        ? bindingEvidenceFromMedia(projection)
        : [
          ...(Array.isArray(projection.images) ? projection.images : []),
          ...(Array.isArray(projection.files) ? projection.files : []),
          ...(Array.isArray(projection.messages) ? projection.messages : []),
        ];
      assertExecutableBindings(route.operationType, projectedBindings);
      assertBindingEvidence?.(route.dispatchContract, projectedBindings);
    } catch {
      return false;
    }
    return true;
  }

  function createExplicitTextToImageRoute(input = '') {
    const prompt = stringValue(input);
    if (!prompt) return null;
    try {
      const route = compileLocalRoute({
        operation: 'text_to_image',
        relation: 'new',
        arguments: { prompt },
        bindings: [],
        constraints: [],
      }, { input: prompt, attachments: [], context: {}, allowVagueGeneration: true });
      return isRouteDispatchable(route) ? route : null;
    } catch {
      return null;
    }
  }


  // ── Quoted content helpers ─────────────────────────────────────
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

  function buildQuotedImagePlaceholders(images = []) {
    return (images || [])
      .map((item, index) => '[quoted_image index=' + (index + 1) + ' id=' + String(item.imageId || item.image_id || '') + ' name=' + String(item.name || '') + ']')
      .join('\n');
  }

  function buildQuotedRouteContent({ text = '', images = [] } = {}) {
    return [cleanQuotedContent(text), buildQuotedImagePlaceholders(images)].filter(Boolean).join('\n') || '[quoted_message]';
  }




  // ── Exports ─────────────────────────────────────────────────────
  const api = Object.freeze({
    ROUTE_EVIDENCE_PRIORITY,
    ROUTE_INTENT_VERSION,
    SEMANTIC_INTENT_VERSION,
    DISPATCH_CONTRACT_VERSION,
    EXECUTION_RESOURCE_PROJECTION_VERSION,
    ROUTE_SYSTEM_PROMPT,
    UNDERSTAND_SYSTEM_PROMPT,
    ROUTE_NODE_SYSTEM_PROMPT,
    ROUTE_NODE_SYSTEM_PROMPT_COMPACT,
    ROUTE_NODE_SYSTEM_PROMPT_SIMPLE,
    ROUTE_REPAIR_SYSTEM_PROMPT,
    INTENT_CRITIC_SYSTEM_PROMPT,
    ROUTE_INTENT_RESPONSE_FORMAT,
    IMAGE_MEMORY_RETRIEVAL_POLICY,
    buildRoutePayload,
    orderImageInputRefs,
    buildIntentCriticPayload,
    inspectIntentCriticResult,
    intentCriticSemanticIssues,
    intentReasoningPayloadOptions,
    semanticIntentForRoute,
    exactHistoricalFollowupRelationConstraint,
    deterministicOperationKeysForInput,
    missingTextSourceForInput,
    deterministicResourceKeysForInput,
    undeliveredGenerationEvidence,
    shouldRunUnderstanding,
    buildUnderstandingPayload,
    buildUnderstandingRepairPayload,
    inspectUnderstandingResult,
    reconcileUnderstandingKinds,
    buildFallbackMultiTaskPlan,
    buildRouteRepairPayload,
    inspectRouteRepairResult,
    applyRouteRepairResult,
    routeRepairAllowedFields,
    ROUTE_REPAIR_VERSION,
    compileUnderstandingShape,
    explicitImageResultCount,
    maxExplicitImageResultCount,
    planCoversExpected,
    expectedPlanTasks,
    buildResourceCandidates,
    buildRouteResourceCandidates,
    buildRouteContext,
    compactWireRouteContext,
    wireResourceCandidates,
    compactWireResourceCandidate,
    extractRouteText,
    inspectModelRouteResult,
    extractExactRouteIntent,
    routeIntentSemanticIssues,
    buildRouteDecision,
    recordRouteMemory,
    routeMemoryContext,
    routeIntentSemanticIssuesForIntent,
    hasQuotedEvidence,
    reconcileUnderstandingDependency,
    compileEmptyCurrentAttachmentSetRoute,
    compileLocalRoute,
    isRouteDispatchable,
    createExplicitTextToImageRoute,
    isTaskSelectionInput,
    selectedMultiTaskIndex,
    compileSelectedPlanTask,
    cleanQuotedContent,
    buildQuotedImagePlaceholders,
    buildQuotedRouteContent,
    capabilityFor,
    parseImageParameterCandidates,
    resolveExecutionArguments,
    hasExactDispatchContract,
    compileDispatchContract,
    LOCAL_ROUTE_TRANSFORM_POLICY,
    IMAGE_PLAN_SYSTEM_PROMPT,
    IMAGE_INSTRUCTION_VERSION,
    IMAGE_INSTRUCTION_SYSTEM_PROMPT,
    hasUnresolvedImageInstructionReference,
    buildImagePlanPayload,
    buildImagePlanRepairPayload,
    buildImageInstructionPayload,
    inspectImagePlanResult,
    inspectImageInstructionResult,
    hasRouteResourceBindings,
    isSelfContainedNewImageRoute,
    requiresImageInstructionMaterialization,
    applyMaterializedImageInstruction,
    clarifyImageInstructionRoute,
    IMAGE_PLAN_VERSION,
    IMAGE_PLAN_MAX_TASKS,
    IMAGE_PLAN_ABSOLUTE_MAX_TASKS,
    IMAGE_PLAN_RESPONSE_FORMAT,
    hasExactImagePlan,
    assertImagePlan,
    shouldRequestMultiTaskPlan,
    buildMultiTaskPlanPayload,
    buildMultiTaskPlanRepairPayload,
    inspectMultiTaskPlan,
    compileMultiTaskPlan,
    shouldRequestImagePlan,
    hasExplicitMultiImageSelection,
    compileImagePlan,
  });

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.ChatUIRouteService = api;
  if (root?.window) root.window.ChatUIRouteService = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
