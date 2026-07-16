# Environment configuration

ChatUI reads configuration from process environment variables. It does **not** load `.env` by itself; copy `.env.example` for local reference, then provide the actual variables through your shell, container platform, or secret manager.

## Deployment modes

| Mode | Intended environment | Required operational controls |
| --- | --- | --- |
| Local / trusted LAN | Personal or controlled internal use with user-supplied upstream credentials | Keep the service behind a trusted network boundary; do not expose the proxy port publicly. |
| Managed internal service | A controlled organization deployment | Enable service authentication, restrict ingress origins, manage upstream access centrally, and configure usage/audit controls. |
| Public service | Internet-facing, multi-user deployment | Requires a dedicated authentication, server-side credential, per-user quota, and distributed rate-limit design before exposure. The current release is not a public multi-tenant gateway. |

## Managed bearer authentication

The default `local` mode keeps the existing trusted-network behavior. To make the API require identities, enable managed mode and configure one or more static tokens through a secret manager:

```bash
CHATUI_DEPLOYMENT_MODE=managed
CHATUI_AUTH_TOKENS=alice:replace-with-a-long-random-token,bob:replace-with-another-long-random-token
```

- Token entries use `principal:token`, separated by commas. Principal names may contain letters, numbers, `.`, `_`, and `-`; tokens cannot contain whitespace or commas.
- Managed mode refuses to start without at least one valid token. API requests must supply `Authorization: Bearer <token>`; `/api/version` and `/api/config/public` remain bootstrap-safe public reads.
- The built-in browser client provides a **Managed access token** field in the configuration dialog. It is held in `sessionStorage` only and is never written into the general configuration object or `localStorage`.
- A created chat or image job records its authenticated principal internally. In managed mode, only that principal can read, subscribe to, abort, or delete it. Cross-principal access is returned as `404 JOB_NOT_FOUND` to avoid confirming another user's job ID.
- `MAX_MANAGED_JOBS_PER_PRINCIPAL` bounds each principal's active and queued chat/image jobs (default `8`). A request over that process-local limit receives `429 PRINCIPAL_JOB_LIMIT_EXCEEDED`; a terminal, aborted, deleted, or swept job releases its slot.
- Static bearer tokens are an internal deployment bridge, not a replacement for SSO, token rotation, per-user quotas, audit retention, or distributed authorization. Do not expose the service as a public multi-tenant gateway on this mechanism alone.

## Request limits and admission

- Every POST route has a request-specific `Content-Length` ceiling and rejects declared oversize requests before authentication or routing. Current ceilings are 256 KiB for usage APIs, 12 MiB for visual chat/proxy requests, and 50 MiB for image/edit and file-extraction payloads. Chunked bodies are measured while streaming and are drained on rejection.
- `MAX_BODY_BYTES` is a global hard ceiling across all JSON body readers. It defaults to 50 MiB to preserve the supported image/file routes; set it lower to impose a deployment-wide cap.
- Global upstream and extraction queues remain process-local. Managed per-principal job admission prevents a single static-token principal from filling the job queue, but it is not a distributed quota or rate-limit system.

## Binding and reverse proxy

- The process default is `HOST=127.0.0.1`. Set `HOST=0.0.0.0` only when a firewall, container network policy, or trusted reverse proxy is intentionally controlling ingress. The official Docker image explicitly sets `HOST=0.0.0.0` because container port publishing is the deployment boundary.
- Terminate TLS and enforce external IP/access controls at the reverse proxy or load balancer. Keep the application port private where possible; do not rely on browser CORS as network access control.
- This service does not consume forwarded client-IP headers for authorization or quotas. Do not add a proxy-trust setting merely to make per-principal limits appear distributed.

## High-impact variables

- `DEFAULT_UPSTREAM_BASE_URL`: default OpenAI-compatible upstream base URL.
- `CHATUI_ALLOW_PRIVATE_UPSTREAM=1`: permits private-network upstream addresses. Enable only for a trusted internal gateway.
- `MAX_UPSTREAM_CONCURRENCY` and `MAX_UPSTREAM_QUEUE`: process-local upstream back-pressure controls.
- `JOB_TTL_MS`, `RUNNING_JOB_TTL_MS`, and `MAX_JOBS_PER_STORE`: retention for the current in-memory job store. A process restart clears it.
- `MAX_MANAGED_JOBS_PER_PRINCIPAL`: maximum active/queued jobs owned by one authenticated principal in managed mode (default `8`).
- `POSTGRES_URL`: optional usage-statistics source; it does not make managed jobs durable.
- `CHATUI_VERBOSE_LOGS=1`: enables redacted upstream diagnostics.
- `CHATUI_DEPLOYMENT_MODE=local|managed`: deployment trust model. `managed` requires `CHATUI_AUTH_TOKENS`.
- `CHATUI_AUTH_TOKENS`: comma-separated static `principal:token` pairs used only when managed mode is enabled. Keep it in a secret manager; it is never returned by public configuration endpoints.
- `CHATUI_CORS_ORIGINS`: optional comma-separated browser origins allowed to call the API cross-origin, for example `https://chat.example.com,http://localhost:3000`. The default is same-origin only; wildcard `*` is intentionally not supported.
- `HOST`: interface binding; defaults to `127.0.0.1` outside the Docker image.

See `.env.example` for the complete, non-secret template and `README.md` for deployment examples.
