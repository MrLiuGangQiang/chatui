FROM --platform=$BUILDPLATFORM node:22-alpine AS deps

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts \
    && npm cache clean --force

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
    PATH=/usr/local/bin:/usr/bin:/bin

COPY package.json package-lock.json ./
COPY --from=deps /app/node_modules ./node_modules
COPY server.js index.html app.js styles.css favicon.svg ./
COPY client ./client
COPY server ./server
COPY vendor ./vendor

USER node
EXPOSE 8765
CMD ["node", "server.js"]
