# ---- Base Node ----
# Use a specific Node.js version known to work, Alpine for smaller size
FROM node:23-alpine AS base
WORKDIR /usr/src/app
ENV NODE_ENV=production

# ---- Dependencies ----
# Install dependencies first to leverage Docker cache
FROM base AS deps
WORKDIR /usr/src/app
COPY package.json package-lock.json* ./
# Temporarily remove scripts to prevent prepare hook during prod install
RUN sed -i '/"scripts":/,/}/ d' package.json 
# Use npm install --omit=dev and ignore scripts (double safety)
RUN npm install --omit=dev --ignore-scripts

# ---- Builder ----
# Build the application
FROM base AS builder
WORKDIR /usr/src/app
# Copy ORIGINAL dependency manifests (including scripts)
COPY package.json package-lock.json* ./
# Install all deps without running prepare/build script implicitly
RUN npm ci --ignore-scripts
# Copy the rest of the source code
COPY . .
# Explicitly build the TypeScript project AFTER installing deps and copying code
RUN npm run build

# ---- Runner ----
# Final stage with only production dependencies and built code
FROM base AS runner
WORKDIR /usr/src/app
# Copy production node_modules from the 'deps' stage
COPY --from=deps /usr/src/app/node_modules ./node_modules
# Copy built application from the 'builder' stage (output is in ./build)
COPY --from=builder /usr/src/app/build ./build 
# Copy package.json (needed for potential runtime info, like version)
COPY package.json .

# Create a non-root user and switch to it
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
# Create logs directory and change ownership before switching user
RUN mkdir logs && chown appuser:appgroup logs 
USER appuser

# Expose port if the application runs a server (adjust if needed)
# EXPOSE 3000

# Command to run the application (entry point is in ./build)
CMD ["node", "build/index.js"]
