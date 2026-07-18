# ADR 0001: Multi-maintainer engineering foundation

- Status: Accepted
- Date: 2026-07-18

## Context

ChatUI is moving from a primarily single-maintainer workflow to long-term multi-maintainer development. The runtime is stable and has strong durable-task recovery, but browser composition still depends on a large root `app.js`, legacy `with (deps)` scopes, and a broad global `ChatUI*` namespace. Before deeper refactoring, the repository needs mandatory automated checks and guardrails that prevent these legacy characteristics from expanding.

## Decision

1. Pull requests and pushes to `main` run the complete project check on Node.js 20.19 and Node.js 22.
2. Pull requests also build the production Docker image without publishing it.
3. `CODEOWNERS` and the pull-request template identify architecture-sensitive changes and required verification.
4. Root `app.js` is frozen at its current byte budget. New business logic belongs in an owning module under `client/`, `server/`, or `shared/`.
5. Existing `with (...)` scopes are recorded as legacy allowances. New files cannot introduce them, and existing files cannot increase their count.
6. Browser `ChatUI*` global exports cannot grow beyond the recorded baseline. New composition should move toward explicit module dependencies.
7. The root static-entry contract remains intact throughout the migration.

## Consequences

- Architecture debt becomes measurable and can only stay level or decrease.
- Some legitimate compatibility changes may require first extracting code from `app.js` or reducing another legacy dependency.
- Updating an architecture baseline requires explicit review and an ADR amendment; it must not be used to bypass a failed check casually.
- This decision does not introduce a frontend framework. ES modules or a minimal bundler will be evaluated in a later milestone.
