# Contributing

## Development workflow

1. Install the Node.js version declared in `package.json`.
2. Install locked dependencies with `npm ci`.
3. Make the smallest change that solves the problem.
4. Run `npm run check` before opening a pull request.
5. Keep `package.json` and `package-lock.json` versions aligned for releases.

## Project boundaries

- `client/core/`: browser-independent domain logic.
- `client/services/`: API calls and payload composition.
- `client/ui/`: DOM rendering and interaction helpers.
- `client/app/`: application state and workflow orchestration.
- `server/api/`: HTTP route dispatch and controllers.
- `server/services/`: server use cases and external integrations.
- `server/jobs/`: managed chat and image job lifecycle.
- `server/http/`: HTTP body, response, and static-file helpers.
- `shared/`: code that is intentionally safe for both browser and server use.
- `vendor/`: checked-in third-party browser assets; do not place application code or secrets here.

Do not move server-only data, SQL, credentials, or implementation details into `shared/`.

## Code style

- Use UTF-8, LF line endings, two-space indentation, and a final newline.
- Prefer small modules with one clear responsibility.
- Avoid adding another implementation when a compatibility facade is sufficient.
- Do not edit minified files in `vendor/` by hand.
- Keep comments focused on non-obvious constraints and decisions.

## Tests

The project currently uses a custom Node.js test runner:

```bash
npm run check
```

Add focused tests under `test/unit/` or `test/smoke/` when practical. When substantially changing a legacy regression, move it into the closest focused suite instead of expanding `test/legacy/regression.test.js`.
The runner recursively discovers named `*.test.js` suites, rejects empty or duplicate suites, and applies a per-test timeout. Run one suite with `npm test -- unit/example.test.js`; invoking a suite file directly only loads its exports and does not execute it.

Browser-ready third-party files are source/build dependencies rather than server runtime dependencies. Keep their version, source, license, and verification mode aligned in `vendor/manifest.json`, then run `npm run check:vendor`.

## Known cleanup boundaries

The following areas require dedicated, separately reviewed refactors rather than incidental cleanup:

- Reduce root `app.js` to a bootstrap entry and remove duplicated workflow implementations.
- Separate server-only usage SQL from browser-safe shared range definitions.
