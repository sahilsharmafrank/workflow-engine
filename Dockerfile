# Builds the whole workspace and runs the @wfe/server CLI (serve or worker,
# selected by the `command:` override in docker-compose.yml).
FROM node:24-alpine

WORKDIR /app

# Copy manifests first so `npm ci` is cached across rebuilds that only change
# source files.
COPY package.json package-lock.json ./
COPY packages/sdk/package.json packages/sdk/
COPY packages/core/package.json packages/core/
COPY packages/server/package.json packages/server/

RUN npm ci

COPY . .
RUN npm run build

EXPOSE 3000

CMD ["node", "packages/server/dist/cli/index.js", "serve"]
