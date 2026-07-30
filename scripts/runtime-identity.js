#!/usr/bin/env node
'use strict';

const path = require('path');
const { createBuildIdentity } = require('../server/build-identity');
const { readVersion } = require('./version-source');

const root = path.resolve(__dirname, '..');
const identity = createBuildIdentity({ root, version: readVersion({ root }) });

if (require.main === module) {
  if (process.argv.includes('--source-only')) process.stdout.write(identity.sourceRevision);
  else process.stdout.write(`${JSON.stringify(identity)}\n`);
}

module.exports = { root, identity };
