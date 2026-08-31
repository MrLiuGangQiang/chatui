#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const routeService = require("../client/services/route-service");
const routeIntentWorkflow = require("../client/app/route-intent-workflow");
const {
  SCHEMA_VERSION,
  loadFixtureSuite,
  scoreRouteCase,
  evaluateRouteText,
  summarizeCaseScores,
  redactText,
  redactValue,
} = require("./lib/intent-routing-evaluation");

const ROOT = path.resolve(__dirname, "..");
const DEFAULT_FIXTURE = path.join(ROOT, "test/fixtures/intent-routing-eval.v3.json");
const DEFAULT_MODELS = ["deepseek-v4-flash", "gpt-5.6-luna", "gpt-5.6-terra"];
const DEFAULT_CHAT_MODEL = "gpt-5.6-luna";
const DEFAULT_IMAGE_MODEL = "gpt-image-2";

function firstDefined(...values) {
  return values.find(value => value !== undefined && value !== null && value !== "");
}

function optionValue(argv, index, option) {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${option} requires a value.`);
  return value;
}

function numberOption(value, option, { min = 0, max = Number.MAX_SAFE_INTEGER, integer = false } = {}) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max || (integer && !Number.isInteger(number))) {
    throw new Error(`${option} must be ${integer ? "an integer" : "a number"} between ${min} and ${max}.`);
  }
  return number;
}

function parseArgs(argv = process.argv.slice(2), environment = process.env) {
  const values = {};
  const options = {
    "--base-url": "baseUrl",
    "--api-key": "apiKey",
    "--models": "models",
    "--fixture": "fixture",
    "--output": "output",
    "--timeout-ms": "timeoutMs",
    "--chat-model": "chatModel",
    "--image-model": "imageModel",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") return { help: true };
    if (argument === "--no-write") {
      values.noWrite = true;
      continue;
    }
    const key = options[argument];
    if (!key) throw new Error(`Unknown option: ${argument}`);
    values[key] = optionValue(argv, index, argument);
    index += 1;
  }
  const baseUrl = String(firstDefined(values.baseUrl, environment.CHATUI_EVAL_BASE_URL, "") || "").trim();
  const apiKey = String(firstDefined(values.apiKey, environment.CHATUI_EVAL_API_KEY, "") || "").trim();
  const models = String(firstDefined(values.models, environment.CHATUI_EVAL_ROUTE_MODELS, DEFAULT_MODELS.join(",")) || "")
    .split(",").map(value => value.trim()).filter(Boolean);
  if (!baseUrl || !apiKey || !models.length) {
    throw new Error("Base URL, API key and at least one intent model are required.");
  }
  return {
    baseUrl,
    apiKey,
    models,
    fixture: path.resolve(firstDefined(values.fixture, environment.CHATUI_EVAL_FIXTURE, DEFAULT_FIXTURE)),
    output: values.output ? path.resolve(values.output) : path.join(ROOT, "temp", "reports", `intent-models-${Date.now()}.json`),
    timeoutMs: numberOption(firstDefined(values.timeoutMs, environment.CHATUI_EVAL_TIMEOUT_MS, 120000), "--timeout-ms", { min: 1000, max: 300000, integer: true }),
    chatModel: String(firstDefined(values.chatModel, environment.CHATUI_EVAL_CHAT_MODEL, DEFAULT_CHAT_MODEL) || "").trim(),
    imageModel: String(firstDefined(values.imageModel, environment.CHATUI_EVAL_IMAGE_MODEL, DEFAULT_IMAGE_MODEL) || "").trim(),
    noWrite: values.noWrite === true,
  };
}

function usage() {
  return [
    "Usage: npm run eval:intent:models -- [options]",
    "",
    "  --base-url <url>       CHATUI_EVAL_BASE_URL",
    "  --api-key <key>       CHATUI_EVAL_API_KEY",
    `  --models <a,b,c>      Intent models (default: ${DEFAULT_MODELS.join(",")})`,
    `  --fixture <path>      Fixture (default: ${path.relative(process.cwd(), DEFAULT_FIXTURE)})`,
    "  --output <path>       Comparison report destination",
    "  --timeout-ms <n>      Per-case absolute pipeline budget",
    `  --chat-model <model>  Metadata only (default: ${DEFAULT_CHAT_MODEL})`,
    `  --image-model <model> Metadata only (default: ${DEFAULT_IMAGE_MODEL})`,
    "  --no-write            Print summary without writing a report",
  ].join("\n");
}

function normalizedEndpoint(baseUrl = "") {
  const value = String(baseUrl).trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(value)) throw new Error("Base URL must start with http:// or https://.");
  const parsed = new URL(value);
  if (parsed.username || parsed.password) throw new Error("Base URL must not contain credentials.");
  return `${value}/responses`;
}

function safeBaseUrl(baseUrl = "") {
  try {
    const parsed = new URL(baseUrl);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname.replace(/\/$/, "")}`;
  } catch {
    return String(baseUrl || "").replace(/\/[^/]*@/, "/[redacted]@");
  }
}

function makeAttachmentMetadata(attachments = []) {
  return (Array.isArray(attachments) ? attachments : []).map((item, index) => {
    const type = String(item?.type || item?.mime || "").toLowerCase();
    const name = String(item?.name || item?.filename || "");
    const image = type.startsWith("image/") || /\.(?:png|jpe?g|gif|webp|bmp|svg)$/i.test(name);
    return {
      type: image ? "image" : "file",
      name,
      index: index + 1,
      source_index: Number(item?.source_index || item?.sourceIndex) || index + 1,
      source: String(item?.route_source || item?.routeSource || item?.source || "current"),
      id: String(item?.image_id || item?.imageId || item?.file_id || item?.fileId || item?.id || ""),
      resource_id: String(item?.resource_id || item?.resourceId || ""),
      reference_id: String(item?.reference_id || item?.referenceId || ""),
      availability: item?.availability === "unavailable"
        || item?.available === false
        || String(item?.unavailable_reason || item?.unavailableReason || item?.unsupported_reason || item?.unsupportedReason || "").trim()
        || (image === false && item?.has_extracted_text === false)
        ? "unavailable" : "available",
      unavailable_reason: String(item?.unavailable_reason || item?.unavailableReason || item?.unsupported_reason || item?.unsupportedReason || ""),
    };
  });
}

function providerError(response, body) {
  const provider = body?.error && typeof body.error === "object" ? body.error : body;
  const error = new Error(String(provider?.message || `Intent model returned HTTP ${response.status}.`));
  error.statusCode = Number(response.status) || 0;
  error.status = error.statusCode;
  error.code = String(provider?.code || provider?.type || `HTTP_${response.status}`);
  error.retryable = error.statusCode === 408 || error.statusCode === 425 || error.statusCode === 429 || error.statusCode >= 500;
  return error;
}

async function requestJsonDirect(url, payload, apiKey, options = {}) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      ...(options.headers || {}),
    },
    body: JSON.stringify(payload),
    signal: options.signal,
  });
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = null; }
  if (!response.ok) throw providerError(response, body || text);
  if (body && typeof body === "object") return body;
  return { output_text: text };
}

function redactedModelOutput(value, apiKey = "") {
  if (typeof value === "string") return { format: "text", value: null, text: redactText(value, apiKey).slice(0, 4000) };
  return { format: "json", value: redactValue(value, apiKey), text: "" };
}

function routeRawOutput(call) {
  if (!call || !['intent_recognition', 'route_fallback'].includes(call.purpose)) return null;
  const text = routeService.extractRouteText(call.response || {});
  let value = null;
  try { value = text ? JSON.parse(String(text).replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()) : null; } catch { value = null; }
  return { text: text.slice(0, 4000), value };
}

async function runModelCase({ model, caseDefinition, endpoint, apiKey, timeoutMs, log }) {
  const startedAt = Date.now();
  const calls = [];
  const traces = [];
  const sessionId = `eval-${model.replace(/[^A-Za-z0-9_-]+/g, "_")}`;
  const state = {
    mode: caseDefinition.current_mode || "chat",
    autoMode: caseDefinition.auto_mode !== false,
    sessions: [{ id: sessionId, messages: [], routeMemory: [] }],
    messages: [],
  };
  const workflow = routeIntentWorkflow.createRouteIntentWorkflow({
    state,
    getConfig: () => ({
      baseUrl: endpoint.replace(/\/responses$/, ""),
      apiKey,
      routeModel: model,
      chatModel: "",
    }),
    getSessionRouteModel: () => model,
    getSessionChatModel: () => "",
    buildRouteAttachmentMetadata: makeAttachmentMetadata,
    requestJson: async (url, payload, key, options = {}) => {
      calls.push({
        purpose: String(options.requestPurpose || ""),
        formatName: String(payload?.text?.format?.name || ""),
        phase: String(options.phase || ""),
        model: String(payload?.model || model),
        response: null,
      });
      const response = await requestJsonDirect(url, payload, key, options);
      calls[calls.length - 1].response = response;
      return response;
    },
  });
  let route = null;
  let error = null;
  try {
    route = await workflow.getEffectiveRoute(
      caseDefinition.input,
      caseDefinition.attachments || [],
      sessionId,
      null,
      caseDefinition.context || {},
      {
        currentTurn: caseDefinition.current_turn || null,
        deadlineAt: Date.now() + timeoutMs,
        submissionId: `eval-${caseDefinition.id}`,
        enforceDeterministicPolicies: true,
        skipImageInstructionMaterialization: true,
        onReasoningTrace: trace => traces.push(trace),
      },
    );
  } catch (caught) {
    error = caught;
  }
  const evaluation = scoreRouteCase(caseDefinition, route, {});
  const firstRouteCall = calls.find(call => ['intent_recognition', 'route_fallback'].includes(call.purpose));
  const rawRoute = firstRouteCall ? routeRawOutput(firstRouteCall) : null;
  const rawEvaluation = rawRoute
    ? evaluateRouteText(caseDefinition, rawRoute.text, {})
    : null;
  return {
    id: caseDefinition.id,
    duration_ms: Date.now() - startedAt,
    category: caseDefinition.category,
    safety_critical: caseDefinition.safety_critical === true,
    evaluation: {
      score: evaluation.score,
      perfect: evaluation.perfect,
      checks: evaluation.checks,
      failure_reasons: evaluation.failure_reasons,
      route_validation_errors: evaluation.route_validation_errors,
      inspection_reason: evaluation.inspection_reason,
    },
    raw_evaluation: rawEvaluation ? {
      score: rawEvaluation.score,
      perfect: rawEvaluation.perfect,
      checks: rawEvaluation.checks,
      failure_reasons: rawEvaluation.failure_reasons,
    } : null,
    route: route ? {
      operation: route.operationType || "",
      relation: route.relation || "",
      goal: route.userGoal || "",
      goal_mode: route.goalMode || "",
      task_shape: route.taskShape || "",
      readiness: route.readiness || "",
      outcome: route.outcome || "",
      source: route.routeDecision?.source || "",
      dispatch_authorized: route.dispatchAuthorized === true,
      intent_risk: route.intentRisk || null,
      reasoning_trace: route.intentReasoningTrace || null,
      image_plan_compiled_kind: route.imagePlanCompiled?.kind || '',
      should_request_image_plan: typeof routeService.shouldRequestImagePlan === 'function'
        ? routeService.shouldRequestImagePlan(route)
        : null,
      parent_dispatch_contract_present: !!route.dispatchContract,
      image_plan_child_count: Array.isArray(route.imagePlanCompiled?.items) ? route.imagePlanCompiled.items.length : 0,
      image_plan_child_contracts_valid: Array.isArray(route.imagePlanCompiled?.items)
        ? route.imagePlanCompiled.items.every(item => !!item?.dispatchContract && item.route?.dispatchAuthorized === true)
        : null,
    } : null,
    raw_route_output: rawRoute ? {
      format: 'json',
      value: redactValue(rawRoute.value, apiKey),
      text: redactText(rawRoute.text, apiKey).slice(0, 4000),
    } : null,
    calls: calls.map(call => ({
      purpose: call.purpose,
      format: call.formatName,
      phase: call.phase,
      model: call.model,
      output: call.response ? redactText(routeService.extractRouteText(call.response), apiKey).slice(0, 4000) : '',
    })),
    trace_updates: traces.length,
    error: error ? redactText(String(error.message || error), apiKey).slice(0, 400) : "",
  };
}

function summarizeModelResults(model, cases) {
  const scoreResults = cases.map(item => ({
    id: item.id,
    category: item.category,
    safety_critical: item.safety_critical,
    score: item.evaluation.score,
    perfect: item.evaluation.perfect,
    checks: item.evaluation.checks,
  }));
  const summary = summarizeCaseScores(scoreResults);
  const rawScoreResults = cases.filter(item => item.raw_evaluation).map(item => ({
    id: item.id,
    category: item.category,
    safety_critical: item.safety_critical,
    score: item.raw_evaluation.score,
    perfect: item.raw_evaluation.perfect,
    checks: item.raw_evaluation.checks,
  }));
  const rawSummary = rawScoreResults.length ? summarizeCaseScores(rawScoreResults) : null;
  const durations = cases.map(item => Number(item.duration_ms) || 0).sort((a, b) => a - b);
  const callCounts = cases.map(item => Array.isArray(item.calls) ? item.calls.length : 0);
  const average = values => values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length * 10) / 10 : 0;
  const percentile = (values, fraction) => values.length ? values[Math.min(values.length - 1, Math.max(0, Math.ceil(values.length * fraction) - 1))] : 0;
  const telemetry = {
    average_duration_ms: average(durations),
    p50_duration_ms: percentile(durations, 0.5),
    p95_duration_ms: percentile(durations, 0.95),
    average_provider_calls: average(callCounts),
    max_provider_calls: callCounts.length ? Math.max(...callCounts) : 0,
    critic_cases: cases.filter(item => (item.calls || []).some(call => call.purpose === 'intent_critic')).length,
    repaired_cases: cases.filter(item => (item.calls || []).some(call => call.purpose === 'route_repair')).length,
  };
  const luna = model.toLowerCase() === "gpt-5.6-luna";
  const gate = {
    passed: Number(summary.average_score) === 100
      && Number(summary.dimension_accuracy?.valid_route) === 100
      && Number(summary.safety_critical?.perfect_case_rate) === 100,
    average_score: summary.average_score,
    valid_route_rate: summary.dimension_accuracy?.valid_route || 0,
    safety_critical_perfect_rate: summary.safety_critical?.perfect_case_rate || 0,
    required_for_luna: luna,
  };
  return { summary, raw_summary: rawSummary, telemetry, gate };
}

async function runModelEvaluation(options, model, { log = console.log } = {}) {
  const { filePath, suite } = loadFixtureSuite(options.fixture);
  const endpoint = normalizedEndpoint(options.baseUrl);
  const results = [];
  for (const caseDefinition of suite.cases) {
    const result = await runModelCase({
      model,
      caseDefinition,
      endpoint,
      apiKey: options.apiKey,
      timeoutMs: options.timeoutMs,
      log,
    });
    results.push(result);
    const failed = result.evaluation.failure_reasons || [];
    log(`[${result.evaluation.perfect ? "PASS" : "FAIL"}] ${model} ${result.id} | ${Number(result.evaluation.score || 0).toFixed(1)} | ${failed.join(", ") || "all checks passed"}`);
  }
  if (results.length !== suite.cases.length) throw new Error(`${model}: evaluator stopped before running every scenario.`);
  const quality = summarizeModelResults(model, results);
  return {
    model,
    fixture: path.relative(ROOT, filePath).replace(/\\/g, "/"),
    scenario_count: results.length,
    summary: quality.summary,
    raw_summary: quality.raw_summary,
    telemetry: quality.telemetry,
    quality_gate: quality.gate,
    cases: results,
  };
}

async function runAllModels(options, { log = console.log } = {}) {
  const modelReports = [];
  for (const model of options.models) {
    modelReports.push(await runModelEvaluation(options, model, { log }));
  }
  const lunaReport = modelReports.find(report => report.model.toLowerCase() === "gpt-5.6-luna");
  const report = {
    schema_version: "intent-model-comparison.v1",
    generated_at: new Date().toISOString(),
    fixture: path.relative(ROOT, options.fixture).replace(/\\/g, "/"),
    base_url: safeBaseUrl(options.baseUrl),
    models: options.models,
    chat_model: options.chatModel,
    image_model: options.imageModel,
    scenario_count: modelReports[0]?.scenario_count || 0,
    policy: {
      all_scenarios_required: true,
      fallback_model_disabled: true,
      luna_required_average_score: 100,
      luna_required_valid_route_rate: 100,
      luna_required_safety_critical_rate: 100,
      raw_outputs: "parsed bounded redacted output only; full provider output is not retained",
    },
    luna_quality_gate: lunaReport?.quality_gate || { passed: false, reason: "gpt-5.6-luna was not evaluated" },
    model_reports: modelReports,
  };
  if (!options.noWrite) {
    fs.mkdirSync(path.dirname(options.output), { recursive: true });
    fs.writeFileSync(options.output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    log(`Intent-model comparison report: ${options.output}`);
  }
  log(`Intent-model comparison complete: ${modelReports.map(item => `${item.model}=${item.summary.average_score}/100`).join("; ")}; Luna gate: ${report.luna_quality_gate.passed ? "PASS" : "FAIL"}.`);
  return report;
}

async function main() {
  let options;
  try {
    options = parseArgs();
  } catch (error) {
    console.error(`[intent-models] ${error.message}`);
    console.error(usage());
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    console.log(usage());
    return;
  }
  try {
    const report = await runAllModels(options);
    if (!report.luna_quality_gate.passed) process.exitCode = 1;
  } catch (error) {
    console.error(`[intent-models] ${error.message}`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = {
  DEFAULT_FIXTURE,
  DEFAULT_MODELS,
  parseArgs,
  usage,
  normalizedEndpoint,
  safeBaseUrl,
  makeAttachmentMetadata,
  runModelCase,
  summarizeModelResults,
  runModelEvaluation,
  runAllModels,
};
