'use strict';

const assert = require('assert');
const path = require('path');

const modules = [
  require('../../shared/intent-understanding'),
  require('../../shared/route-intent'),
  require('../../shared/image-plan'),
  require('../../shared/multi-task-plan'),
  require('../../shared/image-instruction'),
  require('../../shared/clarification-answer'),
  require('../../shared/dispatch-contract'),
];

function schemaViolations(node, currentPath) {
  const violations = [];
  if (!node || typeof node !== 'object') return violations;
  if (Array.isArray(node)) {
    node.forEach((item, index) => violations.push(...schemaViolations(item, `${currentPath}[${index}]`)));
    return violations;
  }
  if (node.properties && typeof node.properties === 'object' && node.additionalProperties === false) {
    const properties = Object.keys(node.properties);
    const required = Array.isArray(node.required) ? node.required : [];
    for (const key of properties) {
      if (!required.includes(key)) {
        violations.push(`${currentPath}.properties.${key} must be listed in required`);
      }
    }
  }
  for (const [key, value] of Object.entries(node)) {
    violations.push(...schemaViolations(value, `${currentPath}.${key}`));
  }
  return violations;
}

function testStrictResponseSchemasListEveryPropertyInRequired() {
  const violations = [];
  for (const mod of modules) {
    for (const key of Object.keys(mod)) {
      if (!/RESPONSE_FORMAT/.test(key)) continue;
      const format = mod[key];
      if (!format || !format.json_schema || !format.json_schema.schema) continue;
      violations.push(...schemaViolations(format.json_schema.schema, `${key}.schema`));
    }
  }
  assert.deepStrictEqual(violations, [],
    'OpenAI structured outputs reject schemas where any property is missing from required');
}

module.exports = [testStrictResponseSchemasListEveryPropertyInRequired];
