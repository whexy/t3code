# Build context: `serve.ts` next to `dist/`, the editor's build. The
# policy-editor job in .github/workflows/self-hosted-build.yml assembles it;
# `build-image.sh` does the same locally.
FROM node:24-alpine
WORKDIR /app
COPY serve.ts ./
COPY dist ./dist
# The saved policies live here; mount a persistent volume writable by uid 1000.
RUN mkdir /data && chown 1000:1000 /data
VOLUME /data
USER 1000:1000
ENV WEB_ROOT=/app/dist POLICY_DIR=/data PORT=8080 PUBLIC_PORT=8081
# 8080: the editor and its write API, for administrators only. 8081: read-only, for hosts.
EXPOSE 8080 8081
CMD ["node", "serve.ts"]
