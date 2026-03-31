FROM node:22-alpine AS prod-deps
RUN apk add --no-cache ffmpeg python3 make g++
WORKDIR /app
ARG NODE_OPTIONS=--max-old-space-size=12288
ENV NODE_OPTIONS=${NODE_OPTIONS}

COPY package.json yarn.lock ./
COPY prisma ./prisma
RUN yarn install --frozen-lockfile --ignore-engines \
 && yarn prisma generate \
 && yarn cache clean

FROM node:22-alpine AS runner
RUN apk add --no-cache ffmpeg
WORKDIR /app

ENV NODE_ENV=production \
    PORT=3005 \
    NODE_OPTIONS=--max-old-space-size=12288

COPY --from=prod-deps --chown=node:node /app/package.json ./package.json
COPY --from=prod-deps --chown=node:node /app/yarn.lock ./yarn.lock
COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=prod-deps --chown=node:node /app/prisma ./prisma
COPY --chown=node:node shared ./shared
COPY --chown=node:node sources ./sources
COPY --chown=node:node tsconfig.json ./tsconfig.json

RUN mkdir -p /app/.logs /data \
 && chown -R node:node /app /data

USER node
EXPOSE 3005

CMD ["sh", "-c", "npx prisma db push --skip-generate --accept-data-loss && node_modules/.bin/tsx ./sources/main.ts"]
