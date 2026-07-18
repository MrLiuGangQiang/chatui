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

## Intent routing contract

The model-facing router accepts exactly one protocol: `task_contract.v2`. The contract contains the canonical intent, task relationship (`new_task`, `followup`, `correction`, or `continuation`), execution API/operation, resources, prompt plan, clarification state, and confidence. Legacy route objects such as `{ "route": "image_generate" }` are rejected rather than adapted.

`client/core/intent-contract.js` validates and normalizes the canonical contract, then projects it into the internal execution route consumed by existing workflows. That projection is an application detail, not a second model protocol. The context boundary is mandatory:

- `new_task` may use only the current user input and current-turn attachments; historical resources and `context_to_preserve` are discarded.
- `followup`, `correction`, and `continuation` may preserve history only when it is explicit in `resources` or `prompt_plan`.

This prevents an unrelated request such as “画一条鱼” from inheriting a previous cat-generation prompt.

## Durable task ownership and recovery

Every submitted task moves through one durable ownership chain:

1. **Pending submission** (`accepted` -> `captured` -> `routing` -> `handoff`) owns the task from the user's click until a restartable managed-job snapshot exists. The accepted record is written before attachment preparation or any other asynchronous work begins.
2. **Managed job** owns chat, Responses API reasoning, image generation, and image editing after its local snapshot contains the complete replay payload and the same `submissionId`/client job id used by the server.
3. **Canonical session snapshot** owns the completed result only after the final assistant message has committed to the session store.

The transition rules are strict:

- A task must always have a recoverable owner. The current owner is cleared only after the successor can independently recover the task.
- Pending submission outranks payload-less display metadata or incomplete local-storage fallbacks. During `handoff`, it yields only to a complete job snapshot whose job id and submission id both match.
- Upstream requests must not start when the browser cannot persist a complete replayable job payload.
- Managed jobs are cleared only after the canonical completion commit succeeds. A failed commit retains the current owner for a later reload/retry.
- Explicit stop and session deletion are terminal: they synchronously clear pending ownership, abort managed jobs, and prevent late asynchronous writes from recreating the deleted/cancelled task. Page leave and unexpected non-user aborts retain ownership.
- Terminal upstream job errors release their job owner after the error is surfaced; transport and polling failures retain it so recovery can retry.
- Active in-memory runs take precedence over storage recovery. This prevents a session switch from starting a duplicate request while the original tab is still executing it.

Session display records are only transient UI projections. They may help rebind a pending bubble, but they are never authoritative without the corresponding pending submission or complete managed-job snapshot. A durable pending submission or managed job must nevertheless project a visible pending display item synchronously, before routing, polling, or the first upstream token, so switching sessions never produces an empty task view.

Canonical history and pending task UI are separate layers. Canonical integrity checks must locate the expected canonical node by role and message/response identity; they must not assume the last DOM node is canonical because a legitimate pending task can follow it. If canonical repair is genuinely required, the pending projection must be restored in the same synchronous render transaction.

Session DOM caching is reserved for sessions with a live or durable task owner. Cache validity is based on canonical history plus the stable pending display identity, not mutable stream text, reasoning, elapsed status, or handoff metadata; those fields reconcile into the existing node when the session becomes active again. Media object URLs remain owned by the media workflow and must not be revoked merely because a detached DOM cache entry is discarded.

Message completion follows the same state-machine rule in the DOM: streaming and pending flags are cleared synchronously, not through `requestAnimationFrame`, because hidden tabs may suspend animation frames and otherwise leave message actions permanently hidden.

The M1 canonical task reducer is exposed through the existing `window.ChatUICore` namespace without adding another browser global. The normal submit path emits task events through the shared task-lifecycle controller, and send-button availability prefers the reducer projection over legacy `busy` flags. This makes late cleanup from an older submission a no-op for a newer task. Standalone regenerate, recovery, and background-follow workflows remain on the legacy busy fallback until their dedicated M1 migration pull requests.

## Multi-maintainer guardrails

The current browser composition is a migration baseline, not a pattern for new code. `scripts/check-architecture.js` enforces the following until explicit modules replace the legacy composition:

- root `app.js` must not grow beyond the recorded budget;
- new or expanded `with (...)` scopes are forbidden;
- browser `ChatUI*` global exports must not increase;
- architecture baseline changes require owner review and an ADR update.

New business logic must be placed in the owning `client/`, `server/`, or `shared/` layer. See [ADR 0001](adr/0001-multi-maintainer-foundation.md) and the [multi-maintainer roadmap](multi-maintainer-roadmap.md).

## Testing layout

- `test/unit/`: focused unit and contract tests.
- `test/smoke/`: black-box server and asset tests.
- `test/legacy/`: regression coverage waiting to be split by feature.
- `test/run-tests.js`: stable test command entry point.

See [development.md](development.md) for commands and contribution workflow.
