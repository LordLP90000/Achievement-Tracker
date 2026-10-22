# Questline API + worker image (one image, different commands). Build context: repository root.
ARG NODE_IMAGE=node:26-alpine@sha256:40cd011b55415bc894e45b02fdd5a5dfde056921b7d23a64c74f80497af48797

FROM ${NODE_IMAGE} AS build
WORKDIR /build
COPY package.json package-lock.json .npmrc ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM ${NODE_IMAGE} AS production-dependencies
WORKDIR /build
COPY package.json package-lock.json .npmrc ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production
# No package managers in the runtime image: nothing can be installed or executed through them.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
      /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /opt/yarn*
WORKDIR /app
# Application files belong to root and are not writable by the runtime user.
COPY --from=production-dependencies /build/node_modules ./node_modules
COPY --from=build /build/dist ./dist
COPY package.json ./
USER node
EXPOSE 3000
CMD ["node", "dist/server.js"]
