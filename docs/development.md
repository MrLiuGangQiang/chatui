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
npm test                 # complete Node test suite
npm run check:project    # metadata, version, and static-asset contract checks
npm run check:syntax     # syntax-check runtime entry files
npm run check            # all required local checks
npm run verify:release -- v1.2.3
```

## Change workflow

1. Keep a change inside the owning layer described in [architecture.md](architecture.md).
2. Add focused coverage under `test/unit/` or `test/smoke/`.
3. Run `npm run check` before opening a pull request.
4. Keep documentation, Docker static assets, and tests in sync when changing a public page or asset.
5. Do not commit local configuration, logs, generated reports, or secret-bearing files.

## CI and releases

- `ci.yml` runs checks for pushes to `main` and pull requests.
- A semantic version tag (`vMAJOR.MINOR.PATCH`) starts the Docker publishing workflow.
- After image publishing succeeds, the release workflow creates or updates the matching published GitHub Release.
- Add `docs/releases/vMAJOR.MINOR.PATCH.md` before tagging; the release job publishes this file as the GitHub Release body.
- The release workflow runs `npm run verify:release -- <tag>` and `npm run check` against the tagged code.
