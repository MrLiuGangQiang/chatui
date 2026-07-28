# Architecture modernization plan

## Purpose and operating rules

This is an incremental modernization plan for ChatUI. It preserves the static root-entry contract, Docker deployment path, browser behavior, and durable task-recovery chain. A change is accepted only when its focused tests and `npm run check` pass. No phase raises the existing architecture baseline simply to admit new debt.

## Baseline assessment — 2026-07-25

| Area | Problem | Why it matters | Evidence |
| --- | --- | --- | --- |
| Browser composition | The legacy root composition and workflows communicate through a large browser-global namespace. | Dependencies are implicit, making load order and refactoring harder to reason about. | 184 `ChatUI*` exports before this work; root `app.js` is 164 KB. |
| Legacy workflow code | Several workflows still use `with (deps)`. | Tooling cannot reliably identify dependencies and accidental coupling is easy. | 76 recorded legacy scopes. |
| Test organization | The regression aggregator is large. | Focused ownership and failure diagnosis get harder as it grows. | `test/legacy/regression.test.js` has 3,444 lines. |
| Dependencies | `chrome-remote-interface` is declared but unused. | It increases the install surface and supply-chain maintenance burden. | No production code, test, or script imports it. |

## Delivery plan

### Phase 1 — remove confirmed dead dependency and global coupling

**Change:** Remove `chrome-remote-interface`. Register the history-anchor navigation, web-preview, message-rendering, and self-initializing route-diagram features through `ChatUIApp.appContext` and make their consumers resolve explicit registry entries.

**Why this first:** The feature is self-contained and has three known consumers. It exercises the target composition pattern without affecting task execution or storage.

**Verification:** Unit-test registry laziness and feature registration; verify the legacy global is absent; lower the global-export ceiling; run the complete project check.

### Phase 2 — shrink root browser composition

**Change:** Migrate one self-contained workflow at a time out of root `app.js`; expose a factory with an explicit dependency object; keep the root file as startup and composition glue only.

**Prerequisite:** Establish the deterministic source-to-compatibility build from Phase 4 before editing the one-line compressed compatibility artifact. This keeps each extraction reviewable and preserves the root static-entry contract.

**Success criterion:** `app.js` is below 50 KB, and every removed proxy has behavior tests before removal.

**Verification:** Workflow unit tests, static-bundle smoke tests, and `npm run check` for each migration.

### Phase 3 — remove legacy dependency scopes

**Change:** Replace each `with (deps)` block with a named dependency interface, beginning with the smallest workflow.

**Why:** Explicit dependencies make ownership, test seams, and safe code search reliable.

**Verification:** Add a focused test for each factory contract; decrease the recorded scope count; never raise the baseline.

### Phase 4 — deterministic browser asset build

**Change:** Introduce ES-module source entry points and a minimal deterministic build that produces the current compatibility paths. Replace manually edited cache query versions with a generated content-hashed manifest.

**Guardrail:** Retain root entry paths until the static server, Docker image, documentation, and smoke tests are migrated together.

**Verification:** Build reproducibility test, static-bundle smoke test, Docker build, and browser launch smoke test.

### Phase 5 — test-suite decomposition

**Change:** Move one behavior-focused group at a time from `test/legacy/` into `test/unit/` or `test/smoke/`; replace source-string assertions with observable behavior where practical.

**Success criterion:** The legacy aggregator is below 500 lines and each critical task transition has an independently runnable test.

**Verification:** Test the moved unit directly, run the complete suite, then remove only the corresponding legacy coverage.

## Phase 3 progress

- Status: in progress. The baseline now records 73 legacy scopes, down from 76 at the beginning of this phase; the allowance was reduced rather than moved.
- Problem and cause: `session-panel-workflow`, `media-workflow`, and `bootstrap-workflow` relied on dynamic `with (deps)` lookup, so their required collaborators were hidden from static analysis and from focused tests.
- Change: all three factories now bind their collaborators explicitly. The session-panel workflow names its UI/session dependencies; the media workflow names its storage, browser, timer, network, state, and error-handling dependencies; the bootstrap workflow names its UI/event/startup collaborators and retains only compatibility fallbacks required by the current root entry point.
- Verification: unit tests cover panel saving, ARIA visibility, focus/timer binding, media object-URL restoration, attachment preservation, injected timer cleanup, and bootstrap event wiring. The architecture guard rejects reintroducing a removed scope and rejects a stale allowance after a scope is removed. `npm run check` must pass for every tranche.
- Next target: another single-scope workflow only after its dependency boundary and behavior tests are identified; multi-scope task-execution workflows remain later because their cancellation and recovery lifecycles have higher regression risk.

## Phase 1 record

- Status: complete. The full project check and the independently discovered suite pass.
- Expected global exports: 184 to 164. Each migrated feature was registered on both `root` and `root.window`; neither now adds a standalone browser global. The message workflow also no longer creates an extra model global during CommonJS fallback.
- Test discovery: `test/run-tests.js` now loads all immediate `legacy/`, `unit/`, and `smoke/` suites in a deterministic order. The legacy aggregator no longer imports or executes unit/smoke suites, reducing it from 3,444 to 3,350 lines.
- Architectural risk: low; the migrated features retain their public APIs and change only browser-module registration and lookup.
- Rollback: restore each feature's previous global registration and its corresponding consumer lookup as an atomic revert.
