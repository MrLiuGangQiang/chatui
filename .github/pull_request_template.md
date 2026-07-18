## Summary

Describe the user-visible or engineering change.

## Owning area

- [ ] `client/core` or `shared`
- [ ] `client/services`
- [ ] `client/app`
- [ ] `client/ui` or `client/features`
- [ ] `server`
- [ ] Build, CI, Docker, or release
- [ ] Documentation only

## Contract impact

- [ ] Task lifecycle or durable recovery
- [ ] Persisted session/job format
- [ ] Public API or model routing contract
- [ ] Root static assets or cache behavior
- [ ] Security, credentials, or upstream access
- [ ] No contract impact

## Verification

- [ ] Added or updated behavior-focused tests
- [ ] Ran `npm run check`
- [ ] Verified refresh/session-switch behavior when task state changed
- [ ] Updated architecture, operations, or release documentation when needed
- [ ] Did not add business logic to root `app.js`
- [ ] Did not introduce a new `with (...)` dependency scope
