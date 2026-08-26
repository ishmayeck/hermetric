FROM node:22-alpine

WORKDIR /app
COPY server.mjs ./

ENV NODE_ENV=production \
    CLAUDE_TOKEN_FILE=/data/token.json

RUN mkdir /data && chown node:node /data
VOLUME /data
USER node
EXPOSE 8080

HEALTHCHECK --interval=60s --timeout=5s --start-period=30s \
  CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1

CMD ["node", "server.mjs"]
