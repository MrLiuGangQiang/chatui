# Repository Agent Instructions

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

- Do not use patchwork fixes that merely mask symptoms. Identify and verify the root cause, then implement a complete fix at the appropriate architectural layer, including regression coverage where applicable.
- Keep browser, server, and shared-code boundaries described in `docs/architecture.md`.
- Preserve root static-entry assets unless the static server, Docker image, tests, and documentation are updated together.
- Add new tests to `test/unit/` or `test/smoke/`; do not expand `test/legacy/` unless preserving an existing regression.
- Keep package scripts, CI, Docker validation, and documentation aligned. Run `npm run check` after changes.
- Do not commit generated reports, logs, local editor state, or secrets.
