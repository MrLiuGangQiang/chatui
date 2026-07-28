# Immutable release process

ChatUI treats a release as one immutable source and image identity, not merely a semantic version string.

## Build identity

`GET /api/version` reports:

- `version`: semantic application version;
- `gitSha`: exact source commit;
- `sourceRevision`: SHA-256 over every runtime file copied by the Dockerfile;
- `dirty`: whether a direct workspace launch contains uncommitted changes;
- `mode`: `workspace` for a direct source launch or `image` for an identified image build.

Docker builds receive the expected commit and source revision as build arguments. The server recomputes the runtime source revision inside the container and refuses to start when it differs. This detects stale, missing, extra, or incorrectly copied runtime code before the image can pass a health check.

## Local candidate verification

Development may use `npm start`, but a direct source process is not release evidence. Its `/api/version` response identifies the exact workspace and whether it is dirty.

After committing all release changes on the candidate commit, run:

```sh
npm run preview:release
```

The command requires a clean worktree, runs the complete project checks, builds the Docker candidate with the local commit and source fingerprint, starts that image, and verifies its API identity and content-addressed browser bundle.

## CI and publication

Main CI independently builds and starts an identified candidate image. A release tag must be annotated and contained in `origin/main`.

The release workflow performs these operations in order:

1. validate the tag, package versions, release notes, tests, and main ancestry;
2. build one multi-platform candidate and push immutable `candidate-<gitSha>` references;
3. pull and run the exact candidate digest;
4. compare its version, Git SHA, runtime source fingerprint, OCI revision label, homepage bundle revision, and critical browser code markers with the tagged source;
5. promote that already verified digest to `MAJOR.MINOR.PATCH`, `vMAJOR.MINOR.PATCH`, and `latest` in Docker Hub and ACR without rebuilding;
6. verify every promoted tag resolves to the candidate digest;
7. publish the GitHub Release.

Deployments should pin the reported digest when possible. After deployment, compare `/api/version` with the release commit and recorded source revision before accepting traffic.
