# syntax=docker/dockerfile:1
# Build from the repository root: docker build -f docker/Dockerfile .

FROM node:26-trixie-slim AS build
WORKDIR /src
RUN npm install --global pnpm@12.23.0
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --recursive run build \
  && node packages/wheatley/scripts/bundle-dashboard.ts \
  && pnpm --filter @wheatley-ai/cli deploy --prod /opt/wheatley

FROM node:26-trixie-slim
ENV NODE_ENV=production \
  WHEATLEY_HOME=/data \
  WHEATLEY_DOCKER=1
COPY --from=build /opt/wheatley /opt/wheatley
RUN ln -s /opt/wheatley/bin/wheatley.js /usr/local/bin/wheatley \
  && mkdir /data \
  && chown node:node /data
USER node
WORKDIR /data
VOLUME ["/data"]
STOPSIGNAL SIGTERM
CMD ["wheatley", "daemon"]
