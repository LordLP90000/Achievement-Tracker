# Questline API + worker image (one image, different commands). Build context: repository root.
# Build stages run on Debian 13 (glibc) like the runtime, so native add-ons (sodium-native, M2) match it.
ARG BUILD_IMAGE=node:26-trixie-slim@sha256:36793bcbb160a6a16cede1e62b93f84e26b78a972a8a4c0b879c1c12f22761ec
# Distroless: Node.js only — no shell, no coreutils, no package manager (threat E-06). The entrypoint is node.
ARG RUNTIME_IMAGE=gcr.io/distroless/nodejs26-debian13:nonroot@sha256:3a6f4e6fd37efe00042667d06fd52240f2589ed09b0694fbb3b1bf860030a839

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
