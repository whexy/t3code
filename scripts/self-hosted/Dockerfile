# Build context: `server.ts` next to `web/`, a hosted web build made with
# VITE_SHARED_CATALOG_PATH=/__t3code/shared-catalog. The self-hosted build
# pipeline assembles it.
FROM node:24-alpine
WORKDIR /app
COPY server.ts ./
COPY web ./web
RUN mkdir /data && chown node:node /data
USER node
ENV WEB_ROOT=/app/web CATALOG_DIR=/data PORT=8080
VOLUME /data
EXPOSE 8080
CMD ["node", "server.ts"]
