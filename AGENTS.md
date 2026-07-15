# Repository Agent Instructions

## Release procedure

When the user asks to **commit and release** (for example, "commit and release"), complete the entire release process; pushing a Git tag by itself is not a completed release.

1. Determine the next semantic version, update `package.json` and every matching version in `package-lock.json`, and ensure they match the planned `vMAJOR.MINOR.PATCH` tag.
2. Run the project test suite and do not release if it fails.
3. Commit the release changes and push the release commit to `main`.
4. Create an **annotated** `vMAJOR.MINOR.PATCH` Git tag and push it. This triggers the Docker publishing workflow.
5. Add `docs/releases/vMAJOR.MINOR.PATCH.md` with a clear title and concise user-facing notes, then create a published (not draft) **GitHub Release** for the same tag from that file. Do not treat a tag as a substitute for a GitHub Release.
6. Verify both conditions before reporting the release as complete:
   - the GitHub Release exists and is published;
   - the tag-triggered Docker publishing workflow completed successfully.
7. Report the exact version, commit, tag, GitHub Release status, Docker workflow result, and any remaining deployment action. If verification is still running, explicitly say the release is in progress rather than complete.

For a hotfix that only repairs packaging or deployment, still follow the complete procedure above, including the GitHub Release and Docker workflow verification.

## Engineering standards

- Keep browser, server, and shared-code boundaries described in `docs/architecture.md`.
- Preserve root static-entry assets unless the static server, Docker image, tests, and documentation are updated together.
- Add new tests to `test/unit/` or `test/smoke/`; do not expand `test/legacy/` unless preserving an existing regression.
- Keep package scripts, CI, Docker validation, and documentation aligned. Run `npm run check` after changes.
- Do not commit generated reports, logs, local editor state, or secrets.
