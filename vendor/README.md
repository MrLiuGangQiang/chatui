# Vendored browser assets

The files in this directory are browser-ready copies of third-party packages. The application serves these files locally so Markdown rendering does not depend on a CDN at runtime.

`vendor/manifest.json` records each package, version, license, source file, and verification mode. Complete upstream license texts are retained under `vendor/licenses/`, including both alternatives offered by DOMPurify. Run `npm run check:vendor` after `npm ci`; the command compares direct copies and license texts byte-for-byte with the locked package, verifies reviewed generated builds by SHA-256, checks the KaTeX font set, and rejects undeclared runtime assets or notices.

When updating an asset:

1. Update the package and lockfile together.
2. Copy the declared distribution file from `node_modules` into the matching `vendor/` path. Generated browser builds must be produced from the declared upstream source, reviewed, and assigned a new SHA-256 in the manifest.
3. Keep the package license identifier and source path current in the manifest, and copy every applicable upstream license into `vendor/licenses/`. These notices ship with Docker and standalone static deployments even though browser-source packages are omitted from production `node_modules`.
4. Run `npm run check:vendor` and `npm run check`.

Do not edit minified files manually or place application code, credentials, or local configuration in this directory.
