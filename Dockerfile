FROM node:22-alpine AS node-runtime

# Build a minimal runtime rootfs: Node binary, required shared libs and CA certs.
RUN set -eux; \
    mkdir -p /node-root/usr/local/bin /node-root/etc/ssl/certs; \
    cp /usr/local/bin/node /node-root/usr/local/bin/node; \
    cp -a /etc/ssl/certs/. /node-root/etc/ssl/certs/; \
    ldd /usr/local/bin/node \
      | awk '{ if ($3 ~ /^\//) print $3; else if ($1 ~ /^\//) print $1 }' \
      | sort -u \
      | while read -r lib; do \
          mkdir -p "/node-root$(dirname "$lib")"; \
          cp -L "$lib" "/node-root$lib"; \
        done

FROM scratch

WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8765 \
    UPSTREAM_TIMEOUT_MS=600000 \
    PATH=/usr/local/bin

COPY --from=node-runtime /node-root/ /
COPY server.js index.html app.js styles.css favicon.svg ./
COPY vendor ./vendor

EXPOSE 8765
CMD ["node", "server.js"]
