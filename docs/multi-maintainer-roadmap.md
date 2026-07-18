# Multi-maintainer modernization roadmap

## Objective

Make ChatUI safe for parallel, long-term maintenance without rewriting the product or breaking the root static-entry and Docker deployment contracts.

## Milestones

### M0: Collaboration foundation

- Add pull-request and `main` CI.
- Validate Node.js 20.19 and Node.js 22.
- Build the Docker image on every pull request.
- Add `CODEOWNERS` and a pull-request checklist.
- Freeze growth of root `app.js`, legacy `with` scopes, and browser global exports.

Exit criteria: every change is automatically checked and legacy composition debt cannot increase unnoticed.

### M1: Canonical session task state

- Add a pure task-state reducer under `client/core/`.
- Define accepted, capturing, routing, handoff, running, recovering, stopping, completed, failed, and stopped transitions.
- Derive send/stop UI state from the canonical task phase.
- Migrate submit, chat, image, recovery, and stop workflows in that order.
- Preserve the current pending-submit, managed-job, and canonical-snapshot durability chain.

Exit criteria: workflows no longer update busy UI independently, and stale completion cannot clear a newer task.

### M2: Shrink the browser composition root

- Remove the duplicated submit-workflow implementation from root `app.js`.
- Introduce a browser composition root with grouped service interfaces.
- Move remaining business logic from root `app.js` into owning modules.
- Remove `with (deps)` one workflow at a time.

Exit criteria: root `app.js` contains startup and composition only and is below 50 KB.

### M3: Explicit modules and generated assets

- Introduce ES module source entry points and a minimal deterministic build.
- Generate the compatibility `app.js` entry rather than editing it manually.
- Replace manual `?v=` updates with content-hashed assets and a generated manifest.
- Keep legacy asset paths available during a compatibility window.

Exit criteria: browser dependency order and cache versions are generated rather than maintained by hand.

### M4: Test-system modernization

- Make unit and smoke tests independently runnable.
- Migrate to the Node.js test runner or an equivalent structured runner.
- Split `test/legacy/regression.test.js` by feature.
- Replace implementation-string assertions with behavior tests.
- Add a small browser integration suite for submit, completion, recovery, session switch, and stop.

Exit criteria: legacy regression aggregation is below 500 lines and critical task-state modules have strong branch coverage.

### M5: Security and observability

- Make API-key persistence opt-in and default to tab-scoped storage.
- Support server-managed upstream credentials for managed deployments.
- Add structured request, submission, job, and task-transition identifiers.
- Reduce inline script allowances and runtime CDN dependencies where practical.

### M6: Multi-instance jobs, when required

- Extract a JobStore interface.
- Keep the current memory implementation for single-instance deployments.
- Add Redis or PostgreSQL-backed job state and cross-instance event delivery only when horizontal scaling is required.

## Delivery rules

- One workflow migration per pull request.
- Avoid repository-wide formatting changes.
- Keep generated and handwritten changes separate in review.
- Every milestone remains independently releasable.
- Architecture baseline increases require an ADR update and explicit owner approval.
