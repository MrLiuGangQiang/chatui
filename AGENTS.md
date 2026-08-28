# Repository Guidelines

> ChatUI is a no-build Node.js + browser single-page app with an OpenAI-compatible proxy (chat, image generation/edit, attachments, Markdown, sessions, jobs, usage stats). `docs/architecture.md` is the authoritative module-boundary document; this file is the compact rulebook. Follow it without waiting to be reminded.

## Design documentation (normative)

- `docs/design/` is the normative specification: 00 index, 01 principles/constraints, 02 architecture and module boundaries, 03 data and persistence, 04 API contracts, 05 security, 06 engineering rules, 07 testing and quality gates, 08 release and operations, 09 evolution boundaries.
- Read the relevant design doc before implementing. Changes that affect architecture, data/protocols, API, security, release behavior, or user-visible behavior must update the matching `docs/design/` document (and deep-dive docs such as `docs/architecture.md` or `docs/development.md`) in the same change.
- New features start with `docs/design/NN-<feature>-设计.md` following the 00 template (scope, flow/state, contracts, security, acceptance criteria, regression tests). Implementation begins only after the design gate.

## Hard rules

- `version.json` is the only version source. `package.json` and `package-lock.json` are npm mirrors; run `npm run release:prepare`, never hand-edit versions.
- There is no build step. `server/http/static.js` composes `/assets/chatui.bundle.js|css` at request time from the `chatuiAssetManifest` in `index.html`.
- Root static entries are protected: `index.html`, `pages/route.html`, `pages/files.html`, `app.js`, `styles.css`, `favicon.svg`, `server.js`. Change them only together with the static server, Docker image, tests, and documentation.
- Intent routing fails closed. When the intent model output is invalid, never fall back to local keyword routing; classify `transient_error`, `configuration_error`, `invalid_model_output`, and `cancelled` honestly, and never present a configuration/network error as a clarification.
- User-facing error copy must be plain and actionable. Internal diagnostics and codes belong in logs, not in the message bubble. Example: `AI 没理解这条请求，请重试；如果还无法理解，请切换更强模型。` - never `意图模型返回了无效的任务结构`.
- Bundle cache policy: only requests whose `?v=` equals the current content fingerprint may receive `public, max-age=31536000, immutable`; bare URLs and mismatched revisions keep `no-store`. The entry HTML always stays `no-store`.
- Every fix must ship its own regression gate: a test that fails without the fix and passes with it, wired into `npm run check` and CI.
- Never commit generated reports, logs, local editor state, or secrets. `temp/` is ignored and holds runtime logs and pid files only.

## Project structure

```text
client/core/      browser-independent domain rules and stable primitives (no DOM, no network, no server deps)
client/services/  API calls, payload composition, routing services
client/ui/        DOM rendering and interaction helpers
client/features/  user-facing feature modules
client/app/       application state and workflow orchestration
server/api/       HTTP route dispatch and controllers
server/services/  server use cases and external integrations
server/jobs/      managed chat/image job lifecycle
server/http/      body, response, and static-file helpers
server/proxy/ security/ usage/ db/ validators/ logging/ config/
shared/           code safe for both browser and server only
vendor/           checked-in third-party browser assets
test/unit/ test/smoke/ test/fixtures/ test/run-tests.js
docs/ pages/ config/public.json
```

## Dependency direction rules

Forbidden:

- `shared -> client` or `shared -> server`
- `client -> server`, database, SQL, or Node-only runtime
- `server -> client/app`, `client/ui`, or browser globals
- `client/core -> client/services`, DOM, or network
- `client/services -> client/ui` or application session state
- `client/ui -> server payload/proxy implementation`
- `vendor -> application code`
- new business logic in root `app.js`
- server-only data or credentials in static public directories

Allowed: server and browser layers may depend on `shared/`; high-level orchestration may depend on lower-level contracts, never the reverse.

## Build, test, and development commands

- `npm ci` - install locked dependencies (Node >= 20.19.0; `.nvmrc` and Docker use 22).
- `npm start` - run locally on port 8765. Do not change the port.
- `npm run check` - full gate: project checks, architecture checks, syntax checks, and all tests. Run after every change.
- `npm test -- <path-or-fragment>` - focused tests, e.g. `npm test -- server-hardening`.
- `node test/run-tests.js <file>` - invoke the custom runner directly. Never run a suite file directly as test evidence.
- `npm run eval:intent` - run the intent-routing evaluation.
- `npm run release:prepare` - increment the version, sync npm mirrors, create release notes.
- `npm run preview:release` - run checks and a release preview (requires Docker).

## Coding style and naming

- UTF-8, LF line endings, two-space indentation, final newline.
- Small modules with one responsibility; prefer a compatibility facade over a duplicate implementation.
- No new `with (...)` scopes; do not add `window.ChatUI*` exports - use the module registry.
- Never hand-edit minified vendor files.
- Keep comments focused on non-obvious constraints and decisions.
- Test files end in `.test.js`; test functions are named `test<ObservedBehavior>`.

## Testing guidelines

- The custom runner (`test/run-tests.js`) is the only standard test entry point.
- New tests go in `test/unit/` or `test/smoke/`; do not grow `test/legacy/` unless preserving an existing regression.
- Name tests after observable behavior. Prefer calling real exported functions and asserting results; use source-string assertions only for frozen wiring.
- Tests that assert on log files must `await logger.flush()` before reading.
- Every suite must export a non-empty array of named `test*` functions.

## Commit and pull request guidelines

- Prefixes used in history: `feat:`, `fix:`, `perf:`, `refactor:`, `chore:`, and `release: vX.Y.Z ...`.
- Make the smallest change that solves the problem; identify and verify the root cause, never mask symptoms.
- Run `npm run check` before opening a pull request; keep package scripts, CI, Docker validation, tests, and documentation aligned.
- A fix PR must include its dedicated regression test and be based on a clean workspace against current `origin/main`.

## Security and configuration tips

- Local private configuration goes in root `.env.local` (git-ignored). It only fills missing variables and never overrides deployed environment variables; never force-commit it.
- Never place credentials, SQL, or server-only data in `shared/`, static public directories, or `vendor/`.
- Logs must redact API keys, auth headers, file/image base64, and signed URL query parameters. Request-trace bodies may contain user text and must never be committed or attached to releases.
- `config/public.json` is a read placeholder exposed through `/api/config/public`; keep it valid JSON.

## Release procedure

When the user asks to **commit and release** (for example, "commit and release"), complete the entire release process; pushing a Git tag by itself is not a completed release.

1. Work from one clean committed candidate based on current `origin/main`. Never use results from a dirty workspace or a different worktree as release evidence.
2. Run `npm run release:prepare` to increment the canonical root `version.json`. The command synchronizes the npm-required `package.json` and `package-lock.json` mirror fields and creates the matching release-notes file; never choose a release version manually.
3. Complete `docs/releases/vMAJOR.MINOR.PATCH.md` in the same candidate commit with a clear title and concise user-facing notes. Release notes must exist in the tagged commit.
4. Run `npm run check`. When Docker is available locally, also run `npm run preview:release`; otherwise the exact-container CI check on the pushed commit must succeed before tagging. Do not release if either check fails.
5. Commit the release changes and push the release commit to `main`. Wait for required main CI checks, including `Exact Docker runtime`, to succeed.
6. Create an **annotated** `vMAJOR.MINOR.PATCH` Git tag on that exact verified main commit and push it. This triggers the Docker publishing workflow.
7. The workflow must build immutable candidate images with the commit SHA and runtime source fingerprint, start and verify the candidate by digest, and only then promote that same digest to the semantic-version, `v`-prefixed, and `latest` tags. Never rebuild between verification and promotion.
8. Create or verify a published (not draft) **GitHub Release** for the same tag from the release-notes file. Do not treat a tag as a substitute for a GitHub Release.
9. Verify all conditions before reporting the release as complete:
   - the GitHub Release exists and is published;
   - the tag-triggered Docker publishing workflow completed successfully.
   - Docker Hub and ACR version tags resolve to the verified candidate digest;
   - the workflow's `/api/version` check matched version, Git SHA, and runtime source fingerprint.
10. Report the exact version, commit, tag, GitHub Release status, verified image digest, Docker workflow result, and any remaining deployment action. If verification is still running, explicitly say the release is in progress rather than complete.

For a hotfix that only repairs packaging or deployment, still follow the complete procedure above, including the GitHub Release and Docker workflow verification.

## Local server port policy

- ChatUI local development and manual test servers must always use port `8765`.
- Never switch to another port automatically (including when `8765` is occupied).
- Before starting a server, inspect the process listening on `8765`; if it is occupied, report the owning process and resolve or reuse that instance instead of starting a server on a different port.
- Do not stop an existing `8765` listener unless it is verified to be the ChatUI instance in this workspace or the user explicitly asks to stop it.

## Engineering standards

- Every problem fix must identify and verify the root cause, then correct the underlying logic at the appropriate architectural layer. Symptom masking, special-case bypasses, and patchwork fixes are not acceptable.
- Every fixed problem must have its own explicit quality gate that prevents recurrence. Add a dedicated automated regression test or deterministic validation for that exact failure mode, prove that it fails without the fix and passes with the fix, and wire it into `npm run check` and CI. A fix is not complete without its corresponding quality gate.
- Keep browser, server, and shared-code boundaries described in `docs/architecture.md`.
- Preserve root static-entry assets unless the static server, Docker image, tests, and documentation are updated together.
- Add new tests to `test/unit/` or `test/smoke/`; do not expand `test/legacy/` unless preserving an existing regression.
- Keep package scripts, CI, Docker validation, and documentation aligned. Run `npm run check` after changes.
- Do not commit generated reports, logs, local editor state, or secrets.
