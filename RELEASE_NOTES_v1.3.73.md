# ChatUI v1.3.73

## Fixes

- Docker deployments can now route public upstream Endpoint traffic through an outbound HTTP(S) proxy. Configure `CHATUI_UPSTREAM_PROXY`; when it is empty, `HTTPS_PROXY` and `HTTP_PROXY` are supported as fallbacks.
- Public upstream URL and DNS validation remains enabled. Private upstreams do not use this automatically configured outbound proxy.
- Upstream network failures now retain their real cause. Visual chat/image failures report actionable classes such as `ECONNRESET`, DNS resolution failure, connection refusal, or connection timeout instead of only a generic ?Endpoint unreachable? message.
- Failed upstream forwarding writes redacted diagnostics: target host/path, outbound body size, image part count, and underlying network code. API keys, Authorization values, and image Base64 data are never logged.

## Changes

- Docker and direct Node runtimes follow the same upstream proxy configuration rules.
- Deployment documentation now covers outbound-proxy setup, safe verbose logs, and investigation steps for ?text works, images fail?.

## Added

- `CHATUI_UPSTREAM_PROXY`: explicit upstream HTTP(S) proxy, with higher priority than `HTTPS_PROXY` and `HTTP_PROXY`.
- `CHATUI_VERBOSE_LOGS=1`: enables redacted upstream diagnostics.

## Removed

- None.

## Upgrade

```bash
docker pull liugangqiang/chatui:1.3.73
docker stop chatui || true
docker rm chatui || true
docker run -d --name chatui --restart unless-stopped -p 8765:8765 \
  liugangqiang/chatui:1.3.73
```

If the Docker host needs a local or gateway proxy to reach the upstream, add a proxy URL that is reachable from **inside the container**:

```bash
-e CHATUI_UPSTREAM_PROXY=http://host.docker.internal:7890
```

After reproducing a failed visual request, inspect the safe diagnostics:

```bash
docker logs --tail 200 chatui
```
