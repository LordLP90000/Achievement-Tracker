# Questline API + worker image (one image, different commands). Build context: repository root.
# Build stages run on Debian 13 (glibc) like the runtime, so native add-ons (sodium-native, M2) match it.
ARG BUILD_IMAGE=node:26.13.0-trixie-slim@sha256:e4db4c914bf8ad241bd24804fc25d272d89bad97e68cdc8a1414862790a02c39
# Distroless: Node.js only — no shell, no coreutils, no package manager (threat E-06). The entrypoint is node.
ARG RUNTIME_IMAGE=gcr.io/distroless/nodejs26-debian13:nonroot@sha256:33c86a63859efc2ebd88ea0a355863582ec6f1220d048de62baffb2584e709b3

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

FROM ${RUNTIME_IMAGE} AS distroless

# The runtime's file system: the distroless image without its system OpenSSL and the zstd and zlib that only it
# needs. Node.js brings its own three and loads none of these, and every finding in the image so far was in one of
# them (ADR-0017 as amended). The script fails the build if anything that stays needs what it removes.
FROM ${BUILD_IMAGE} AS runtime-files
WORKDIR /build
COPY --from=distroless / /runtime/
COPY scripts/remove-image-packages.ts ./
RUN node remove-image-packages.ts /runtime libssl3t64 libzstd1 zlib1g

FROM scratch AS runtime
COPY --from=runtime-files /runtime/ /
# What the distroless image sets and an empty base does not hand on (test/e2e/smoke.test.ts compares them).
ENV PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt \
    NODE_ENV=production
WORKDIR /app
# Application files belong to root and are not writable by the runtime user.
COPY --from=production-dependencies /build/node_modules ./node_modules
COPY --from=build /build/dist ./dist
COPY package.json ./
USER 65532:65532
EXPOSE 3000
ENTRYPOINT ["/nodejs/bin/node"]
CMD ["dist/server.js"]
