# syntax=docker/dockerfile:1
# switchkick as a container, configured with environment variables:
#
#   docker run -d -p 127.0.0.1:8787:8787 \
#     -e OPENROUTER_API_KEY -e SWITCHKICK_TOKEN -e SWITCHKICK_MODE=local \
#     -v switchkick-data:/data ghcr.io/eased-tech/switchkick
#
# It listens on 0.0.0.0 inside the container, so SWITCHKICK_TOKEN is required. See the README.

# The build is plain JavaScript, so it runs once on the build machine's platform and every
# target platform copies the result. The final stage has no RUN step, so it needs no emulation.
FROM --platform=$BUILDPLATFORM node:24-alpine AS build
WORKDIR /src
RUN npm install --global pnpm@12.14.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY packages/core/package.json packages/core/
COPY packages/jev/package.json packages/jev/
COPY packages/proxy/package.json packages/proxy/
RUN pnpm install --frozen-lockfile
COPY . .
# Install from the same tarballs that are published to npm, so the image runs the npm package.
RUN pnpm build \
  && pnpm --recursive pack --pack-destination /pack \
  && mkdir -p /opt/switchkick /out/data \
  && cd /opt/switchkick \
  && echo '{"private":true}' > package.json \
  && npm install --omit=dev --no-audit --no-fund /pack/*.tgz

FROM node:24-alpine
LABEL org.opencontainers.image.source="https://github.com/eased-tech/switchkick" \
      org.opencontainers.image.description="Routes OpenAI and Anthropic API traffic through OpenRouter, using Jev to pick the model for each turn." \
      org.opencontainers.image.licenses="Apache-2.0"
ENV NODE_ENV=production \
    SWITCHKICK_HOST=0.0.0.0 \
    SWITCHKICK_PORT=8787 \
    XDG_CONFIG_HOME=/config \
    XDG_STATE_HOME=/data
COPY --from=build /opt/switchkick /opt/switchkick
# Sessions and the decision log live in /data; mount a volume there to keep them.
COPY --from=build --chown=node:node /out/data /data
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --start-interval=2s \
  CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.SWITCHKICK_PORT}/healthz`).then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
ENTRYPOINT ["node", "/opt/switchkick/node_modules/switchkick/dist/cli.js"]
CMD ["serve"]
