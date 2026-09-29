 # syntax=docker/dockerfile:1

  FROM node:24-bookworm-slim AS base
  WORKDIR /app

  FROM base AS development
  COPY package.json package-lock.json ./
  RUN npm ci
  COPY . .
  CMD ["npm", "run", "dev"]

  FROM development AS test
  RUN npm run check

  FROM development AS build
  RUN npm run build

  FROM base AS production-dependencies
  ENV NODE_ENV=production
  COPY package.json package-lock.json ./
  RUN npm ci --omit=dev && npm cache clean --force

FROM base AS production
ENV NODE_ENV=production
RUN rm -rf /usr/local/lib/node_modules/npm \
    /usr/local/lib/node_modules/corepack \
    /opt/yarn-v1.22.22 && \
    rm -f /usr/local/bin/npm \
    /usr/local/bin/npx \
    /usr/local/bin/corepack \
    /usr/local/bin/yarn \
    /usr/local/bin/yarnpkg
COPY --from=production-dependencies /app/node_modules ./node_modules
COPY --chown=node:node package.json ./
COPY --chown=node:node migrations ./migrations
COPY --chown=node:node scripts/start-staging.sh ./scripts/start-staging.sh
COPY --from=build --chown=node:node /app/public ./public
COPY --from=build --chown=node:node /app/dist ./dist
  USER node
  EXPOSE 3000
  CMD ["node", "dist/server.js"]
