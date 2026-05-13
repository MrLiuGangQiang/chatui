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
RUN npm ci --omit=dev --ignore-scripts \
    && npm cache clean --force
COPY server.js index.html app.js app.js.br app.js.gz styles.css styles.css.br styles.css.gz favicon.svg ./

USER node
EXPOSE 8765
CMD ["node", "server.js"]
