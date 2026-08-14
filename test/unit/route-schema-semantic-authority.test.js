'use strict';

const assert = require('assert');
const routeIntent = require('../../shared/route-intent');

function routeSchema() {
  return routeIntent.ROUTE_INTENT_RESPONSE_FORMAT.json_schema.schema;
}

function testQuotedContentGroundingIsAFirstClassFollowupAndBindingObligation() {
  const schema = routeSchema();
  const relationDescription = schema.properties.relation.description;
  const resourceDescription = schema.properties.resource_refs.description;
  const roleDescription = schema.properties.resource_refs.items.properties.role.description;

  assert.match(relationDescription, /quoted[^.]*followup[^.]*continuation/i,
    'quoted source content must remain a followup even when repeat/continuation wording is present');
  assert.match(`${resourceDescription} ${roleDescription}`, /goal[^.]*quoted[^.]*history[^.]*context/i,
    'message facts copied into goal must retain an explicit context binding');
}

function testMultiTaskGoalPreservesEveryRequestedStepInsteadOfOnlyTheFirstOperation() {
  const description = routeSchema().properties.goal.description;
  assert.match(description, /task_shape[^.]*multi[^.]*all[^.]*tasks/i,
    'the goal field must retain all explicit tasks for a multi route');
  assert.match(description, /operation[^.]*first[^.]*never[^.]*drop/i,
    'selecting the first operation must not erase later requested tasks from goal');
}

module.exports = [
  testQuotedContentGroundingIsAFirstClassFollowupAndBindingObligation,
  testMultiTaskGoalPreservesEveryRequestedStepInsteadOfOnlyTheFirstOperation,
];