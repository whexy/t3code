# Build context: `bin.mjs`, the MCP bridge bundled by `vp pack` in apps/mcp.
# The self-hosted build pipeline assembles it.
#
# Port 8787 serves MCP at /mcp/<secret> and may be published. Port 8788 is the
# admin page, which shows that secret and can pair servers: keep it private.
FROM node:24-alpine
WORKDIR /app
COPY bin.mjs ./
RUN mkdir /data && chown node:node /data
USER node
ENV T3_MCP_DATA_DIR=/data T3_MCP_HOST=0.0.0.0 T3_MCP_ADMIN_HOST=0.0.0.0
VOLUME /data
EXPOSE 8787 8788
CMD ["node", "bin.mjs"]
