"use strict";

const fs = require("fs");
const path = require("path");
const routeService = require("../../client/services/route-service");
const capabilityRegistry = require("../../shared/capability-registry");
const dispatchContractContract = require("../../shared/dispatch-contract");
const taskContinuityContract = require("../../shared/task-continuity");

const SCHEMA_VERSION = "intent-routing-eval.v3";
const VALID_OPERATIONS = new Set([
  "plain_chat", "file_qa", "multimodal_qa", "image_qa", "image_compare",
  "ocr", "text_to_image", "image_reference_gen", "edit_image", "web_search",
]);
const VALID_RELATIONS = new Set(["new", "followup", "continuation"]);
const VALID_TASK_SHAPES = new Set(["single", "multi"]);
const VALID_GOAL_MODES = new Set(["replace", "amend"]);
const IMAGE_TASK_OPERATIONS = new Set(["text_to_image", "image_reference_gen", "edit_image"]);
const IMAGE_TASK_AMEND_OPERATIONS = new Set(["text_to_image", "edit_image"]);
const VALID_RESOURCE_TYPES = new Set(["image", "file", "text", "message"]);
const VALID_RESOURCE_SOURCES = new Set(["current", "quoted", "history", "context"]);
const VALID_RESOURCE_ROLES = new Set([
  "source", "target", "reference", "style_reference", "mask",
  "compare_a", "compare_b", "attachment", "context",
]);
const VALID_CLARIFICATION_TYPES = new Set([...VALID_RESOURCE_TYPES, "parameter"]);
const VALID_CLARIFICATION_ROLES = new Set([
  ...VALID_RESOURCE_ROLES, "argument", "clarification",
]);
const VALID_UNRESOLVED_REASONS = new Set(["missing", "ambiguous", "unavailable"]);
const VALID_RESOURCE_MATCH_MODES = new Set(["exact", "contains", "media_exact"]);
const SCORE_WEIGHTS = Object.freeze({
  valid_route: 10,
  operation: 15,
  task_shape: 5,
  goal: 15,
  goal_mode: 10,
  readiness: 5,
  relation: 10,
  resources: 15,
  clarification: 5,
  dispatch_contract: 10,
});
const SECRET_FIELD_RE = /(?:api[_-]?key|authorization|token|secret|password|base64|data_url|dataurl|blob_url|binary|contents?)/i;
const API_KEY_RE = /\b(?:sk|key|token)-[A-Za-z0-9_-]{16,}\b/gi;
const BEARER_RE = /Bearer\s+[A-Za-z0-9._~+/=-]+/gi;
const DATA_URL_RE = /data:[^\s"']{0,80};base64,[A-Za-z0-9+/=\r\n]+/gi;
const LONG_B64_RE = /(?:[A-Za-z0-9+/]{120,}={0,2})/g;

function fail(message) {
  throw new Error(`[intent-routing-eval] ${message}`);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function own(value, key) {
  return Object.prototype.hasOwnProperty.call(value || {}, key);
}

function scalar(value) {
  return String(value ?? "");
}

function compareField(actual, expected, field) {
  if (field === "index") return Number(actual) === Number(expected);
  if (field === "missing") return Boolean(actual) === Boolean(expected);
  return scalar(actual) === scalar(expected);
}

function validateResourceExpectation(resource = {}, label = "resource") {
  if (!isPlainObject(resource)) fail(`${label} must be an object.`);
  if (!VALID_RESOURCE_TYPES.has(resource.type)) fail(`${label}.type is invalid.`);
  if (!VALID_RESOURCE_SOURCES.has(resource.source)) fail(`${label}.source is invalid.`);
  if (!VALID_RESOURCE_ROLES.has(resource.role)) fail(`${label}.role is invalid.`);
  if (!Number.isInteger(resource.index) || resource.index < 1) fail(`${label}.index must be a positive integer.`);
  if (typeof resource.missing !== "boolean") fail(`${label}.missing must be boolean.`);
  for (const key of ["id", "reference_id"]) {
    if (own(resource, key) && typeof resource[key] !== "string") fail(`${label}.${key} must be a string when present.`);
  }
}

function validateExpected(expected = {}, label = "expected") {
  if (!isPlainObject(expected)) fail(`${label} must be an object.`);
  if (!VALID_OPERATIONS.has(expected.operation)) fail(`${label}.operation is invalid.`);
  if (!VALID_TASK_SHAPES.has(expected.task_shape)) fail(`${label}.task_shape is invalid.`);
  if (!VALID_GOAL_MODES.has(expected.goal_mode)) fail(`${label}.goal_mode is invalid.`);
  if (!IMAGE_TASK_AMEND_OPERATIONS.has(expected.operation) && expected.goal_mode !== "replace") {
    fail(`${label}.goal_mode must be replace for ${expected.operation}.`);
  }
  if (!(typeof expected.relation === "string" ? VALID_RELATIONS.has(expected.relation) : (Array.isArray(expected.relation) && expected.relation.length && expected.relation.every(r => VALID_RELATIONS.has(r))))) fail(`${label}.relation is invalid.`);
  if (!isPlainObject(expected.goal)
      || !Array.isArray(expected.goal.concepts)
      || !expected.goal.concepts.length
      || !Array.isArray(expected.goal.forbidden)) {
    fail(`${label}.goal must contain non-empty concepts and a forbidden array.`);
  }
  expected.goal.concepts.forEach((alternatives, index) => {
    if (!Array.isArray(alternatives) || !alternatives.length
        || alternatives.some(value => !scalar(value).trim())) {
      fail(`${label}.goal.concepts[${index}] must contain non-empty alternatives.`);
    }
  });
  if (expected.goal.forbidden.some(value => !scalar(value).trim())) {
    fail(`${label}.goal.forbidden must contain only non-empty strings.`);
  }
  if (own(expected.goal, "intent_forbidden")
      && (!Array.isArray(expected.goal.intent_forbidden)
        || expected.goal.intent_forbidden.some(value => !scalar(value).trim()))) {
    fail(`${label}.goal.intent_forbidden must contain only non-empty strings when present.`);
  }
  if (!isPlainObject(expected.clarification)
      || typeof expected.clarification.required !== "boolean"
      || !Array.isArray(expected.clarification.unresolved)) {
    fail(`${label}.clarification must contain required and unresolved.`);
  }
  expected.clarification.unresolved.forEach((slot, index) => {
    const slotLabel = `${label}.clarification.unresolved[${index}]`;
    if (!isPlainObject(slot)) fail(`${slotLabel} must be an object.`);
    if (!VALID_CLARIFICATION_TYPES.has(slot.type)) fail(`${slotLabel}.type is invalid.`);
    if (!VALID_CLARIFICATION_ROLES.has(slot.role)) fail(`${slotLabel}.role is invalid.`);
    if (!VALID_UNRESOLVED_REASONS.has(slot.reason)) fail(`${slotLabel}.reason is invalid.`);
    if (!Number.isInteger(slot.choice_count) || slot.choice_count < 0) fail(`${slotLabel}.choice_count must be a non-negative integer.`);
    if (slot.reason === "ambiguous" && slot.choice_count < 2) fail(`${slotLabel} must expect at least two choices.`);
    if (slot.reason !== "ambiguous" && slot.choice_count !== 0) fail(`${slotLabel} cannot expect choices for ${slot.reason}.`);
    if (own(slot, "choices")) {
      if (!Array.isArray(slot.choices) || slot.choices.length !== slot.choice_count) fail(`${slotLabel}.choices must match choice_count.`);
      slot.choices.forEach((choice, choiceIndex) => {
        const choiceLabel = `${slotLabel}.choices[${choiceIndex}]`;
        if (!isPlainObject(choice) || !VALID_RESOURCE_SOURCES.has(choice.source)) fail(`${choiceLabel}.source is invalid.`);
        if (!Number.isInteger(choice.index) || choice.index < 1) fail(`${choiceLabel}.index must be a positive integer.`);
        for (const key of ["id", "reference_id"]) {
          if (own(choice, key) && typeof choice[key] !== "string") fail(`${choiceLabel}.${key} must be a string when present.`);
        }
      });
    }
  });
  if (!expected.clarification.required && expected.clarification.unresolved.length) {
    fail(`${label}.clarification.unresolved must be empty when clarification is not required.`);
  }
  if (!isPlainObject(expected.resources)
      || !VALID_RESOURCE_MATCH_MODES.has(expected.resources.mode)
      || !Array.isArray(expected.resources.items)) {
    fail(`${label}.resources must contain a mode and items array.`);
  }
  if (expected.resources.mode === "media_exact"
      && expected.resources.items.some(resource => !["image", "file"].includes(resource.type))) {
    fail(`${label}.resources.media_exact may contain only image or file expectations.`);
  }
  expected.resources.items.forEach((resource, index) => validateResourceExpectation(resource, `${label}.resources.items[${index}]`));
}

function validateFixtureCase(caseDefinition = {}, seenIds = new Set()) {
  if (!isPlainObject(caseDefinition)) fail("Every fixture case must be an object.");
  const id = scalar(caseDefinition.id).trim();
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) fail("Every fixture case needs a kebab-case id.");
  if (seenIds.has(id)) fail(`Duplicate fixture id: ${id}.`);
  seenIds.add(id);
  if (!scalar(caseDefinition.category).trim()) fail(`${id}.category is required.`);
  if (typeof caseDefinition.safety_critical !== "boolean") fail(`${id}.safety_critical must be boolean.`);
  if (typeof caseDefinition.input !== "string") fail(`${id}.input must be a string.`);
  if (!Array.isArray(caseDefinition.attachments)) fail(`${id}.attachments must be an array.`);
  if (!caseDefinition.input.trim() && !caseDefinition.attachments.length) fail(`${id} needs input or at least one attachment.`);
  if (!isPlainObject(caseDefinition.context)) fail(`${id}.context must be an object.`);
  if (own(caseDefinition, "current_mode") && !["chat", "image", "edit_image"].includes(caseDefinition.current_mode)) fail(`${id}.current_mode is invalid.`);
  if (own(caseDefinition, "auto_mode") && typeof caseDefinition.auto_mode !== "boolean") fail(`${id}.auto_mode must be boolean.`);
  const recentMessages = Array.isArray(caseDefinition.context.recent_messages)
    ? caseDefinition.context.recent_messages
    : [];
  const duplicateCurrentMessages = recentMessages.filter(message => (
    message?.role === "user" && scalar(message?.content) === caseDefinition.input
  ));
  if (own(caseDefinition, "current_turn")) {
    const currentTurn = caseDefinition.current_turn;
    if (!isPlainObject(currentTurn)
        || Object.keys(currentTurn).length !== 1
        || !Number.isInteger(currentTurn.messageIndex)
        || currentTurn.messageIndex < 1) {
      fail(`${id}.current_turn must contain exactly one positive integer messageIndex.`);
    }
    const currentMessage = recentMessages.find(message => Number(message?.index) === currentTurn.messageIndex);
    if (!currentMessage || currentMessage.role !== "user" || scalar(currentMessage.content) !== caseDefinition.input) {
      fail(`${id}.current_turn must identify the current user input in context.recent_messages.`);
    }
  } else if (duplicateCurrentMessages.length) {
    fail(`${id}.current_turn is required when context.recent_messages contains the current user input.`);
  }
  validateExpected(caseDefinition.expected, `${id}.expected`);
  if (caseDefinition.expected.goal_mode === "amend") {
    const previousTaskState = taskContinuityContract.taskContinuityFromExecution(
      caseDefinition.context.previous_execution || {},
    );
    if (!previousTaskState) fail(`${id}.expected.goal_mode=amend requires previous_execution task state.`);
  }

  const candidates = routeService.buildRouteResourceCandidates({
    attachments: caseDefinition.attachments,
    context: caseDefinition.context,
    input: caseDefinition.input,
    currentTurn: caseDefinition.current_turn || null,
  });
  const matchesFixtureLocator = (locator, candidate) => Object.entries(locator).every(([field, value]) => {
    // `role` and `missing` describe the final execution contract, not the
    // source candidate metadata (a message's original role is e.g. assistant).
    if (field === 'role' || field === 'missing') return true;
    return compareField(candidate[field], value, field);
  });
  for (const resource of caseDefinition.expected.resources.items) {
    if (resource.missing) continue;
    const matches = candidates.filter(candidate => matchesFixtureLocator(resource, candidate));
    if (matches.length !== 1) fail(`${id} expected resource ${resource.id || resource.type} resolves to ${matches.length} fixture candidates.`);
  }
  for (const slot of caseDefinition.expected.clarification.unresolved) {
    for (const choice of slot.choices || []) {
      const matches = candidates.filter(candidate => matchesFixtureLocator(choice, candidate));
      if (matches.length !== 1) fail(`${id} expected clarification choice ${choice.id || choice.index} resolves to ${matches.length} fixture candidates.`);
    }
  }
}

function validateFixtureSuite(suite = {}) {
  if (!isPlainObject(suite)) fail("Fixture suite must be an object.");
  if (suite.schema_version !== SCHEMA_VERSION) fail(`Fixture schema_version must be ${SCHEMA_VERSION}.`);
  if (!Array.isArray(suite.cases) || !suite.cases.length) fail("Fixture suite must contain at least one case.");
  const seenIds = new Set();
  suite.cases.forEach(caseDefinition => validateFixtureCase(caseDefinition, seenIds));
  return suite;
}

function loadFixtureSuite(filePath) {
  const resolvedPath = path.resolve(filePath);
  return { filePath: resolvedPath, suite: validateFixtureSuite(readJson(resolvedPath)) };
}

function routeSnapshot(route = null) {
  if (!route || typeof route !== "object") return null;
  return {
    operation: scalar(route.operationType),
    api: scalar(route.operationApi || route.api),
    task_shape: scalar(route.taskShape),
    relation: scalar(route.relation),
    goal_mode: scalar(route.goalMode),
    goal: scalar(route.userGoal || route.executionPrompt || route.dispatchContract?.arguments?.prompt),
    execution_goal: scalar(route.dispatchContract?.arguments?.prompt || route.executionPrompt),
    resolved_goal: scalar(route.resolvedImageGoal),
    task_state: route.imageTaskState || null,
    readiness: scalar(route.readiness),
    dispatch_authorized: route.dispatchAuthorized === true,
    resources: Array.isArray(route.resources) ? route.resources : [],
    clarification: {
      question: scalar(route.clarificationQuestion),
      unresolved_resources: Array.isArray(route.clarificationSlots) ? route.clarificationSlots : [],
    },
    dispatch_contract: route.dispatchContract || null,
  };
}

function normalizedGoalText(value = "") {
  return scalar(value).normalize("NFKC").toLowerCase().replace(/[\s，。！？!?；;：:、,.()（）【】\[\]"'“”‘’_-]+/g, "");
}

const EXECUTION_SEMANTIC_CONTEXT_PREFIX = "[execution_semantic_context.v1]";
const EXECUTION_SEMANTIC_RESOLUTION_HEADING = "路由消解（仅用于识别指代、上下文和已选资源；不得新增、删除或覆盖用户原始要求）：";

function executionGoalForEvaluation(value = "") {
  const text = scalar(value).trim();
  if (!text.startsWith(EXECUTION_SEMANTIC_CONTEXT_PREFIX)) return text;
  const headingIndex = text.indexOf(EXECUTION_SEMANTIC_RESOLUTION_HEADING);
  if (headingIndex < 0) return text;
  return text.slice(headingIndex + EXECUTION_SEMANTIC_RESOLUTION_HEADING.length).trim();
}


function escapeRegExp(value = '') {
  return scalar(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function forbiddenConceptIsNegated(text = '', concept = '') {
  const normalizedText = normalizedGoalText(text);
  const normalizedConcept = normalizedGoalText(concept);
  if (!normalizedConcept || !normalizedText.includes(normalizedConcept)) return false;
  const negation = '(?:不要|不使用|不采用|不保留|不参照|不沿用|取消|移除|去掉|删除|排除|避免|撤销|不再)';
  return new RegExp(negation + '.{0,36}' + escapeRegExp(normalizedConcept), 'i').test(normalizedText);
}

function goalMatchesExpectation(expected = {}, actual = "", options = {}) {
  const text = normalizedGoalText(actual);
  if (!text) return false;
  const concepts = Array.isArray(expected.concepts) ? expected.concepts : [];
  const forbidden = [
    ...(Array.isArray(expected.forbidden) ? expected.forbidden : []),
    ...(options.intentOnly === true && Array.isArray(expected.intent_forbidden) ? expected.intent_forbidden : []),
  ];
  return concepts.every(alternatives => alternatives.some(value => text.includes(normalizedGoalText(value))))
    && forbidden.every(value => {
      const normalized = normalizedGoalText(value);
      return !text.includes(normalized) || forbiddenConceptIsNegated(text, value);
    });
}

function modelResourcesMatchExpectation(caseDefinition = {}, intent = null) {
  if (!intent || !Array.isArray(intent.resource_refs)) return false;
  const catalog = routeService.buildRouteResourceCandidates({
    attachments: caseDefinition.attachments || [],
    context: caseDefinition.context || {},
    input: caseDefinition.input || "",
  });
  const projected = [];
  for (const ref of intent.resource_refs) {
    const candidate = catalog.find(item => item.candidate_key === scalar(ref?.candidate_key));
    if (!candidate) return false;
    // Selecting an unavailable candidate is useful semantic evidence for the
    // compiler to produce an `unavailable` clarification, but it is never an
    // executable binding. Exclude it from the independent execution-resource
    // oracle; the clarification/readiness checks separately require fail-closed.
    if (candidate.availability === "unavailable") continue;
    projected.push({
      type: candidate.type,
      source: candidate.source,
      role: scalar(ref.role),
      index: Number(candidate.index),
      id: scalar(candidate.id),
      reference_id: scalar(candidate.reference_id),
      missing: false,
    });
  }
  return resourcesMatchExpectation(caseDefinition.expected?.resources || { mode: "exact", items: [] }, projected);
}

// Keep the model's semantic proposal as an independent oracle input. The local
// compiler is allowed to enforce protocol safety and resource availability, but
// it must not be the only source used to decide whether operation/relation/goal
// are correct; otherwise a compiler normalization could hide a bad model route.
function relationMatchesExpectation(expectedRelation, actualRelation) {
  const actual = scalar(actualRelation);
  if (Array.isArray(expectedRelation)) return expectedRelation.includes(actual);
  return actual === scalar(expectedRelation);
}

function modelSemanticsMatchExpectation(caseDefinition = {}, intent = null) {
  if (!intent || typeof intent !== "object" || Array.isArray(intent)) {
    return { present: false, operation: false, task_shape: false, relation: false, goal_mode: false, goal: false };
  }
  const expected = caseDefinition.expected || {};
  return {
    present: true,
    operation: scalar(intent.operation) === scalar(expected.operation),
    task_shape: scalar(intent.task_shape) === scalar(expected.task_shape),
    relation: relationMatchesExpectation(expected.relation, intent.relation),
    goal_mode: scalar(intent.goal_mode) === scalar(expected.goal_mode),
    goal: goalMatchesExpectation(expected.goal, intent.goal, { intentOnly: true }),
  };
}

function validateCompiledRoute(route = null) {
  const errors = [];
  const compiled = routeSnapshot(route);
  if (!compiled) return { valid: false, errors: ["compiled route is not an object"] };
  if (!VALID_RELATIONS.has(compiled.relation)) errors.push("relation is invalid");
  if (!VALID_TASK_SHAPES.has(compiled.task_shape)) errors.push("task_shape is invalid");
  if (!VALID_GOAL_MODES.has(compiled.goal_mode)) errors.push("goal_mode is invalid");
  if (!VALID_OPERATIONS.has(compiled.operation) || !capabilityRegistry.capabilityFor(compiled.operation)) errors.push("operation is invalid");
  if (compiled.goal_mode === "amend" && !IMAGE_TASK_AMEND_OPERATIONS.has(compiled.operation)) {
    errors.push("goal_mode=amend is invalid for operation");
  }
  if (IMAGE_TASK_OPERATIONS.has(compiled.operation)) {
    if (!taskContinuityContract.hasExactTaskContinuity(compiled.task_state)) {
      errors.push("image route requires an exact task_continuity.v1 state");
    } else {
      if (compiled.task_state.goal_mode !== compiled.goal_mode) errors.push("task state goal_mode does not match route goal_mode");
      if (taskContinuityContract.renderTaskContinuity(compiled.task_state) !== compiled.resolved_goal) {
        errors.push("resolved image goal does not match task state rendering");
      }
    }
  } else {
    if (compiled.goal_mode !== "replace") errors.push("non-image route goal_mode must be replace");
    if (compiled.task_state !== null) errors.push("non-image route cannot retain image task state");
  }
  if (!["ready", "needs_clarification"].includes(compiled.readiness)) errors.push("readiness is invalid");
  const keys = new Set();
  for (const [index, resource] of compiled.resources.entries()) {
    const label = `resources[${index}]`;
    if (!isPlainObject(resource)) { errors.push(`${label} is not an object`); continue; }
    if (!/^r[1-9][0-9]*$/.test(scalar(resource.key))) errors.push(`${label}.key is invalid`);
    if (keys.has(resource.key)) errors.push(`${label}.key is duplicated`);
    keys.add(resource.key);
    if (!VALID_RESOURCE_TYPES.has(resource.type)) errors.push(`${label}.type is invalid`);
    if (!VALID_RESOURCE_SOURCES.has(resource.source)) errors.push(`${label}.source is invalid`);
    if (!VALID_RESOURCE_ROLES.has(resource.role)) errors.push(`${label}.role is invalid`);
    if (!Number.isInteger(resource.index) || resource.index < 1) errors.push(`${label}.index is invalid`);
    if (resource.type !== "text" && !scalar(resource.resource_id)) errors.push(`${label}.resource_id is missing`);
  }
  const clarification = compiled.clarification;
  if (compiled.readiness === "ready") {
    const planningRoute = compiled.task_shape === "multi" && routeService.shouldRequestImagePlan(route);
    if (planningRoute) {
      if (compiled.dispatch_contract !== null) errors.push("planning route cannot authorize a pre-plan dispatch contract");
      if (compiled.dispatch_authorized) errors.push("planning route cannot authorize dispatch before image planning");
    } else {
      if (!dispatchContractContract.hasExactDispatchContract(compiled.dispatch_contract)) errors.push("ready route requires an exact dispatch_contract.v1");
      if (!compiled.dispatch_authorized) errors.push("ready route must authorize dispatch");
    }
    if (clarification.question || clarification.unresolved_resources.length) errors.push("ready route cannot retain clarification state");
  } else {
    if (compiled.dispatch_contract !== null) errors.push("clarification route cannot contain an execution plan");
    if (compiled.dispatch_authorized) errors.push("clarification route cannot authorize dispatch");
    if (!clarification.question || !clarification.unresolved_resources.length) errors.push("clarification route must explain what is unresolved");
  }
  return { valid: errors.length === 0, errors };
}

function resourcesMatch(expected = {}, actual = {}) {
  return Object.entries(expected).every(([field, value]) => compareField(actual?.[field], value, field));
}

function resourcesMatchExpectation(expectedResources = {}, actualResources = []) {
  const allActualResources = Array.isArray(actualResources) ? actualResources : [];
  const unmatched = expectedResources.mode === "media_exact"
    ? allActualResources.filter(resource => ["image", "file"].includes(resource?.type))
    : [...allActualResources];
  for (const expected of expectedResources.items || []) {
    const matchIndex = unmatched.findIndex(actual => resourcesMatch(expected, actual));
    if (matchIndex < 0) return false;
    unmatched.splice(matchIndex, 1);
  }
  return expectedResources.mode === "contains" || unmatched.length === 0;
}

function choiceMatchesExpectation(expected = {}, actual = {}) {
  return Object.entries(expected).every(([field, value]) => compareField(actual?.[field], value, field));
}

function unresolvedSlotMatchesExpectation(expected = {}, actual = {}) {
  if (actual?.type !== expected.type || actual?.role !== expected.role || actual?.reason !== expected.reason) return false;
  const choices = Array.isArray(actual?.choices) ? actual.choices : [];
  if (choices.length !== expected.choice_count) return false;
  if (!Array.isArray(expected.choices)) return true;
  const unmatched = [...choices];
  for (const expectedChoice of expected.choices) {
    const index = unmatched.findIndex(actualChoice => choiceMatchesExpectation(expectedChoice, actualChoice));
    if (index < 0) return false;
    unmatched.splice(index, 1);
  }
  return unmatched.length === 0;
}

function clarificationMatchesExpectation(expected = {}, compiled = {}) {
  const clarification = compiled?.clarification || {};
  const question = scalar(clarification.question).trim();
  const unresolved = Array.isArray(clarification.unresolved_resources) ? clarification.unresolved_resources : [];
  if (!expected.required) return !question && unresolved.length === 0;
  if (!question || unresolved.length !== expected.unresolved.length) return false;
  const unmatched = [...unresolved];
  for (const expectedSlot of expected.unresolved) {
    const index = unmatched.findIndex(actualSlot => unresolvedSlotMatchesExpectation(expectedSlot, actualSlot));
    if (index < 0) return false;
    unmatched.splice(index, 1);
  }
  return unmatched.length === 0;
}

function scoreRouteCase(caseDefinition = {}, route = null, metadata = {}) {
  const expected = caseDefinition.expected || {};
  const compiled = routeSnapshot(route);
  const validation = validateCompiledRoute(route);
  const validRoute = validation.valid;
  const expectsClarification = expected.clarification.required === true;
  const modelIntent = metadata.model_intent || null;
  const modelResourcesMatch = modelIntent ? modelResourcesMatchExpectation(caseDefinition, modelIntent) : true;
  const modelSemantics = modelIntent
    ? modelSemanticsMatchExpectation(caseDefinition, modelIntent)
    : { present: false, operation: true, task_shape: true, relation: true, goal_mode: true, goal: true };
  const checks = {
    valid_route: validRoute,
    operation: validRoute
      && compiled.operation === expected.operation
      && modelSemantics.operation,
    task_shape: validRoute
      && compiled.task_shape === expected.task_shape
      && modelSemantics.task_shape,
    goal: validRoute
      && goalMatchesExpectation(expected.goal, compiled.goal)
      && (expectsClarification || goalMatchesExpectation(
        expected.goal,
        executionGoalForEvaluation(compiled.execution_goal),
      ))
      && modelSemantics.goal,
    goal_mode: validRoute
      && compiled.goal_mode === expected.goal_mode
      && modelSemantics.goal_mode,
    readiness: validRoute && compiled.readiness === (expectsClarification ? "needs_clarification" : "ready"),
    relation: validRoute
      && relationMatchesExpectation(expected.relation, compiled.relation)
      && modelSemantics.relation,
    resources: validRoute
      && resourcesMatchExpectation(expected.resources, compiled.resources)
      && modelResourcesMatch,
    clarification: validRoute && clarificationMatchesExpectation(expected.clarification, compiled),
    dispatch_contract: validRoute && (expectsClarification
      ? compiled.dispatch_contract === null
      : expected.task_shape === "multi"
        ? compiled.dispatch_contract === null
          && routeService.shouldRequestImagePlan(route)
        : dispatchContractContract.hasExactDispatchContract(compiled.dispatch_contract)),
  };
  const score = Object.entries(SCORE_WEIGHTS).reduce((total, [key, weight]) => total + (checks[key] ? weight : 0), 0);
  const failureReasons = Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name);
  return {
    id: scalar(caseDefinition.id),
    category: scalar(caseDefinition.category),
    safety_critical: caseDefinition.safety_critical === true,
    score,
    checks,
    perfect: failureReasons.length === 0,
    failure_reasons: failureReasons,
    route_validation_errors: validation.errors,
    inspection_reason: scalar(metadata.inspection_reason),
    inspection_error: scalar(metadata.inspection_error),
    model_semantics_match: modelSemantics,
    model_resources_match: modelIntent ? modelResourcesMatch : false,
    compiled: route ? summarizeCompiledRoute(route) : null,
  };
}

function summarizeCompiledRoute(route = null) {
  return routeSnapshot(route);
}

function stripJsonFence(value = "") {
  const text = scalar(value).trim();
  return text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
}

function redactText(value = "", apiKey = "") {
  let text = scalar(value);
  if (apiKey) text = text.split(scalar(apiKey)).join("[redacted]");
  text = text.replace(API_KEY_RE, "[redacted-key]")
    .replace(BEARER_RE, "Bearer [redacted]")
    .replace(DATA_URL_RE, "[redacted-data-url]")
    .replace(LONG_B64_RE, "[redacted-binary]");
  return text.length > 12000 ? `${text.slice(0, 12000)}…[truncated]` : text;
}

function redactValue(value, apiKey = "", key = "") {
  if (SECRET_FIELD_RE.test(key)) return "[redacted]";
  if (typeof value === "string") return redactText(value, apiKey);
  if (Array.isArray(value)) return value.map(item => redactValue(item, apiKey, ""));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([childKey, childValue]) => [childKey, redactValue(childValue, apiKey, childKey)]));
  }
  return value;
}

function redactModelOutput(rawText = "", apiKey = "") {
  const text = redactText(rawText, apiKey);
  try {
    const parsed = JSON.parse(stripJsonFence(text));
    const value = redactValue(parsed, apiKey);
    return { format: "json", value, text: JSON.stringify(value) };
  } catch {
    return { format: "text", value: null, text };
  }
}

function evaluateRouteText(caseDefinition = {}, rawText = "", { apiKey = "" } = {}) {
  const modelIntent = (() => {
    try { return JSON.parse(stripJsonFence(rawText)); } catch { return null; }
  })();
  const inspection = routeService.inspectModelRouteResult(rawText, {
    input: caseDefinition.input,
    attachments: caseDefinition.attachments || [],
    context: caseDefinition.context || {},
    currentMode: caseDefinition.current_mode || "chat",
    autoMode: caseDefinition.auto_mode !== false,
    currentTurn: caseDefinition.current_turn || null,
  });
  const result = scoreRouteCase(caseDefinition, inspection.route, {
    inspection_reason: inspection.reason,
    inspection_error: inspection.error || inspection.parseError,
    model_intent: modelIntent,
  });
  result.model_output = redactModelOutput(rawText, apiKey);
  return result;
}

function summarizeCaseScores(results = []) {
  const list = Array.isArray(results) ? results : [];
  const total = list.length;
  const dimensionAccuracy = Object.fromEntries(Object.keys(SCORE_WEIGHTS).map(key => [key,
    total ? Number((list.filter(result => result?.checks?.[key]).length * 100 / total).toFixed(2)) : 0,
  ]));
  const byCategory = {};
  for (const result of list) {
    const category = scalar(result?.category || "uncategorized");
    if (!byCategory[category]) byCategory[category] = { total: 0, perfect_cases: 0, score_total: 0 };
    byCategory[category].total += 1;
    byCategory[category].score_total += Number(result?.score) || 0;
    if (result?.perfect) byCategory[category].perfect_cases += 1;
  }
  for (const summary of Object.values(byCategory)) {
    summary.average_score = Number((summary.score_total / summary.total).toFixed(2));
    summary.perfect_case_rate = Number((summary.perfect_cases * 100 / summary.total).toFixed(2));
    delete summary.score_total;
  }
  const safetyCriticalResults = list.filter(result => result?.safety_critical === true);
  const safetyCriticalPerfect = safetyCriticalResults.filter(result => result?.perfect);
  return {
    total_cases: total,
    average_score: total ? Number((list.reduce((sum, result) => sum + (Number(result?.score) || 0), 0) / total).toFixed(2)) : 0,
    perfect_cases: list.filter(result => result?.perfect).length,
    perfect_case_rate: total ? Number((list.filter(result => result?.perfect).length * 100 / total).toFixed(2)) : 0,
    dimension_accuracy: dimensionAccuracy,
    by_category: byCategory,
    safety_critical: {
      total_cases: safetyCriticalResults.length,
      perfect_cases: safetyCriticalPerfect.length,
      perfect_case_rate: safetyCriticalResults.length
        ? Number((safetyCriticalPerfect.length * 100 / safetyCriticalResults.length).toFixed(2))
        : 100,
      failed_case_ids: safetyCriticalResults.filter(result => !result?.perfect).map(result => scalar(result.id)),
    },
  };
}

module.exports = {
  SCHEMA_VERSION,
  SCORE_WEIGHTS,
  VALID_OPERATIONS,
  VALID_TASK_SHAPES,
  VALID_GOAL_MODES,
  validateCompiledRoute,
  validateFixtureSuite,
  loadFixtureSuite,
  resourcesMatchExpectation,
  clarificationMatchesExpectation,
  goalMatchesExpectation,
  executionGoalForEvaluation,
  relationMatchesExpectation,
  modelResourcesMatchExpectation,
  scoreRouteCase,
  summarizeCompiledRoute,
  redactText,
  redactValue,
  redactModelOutput,
  evaluateRouteText,
  summarizeCaseScores,
};
