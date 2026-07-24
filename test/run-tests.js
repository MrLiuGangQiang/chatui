'use strict';

const tests = [
  ...require('./legacy/regression.test'),
  ...require('./unit/session-attachment-isolation.test'),
  ...require('./unit/markdown-dependency-loader-entry.test'),
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
