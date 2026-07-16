# Development guide

## Prerequisites

- Node.js 22 (see `.nvmrc`); Node.js 20.19 or later remains the package minimum.
- Docker for local container validation when available.

## Install and run

```bash
npm ci
npm start
```

Open `http://127.0.0.1:8765` after the server starts.

## Quality commands

```bash
npm test                              # complete Node test suite
npm run check:runtime                 # compare local Node with .nvmrc (strict in release preflight)
npm run check:project                 # metadata, version, and static-asset contract checks
npm run check:syntax                  # syntax-check every tracked JavaScript source file
npm run check                         # required local checks
npm run audit:prod                    # production dependency audit (requires registry access)
npm run release:preflight -- v1.2.3  # strict Node 22 + release metadata + full checks
```

## Change workflow

1. Keep a change inside the owning layer described in [architecture.md](architecture.md).
2. Add focused coverage under `test/unit/` or `test/smoke/`.
3. Run `npm run check` before opening a pull request.
4. Keep documentation, Docker static assets, and tests in sync when changing a public page or asset.
5. Do not commit local configuration, logs, generated reports, or secret-bearing files.
6. Pull requests and pushes to `main` run the Node 22 CI quality gate (`npm ci` followed by `npm run check`).

## Release quality gate

- This repository intentionally has **one automated release workflow**: pushing a semantic version tag (`vMAJOR.MINOR.PATCH`) starts `.github/workflows/dockerhub.yml`.
- The tag workflow runs `npm run release:preflight -- <tag>` on Node 22 before it builds or publishes an image.
- Preflight enforces the Node 22 release runtime, validates release metadata, and runs the complete project check suite.
- After multi-architecture image publishing succeeds, the same workflow creates or updates the matching published GitHub Release.
- Add `docs/releases/vMAJOR.MINOR.PATCH.md` before tagging; its contents become the GitHub Release body.
- For non-release work, run `npm run check` locally before committing. `npm run audit:prod` is intentionally separate because it requires access to the npm advisory service.
