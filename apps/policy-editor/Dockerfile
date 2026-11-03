# Build context: `serve.ts` next to `dist/`, the editor's build. The
# policy-editor job in .github/workflows/self-hosted-build.yml assembles it;
# `build-image.sh` does the same locally.
FROM node:24-alpine
WORKDIR /app
COPY serve.ts ./
COPY dist ./dist
# The saved fleet policy lives here; mount a persistent volume writable by uid 1000.
RUN mkdir /data && chown 1000:1000 /data
VOLUME /data
USER 1000:1000
ENV WEB_ROOT=/app/dist POLICY_DIR=/data PORT=8080
EXPOSE 8080
CMD ["node", "serve.ts"]
