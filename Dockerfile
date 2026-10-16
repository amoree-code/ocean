FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install --no-install-recommends -y python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/harness/package.json ./packages/harness/package.json
COPY packages/core/package.json ./packages/core/package.json
COPY packages/market/package.json ./packages/market/package.json
COPY packages/brain/package.json ./packages/brain/package.json
COPY packages/context/package.json ./packages/context/package.json
RUN mkdir -p scripts packages/harness/scripts packages/core
COPY scripts/prepare-hooks.mjs ./scripts/
COPY packages/harness/scripts/prepare-node-pty.mjs ./packages/harness/scripts/
RUN corepack enable && pnpm install --frozen-lockfile

COPY . .
RUN pnpm test

RUN useradd --create-home --shell /usr/sbin/nologin ocean \
  && chown -R ocean:ocean /app
USER ocean

CMD ["pnpm", "test"]
