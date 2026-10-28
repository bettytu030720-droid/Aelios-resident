# The Claude box (server.mjs): the official Claude Agent SDK behind a small HTTP server, for the resident's
# `claude-code/…` models. Built and pushed by `npm run deploy:claude` (Cloudflare Containers, Workers Paid).
FROM node:22-bookworm AS install
WORKDIR /box
COPY package.json package-lock.json ./
# The SDK installs Claude Code for glibc and musl alike; this image is glibc.
RUN npm ci --omit=dev --no-audit --no-fund && rm -rf node_modules/@anthropic-ai/claude-agent-sdk-linux-*-musl

FROM node:22-bookworm-slim
# The slim image has no root certificates; Claude Code reaches api.anthropic.com over TLS.
COPY --from=install /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
ENV NODE_ENV=production SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt
WORKDIR /box
COPY --from=install /box/node_modules ./node_modules
COPY package.json server.mjs transcript.mjs ./
# Claude Code does not run as root, and needs nothing but its own home.
RUN useradd --create-home box
USER box
ENV HOME=/home/box PORT=8080
EXPOSE 8080
CMD ["node", "server.mjs"]
