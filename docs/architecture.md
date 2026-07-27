# Architecture

## Runtime entry points

ChatUI deliberately keeps a small set of browser entry assets at the repository root:

- `index.html`: primary application shell.
- `route.html`: task-routing diagram loaded in the modal iframe.
- `app.js` and `styles.css`: compatibility entry assets referenced directly by the static page.
- `server.js`: Node.js process entry point.

These files are part of the public static-file contract. Moving or renaming one requires coordinated changes to `index.html`, `server/http/static.js`, the Dockerfile, and tests. `scripts/check-project.js` protects this contract. The static server derives content-addressed revisions for the top-level JS/CSS bundles when it renders `index.html`; bundle URLs therefore change automatically whenever a bundled source file changes.

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

The model-facing router emits the compact `route_decision.v1` semantic protocol, not an execution contract. It decides `operation`, `readiness`, conversation `relation`, candidate keys, semantic roles, explicit changes, and clarification slots. The application owns the candidate catalog and deterministically compiles that decision into the sole executable `task_contract.v5`, copying source/index/id/reference identity from supplied candidates and deriving directive mode, base keys, policy, and audit fields. A parseable `needs_clarification` decision is a terminal orchestration outcome: the application compiles and returns its question without a fallback-model reinterpretation. The application derives API and runtime mode only from a compiled, validated, ready v5 contract. In automatic routing, that mode is state for the current task only and cannot constrain the next request. When automatic routing is explicitly disabled, the application also validates the ready operation against the selected fixed product mode instead of trusting the prompt alone.

`client/services/route-service.js` builds type-local `i*`, `f*`, and `m*` candidate keys. The model may select keys and roles but never authors resource identity or full directive objects. The compiler rejects unknown keys, duplicates, type/role mismatches, illegal clarification choices, and an omitted explicitly quoted text dependency; it never guesses or appends a resource. For a ready single-target image edit, the compiler also applies a fail-closed ambiguity guard: when multiple candidates match the same user description and there is no quoted image, explicit ordinal/name, sole current upload, or prior structured selection, it downgrades to a non-executing clarification containing the exact matching choices. This guard may only remove dispatch authority; it never chooses a different image. `client/core/intent-contract.js` then strictly validates every compiled v5 shape and derives one canonical execution projection. The bounded v4/v5 parser remains only as an in-flight compatibility reader, not a model output protocol. Every selected image, file, and message must still resolve uniquely before execution.

- `standalone` validates a request with no declared historical, quoted, or context resource baseline. It has no base resources or patch operations and cannot inherit historical prompts. Any operation that uses only current-turn resources may retain its real discourse relation (`followup`, `correction`, or `continuation`) without becoming a patch; relation is conversation metadata, not a resource baseline.
- `patch` validates the declared base resources and records only explicit `preserve`, `add`, `replace`, and `remove` changes. `unmentioned_policy` is audit evidence; it never rewrites the model-facing prompt.

The context boundary is mandatory: relation `new` may reference only current-turn resources, and every declared historical, quoted, or context resource must identify its patch base explicitly regardless of relation. Current-turn image/file questions and text generation remain standalone even when their discourse relation is follow-up, correction, or continuation. Image edits and reference-image generation always identify all input bases. Combining existing images into a new composition is reference-image generation, with every input image using a reference role; `edit_image` accepts exactly one target image and at most one mask. An ambiguous edit target therefore requires one explicit candidate choice and never offers an "all" selection. Asking to reverse-engineer, recover, extract, or write a prompt from an image is an `image_qa` text-output task, never reference-image generation merely because the instruction says “generate a prompt.” The first `route_decision.v1` is authoritative for semantics: the compiler validates and mechanically maps its operation, relation, readiness, bindings, changes, constraints, and clarification without adding, removing, or rewriting any of them. Invalid decisions fail validation instead of being converted into a different local decision. Prompt composition is deterministic and does not accept a router-authored replacement prompt. Message-backed `text_to_image` prepends exactly the messages selected by the first route; the route must therefore leave `bindings=[]` for a self-contained follow-up such as “再画一只狗，换个品种”, while an incomplete or explicitly referential request must bind its context itself. Reference-image generation sends its selected images as media and forwards the user's natural request directly, rather than serializing internal patch labels such as “补丁基线” into the image prompt. Execution prompts are never silently shortened; the complete input is preserved behind the same explicit 120,000-character preflight limit used by submission. This prevents an unrelated request such as “画一条鱼” from inheriting a previous cat-generation prompt, prevents repeated generation verbs from producing duplicate subjects, prevents hidden tail loss, and keeps local image edits from acquiring unrelated historical style text.

### Candidate binding, contract repair, and cancellation

Before an image, file, or message resource can execute, the parser resolves it to exactly one supplied candidate. Opaque image/file IDs are the stable identity; indexes are presentation coordinates owned by the current candidate table. When a declared ID identifies exactly one candidate, its optional reference ID agrees, and the declared source preserves the same context boundary, the runtime replaces only the stale display index and any attachment-ID alias with canonical candidate data. Without a stable ID, source and index must already identify exactly one candidate. Conflicting IDs, source changes, or non-unique reference IDs fail closed. An explicitly quoted image is the sole media source alias: a route result may describe that exact `quoted` candidate as `history`, while execution retains the `quoted` source; this alias requires an explicit UI quote and never applies to ordinary history, current, or context resources. Quoted message resources have the analogous exact history/quote binding. Execution always uses the canonical candidate's real source index, identity, and message body. In mixed attachment batches, `attachments.index`/`source_index` preserve the original upload position while `media_index` is the type-local image or file number used by `resources.index`. Image and file indexes remain separate (`selectedImageIndexes` and `selectedFileIndexes`); the legacy `selectedIndexes` field contains images only.

Clarification is a successful non-executing readiness state, not a separate operation and not a contract failure. The real or provisional operation stays visible for audit, but it cannot authorize dispatch. Concrete usable resources remain in `resources`; unresolved slots live in `clarification.unresolved_resources` and never use fabricated `index: 0` or `missing: true` bindings. An ambiguous slot contains two or more concrete choices copied from the supplied candidate set, while a missing resource has no choices. An attachment explicitly marked `has_extracted_text=false` or carrying an `unsupported_reason` is represented as `reason=unavailable`, is excluded from executable resources and choices, and requires a replacement upload when the task depends on it. Attachment-only turns and cross-API multi-task turns use a missing text-source slot so the router asks for one executable instruction instead of guessing or partially executing.

Image ambiguity choices remain structured data and are never concatenated into the customer-facing question. `client/features/clarification/presentation.js` resolves their stable image IDs against canonical session media and renders a numbered thumbnail list. The canonical assistant record keeps a plain-text question plus durable `indexeddb://` thumbnail references, so refresh and session switching restore the same visual choices without persisting blob URLs or exposing route metadata labels.

The follow-up classifier emits only `pending_continuation.v4`: relationship, a complete natural-language `resolved_input`, validated choice evidence, and optional non-executing assistance. It cannot emit an operation, API, runtime mode, final prompt, media indexes, or dispatch authorization. Resource choice language is kept out of `resolved_input`: ordinals, candidate labels, filenames, and similar wording that only identifies an external candidate remain in `selections`, while the resolved request refers to that bound resource neutrally as the current image/file or omits the reference. This prevents a choice such as “the second image” from being reinterpreted as an internal grid cell or image region by the execution model. Every merged answer—including a structured resource choice—returns through the complete task router with `clarification_context.v1`. Earlier pending attachments keep their historical or contextual source; only attachments uploaded in the answering turn are `current`.

If the router declared clarification but its structured choices cannot be retained safely, the customer still receives the router's original question. The invalid structure is never persisted as an executable contract; the pending state instead records a mandatory reroute policy. After the customer answers, the combined request returns through canonical intent routing. A continuation classifier may merge the text but cannot directly select an execution API for this degraded path.

Route responses request strict JSON-Schema output for `route_decision.v1`. Gateways that reject JSON Schema may retry only with `response_format={"type":"json_object"}` for the same compact protocol; routing never silently removes the machine-readable response requirement. If a ready decision still fails validation, the same model may receive one bounded format repair whose operation, relation, readiness, selected candidate keys/roles, and unresolved-slot semantics are immutable. Repair cannot add a missing resource or change intent. A distinct chat model is used only after that bounded repair fails. Missing semantic fingerprints, oversized output, invented candidates, or semantic drift fail closed. Once a parseable decision declares `needs_clarification`, the turn terminates before repair and fallback.

Continuation classification, structured-output compatibility retries, primary routing, repair, and fallback routing share one 60-second absolute intent-pipeline deadline. No retry receives a fresh timeout window, and no fallback starts after expiry. Timeout or cancellation aborts the active request and cannot produce a formal dispatch.

`image_reference_gen` produces a new composition but consumes one or more image inputs, so its transport is `/images/edits` with multipart image files. Its product mode remains image-generation (alongside `text_to_image`); transport selection must not relabel it as `edit_image`. Pure `text_to_image` alone uses `/images/generations`.

A complete route with unique, resolved resources executes immediately. Confidence and review-reason fields are audit metadata, not a trigger for a second model decision. Every canonical plan carries an application-authored dispatch authorization. A clarification plan has `api=clarify` and no authorization; after the customer answers, only a fresh, fully validated `ready` route can derive an API and create authorization. Submission and regeneration both fail closed if a task contract reaches them without that authorization.

### Intent-routing evaluation

`test/fixtures/intent-routing-eval.v1.json` is the versioned, anonymized regression corpus for routing behavior. `npm run eval:intent` sends it to an explicitly configured route model and scores contract validity, operation, readiness, relation, resource binding, exact clarification slots, and directive mode. Aggregate thresholds cannot hide a dangerous result: every case marked `safety_critical` must score 100. Reports are local ignored artifacts; the fixture and scorer remain reviewable source. See `docs/intent-routing-evaluation.md` for the workflow and quality gates.

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

The M1 canonical task reducer is exposed through the existing `window.ChatUICore` namespace without adding another browser global. The normal submit path emits task events through the shared task-lifecycle controller, and send-button availability prefers the reducer projection over legacy `busy` flags. This makes late cleanup from an older submission a no-op for a newer task. Explicit stop is also owned by the shared lifecycle controller, which synchronously clears pending ownership, enters `stopping`, settles managed-job aborts, and commits `stopped` without allowing a late stop completion to overwrite a newer task. Standalone assistant regeneration and force-image regeneration now run through `client/app/regenerate-workflow.js`: they persist accepted ownership before asynchronous capture, use the same submission and managed-job identity through handoff, and project completion or recovery through canonical task events. Recovery and background-follow workflows remain on the legacy busy fallback until their dedicated M1 migration pull requests.

The browser composition layer registers extracted workflow modules through the existing `ChatUIApp.appContext` registry instead of adding new `window.ChatUI*` globals. Root `app.js` resolves these modules lazily and supplies explicit dependencies.

`app.js` is a composition entry point, not a second business-logic implementation: submission, attachment metadata, and route-resource selection each have one canonical module implementation.

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
