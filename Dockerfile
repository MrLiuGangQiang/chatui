FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8765

COPY server.js index.html app.js styles.css README.md ./

EXPOSE 8765
CMD ["node", "server.js"]
