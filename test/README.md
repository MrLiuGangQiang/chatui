# Test layout

- `unit/`: focused, importable unit and contract suites. Each file exports an array of test functions.
- `smoke/`: black-box HTTP and static-asset coverage against a started server.
- `legacy/`: regression coverage that has not yet been split into focused feature suites.
- `run-tests.js`: the small Node.js test entry point used by `npm test` and CI.

New tests should be added to `unit/` or `smoke/`. When changing an existing legacy test substantially, move it into the closest focused suite instead of expanding `legacy/regression.test.js`.

## Running tests

Test files export arrays and are not standalone executables. Run all or focused suites through the runner:

```bash
node test/run-tests.js
node test/run-tests.js unit/server-hardening.test.js
node test/run-tests.js smoke
node test/run-tests.js --list
node test/run-tests.js unit/usage --timeout=20000
```

Discovery is recursive below each test layer. An unmatched filter, empty suite, unnamed entry, duplicate test name, declared-but-unexported `test*` function declaration or assigned function, timeout, or assertion failure exits non-zero. The runner snapshots and restores global own-property descriptors around every test so browser mocks cannot leak into later cases; a new non-configurable global fails cleanup. A timed-out promise or synchronous event-loop block cannot be forcibly cancelled by the current in-process runner, so tests must still clean up servers, timers, JSDOM windows, and other asynchronous resources in `finally` blocks.

Prefer behavior and observable contracts over source substring assertions. Static assertions are appropriate for a small number of packaging, architecture, and forbidden-code invariants, but they do not prove that a user flow executes successfully. Real browser, database, Docker, or credential-backed checks should be placed in the documented smoke/CI layer rather than silently skipped inside deterministic unit suites.
