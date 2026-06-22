ARG NODE_VERSION=22

# --- build stage ---
FROM node:${NODE_VERSION}-alpine AS builder
WORKDIR /app

COPY package-lock.json server/package.json ./
RUN npm ci

COPY server/ .
RUN npm run build

# --- production stage ---
FROM node:${NODE_VERSION}-alpine
WORKDIR /app

RUN apk add --no-cache tini=~0.19

ENV NODE_ENV=production

COPY package-lock.json server/package.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/drizzle ./drizzle
COPY server/okfvault.example.yaml ./okfvault.yaml

EXPOSE 3000

# Config resolves with precedence: CLI flags > env vars > config file > defaults.
# Mount a YAML config at /app/okfvault.yaml (or set OKFVAULT_CONFIG) to use the
# FILE path. `serve --migrate` applies pending migrations before every start.
ENTRYPOINT ["tini", "--"]
CMD ["node", "dist/cli.js", "serve", "--migrate"]
