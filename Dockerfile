# syntax=docker/dockerfile:1.7
FROM node:22-alpine

# Runtime-only dependencies:
# - poppler-utils: PDF text extraction / PDF-to-image fallback
# - tesseract + eng/chi_sim: OCR fallback used by server.js (`chi_sim+eng`)
# - font-noto-cjk + fontconfig: compact CJK font fallback for PDF rendering
RUN apk add --no-cache \
    ca-certificates \
    poppler-utils \
    tesseract-ocr \
    tesseract-ocr-data-eng \
    tesseract-ocr-data-chi_sim \
    font-noto-cjk \
    fontconfig

WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8765 \
    UPSTREAM_TIMEOUT_MS=600000 \
    CHATUI_PID_DIR=/tmp/chatui \
    POSTGRES_URL= \
    USAGE_RANKING_LIMIT=10 \
    PG_POOL_MIN=0 \
    PG_POOL_MAX=10 \
    PG_IDLE_TIMEOUT_MS=30000 \
    PG_CONNECTION_TIMEOUT_MS=5000 \
    PATH=/usr/local/bin:/usr/bin:/bin

COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY server.js index.html app.js styles.css favicon.svg ./
COPY config ./config
COPY styles ./styles
COPY client ./client
COPY server ./server
COPY vendor ./vendor

USER node
EXPOSE 8765
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
    CMD node -e "const http=require('http');const req=http.get('http://127.0.0.1:'+(process.env.PORT||8765)+'/api/version',res=>process.exit(res.statusCode===200?0:1));req.on('error',()=>process.exit(1));req.setTimeout(2500,()=>{req.destroy();process.exit(1);});"
CMD ["node", "server.js"]
