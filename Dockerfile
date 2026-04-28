FROM node:22-alpine AS node-runtime

# Collect only the Node.js executable and the shared libraries it actually needs.
RUN set -eux; \
    mkdir -p /node-root/usr/local/bin; \
    cp /usr/local/bin/node /node-root/usr/local/bin/node; \
    ldd /usr/local/bin/node \
      | awk '{ if ($3 ~ /^\//) print $3; else if ($1 ~ /^\//) print $1 }' \
      | sort -u \
      | while read -r lib; do \
          mkdir -p "/node-root$(dirname "$lib")"; \
          cp -L "$lib" "/node-root$lib"; \
        done

FROM alpine:3.22

WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8765

COPY --from=node-runtime /node-root/ /
COPY server.js index.html app.js styles.css ./

EXPOSE 8765
CMD ["node", "server.js"]
