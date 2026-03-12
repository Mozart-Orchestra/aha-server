# Stage 1: Building the application
FROM node:20 AS builder

# Install dependencies
RUN apt-get update && apt-get install -y python3 ffmpeg make g++ build-essential && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package.json and yarn.lock
COPY package.json yarn.lock ./
COPY ./prisma ./prisma

# Install dependencies
RUN yarn install --frozen-lockfile --ignore-engines

# Generate Prisma client
RUN npx prisma generate

# Copy the rest of the application code
COPY ./tsconfig.json ./tsconfig.json
COPY ./vitest.config.ts ./vitest.config.ts
COPY ./sources ./sources

# Build the application
RUN yarn build

# Stage 2: Runtime
FROM node:20-slim AS runner

WORKDIR /app

# Install runtime deps
RUN apt-get update && apt-get install -y python3 ffmpeg curl && rm -rf /var/lib/apt/lists/*

# Set environment to production
ENV NODE_ENV=production

# Copy necessary files from the builder stage
COPY --from=builder /app/tsconfig.json ./tsconfig.json
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/sources ./sources
COPY --from=builder /app/prisma ./prisma

# Expose the port the app will run on
EXPOSE 3005

# Run migrations then start
CMD ["sh", "-c", "npx prisma migrate deploy && yarn start"]
