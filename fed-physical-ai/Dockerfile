FROM node:24-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates && mkdir -p /app/certs && curl --fail --proto '=https' --tlsv1.2 https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem -o /app/certs/rds-global-bundle.pem
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json playwright.config.ts ./
COPY src ./src
COPY scripts ./scripts
COPY public ./public
COPY tests ./tests
COPY e2e ./e2e
RUN npm run build

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4173
ENV NODE_EXTRA_CA_CERTS=/app/certs/rds-global-bundle.pem
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=build /app/build/src/server.js ./build/src/server.js
COPY --from=build /app/build/src/platform ./build/src/platform
COPY --from=build /app/build/src/core ./build/src/core
COPY --from=build /app/build/src/ai ./build/src/ai
COPY --from=build /app/certs ./certs
COPY --from=build /app/build/scripts/bootstrap-aws.js ./build/scripts/bootstrap-aws.js
COPY --from=build /app/build/scripts/migrate.js ./build/scripts/migrate.js
COPY --from=build /app/build/scripts/verify-audit.js ./build/scripts/verify-audit.js
COPY --from=build /app/build/scripts/publish-observation.js ./build/scripts/publish-observation.js
COPY --from=build /app/dist ./dist
COPY migrations ./migrations
USER node
EXPOSE 4173
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 CMD ["node", "-e", "fetch('http://127.0.0.1:4173/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "build/src/server.js"]
