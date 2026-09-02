'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const prompts = require('../../client/services/route-prompts');
const routeService = require('../../client/services/route-service');

const UNDERSTAND_PROMPT = prompts.UNDERSTAND_SYSTEM_PROMPT_LINES.join('\n');
const ROUTE_NODE_PROMPT = prompts.ROUTE_NODE_SYSTEM_PROMPT_LINES.join('\n');

function testRoutePromptModuleOwnsPromptTextAndPreservesServiceCompatibility() {
  assert.strictEqual(routeService.ROUTE_SYSTEM_PROMPT, prompts.ROUTE_SYSTEM_PROMPT);
  assert.strictEqual(routeService.ROUTE_NODE_SYSTEM_PROMPT, prompts.ROUTE_NODE_SYSTEM_PROMPT);
  assert.strictEqual(routeService.IMAGE_PLAN_SYSTEM_PROMPT, prompts.IMAGE_PLAN_SYSTEM_PROMPT);
  assert.strictEqual(routeService.IMAGE_INSTRUCTION_SYSTEM_PROMPT, prompts.IMAGE_INSTRUCTION_SYSTEM_PROMPT);
  assert.strictEqual(routeService.INTENT_CRITIC_SYSTEM_PROMPT, prompts.INTENT_CRITIC_SYSTEM_PROMPT);
  assert.match(ROUTE_NODE_PROMPT, /只分类/);
  assert.match(ROUTE_NODE_PROMPT, /【文件任务】[\s\S]*file_qa[\s\S]*attachment/,
    'intent recognition must classify current-file reads as file_qa with an attachment binding');
  assert.match(prompts.IMAGE_PLAN_SYSTEM_PROMPT, /image_plan\.v1/);
  assert.match(prompts.IMAGE_INSTRUCTION_SYSTEM_PROMPT, /image_instruction\.v1/);
}

function testRoutePromptModuleParameterizesImagePlanTaskLimitWithoutChangingNodePrompts() {
  const custom = prompts.createRoutePromptSet({ imagePlanAbsoluteMaxTasks: 7 });
  assert.match(custom.IMAGE_PLAN_SYSTEM_PROMPT, /范围 1\.\.7/);
  assert.strictEqual(custom.ROUTE_SYSTEM_PROMPT, prompts.ROUTE_SYSTEM_PROMPT);
  assert.strictEqual(custom.UNDERSTAND_SYSTEM_PROMPT_LINES.join('\n'), UNDERSTAND_PROMPT);
  assert.strictEqual(custom.IMAGE_INSTRUCTION_SYSTEM_PROMPT, prompts.IMAGE_INSTRUCTION_SYSTEM_PROMPT);
}

function testUnderstandNodeOwnsItsProtocolAndSplitsIndependentImageActions() {
  assert.match(UNDERSTAND_PROMPT, /intent_understanding\.v1/);
  assert.match(UNDERSTAND_PROMPT, /每个独立执行结果一条 action/);
  assert.match(UNDERSTAND_PROMPT, /只有独立输出才拆分/);
  assert.match(UNDERSTAND_PROMPT, /否定\/排除.*不是 action/);
  assert.match(UNDERSTAND_PROMPT, /第二张和最后一张是什么颜色/);
  assert.match(UNDERSTAND_PROMPT, /合并为一条 action/);
  assert.match(UNDERSTAND_PROMPT, /不得拆成多个独立 action/);
  assert.match(UNDERSTAND_PROMPT, /"index":1,"kind":"image_generate"/);
  assert.match(UNDERSTAND_PROMPT, /"index":2,"kind":"image_generate"/);
  assert.doesNotMatch(UNDERSTAND_PROMPT, /【判断顺序】/,
    'the understand node must not carry route decision-order instructions');
  assert.doesNotMatch(UNDERSTAND_PROMPT, /goal_mode/,
    'the understand node must not write route goal-mode decisions');
  assert.ok(UNDERSTAND_PROMPT.length <= 2800, `understand prompt must stay bounded, got ${UNDERSTAND_PROMPT.length}`);
}

function testRouteNodeOwnsItsProtocolAndKeepsRelationRulesGrouped() {
  assert.match(ROUTE_NODE_PROMPT, /route_intent\.v3/);
  assert.match(ROUTE_NODE_PROMPT, /operation、relation、goal、goal_mode、resource_refs、task_shape/);
  assert.strictEqual(prompts.RELATION_SYSTEM_PROMPT_LINES.length, 5,
    'the relation segment must contain the relation preamble and the four relation rules');
  const first = ROUTE_NODE_PROMPT.indexOf(prompts.RELATION_SYSTEM_PROMPT_LINES[0]);
  const last = ROUTE_NODE_PROMPT.indexOf(prompts.RELATION_SYSTEM_PROMPT_LINES[4]);
  assert.ok(first >= 0 && last > first, 'the relation rules must stay grouped inside the route node prompt');
  assert.strictEqual(prompts.RELATION_SYSTEM_PROMPT_LINES.every(line => ROUTE_NODE_PROMPT.includes(line)), true);
  assert.match(ROUTE_NODE_PROMPT, /【输出示例】\{"operation":"text_to_image"/);
  // The full fallback prompt carries a consolidated positive/negative
  // example block (relation/goal_mode/resource disambiguation) in addition
  // to the single JSON output example, so it may reach 6400 characters.
  assert.ok(ROUTE_NODE_PROMPT.length <= 7400, `route node prompt must stay bounded, got ${ROUTE_NODE_PROMPT.length}`);
}

function testRuntimePayloadsUseNodePromptsInsteadOfTheLegacyMonolith() {
  const routePayload = routeService.buildRoutePayload({
    model: 'route-model', input: '画一只猫', attachments: [], context: {},
  });
  const routeSystem = routePayload.input.find(message => message.role === 'system');
  assert.strictEqual(routeSystem.content, routeService.ROUTE_NODE_SYSTEM_PROMPT,
    'the simple route path must use the node prompt rather than the pre-CoT monolith');
  assert.match(routeSystem.content, /意图路由节点/);
  assert.doesNotMatch(routeSystem.content, /Model-first:/);

  const understandPayload = routeService.buildUnderstandingPayload({
    model: 'route-model', input: '分别生成两只猫', attachments: [], context: {},
  });
  const understandSystem = understandPayload.input.find(message => message.role === 'system');
  assert.strictEqual(understandSystem.content, routeService.UNDERSTAND_SYSTEM_PROMPT);
  assert.match(understandSystem.content, /intent_understanding\.v1/);
  assert.doesNotMatch(understandSystem.content, /【operation】/,
    'the understand node must not reuse the old operation classification prompt');
}

function testRouteServiceDoesNotReembedPromptOwnershipOrGrowABrowserGlobal() {
  const routeSource = fs.readFileSync(path.join(__dirname, '../../client/services/route-service.js'), 'utf8');
  const promptSource = fs.readFileSync(path.join(__dirname, '../../client/services/route-prompts.js'), 'utf8');
  assert.doesNotMatch(routeSource, /const ROUTE_SYSTEM_PROMPT\s*=\s*\[/);
  assert.doesNotMatch(routeSource, /【operation】/);
  assert.match(routeSource, /require\('\.\/route-prompts'\)/);
  assert.match(promptSource, /const ROUTE_NODE_SYSTEM_PROMPT_LINES\s*=\s*Object\.freeze\(\[/);
  assert.match(promptSource, /const UNDERSTAND_SYSTEM_PROMPT_LINES\s*=\s*Object\.freeze\(\[/);
  assert.doesNotMatch(promptSource, /const ROUTE_PROMPT_LINES\s*=\s*\[/,
    'the legacy monolithic prompt assembly must be gone from the prompt module');
  assert.doesNotMatch(promptSource, /root\.ChatUIRoutePrompts\s*=/,
    'the extracted module must use the registry rather than grow the browser global namespace');
}


function testPromptsTeachMessageRefsAreNotFiles() {
  const compact = prompts.ROUTE_NODE_SYSTEM_PROMPT_COMPACT;
  const simple = prompts.ROUTE_NODE_SYSTEM_PROMPT_SIMPLE;
  assert.ok(UNDERSTAND_PROMPT.includes('消息（mN）是文字证据，不是文件/图片'),
    'the understand node must learn that quoted/history messages are text, not files');
  assert.match(UNDERSTAND_PROMPT, /统计字数.*plain_text/,
    'message character-count questions must be classified as plain_text');
  for (const [name, prompt] of [
    ['route full', ROUTE_NODE_PROMPT],
    ['route compact', compact],
    ['route simple', simple],
  ]) {
    assert.match(prompt, /消息（mN）只能绑 context/,
      name + ' route prompt must forbid binding a message as a file');
    assert.match(prompt, /file_qa[\s\S]*f=attachment/,
      name + ' route prompt must keep file_qa bound to a real fN file');
  }
}


function testMultiTaskPlanPromptKeepsExplicitImageRequests() {
  assert.match(prompts.MULTI_TASK_PLAN_SYSTEM_PROMPT, /不得降级成plain_chat/,
    'the multi-task planner must not degrade an explicit image request to plain_chat');
  assert.match(prompts.MULTI_TASK_PLAN_SYSTEM_PROMPT, /text_to_image\/image_reference_gen\/edit_image/,
    'the multi-task planner must route image requests to the image operations');
}

function testImageInstructionPromptRespectsExplicitDelegationAndAnsweredClarifications() {
  assert.match(prompts.IMAGE_INSTRUCTION_SYSTEM_PROMPT, /用户明确委托创作自由/,
    'the materializer must know that an explicit user delegation authorizes choosing concrete details');
  assert.match(prompts.IMAGE_INSTRUCTION_SYSTEM_PROMPT, /随便|你决定|you choose|up to you/,
    'the delegation rule must keep minimal concrete anchors');
  assert.match(prompts.IMAGE_INSTRUCTION_SYSTEM_PROMPT, /answer_completes*=s*true/,
    'the materializer must treat an already-answered clarification as authority to proceed');
  assert.match(prompts.IMAGE_INSTRUCTION_SYSTEM_PROMPT, /needs_clarification/,
    'genuinely unresolved references must still ask for clarification');
}

function testPromptsTeachVerbClassesInsteadOfEnumeratingWordLists() {
  // The router must learn action-type rules, not closed dictionary lists that
  // silently miss new wording ("转成", "弄成", ...).
  const simple = prompts.ROUTE_NODE_SYSTEM_PROMPT_SIMPLE;
  const full = prompts.ROUTE_NODE_SYSTEM_PROMPT;
  const understand = prompts.UNDERSTAND_SYSTEM_PROMPT_LINES.join('\n');
  for (const [name, prompt] of [['simple', simple], ['full', full]]) {
    assert.ok(!prompt.includes('放大/缩小') && !prompt.includes('把…改成') && !prompt.includes('这只狗'),
      name + ' route prompt must not enumerate closed verb lists');
    assert.match(prompt, /修改类动词或明确目标图/,
      name + ' route prompt must teach the semantic edit boundary');
    assert.match(prompt, /没有明确指向既有图片的目标表述/,
      name + ' route prompt must describe generation-vs-edit by target reference semantics');
  }
  assert.ok(!understand.includes('继续/再/接着 + 画/生成'),
    'the understand prompt must not enumerate continuation verb pairs');
  assert.match(understand, /延续连接词（“继续\/再\/接着”）\+ 生成类动词/,
    'the understand prompt must teach the continuation rule semantically');
  for (const [name, prompt] of [['simple', simple], ['full', full], ['understand', understand]]) {
    assert.ok(!prompt.includes('没看到图片/结果在哪里'),
      name + ' prompt must not enumerate delivery-question word lists');
    assert.match(prompt, /对上一张图交付状态的追问/,
      name + ' prompt must describe the delivery-followup question semantically');
  }
}

function testImageInstructionPromptWritesFromTheProviderPerspective() {
  // The materializer must write the instruction the way the provider will read
  // it: the provider receives only the instruction text and the bound input
  // images, so every object must be one of the bound inputs or a concrete
  // description — never conversation positioning like "最近生成的那张".
  const prompt = prompts.IMAGE_INSTRUCTION_SYSTEM_PROMPT;
  assert.match(prompt, /provider只收到这段指令文本和已绑定的输入图/,
    'the materializer must know exactly what the provider receives');
  assert.match(prompt, /“最近生成的那张猫的插画”/,
    'turn-position provenance must be named as forbidden, not left implicit');
  assert.match(prompt, /“在这张猫的插画的基础上，将背景替换为…”/,
    'edit targets must be addressed as the bound input image');
  assert.match(prompt, /绝不按先后轮次定位/);
  assert.match(prompt, /“参考图”\/“风格参考图”/,
    'bound references must be called by their request role');
}

function testRouteNodePromptsHonorLocalClaimsAndGoalFidelity() {
  // intent_claims is published by the local claim extractor and must be
  // visible as protocol evidence in the prompts that consume it.
  const full = prompts.ROUTE_NODE_SYSTEM_PROMPT;
  const compact = prompts.ROUTE_NODE_SYSTEM_PROMPT_COMPACT;
  const simple = prompts.ROUTE_NODE_SYSTEM_PROMPT_SIMPLE;
  const understand = prompts.UNDERSTAND_SYSTEM_PROMPT_LINES.join('\n');
  for (const [name, prompt] of [['full', full], ['compact', compact], ['simple', simple]]) {
    assert.match(prompt, /intent_claims[\s\S]*本地确定性声明/,
      name + ' route prompt must treat intent_claims as local deterministic evidence');
    assert.match(prompt, /image_ranking_question→image_qa/,
      name + ' route prompt must know ranking questions map to image_qa');
  }
  assert.match(full, /对图片的评价排序（“哪张最好”）→image_qa/,
    'the full route prompt must scope ranking questions to image objects');
  assert.match(compact, /对图片的评价排序（“哪张最好”）→image_qa绑source/,
    'the CoT route prompt must bind image ranking questions to image_qa with source');
  assert.match(compact, /image_compare仅用于明确要求并排比较\/差异对比/,
    'image_compare must stay reserved for explicit side-by-side comparison');
  assert.match(compact, /conversation_focus=text且输入无图片词汇时→plain_chat/,
    'the CoT route prompt must keep text-topic ranking questions on plain_chat');
  assert.match(understand, /对图片的评价\/排序问题（“哪张最好”）→image_read，不是 image_compare/,
    'the understand node must classify image ranking questions as image_read');
  for (const [name, prompt] of [['full', full], ['compact', compact], ['simple', simple]]) {
    assert.match(prompt, /用户明确写出的对象、序号与约束原样保留/,
      name + ' route prompt must keep explicitly stated objects and ordinals in goal');
    assert.match(prompt, /模糊指代[\s\S]*?须消解成具体对象才能写入/,
      name + ' route prompt must forbid unresolved vague references inside goal');
  }
  assert.match(full, /不写候选键\/资源ID/,
    'candidate keys stay forbidden while natural-language ordinals are retained');
  assert.match(compact, /输入“把第二张改成黑白”，goal须含“第二张”/,
    'the CoT route prompt must teach ordinal retention with a worked example');
  assert.match(compact, /靠conversation_focus消解的省略式追问不绑mN/,
    'focus-resolved elliptical followups must not bind a message as context');
  assert.match(compact, /“背景换成海边”须保留前序“猫咪插画”主体/,
    'short visual constraints must keep the prior subject with a worked example');
}

function testRouteNodePromptsDefineGenerationContinuationNotAsEdit() {
  // Regression: "继续画一只狗" was misclassified as edit_image (with no target)
  // because "继续" + dog history looked like an edit request, forcing a
  // "which image to edit" candidate picker. Every route/understand prompt must
  // state that a generation-intent continuation with no edit verb and no
  // explicit target image is a new text_to_image / image_generate, never an
  // edit.
  assert.match(prompts.ROUTE_NODE_SYSTEM_PROMPT_SIMPLE, /把生成当成编辑/,
    'the simple route prompt must teach that a generation continuation is not an edit');
  assert.match(prompts.ROUTE_NODE_SYSTEM_PROMPT, /把生成当成编辑/,
    'the full route prompt must teach that a generation continuation is not an edit');
  assert.match(prompts.ROUTE_NODE_SYSTEM_PROMPT_COMPACT, /只有修改类动词或明确目标图才用 edit_image/,
    'the complex-path prompt must keep generation continuations on text_to_image, never edit');
  assert.match(prompts.UNDERSTAND_SYSTEM_PROMPT_LINES.join('\n'), /非 image_edit/,
    'the understand prompt must classify generation continuations as image_generate, not image_edit');
}


function testUnderstandPromptUsesBoundedEvidenceLanguageInsteadOfCrypticEnglish() {
  const prompt = UNDERSTAND_PROMPT;
  assert.doesNotMatch(prompt, /Model-first:|repair evidence/,
    'cryptic english directives confuse small routing models');
  assert.match(prompt, /【证据优先】/);
  assert.match(prompt, /不得猜测、修改或编造证据/);
  assert.match(prompt, /有歧义交下游澄清/);
}

function testUnderstandPromptExampleKeepsTheFullPictureDescription() {
  const prompt = UNDERSTAND_PROMPT;
  assert.match(prompt, /一只橘白短毛猫坐在木窗台上、午后阳光洒落、写实摄影风格/);
  assert.match(prompt, /一只金毛犬站在草地上、傍晚逆光、写实摄影风格/);
}

function testSimpleRoutePromptKeepsQualityRulesBeforeSizeOptimization() {
  // Quality and accuracy are the hard priority. The simple path must keep
  // every reachable decision rule; size can only be reduced by removing rules
  // the deterministic complexity gate proves unreachable.
  const simple = prompts.ROUTE_NODE_SYSTEM_PROMPT_SIMPLE;
  assert.ok(simple.length <= 4400, 'simple route prompt may not grow unbounded, got ' + simple.length);
  assert.match(simple, /把生成当成编辑/);
  assert.match(simple, /消息（mN）只能绑 context/);
  assert.match(simple, /file_qa[\s\S]*f=attachment/);
  assert.match(simple, /P1→P5/);
  assert.match(simple, /不得只写“基于这个生成/);
  assert.match(simple, /edit_image多history候选未选定→followup\+ambiguous省略target/,
    'vague edits must ask instead of guessing a target');
  assert.match(simple, /当前输入已自足且未明确指向历史时历史同义正文不绑/,
    'self-contained inputs must not over-bind historical message evidence');
  assert.match(simple, /message_index大者更新，模糊指代选最大/,
    'candidate recency rules must stay on the simple path');
  assert.match(simple, /“不使用旧图”不改operation\/goal_mode/,
    'negated resource policies must not rewrite operation/goal_mode');
  assert.match(simple, /拒绝使用历史资源只影响resource_refs/,
    'refusing historical resources must not silently change goal_mode');
  assert.match(simple, /auto_mode=false\/current_mode=image/,
    'manual image mode must keep the merge-vs-edit boundary');
}function testRouteRelationOrderReferencesTheNumberedRulesExplicitly() {
  const prompt = ROUTE_NODE_PROMPT;
  assert.match(prompt, /relation描述本轮主要言语行为与前序执行的关系[^\n]*必须按下方关系规则1→4顺序判断/);
  assert.doesNotMatch(prompt, /必须按1→4顺序判断/);
}

function testImagePlanPromptSeparatesPromptTextFromParameterFields() {
  const prompt = prompts.IMAGE_PLAN_SYSTEM_PROMPT;
  assert.match(prompt, /背景\/画布要求写入 background 字段/);
  assert.match(prompt, /只描述画面内容（主体、场景、风格、修改项）/);
  assert.match(prompt, /超过 [0-9]+ 个的请求会在上游被拦截/);
  assert.match(prompt, /要沿用风格时必须绑定风格参考图（style_reference）/,
    'the image plan must bind style_reference, not a generic reference, for style continuity');
  assert.match(prompt, /主体\/构图参考图（reference）只写主体\/构图\/内容、不得写“与参考图风格一致”/,
    'the image plan must not reuse a subject reference as a style reference');
}

function testIntentCriticPromptForbidsFlaggingLegalProtocolCombinations() {
  // The critic runs on high-risk turns and feeds the bounded repair loop. It
  // must not burn that budget on protocol-legal combinations or on summary
  // phrases the current input has already made self-sufficient.
  const prompt = prompts.INTENT_CRITIC_SYSTEM_PROMPT;
  assert.match(prompt, /goal_mode与resource_refs是相互独立的维度/,
    'the critic must treat goal_mode and resource_refs as independent dimensions');
  assert.match(prompt, /amend只说明本轮文字约束如何叠加到前序图片任务，不代表使用或修改旧图/,
    'amend must not imply the old image is used or edited');
  assert.match(prompt, /是否使用旧图只看resource_refs/,
    'resource usage must be judged from resource_refs alone');
  assert.match(prompt, /image_reference_gen的goal_mode=replace是新建图片的正确值/,
    'replace on reference generation is a legal new-image combination');
  assert.match(prompt, /当前输入已具体列出对象、尺寸、空间关系、否定条件等关键要求时即视为自足/,
    'a concrete current input must be treated as self-sufficient');
  assert.match(prompt, /不得仅因无法从历史恢复该概括短语而要求澄清或判为丢失依赖/,
    'unrecoverable historical summary phrases must not force clarification');
}

function testImageInstructionPromptSeparatesAmendDeltaFromCompleteInstructions() {
  // The route semantic normalizer already strips the previous base from an
  // amend goal, and applyMaterializedImageInstruction feeds the materialized
  // text back into transitionTaskContinuity, which re-appends the base. If the
  // materializer writes a "self-contained" full instruction for an amend goal,
  // the base is rendered twice in the final provider prompt. The prompt must
  // therefore teach two distinct instruction shapes: a complete standalone
  // instruction for edit_image / image_reference_gen / replace, and a
  // delta-only text for text_to_image + amend.
  const prompt = prompts.IMAGE_INSTRUCTION_SYSTEM_PROMPT;
  assert.match(prompt, /edit_image：输出发给已绑定目标图的完整编辑指令/,
    'edit_image must always receive a complete edit instruction for the bound target');
  assert.match(prompt, /image_reference_gen与text_to_image\+goal_mode=replace/,
    'reference generation and replace text-to-image must be covered by the complete-instruction shape');
  assert.match(prompt, /完整自足的新建图片指令/,
    'replace must produce a complete self-contained instruction');
  assert.match(prompt, /text_to_image\+goal_mode=amend[\s\S]*只写本轮相对前序基础要求的增量/,
    'amend materialization must write only the current delta');
  assert.match(prompt, /context\.previous_execution\.task_state/,
    'the amend delta must locate the prior base in the wire context');
  assert.match(prompt, /下游会自动把基础拼回/,
    'the materializer must know the base is re-joined downstream');
  assert.match(prompt, /不得复述或重复基础内容/,
    'the amend delta must not repeat the base content');
  assert.match(prompt, /未提及部分默认沿用基础/,
    'unspecified parts of an amend must default to the prior base');
  assert.match(prompt, /增量内部同样不得出现/,
    'conversation positioning must stay forbidden inside the amend delta too');
  assert.doesNotMatch(prompt, /基于resolved_task输出自足指令/,
    'the delegation clause must not promise a self-contained instruction for amend turns');
  assert.match(prompt, /委托创作自由[\s\S]*?text_to_image\+goal_mode=amend时只写增量/,
    'the delegation clause must keep amend turns delta-only instead of self-contained');
}

function testRouteNodePromptsCarryRelationAndGoalModeFewShotExamples() {
  // Each route-node variant must teach the highest-value disambiguations with
  // concrete positive/negative pairs, not only a single text_to_image example.
  const full = prompts.ROUTE_NODE_SYSTEM_PROMPT;
  const simple = prompts.ROUTE_NODE_SYSTEM_PROMPT_SIMPLE;
  const compact = prompts.ROUTE_NODE_SYSTEM_PROMPT_COMPACT;
  for (const [name, prompt] of [['full', full], ['simple', simple], ['compact', compact]]) {
    assert.match(prompt, /【正反示例】/,
      name + ' route prompt must carry a positive/negative example block');
  }
  assert.match(full, /“把第二张改成黑白”[\s\S]*followup\+edit_image/,
    'the full prompt must exemplify an edit request as followup+edit_image');
  assert.match(full, /“继续画一只狗，换个品种”[\s\S]*continuation\+text_to_image/,
    'the full prompt must exemplify a generation continuation as continuation+text_to_image');
  assert.match(full, /只改前序部分约束→goal_mode=amend/,
    'the full prompt must exemplify amend as a partial change to the prior image task');
  assert.match(simple, /“画一只猫”→new\+replace/,
    'the simple prompt must exemplify a self-contained request as new+replace');
}

function testRouteNodePromptsTeachDecisionOrderAndSplitOperation() {
  // Weak routers (e.g. deepseek-v4-flash) lose accuracy when ten operation
  // definitions and six boundary rules are packed into one dense paragraph,
  // and when the field list order contradicts the decision order taught by the
  // full prompt. The simple and CoT variants must state the decision order
  // explicitly and separate the operation definitions from the boundary rules.
  const simple = prompts.ROUTE_NODE_SYSTEM_PROMPT_SIMPLE;
  const compact = prompts.ROUTE_NODE_SYSTEM_PROMPT_COMPACT;
  for (const [name, prompt] of [['simple', simple], ['compact', compact]]) {
    assert.match(prompt, /【判断顺序】1 operation→2 task_shape→3 resource_refs→4 relation→5 goal→6 goal_mode/,
      name + ' route prompt must teach the decision order');
    assert.match(prompt, /【operation】[\s\S]*【operation边界】/,
      name + ' route prompt must separate operation definitions from boundary rules');
  }
  assert.match(compact, /修改既有具体成果[\s\S]*?followup/,
    'the complex-path prompt must keep the followup boundary for edited results and shared task requirements');
}

function testCriticRepairAndPlanPromptsCarryWorkedExamples() {
  assert.match(prompts.INTENT_CRITIC_SYSTEM_PROMPT, /verdict=accept/,
    'the critic must exemplify an accept verdict');
  assert.match(prompts.INTENT_CRITIC_SYSTEM_PROMPT, /verdict=repair/,
    'the critic must exemplify a repair verdict');
  assert.match(prompts.INTENT_CRITIC_SYSTEM_PROMPT, /route_operation_mismatch/,
    'the critic must exemplify a reason code');
  assert.match(prompts.INTENT_CRITIC_SYSTEM_PROMPT, /image_reference_gen\+replace是合法新建组合/,
    'the critic example must protect the legal reference-generation replace combination');
  assert.match(prompts.INTENT_CRITIC_SYSTEM_PROMPT, /candidate_key:"i1",role:"reference"/,
    'the reference-generation accept example must bind a real reference image, not an empty resource set');
  assert.doesNotMatch(prompts.INTENT_CRITIC_SYSTEM_PROMPT, /image_reference_gen[^。；]*resource_refs=\[\]/,
    'the critic must never be taught to accept an image_reference_gen route without a bound reference');
  assert.match(prompts.ROUTE_REPAIR_SYSTEM_PROMPT, /"changed_fields":\["relation"\]/,
    'the repair prompt must exemplify a declared single-field change');
  assert.match(prompts.ROUTE_REPAIR_SYSTEM_PROMPT, /base_route_intent/,
    'the repair prompt must exemplify the trusted baseline');
  assert.match(prompts.ROUTE_REPAIR_SYSTEM_PROMPT, /不得借机改写goal、新增resource_refs/,
    'the repair prompt must exemplify the undeclared-change prohibition');
  assert.match(prompts.MULTI_TASK_PLAN_SYSTEM_PROMPT, /"key":"t1"/,
    'the multi-task planner must exemplify a first task');
  assert.match(prompts.MULTI_TASK_PLAN_SYSTEM_PROMPT, /"key":"t2"/,
    'the multi-task planner must exemplify a second task');
  assert.match(prompts.MULTI_TASK_PLAN_SYSTEM_PROMPT, /不得把两个动作合并成一个task/,
    'the multi-task planner must exemplify the no-merge rule');
}


function testRouteNodePromptsAvoidDomainSpecificBusinessNouns() {
  // Regression: the floor-plan scenario (堂屋/户型/平面图/双开门…) was once
  // embedded verbatim in the route prompts as a worked example. A prompt must
  // teach the general rule with neutral vocabulary, not anchor the model on one
  // customer domain; domain nouns belong in fixtures and functional tests, not
  // in the prompt text. This gate fails before the de-embedding fix and passes
  // after it.
  const text = [
    prompts.ROUTE_NODE_SYSTEM_PROMPT,
    prompts.ROUTE_NODE_SYSTEM_PROMPT_COMPACT,
    prompts.ROUTE_NODE_SYSTEM_PROMPT_SIMPLE,
    UNDERSTAND_PROMPT,
  ].join('\n');
  for (const noun of ['堂屋', '户型', '平面图', '双开门', '入户门', '卧室', '餐厅', '卫生间']) {
    assert.ok(!text.includes(noun), 'route prompts must not embed the domain-specific business noun ' + noun);
  }
  // The neutral replacement still carries the rule and a worked example.
  assert.match(prompts.ROUTE_NODE_SYSTEM_PROMPT_COMPACT, /短视觉约束紧接图片设计时保留前序主体/,
    'the CoT route prompt must keep the prior-subject rule for short visual constraints');
  assert.match(prompts.ROUTE_NODE_SYSTEM_PROMPT_COMPACT, /“背景换成海边”须保留前序“猫咪插画”主体/,
    'the CoT route prompt must keep a neutral worked example for short visual constraints');
}


function testRouteNodePromptsKeepTheComplexPathCompleteWithTheFullRuleSet() {
  // Root-cause regression: a slimmed CoT prompt (COMPACT <= 2650 chars) omitted
  // decision families the understand node does not compensate for (operation
  // boundaries, resource roles, relation semantics, delivery evidence), which
  // measurably misrouted complex turns in the real-model eval. The complex
  // path must therefore carry the complete rule set; SIMPLE is the only
  // reduced variant, justified by its deterministic complexity gate.
  assert.strictEqual(prompts.ROUTE_NODE_SYSTEM_PROMPT_COMPACT, prompts.ROUTE_NODE_SYSTEM_PROMPT,
    'the understand -> route path must carry the complete rule set (COMPACT == FULL)');
  assert.ok(prompts.ROUTE_NODE_SYSTEM_PROMPT_COMPACT.length <= 7400,
    'the complete complex-path prompt must stay bounded');
}


function testRouteNodePromptsKeepCorrectionAndContinuationBoundariesExplicit() {
  // Root-cause regression: current-upload edits must not overwrite the
  // correction semantics, history-reference continuation must stay
  // continuation, and scanned/image-like documents must stay file_qa.
  assert.match(prompts.ROUTE_NODE_SYSTEM_PROMPT, /规则1\/2\/3均不命中时才new/,
    'current-upload edits may only be new when correction/followup rules do not apply');
  assert.match(prompts.ROUTE_NODE_SYSTEM_PROMPT, /扫描件\/图片化的文档仍按file_qa/,
    'scanned documents must remain file_qa unless explicit text extraction is requested');
  assert.match(prompts.UNDERSTAND_SYSTEM_PROMPT_LINES.join('\n'), /沿用历史参考图继续生成新结果\/新版本[^。]*continuation/,
    'the understand node must classify reference-based regeneration as continuation, not followup');
  assert.match(prompts.UNDERSTAND_SYSTEM_PROMPT_LINES.join('\n'), /明确纠正前序成果优先于 current 图 new/,
    'the understand node must keep explicit corrections on followup');
  assert.match(prompts.ROUTE_NODE_SYSTEM_PROMPT, /纠正\/否定前序成果的背景陈述[^。]*也不得写入 goal/,
    'goal must keep only the executable instruction, not the correction preamble');
  assert.match(prompts.ROUTE_NODE_SYSTEM_PROMPT, /multi时goal必须保留全部独立结果的数量与彼此差异/,
    'multi-image goals must state the independent result count explicitly');
  assert.match(prompts.ROUTE_NODE_SYSTEM_PROMPT_SIMPLE, /对“刚才那个文件\/这个文档”等历史指代[^。]*必须是 file_qa/,
    'historical file references must stay file_qa even when the file is missing');
  assert.match(prompts.ROUTE_NODE_SYSTEM_PROMPT_SIMPLE, /无动词的短名词短语约束[^。]*继承前序主体\/任务类型/,
    'verb-less short constraints must inherit the prior subject and task type');
  assert.match(prompts.ROUTE_NODE_SYSTEM_PROMPT, /资源歧义只省略 resource_refs 的 target 角色[^。]*不得因歧义删除主体/,
    'ambiguous resources may only drop the target binding, never the explicitly stated subject');
  assert.match(prompts.ROUTE_NODE_SYSTEM_PROMPT, /不得用“三处要求\/上述约束”等概括回指代替具体约束/,
    'goal must enumerate concrete constraints instead of summary references');
}

module.exports = [
  testMultiTaskPlanPromptKeepsExplicitImageRequests,
  testPromptsTeachMessageRefsAreNotFiles,
  testRoutePromptModuleOwnsPromptTextAndPreservesServiceCompatibility,
  testRoutePromptModuleParameterizesImagePlanTaskLimitWithoutChangingNodePrompts,
  testUnderstandNodeOwnsItsProtocolAndSplitsIndependentImageActions,
  testImageInstructionPromptRespectsExplicitDelegationAndAnsweredClarifications,
  testRouteNodePromptsDefineGenerationContinuationNotAsEdit,
  testRouteNodePromptsAvoidDomainSpecificBusinessNouns,
  testRouteNodePromptsKeepTheComplexPathCompleteWithTheFullRuleSet,
  testRouteNodePromptsKeepCorrectionAndContinuationBoundariesExplicit,
  testUnderstandPromptUsesBoundedEvidenceLanguageInsteadOfCrypticEnglish,
  testUnderstandPromptExampleKeepsTheFullPictureDescription,
  testSimpleRoutePromptKeepsQualityRulesBeforeSizeOptimization,
  testRouteRelationOrderReferencesTheNumberedRulesExplicitly,
  testImagePlanPromptSeparatesPromptTextFromParameterFields,
  testRouteNodeOwnsItsProtocolAndKeepsRelationRulesGrouped,
  testRuntimePayloadsUseNodePromptsInsteadOfTheLegacyMonolith,
  testRouteServiceDoesNotReembedPromptOwnershipOrGrowABrowserGlobal,
  testIntentCriticPromptForbidsFlaggingLegalProtocolCombinations,
  testPromptsTeachVerbClassesInsteadOfEnumeratingWordLists,
  testRouteNodePromptsHonorLocalClaimsAndGoalFidelity,
  testImageInstructionPromptWritesFromTheProviderPerspective,
  testImageInstructionPromptSeparatesAmendDeltaFromCompleteInstructions,
  testRouteNodePromptsCarryRelationAndGoalModeFewShotExamples,
  testCriticRepairAndPlanPromptsCarryWorkedExamples,
  testRouteNodePromptsTeachDecisionOrderAndSplitOperation,
];
