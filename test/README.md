# Test layout

- `unit/`: focused, importable unit and contract suites. Each file exports an array of test functions.
- `smoke/`: black-box HTTP and static-asset coverage against a started server.
- `legacy/`: regression coverage that has not yet been split into focused feature suites.
- `run-tests.js`: the Node.js test entry point used by `npm test` and CI. It recursively discovers suites in deterministic `unit`, `smoke`, then `legacy` order; rejects empty or malformed suites and duplicate test names; and fails tests that exceed `CHATUI_TEST_TIMEOUT_MS` (30 seconds by default).

New tests should be added to `unit/` or `smoke/`. When changing an existing legacy test substantially, move it into the closest focused suite instead of expanding `legacy/regression.test.js`.

Run one file through the same runner with `npm test -- unit/example.test.js`. Do not use `node test/unit/example.test.js`: suite files export test functions and intentionally do not execute themselves.
