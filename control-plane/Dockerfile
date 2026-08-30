# Build the browser console separately so no development dependency reaches the
# runtime image.
FROM node:20.19.2-alpine AS web-build
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

# Build stage: compile TypeScript with development dependencies present.
FROM node:20.19.2-alpine AS backend-build
WORKDIR /app
RUN apk add --no-cache python3 make g++
COPY package.json package-lock.json* .npmrc ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build
RUN npm prune --omit=dev

# Runtime stage: production dependencies only, unprivileged user.
FROM node:20.19.2-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json* .npmrc ./
COPY --from=backend-build /app/node_modules ./node_modules
COPY --from=backend-build /app/dist ./dist
COPY --from=web-build /web/dist ./public
COPY migrations ./migrations

# The revision this image was built from. Deployment is only deterministic if
# the running container can be asked what it is, rather than inferred from a
# working tree that may have moved since.
ARG SOURCE_REVISION=unknown
ENV SOURCE_REVISION=$SOURCE_REVISION
LABEL org.opencontainers.image.revision=$SOURCE_REVISION

# The image never contains configuration: everything arrives as environment.
USER node
EXPOSE 8080
ENV STATIC_ROOT=/app/public

# The health endpoint is unauthenticated and reports liveness only.
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.HTTP_PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/src/main.js"]
