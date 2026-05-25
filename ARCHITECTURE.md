# ChatUI Architecture Notes

ChatUI is intentionally lightweight: no front-end build step is required, the server uses Node's built-in HTTP module, and browser modules are exposed through `window.ChatUICore`, `window.ChatUIServices`, `window.ChatUI`, and `window.ChatUIApp`.

This file records the extension boundaries that should be used for future changes so new features do not keep growing the root `app.js` and `styles.css` files.

## Current shape

- `server/` contains the HTTP server, API routing, proxying, extraction, and background job handling.
- `client/core/` contains pure browser-safe helpers.
- `client/services/` contains browser API/service helpers. Browser fallback implementations are exposed by `client/services/fallback.js`; `client/services/browser.js` is now a thin namespace adapter.
- `client/app/` contains app/session/runtime helpers.
- `client/ui/` contains UI rendering/action helpers.
- `styles/composer.css` contains composer/input layout override rules that must load after root `styles.css`.
- `styles/messages.css` contains message-layout override rules that must load after root `styles.css`.
- Root `app.js` and `styles.css` are still the main runtime/style surfaces and should be treated as legacy-heavy files.

## Extension rules

1. Prefer adding reusable logic under `client/` or `server/` modules instead of adding more large blocks to root `app.js`.
2. Keep root `app.js` changes as glue code only when possible.
3. Keep feature configuration behind server-side config readers and public config endpoints.
4. Do not add default-visible UI surfaces without an explicit placement and default-state decision.
5. UI changes that touch messages, avatars, actions, composer, or mobile layout should include a regression test or at least a DOM/layout verification plan.

## Public config

Server-side non-sensitive UI feature flags should go in `config/public.json` and be read through:

```http
GET /api/config/public
```

Response shape:

```json
{
  "version": "1.1.93",
  "config": {
    "ui": {},
    "features": {}
  }
}
```

Only non-sensitive values may be exposed here. API keys, tokens, private headers, and deployment secrets must never be returned from this endpoint.

## Recommended next refactors

1. Continue splitting CSS from root `styles.css`; composer overrides live in `styles/composer.css`, and message timing/layout overrides live in `styles/messages.css`.
2. Continue thinning browser namespace adapters (`client/*/browser.js`) so they expose stable `window.*` namespaces while implementation logic stays in focused modules or fallback bundles.
3. Move message rendering and message action glue out of root `app.js` into `client/ui` and `client/app` modules.
4. Add minimal browser regression coverage for message layout and mobile composer behavior.
5. Extend the `createJobStores()` factory when optional persistent storage is needed. Keep route/job handlers depending on store behavior instead of constructing storage directly.

## CSS contract

`test/unit/css-contract-test.js` protects critical selectors plus composer/timing metadata layout while the large root stylesheet is being split.

Keep that test updated when intentionally changing message, avatar, action-button, composer, or sidebar layout. Do not remove a protected selector or timing layout rule without replacing the test with an equivalent layout check.

## Job storage

Background chat/image tasks currently use in-memory stores created by `createJobStores()` in `server/jobs/store.js`.

The factory is the extension point for future persistence. If long-running jobs need to survive process restarts, add a compatible store implementation behind this factory instead of changing route handlers directly.
