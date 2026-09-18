FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev --ignore-scripts
COPY server.mjs ./
COPY public ./public
ENV NODE_ENV=production PORT=3473
EXPOSE 3473
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q -O - http://127.0.0.1:3473/healthz >/dev/null 2>&1 || exit 1
USER node
CMD ["node", "server.mjs"]
