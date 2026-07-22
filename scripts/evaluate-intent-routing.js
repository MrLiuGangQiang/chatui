#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const routeService = require('../client/services/route-service');
const {
  SCHEMA_VERSION,
  loadFixtureSuite,
  evaluateRouteText,
  scoreRouteCase,
  summarizeCaseScores,
} = require('./lib/intent-routing-evaluation');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_FIXTURE = path.join(ROOT, 'test/fixtures/intent-routing-eval.v1.json');

function usage() {
  return [
    'Usage: npm run eval:intent -- [options]',
    '',
    'Required (or set the matching CHATUI_EVAL_* environment variable):',
    '  --base-url <url>             CHATUI_EVAL_BASE_URL',
    '  --api-key <key>              CHATUI_EVAL_API_KEY',
    '  --model <model>              CHATUI_EVAL_ROUTE_MODEL',
    '',
    'Options:',
    `  --fixture <path>             Fixture file (default: ${path.relative(process.cwd(), DEFAULT_FIXTURE) || DEFAULT_FIXTURE})`,
    '  --output <path>              JSON report destination (default: reports/intent-routing/...)',
    '  --timeout-ms <number>        Per-case timeout in milliseconds (default: 30000)',
    '  --limit <number>             Evaluate only the first N cases',
    '  --min-score <0-100>          Fail when average score is lower (default: 90)',
    '  --min-valid-contract <0-100> Fail when valid-contract rate is lower (default: 100)',
    '  --no-write                   Print results without writing a report',
    '  --help                       Show this help',
  ].join('\n');
}

function optionValue(argv, index, option) {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${option} requires a value.`);
  return value;
}

function numberOption(value, option, { min = 0, max = Number.MAX_SAFE_INTEGER, integer = false } = {}) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max || (integer && !Number.isInteger(number))) {
    throw new Error(`${option} must be ${integer ? 'an integer' : 'a number'} between ${min} and ${max}.`);
  }
  return number;
}

function parseArgs(argv = process.argv.slice(2), environment = process.env) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help') return { help: true };
    if (argument === '--no-write') {
      values.noWrite = true;
      continue;
    }
    const options = {
      '--base-url': 'baseUrl',
      '--api-key': 'apiKey',
      '--model': 'model',
      '--fixture': 'fixture',
      '--output': 'output',
      '--timeout-ms': 'timeoutMs',
      '--limit': 'limit',
      '--min-score': 'minScore',
      '--min-valid-contract': 'minValidContract',
    };
    const key = options[argument];
    if (!key) throw new Error(`Unknown option: ${argument}`);
    values[key] = optionValue(argv, index, argument);
    index += 1;
  }

  const baseUrl = String(values.baseUrl || environment.CHATUI_EVAL_BASE_URL || '').trim();
  const apiKey = String(values.apiKey || environment.CHATUI_EVAL_API_KEY || '').trim();
  const model = String(values.model || environment.CHATUI_EVAL_ROUTE_MODEL || '').trim();
  if (!baseUrl || !apiKey || !model) {
    throw new Error('Route-model credentials are required. Set --base-url, --api-key, and --model (or CHATUI_EVAL_* variables).');
  }
  return {
    baseUrl,
    apiKey,
    model,
    fixture: path.resolve(values.fixture || environment.CHATUI_EVAL_FIXTURE || DEFAULT_FIXTURE),
    output: values.output ? path.resolve(values.output) : '',
    timeoutMs: numberOption(values.timeoutMs || environment.CHATUI_EVAL_TIMEOUT_MS || 30000, '--timeout-ms', { min: 1000, max: 300000, integer: true }),
    limit: values.limit ? numberOption(values.limit, '--limit', { min: 1, max: 10000, integer: true }) : 0,
    minScore: numberOption(values.minScore || environment.CHATUI_EVAL_MIN_SCORE || 90, '--min-score', { min: 0, max: 100 }),
    minValidContract: numberOption(values.minValidContract || environment.CHATUI_EVAL_MIN_VALID_CONTRACT || 100, '--min-valid-contract', { min: 0, max: 100 }),
    noWrite: !!values.noWrite,
  };
}

function endpointFor(baseUrl = '') {
  const normalized = String(baseUrl).trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(normalized)) throw new Error('--base-url must start with http:// or https://.');
  return `${normalized}/chat/completions`;
}

function safeBaseUrl(baseUrl = '') {
  try {
    const parsed = new URL(baseUrl);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname.replace(/\/$/, '')}`;
  } catch {
    return String(baseUrl || '').replace(/\/[^/]*@/, '/[redacted]@');
  }
}

function redactErrorMessage(error, apiKey = '') {
  let message = String(error?.message || error || 'Unknown route-model error');
  if (apiKey) message = message.split(String(apiKey)).join('[redacted]');
  return message
    .replace(/(https?:\/\/)[^/\s@]+@/gi, '$1[redacted]@')
    .slice(0, 240);
}

function defaultOutputPath() {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join(ROOT, 'reports', 'intent-routing', `intent-routing-eval-${timestamp}.json`);
}

async function requestRouteModel({ endpoint, apiKey, payload, timeoutMs }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Route model returned HTTP ${response.status}.`);
    let body;
    try {
      body = await response.json();
    } catch {
      throw new Error('Route model returned invalid JSON.');
    }
    const text = String(routeService.extractRouteText(body) || '').trim();
    if (!text) throw new Error('Route model returned an empty decision.');
    return text;
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`Route model request timed out after ${timeoutMs}ms.`);
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function formatCaseResult(result = {}) {
  const reasons = [...(result.failure_reasons || []), ...(result.transport_error ? ['transport_error'] : [])];
  return `[${result.perfect ? 'PASS' : 'FAIL'}] ${result.id} | ${Number(result.score || 0).toFixed(1)} | ${reasons.join(', ') || 'all checks passed'}`;
}

function qualityGate(summary = {}, options = {}) {
  const averageScore = Number(summary.average_score) || 0;
  const validContractRate = Number(summary.dimension_accuracy?.valid_contract) || 0;
  return {
    passed: averageScore >= options.minScore && validContractRate >= options.minValidContract,
    average_score: averageScore,
    valid_contract_rate: validContractRate,
    min_score: options.minScore,
    min_valid_contract: options.minValidContract,
  };
}

async function runEvaluation(options, { requestRoute = requestRouteModel, log = console.log } = {}) {
  const { filePath, suite } = loadFixtureSuite(options.fixture);
  const cases = options.limit ? suite.cases.slice(0, options.limit) : suite.cases;
  const endpoint = endpointFor(options.baseUrl);
  const results = [];

  for (const caseDefinition of cases) {
    let result;
    try {
      const payload = routeService.buildRoutePayload({
        model: options.model,
        input: caseDefinition.input,
        attachments: caseDefinition.attachments,
        context: caseDefinition.context,
      });
      const rawText = await requestRoute({ endpoint, apiKey: options.apiKey, payload, timeoutMs: options.timeoutMs });
      result = evaluateRouteText(caseDefinition, rawText);
    } catch (error) {
      result = scoreRouteCase(caseDefinition, null);
      result.transport_error = redactErrorMessage(error, options.apiKey);
    }
    results.push(result);
    log(formatCaseResult(result));
  }

  const summary = summarizeCaseScores(results);
  const gate = qualityGate(summary, options);
  const report = {
    schema_version: SCHEMA_VERSION,
    generated_at: new Date().toISOString(),
    fixture: path.relative(ROOT, filePath).replace(/\\/g, '/'),
    model: options.model,
    base_url: safeBaseUrl(options.baseUrl),
    summary,
    quality_gate: gate,
    cases: results,
  };
  const output = options.output || defaultOutputPath();
  if (!options.noWrite) {
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    log(`Intent-routing evaluation report: ${output}`);
  }
  log(`Intent-routing score: ${summary.average_score}/100; valid contracts: ${summary.dimension_accuracy.valid_contract}%; gate: ${gate.passed ? 'PASS' : 'FAIL'}.`);
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
  redactErrorMessage,
  defaultOutputPath,
  requestRouteModel,
  qualityGate,
  runEvaluation,
};
