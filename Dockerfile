FROM node:22-alpine

RUN apk add --no-cache \
    ca-certificates \
    poppler-utils \
    tesseract-ocr \
    tesseract-ocr-data-eng \
    tesseract-ocr-data-chi_sim \
    tesseract-ocr-data-chi_tra \
    font-noto \
    font-noto-cjk \
    font-noto-cjk-extra \
    ttf-dejavu \
    fontconfig

WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8765 \
    UPSTREAM_TIMEOUT_MS=600000 \
    PATH=/usr/local/bin:/usr/bin:/bin

COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server.js index.html app.js styles.css favicon.svg ./
COPY vendor ./vendor

EXPOSE 8765
CMD ["node", "server.js"]
