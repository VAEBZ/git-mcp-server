# ---- Base Node ----
# Use a specific Node.js version known to work, Alpine for smaller size
FROM node:23-alpine AS base
WORKDIR /usr/src/app
ENV NODE_ENV=production

# ---- Dependencies ----
# Install dependencies first to leverage Docker cache
FROM base AS deps
WORKDIR /usr/src/app
COPY package.json ./
# Use npm install which will generate a lockfile if not present
# Install only production dependencies in this stage for the final image
RUN npm install --omit=dev --ignore-scripts

# ---- Builder ----
# Build the application
FROM base AS builder
WORKDIR /usr/src/app
# Ensure devDependencies are installed for this build stage
ENV NODE_ENV=development
# Copy dependency manifest (package.json only)
COPY package.json ./
# Copy the rest of the source code
COPY . .
# Ensure a clean state for node_modules before installing
RUN rm -rf node_modules
# Install *all* dependencies (including dev), ignoring scripts for now
RUN npm install --ignore-scripts
# Explicitly run the build script now that all files and deps are in place
RUN npm run build
# Debug: List @types contents
RUN ls -l node_modules/@types

# ---- Runner ----
# Final stage with only production dependencies and built code
FROM base AS runner
WORKDIR /usr/src/app
# Copy production node_modules from the 'deps' stage
COPY --from=deps /usr/src/app/node_modules ./node_modules
# Copy built application from the 'builder' stage
COPY --from=builder /usr/src/app/build ./dist
# Copy package.json (needed for potential runtime info, like version)
COPY package.json .

# Install git
RUN apk add --no-cache git

# Create a non-root user and group
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

# Create logs directory and set permissions before switching user
RUN mkdir -p /usr/src/app/logs && chown appuser:appgroup /usr/src/app/logs

USER appuser

# Expose port if the application runs a server (adjust if needed)
# EXPOSE 3000

# Set the entrypoint and default command for the container
ENTRYPOINT ["node", "dist/index.js"]
