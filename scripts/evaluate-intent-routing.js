#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const routeService = require("../client/services/route-service");
const requestCompatibility = require("../client/services/request-compatibility");
const { responseOutputText } = require("../shared/responses-output");
const {
  SCHEMA_VERSION,
  loadFixtureSuite,
  evaluateRouteText,
  scoreRouteCase,
  summarizeCompiledRoute,
  summarizeCaseScores,
  redactText,
  redactValue,
} = require("./lib/intent-routing-evaluation");

const ROOT = path.resolve(__dirname, "..");
const DEFAULT_FIXTURE = path.join(ROOT, "test/fixtures/intent-routing-eval.v3.json");

function usage() {
  return [
    "Usage: npm run eval:intent -- [options]",
    "",
    "Required (or set the matching CHATUI_EVAL_* environment variable):",
    "  --base-url <url>             CHATUI_EVAL_BASE_URL",
    "  --api-key <key>              CHATUI_EVAL_API_KEY",
    "  --model <model>              CHATUI_EVAL_ROUTE_MODEL",
    "",
    "Options:",
    `  --fixture <path>             Fixture file (default: ${path.relative(process.cwd(), DEFAULT_FIXTURE) || DEFAULT_FIXTURE})`,
    "  --output <path>              JSON report destination (default: temp/reports/...)",
    "  --timeout-ms <number>        Per-case timeout in milliseconds (default: 120000)",
    "  --limit <number>             Evaluate only the first N cases",
    "  --min-score <0-100>          Fail when average score is lower (default: 100)",
    "  --min-valid-route <0-100> Fail when valid-route rate is lower (default: 100)",
    "  Safety-critical cases always require a 100% perfect-case rate.",
    "  --no-write                   Print results without writing a report",
    "  --help                       Show this help",
  ].join("\n");
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

function firstDefined(...values) {
  return values.find(value => value !== undefined && value !== null && value !== "");
}

function parseArgs(argv = process.argv.slice(2), environment = process.env) {
  const values = {};
  const options = {
    "--base-url": "baseUrl",
    "--api-key": "apiKey",
    "--model": "model",
    "--fixture": "fixture",
    "--output": "output",
    "--timeout-ms": "timeoutMs",
    "--limit": "limit",
    "--min-score": "minScore",
    "--min-valid-route": "minValidRoute",
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
  const model = String(firstDefined(values.model, environment.CHATUI_EVAL_ROUTE_MODEL, "") || "").trim();
  if (!baseUrl || !apiKey || !model) {
    throw new Error("Route-model credentials are required. Set --base-url, --api-key, and --model (or CHATUI_EVAL_* variables).");
  }
  return {
    baseUrl,
    apiKey,
    model,
    fixture: path.resolve(firstDefined(values.fixture, environment.CHATUI_EVAL_FIXTURE, DEFAULT_FIXTURE)),
    output: values.output ? path.resolve(values.output) : "",
    timeoutMs: numberOption(firstDefined(values.timeoutMs, environment.CHATUI_EVAL_TIMEOUT_MS, 120000), "--timeout-ms", { min: 1000, max: 300000, integer: true }),
    limit: values.limit !== undefined ? numberOption(values.limit, "--limit", { min: 1, max: 10000, integer: true }) : 0,
    minScore: numberOption(firstDefined(values.minScore, environment.CHATUI_EVAL_MIN_SCORE, 100), "--min-score", { min: 0, max: 100 }),
    minValidRoute: numberOption(firstDefined(values.minValidRoute, environment.CHATUI_EVAL_MIN_VALID_ROUTE, 100), "--min-valid-route", { min: 0, max: 100 }),
    noWrite: values.noWrite === true,
  };
}

function endpointFor(baseUrl = "") {
  const normalized = String(baseUrl).trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(normalized)) throw new Error("--base-url must start with http:// or https://.");
  const parsed = new URL(normalized);
  if (parsed.username || parsed.password) throw new Error("--base-url must not contain credentials.");
  return `${normalized}/responses`;
}

function safeBaseUrl(baseUrl = "") {
  try {
    const parsed = new URL(baseUrl);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname.replace(/\/$/, "")}`;
  } catch {
    return String(baseUrl || "").replace(/\/[^/]*@/, "/[redacted]@");
  }
}

function redactErrorMessage(error, apiKey = "") {
  return redactText(String(error?.message || error || "Unknown route-model error"), apiKey).slice(0, 400);
}

function defaultOutputPath() {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return path.join(ROOT, "temp", "reports", `intent-routing-eval-${timestamp}.json`);
}

function summarizeAttachmentForReport(attachment = {}, apiKey = "") {
  const safe = {};
  for (const [key, value] of Object.entries(attachment || {})) {
    if (/^(data|blob|url|content|bytes|base64|buffer|file)$/i.test(key)) {
      safe[key] = "[redacted]";
    } else {
      safe[key] = redactValue(value, apiKey, key);
    }
  }
  return safe;
}

function summarizeContextForReport(context = {}, apiKey = "") {
  return redactValue(context, apiKey);
}

function auditRoutePayload(payload = {}, apiKey = "") {
  const serialized = JSON.stringify(payload);
  const keys = [];
  const walk = (value, pathName = "payload") => {
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      const childPath = `${pathName}.${key}`;
      keys.push(childPath);
      if (child && typeof child === "object") walk(child, childPath);
    }
  };
  walk(payload);
  const protocolField = keys.find(key => /(?:requestPurpose|dispatchContract|bindingEvidence)/i.test(key));
  const requestItems = Array.isArray(payload.input)
    ? payload.input
    : (Array.isArray(payload.messages) ? payload.messages : []);
  return {
    payload_bytes: Buffer.byteLength(serialized, "utf8"),
    transport: Array.isArray(payload.input) || payload.text ? "responses" : "chat",
    message_count: requestItems.length,
    contains_api_key: apiKey ? serialized.includes(apiKey) : false,
    contains_data_url: /data:[^\s"']+;base64,/i.test(serialized),
    contains_binary_field: /(?:base64|arraybuffer|blob|bytes|buffer)/i.test(serialized),
    embedded_execution_protocol_field: protocolField || "",
    user_content_redacted: redactValue(requestItems.find(message => message?.role === "user")?.content || "", apiKey),
  };
}

function providerRequestError(response, body = null) {
  const provider = body?.error && typeof body.error === "object" ? body.error : body;
  const message = String(provider?.message || `Route model returned HTTP ${response.status}.`);
  const error = new Error(message);
  error.code = String(provider?.code || provider?.type || `HTTP_${response.status}`);
  error.statusCode = Number(response.status) || 0;
  error.status = error.statusCode;
  error.error = provider && typeof provider === "object" ? provider : null;
  return error;
}

async function requestRouteModelOnce({ endpoint, apiKey, payload, deadlineAt, fetchImpl }) {
  const remainingMs = Math.max(0, Number(deadlineAt) - Date.now());
  if (!remainingMs) throw new Error("Route model request timed out before the next compatibility attempt.");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), remainingMs);
  try {
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const rawBody = await response.text();
    let body = null;
    if (rawBody) {
      try { body = JSON.parse(rawBody); } catch {
        if (response.ok) throw new Error("Route model returned invalid JSON.");
      }
    }
    if (!response.ok) throw providerRequestError(response, body);
    const text = String(responseOutputText(body || {}) || "").trim();
    if (!text) throw new Error("Route model returned an empty decision.");
    return text;
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`Route model request timed out after the shared compatibility deadline.`);
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function requestRouteModel({ endpoint, apiKey, payload, timeoutMs, fetchImpl = fetch }) {
  const deadlineAt = Date.now() + timeoutMs;
  const request = nextPayload => requestRouteModelOnce({
    endpoint,
    apiKey,
    payload: nextPayload,
    deadlineAt,
    fetchImpl,
  });
  let attempt = request;
  if (typeof requestCompatibility.requestJsonWithReasoningParamFallback === "function") {
    const inner = attempt;
    attempt = nextPayload => requestCompatibility.requestJsonWithReasoningParamFallback(inner, nextPayload);
  }
  if (typeof requestCompatibility.requestJsonWithToolChoiceParamFallback === "function") {
    const inner = attempt;
    attempt = nextPayload => requestCompatibility.requestJsonWithToolChoiceParamFallback(inner, nextPayload);
  }
  if (typeof requestCompatibility.requestJsonWithStructuredOutputFallback === "function") {
    const inner = attempt;
    attempt = nextPayload => requestCompatibility.requestJsonWithStructuredOutputFallback(inner, nextPayload);
  }
  return attempt(payload);
}

function buildRoutePayloadForCase(caseDefinition = {}, model = "") {
  return routeService.buildRoutePayload({
    model,
    input: caseDefinition.input,
    attachments: caseDefinition.attachments,
    context: caseDefinition.context,
    currentMode: caseDefinition.current_mode || "chat",
    autoMode: caseDefinition.auto_mode !== false,
    currentTurn: caseDefinition.current_turn || null,
  });
}

function formatCaseResult(result = {}) {
  const reasons = [...(result.failure_reasons || []), ...(result.transport_error ? ["transport_error"] : [])];
  return `[${result.perfect ? "PASS" : "FAIL"}] ${result.id} | ${Number(result.score || 0).toFixed(1)} | ${reasons.join(", ") || "all checks passed"}`;
}

function qualityGate(summary = {}, options = {}) {
  const averageScore = Number(summary.average_score) || 0;
  const validRouteRate = Number(summary.dimension_accuracy?.valid_route) || 0;
  const safetyCriticalPerfectRate = Number(summary.safety_critical?.perfect_case_rate);
  const safetyCriticalPassed = Number.isFinite(safetyCriticalPerfectRate) && safetyCriticalPerfectRate === 100;
  return {
    passed: averageScore >= options.minScore && validRouteRate >= options.minValidRoute && safetyCriticalPassed,
    average_score: averageScore,
    valid_route_rate: validRouteRate,
    min_score: options.minScore,
    min_valid_route: options.minValidRoute,
    safety_critical_perfect_rate: safetyCriticalPerfectRate,
    min_safety_critical_perfect_rate: 100,
  };
}

function buildCaseReport(caseDefinition, result, { rawText = "", apiKey = "", payload = null, durationMs = 0 } = {}) {
  return {
    id: result.id,
    category: result.category,
    safety_critical: result.safety_critical,
    input: redactText(caseDefinition.input, apiKey),
    attachments: (caseDefinition.attachments || []).map(item => summarizeAttachmentForReport(item, apiKey)),
    context: summarizeContextForReport(caseDefinition.context || {}, apiKey),
    current_turn: redactValue(caseDefinition.current_turn || null, apiKey),
    expected: redactValue(caseDefinition.expected, apiKey),
    model_output: result.model_output || { format: "text", value: null, text: "" },
    compiled_result: result.compiled,
    dispatch_contract: result.compiled?.dispatch_contract || null,
    evaluation: {
      score: result.score,
      perfect: result.perfect,
      checks: result.checks,
      failure_reasons: result.failure_reasons,
      route_validation_errors: result.route_validation_errors,
      inspection_reason: result.inspection_reason,
      inspection_error: result.inspection_error,
    },
    transport_error: result.transport_error || "",
    duration_ms: durationMs,
    route_payload_audit: payload ? auditRoutePayload(payload, apiKey) : null,
    // Keep the raw text out of the report. `model_output` is parsed and
    // redacted, which preserves auditability without leaking credentials or
    // binary content.
    raw_model_output_retained: false,
    raw_model_output_sha256: require("crypto").createHash("sha256").update(String(rawText)).digest("hex"),
  };
}

async function runEvaluation(options, { requestRoute = requestRouteModel, log = console.log } = {}) {
  const { filePath, suite } = loadFixtureSuite(options.fixture);
  const cases = options.limit ? suite.cases.slice(0, options.limit) : suite.cases;
  const endpoint = endpointFor(options.baseUrl);
  const results = [];

  for (const caseDefinition of cases) {
    const started = Date.now();
    let result;
    let payload = null;
    let rawText = "";
    try {
      payload = buildRoutePayloadForCase(caseDefinition, options.model);
      rawText = await requestRoute({ endpoint, apiKey: options.apiKey, payload, timeoutMs: options.timeoutMs });
      result = evaluateRouteText(caseDefinition, rawText, { apiKey: options.apiKey });
    } catch (error) {
      result = scoreRouteCase(caseDefinition, null, { inspection_reason: "transport_error" });
      result.transport_error = redactErrorMessage(error, options.apiKey);
      result.model_output = rawText
        ? require("./lib/intent-routing-evaluation").redactModelOutput(rawText, options.apiKey)
        : { format: "text", value: null, text: "" };
    }
    const caseReport = buildCaseReport(caseDefinition, result, {
      rawText,
      apiKey: options.apiKey,
      payload,
      durationMs: Date.now() - started,
    });
    results.push(caseReport);
    log(formatCaseResult(result));
  }

  const scoreResults = results.map(item => ({
    id: item.id,
    category: item.category,
    safety_critical: item.safety_critical,
    score: item.evaluation.score,
    perfect: item.evaluation.perfect,
    checks: item.evaluation.checks,
  }));
  const summary = summarizeCaseScores(scoreResults);
  const gate = qualityGate(summary, options);
  const report = {
    schema_version: SCHEMA_VERSION,
    generated_at: new Date().toISOString(),
    fixture: path.relative(ROOT, filePath).replace(/\\/g, "/"),
    model: options.model,
    base_url: safeBaseUrl(options.baseUrl),
    criteria: {
      score_weights: require("./lib/intent-routing-evaluation").SCORE_WEIGHTS,
      valid_route_definition: "compiled route state is internally consistent and every ready route contains an exact dispatch_contract.v1",
      safety_critical_policy: "every safety-critical case must be perfect; aggregate thresholds cannot trade it away",
      raw_output_policy: "only parsed, bounded, redacted model output and a SHA-256 evidence hash are retained",
    },
    summary,
    quality_gate: gate,
    cases: results,
  };
  const output = options.output || defaultOutputPath();
  if (!options.noWrite) {
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    log(`Intent-routing evaluation report: ${output}`);
  }
  log(`Intent-routing score: ${summary.average_score}/100; valid routes: ${summary.dimension_accuracy.valid_route}%; safety-critical perfect cases: ${summary.safety_critical.perfect_case_rate}%; gate: ${gate.passed ? "PASS" : "FAIL"}.`);
  return report;
}

async function main() {
  let options;
  try {
    options = parseArgs();
  } catch (error) {
    console.error(`[intent-routing-eval] ${error.message}`);
    console.error(usage());
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    console.log(usage());
    return;
  }
  try {
    const report = await runEvaluation(options);
    if (!report.quality_gate.passed) process.exitCode = 1;
  } catch (error) {
    console.error(`[intent-routing-eval] ${error.message}`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = {
  DEFAULT_FIXTURE,
  usage,
  parseArgs,
  endpointFor,
  safeBaseUrl,
  redactErrorMessage,
  defaultOutputPath,
  auditRoutePayload,
  buildRoutePayloadForCase,
  requestRouteModel,
  qualityGate,
  buildCaseReport,
  runEvaluation,
};
