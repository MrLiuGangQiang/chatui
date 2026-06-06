#!/usr/bin/env node
const assert = require('assert');
const fs = require('fs');

const workflow = fs.readFileSync('client/app/bootstrap-workflow.js', 'utf8');
const app = fs.readFileSync('app.js', 'utf8');
const html = fs.readFileSync('index.html', 'utf8');

assert(workflow.includes('createBootstrapWorkflow'), 'bootstrap workflow factory should exist');
assert(workflow.includes('function start()'), 'bootstrap workflow should expose start');
assert(workflow.includes('["baseUrl","apiKey","chatModel","routeModel","imageModel","imageSize"].forEach'), 'startup config bindings should live in bootstrap workflow');
assert(workflow.includes('Promise.resolve().then(()=>waitForMarkdownReady())'), 'startup render sequence should live in bootstrap workflow');
assert(workflow.includes('refreshActiveSessionOnReturn'), 'foreground refresh bindings should live in bootstrap workflow');
assert(
  workflow.includes('(window.requestAnimationFrame||requestAnimationFrame).call(window,'),
  'bootstrap workflow must invoke requestAnimationFrame with the window receiver to avoid Chrome Illegal invocation',
);
assert(app.includes('getBootstrapWorkflow().start()'), 'app.js should delegate startup to bootstrap workflow');
assert(!app.includes('["baseUrl","apiKey","chatModel","routeModel","imageModel","imageSize"].forEach'), 'app.js should not keep the startup binding block');
assert(html.indexOf('client/app/bootstrap-workflow.js') > -1, 'index should load bootstrap workflow');
assert(html.indexOf('client/app/bootstrap-workflow.js') < html.indexOf('./app.js'), 'bootstrap workflow must load before app.js');
console.log('app bootstrap workflow ok');
