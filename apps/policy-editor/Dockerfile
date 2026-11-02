# Build context: `serve.ts` next to `dist/`, the editor's build. The self-hosted
# policy editor pipeline assembles it; `build-image.sh` does the same locally.
FROM node:24-alpine
WORKDIR /app
COPY serve.ts ./
COPY dist ./dist
USER 1000:1000
ENV WEB_ROOT=/app/dist PORT=8080
EXPOSE 8080
CMD ["node", "serve.ts"]
