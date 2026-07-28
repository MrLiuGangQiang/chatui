# Branch management

## Policy

`main` is the only long-lived development branch. Direct pushes to `main` are allowed and must trigger the CI workflow; a pull request is optional, not a build prerequisite. Do not force-push `main`.

Use a short-lived branch only when parallel work, review, or an isolated rollback point is useful:

- `feature/<topic>` for a user-visible capability.
- `fix/<topic>` for a non-urgent correction.
- `hotfix/<version>-<topic>` for a production correction.

Rebase or merge the current `main` before integrating a short-lived branch. After the change reaches `main`, delete the remote and local branch. Do not create release branches for normal releases: create an annotated `vMAJOR.MINOR.PATCH` tag from `main` instead.

## Build and release flow

| Event | Required outcome |
| --- | --- |
| Push to `main` | Run the complete CI check. No PR is required. |
| Optional pull request | Run the same CI check before review/merge. |
| Annotated `v*` tag | Trigger Docker image publishing. |
| Urgent rollback | Revert the `main` commit, run CI, then tag a corrective release if deployed. |

## Cleanup rule

Review branches after every release. A branch can be deleted when it is merged or its patches are already equivalent to `main`, it is not checked out by an active worktree, and it has no unique commits that need preservation. Keep a named backup branch only when it contains unique history; document why it is retained and either merge it deliberately or archive it before the next major cleanup.

## Current exception

`backup/local-v1.3.74-0f8399a` remains because it contains three commits whose patches are not present in `main`. It is a recovery branch, not an active development branch, and must be reviewed before the next branch cleanup.
