'use strict';

const assert = require('assert');
const routeService = require('../../client/services/route-service');

function readyRoute(overrides = {}) {
  return {
    operationType: 'plain_chat',
    relation: 'new',
    taskShape: 'single',
    needClarification: false,
    readiness: 'ready',
    dispatchAuthorized: true,
    resources: [],
    ...overrides,
  };
}

function testRouteDecisionRanksSourcesAndReadyRoutes() {
  const primary = routeService.buildRouteDecision(readyRoute(), { source: 'primary_model' });
  assert.strictEqual(primary.confidence, 0.85);
  assert.strictEqual(primary.source, 'primary_model');

  const repair = routeService.buildRouteDecision(readyRoute(), { source: 'primary_repair' });
  assert.strictEqual(repair.confidence, 0.76);

  const fallback = routeService.buildRouteDecision(readyRoute(), { source: 'fallback_model' });
  assert.strictEqual(fallback.confidence, 0.7);

  const deterministic = routeService.buildRouteDecision(readyRoute(), { source: 'multi_task_selector' });
  assert.strictEqual(deterministic.confidence, 0.98);
}

function testRouteDecisionCapsClarificationAndMultiShape() {
  const clarifying = routeService.buildRouteDecision(readyRoute({
    needClarification: true,
    readiness: 'needs_clarification',
    api: 'clarify',
    dispatchAuthorized: false,
  }), { source: 'primary_model' });
  assert.ok(clarifying.confidence <= 0.42, `clarification confidence must be bounded, got ${clarifying.confidence}`);

  const multi = routeService.buildRouteDecision(readyRoute({ taskShape: 'multi' }), { source: 'primary_model' });
  assert.ok(multi.confidence <= 0.78, `multi-task confidence must be bounded, got ${multi.confidence}`);
}

function testRouteDecisionCollectsEvidence() {
  const decision = routeService.buildRouteDecision(readyRoute({
    resources: [{ type: 'image', role: 'source', source: 'quoted', resource_id: 'res:image:i1' }],
  }), {
    source: 'primary_repair',
    context: { quoted_message: { id: 'q1' } },
    understandingShape: { actions: [{ kind: 'image_read' }] },
  });
  assert.ok(decision.evidence.some(item => item.type === 'source' && item.value === 'primary_repair'));
  assert.ok(decision.evidence.some(item => item.type === 'context' && item.value === 'quoted'));
  assert.ok(decision.evidence.some(item => item.type === 'bound_resources' && item.value === 1));
  assert.ok(decision.evidence.some(item => item.type === 'understanding_actions' && item.value === 1));
}

module.exports = [
  testRouteDecisionRanksSourcesAndReadyRoutes,
  testRouteDecisionCapsClarificationAndMultiShape,
  testRouteDecisionCollectsEvidence,
];
