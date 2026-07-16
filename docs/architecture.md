# Architecture

## Runtime entry points

ChatUI deliberately keeps a small set of browser entry assets at the repository root:

- `index.html`: primary application shell.
- `route.html`: task-routing diagram loaded in the modal iframe.
- `app.js` and `styles.css`: compatibility entry assets referenced directly by the static page.
- `server.js`: Node.js process entry point.

These files are part of the public static-file contract. Moving or renaming one requires coordinated changes to `index.html`, `server/http/static.js`, the Dockerfile, and tests. `scripts/check-project.js` protects this contract.

## Application layers

| Area | Responsibility |
| --- | --- |
| `client/core/` | Browser-independent domain rules and normalization. |
| `client/services/` | API access, request construction, and integration adapters. |
| `client/ui/` | DOM-level rendering and interaction utilities. |
| `client/app/` | Application state and workflow orchestration. |
| `server/api/` | HTTP route dispatch and controllers. |
| `server/http/` | HTTP primitives, static serving, request and response helpers. |
| `server/services/` | Server-side use cases and external integrations. |
| `server/jobs/` | Managed chat and image job lifecycle. |
| `server/extract/` | Attachment text extraction. |
| `shared/` | Code intentionally safe for both browser and server contexts. |
| `vendor/` | Checked-in third-party browser assets only. |

## Boundary rules

1. Browser modules must not import Node-only modules.
2. `shared/` must not contain credentials, server-only SQL, filesystem access, or upstream secrets.
3. UI modules render and bind interactions; business decisions belong in `core/`, `services/`, or `app/` workflows.
4. Server routes should delegate to a controller or service instead of embedding large use cases in route dispatch.
5. New source belongs in an existing layer whenever possible; do not add new root-level application files without documenting the static-entry requirement.

## Runtime composition and lifecycle

`server/app.js` is the server composition root. Each `createApp()` call creates an isolated runtime context and injects it into job, proxy, and extraction handlers:

- upstream and extraction concurrency limiters;
- guarded upstream HTTP dispatcher/agent service;
- chat and image job stores, subscriber state, and the job sweeper;
- managed-principal job admission state.

This keeps test instances and future multi-instance embeddings from sharing queue or quota state by accident. The old exports in `server/concurrency.js`, `server/jobs/common.js`, and `server/extract/index.js` remain compatibility adapters for direct callers; new server composition must use the app-scoped dependencies instead.

`createApp()` returns an async `dispose()` method. It stops the sweeper, aborts/clears in-memory jobs, releases admission records, closes owned concurrency queues, shuts down owned Undici dispatchers, and ends the owned PostgreSQL pool. The HTTP server's `close` event invokes the same disposal path. Callers that inject an externally owned pool or runtime service retain responsibility for closing that injected resource.

## Testing layout

- `test/unit/`: focused unit and contract tests.
- `test/smoke/`: black-box server and asset tests.
- `test/legacy/`: regression coverage waiting to be split by feature.
- `test/run-tests.js`: stable test command entry point.

See [development.md](development.md) for commands and contribution workflow.
