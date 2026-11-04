# Questline API + worker image (one image, different commands). Build context: repository root.
# Build stages run on Debian 13 (glibc) like the runtime, so native add-ons (sodium-native, M2) match it.
ARG BUILD_IMAGE=node:26.13.0-trixie-slim@sha256:e4db4c914bf8ad241bd24804fc25d272d89bad97e68cdc8a1414862790a02c39
# Distroless: Node.js only — no shell, no coreutils, no package manager (threat E-06). The entrypoint is node.
ARG RUNTIME_IMAGE=gcr.io/distroless/nodejs26-debian13:nonroot@sha256:a51c5d631b90e1b298e17a88a307b77f0b959b47de942d033acce0c96be3fb83

FROM ${BUILD_IMAGE} AS build
WORKDIR /build
COPY package.json package-lock.json .npmrc ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM ${BUILD_IMAGE} AS production-dependencies
WORKDIR /build
COPY package.json package-lock.json .npmrc ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY docker/keep-native-prebuild.mjs ./
RUN node keep-native-prebuild.mjs

FROM ${RUNTIME_IMAGE} AS runtime
ENV NODE_ENV=production
WORKDIR /app
# Application files belong to root and are not writable by the runtime user.
COPY --from=production-dependencies /build/node_modules ./node_modules
COPY --from=build /build/dist ./dist
COPY package.json ./
USER 65532:65532
EXPOSE 3000
CMD ["dist/server.js"]
