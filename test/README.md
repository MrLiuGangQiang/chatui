# Test layout

- `unit/`: focused, importable unit and contract suites. Each file exports an array of test functions.
- `smoke/`: black-box HTTP and static-asset coverage against a started server.
- `legacy/`: regression coverage that has not yet been split into focused feature suites.
- `run-tests.js`: the small Node.js test entry point used by `npm test` and CI.

New tests should be added to `unit/` or `smoke/`. When changing an existing legacy test substantially, move it into the closest focused suite instead of expanding `legacy/regression.test.js`.
