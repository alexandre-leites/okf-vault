ARG NODE_VERSION=22

# --- build stage ---
FROM node:${NODE_VERSION}-alpine AS builder
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

# --- production stage ---
FROM node:${NODE_VERSION}-alpine
WORKDIR /app

RUN apk add --no-cache tini=~0.19

ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/drizzle ./drizzle

EXPOSE 3000

ENTRYPOINT ["tini", "--"]
CMD ["node", "dist/cli.js", "serve"]
