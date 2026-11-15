# Build context: `server.ts` and `ota-certificate.pem` next to `web/`, a hosted web build made with
# VITE_SHARED_CATALOG_PATH=/__t3code/shared-catalog. The web-hub job in
# .github/workflows/self-hosted-build.yml assembles it.
FROM node:24-alpine
# The release (1.2.N) the hub serves, which is its web bundle's OTA runtime version.
ARG T3CODE_RELEASE
WORKDIR /app
COPY server.ts ota-certificate.pem ./
COPY web ./web
RUN mkdir /data && chown node:node /data
USER node
ENV WEB_ROOT=/app/web CATALOG_DIR=/data PORT=8080 T3CODE_RELEASE=$T3CODE_RELEASE
VOLUME /data
EXPOSE 8080
CMD ["node", "server.ts"]
