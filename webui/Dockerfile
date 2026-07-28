# syntax=docker/dockerfile:1

FROM node:20-bookworm-slim AS frontend-build
WORKDIR /app/web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

FROM node:20-bookworm-slim AS backend-build
# better-sqlite3 and argon2 compile native bindings during install — build
# tools are needed only in this stage, never in the runtime stage below.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json drizzle.config.ts ./
COPY src/ ./src/
RUN npm run build

# Same base image as backend-build, not a slimmer distro — better-sqlite3 and
# argon2 are native addons compiled against this stage's libc there; swapping
# runtime bases breaks them at load time rather than at build time.
FROM node:20-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY --from=backend-build /app/node_modules ./node_modules
COPY --from=backend-build /app/dist ./dist
# db:migrate runs via tsx directly against source (src/db/migrate.ts), and
# drizzle.config.ts points migrationsFolder at ./src/db/migrations — neither
# is compiled into dist/, so the source tree has to ship too.
COPY --from=backend-build /app/src ./src
COPY --from=backend-build /app/package.json ./package.json
COPY --from=frontend-build /app/web/dist ./web/dist

EXPOSE 8080

CMD ["sh", "-c", "npm run db:migrate && node dist/index.js"]
