#!/usr/bin/env node
'use strict';

const path = require('path');
const pkg = require('../package.json');
const { createBuildIdentity } = require('../server/build-identity');

const root = path.resolve(__dirname, '..');
const identity = createBuildIdentity({ root, version: pkg.version });

if (require.main === module) {
  if (process.argv.includes('--source-only')) process.stdout.write(identity.sourceRevision);
  else process.stdout.write(`${JSON.stringify(identity)}\n`);
}

module.exports = { root, identity };
