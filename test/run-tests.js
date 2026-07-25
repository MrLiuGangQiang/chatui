'use strict';

const fs = require('fs');
const path = require('path');

function loadTestDirectory(directory) {
  return fs.readdirSync(directory, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.test.js'))
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap(entry => {
      const suite = require(path.join(directory, entry.name));
      if (!Array.isArray(suite)) throw new Error(`Test suite ${entry.name} must export an array.`);
      return suite;
    });
}

const tests = [
  ...loadTestDirectory(path.join(__dirname, 'legacy')),
  ...loadTestDirectory(path.join(__dirname, 'unit')),
  ...loadTestDirectory(path.join(__dirname, 'smoke')),
];

async function run() {
  for (const test of tests) {
    await test();
    console.log(`PASS ${test.name}`);
  }
  console.log(`All ${tests.length} tests passed.`);
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
