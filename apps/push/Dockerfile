# Build context: `bin.mjs`, t3-push bundled by `vp pack` in apps/push. The
# push job in .github/workflows/self-hosted-build.yml assembles it.
#
# One replica with a Recreate rollout: deliveries are serialized inside the
# process, and a new pod must not send while the old one still can.
FROM node:24-alpine
WORKDIR /app
COPY bin.mjs ./
# push.sqlite lives here; mount a persistent volume writable by uid 1000.
RUN mkdir /data && chown node:node /data
USER node
ENV DATA_DIR=/data PORT=8080
VOLUME /data
EXPOSE 8080
CMD ["node", "bin.mjs"]
