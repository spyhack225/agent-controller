ARG NODE_IMAGE=node:22.21.1-bookworm-slim@sha256:25b3eb23a00590b7499f2a2ce939322727fcce1b15fdd69754fcd09536a3ae2c

FROM ${NODE_IMAGE} AS dependencies

WORKDIR /app
COPY cloudflare-control-plane/container-runtime/package.json cloudflare-control-plane/container-runtime/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
    && npm cache clean --force

FROM ${NODE_IMAGE} AS runtime

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3996 \
    INTERNAL_HOST=0.0.0.0 \
    INTERNAL_PORT=3998

WORKDIR /app
COPY --from=dependencies --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node cloudflare-control-plane/container-runtime/package.json cloudflare-control-plane/container-runtime/package-lock.json ./
COPY --chown=node:node src ./src

USER node
EXPOSE 3996 3998
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3996/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["node", "src/containerServer.mjs"]
