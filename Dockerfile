# Option 5: the self-hosted room server (also serves the page). No npm packages needed at runtime.
#   docker build -t sevens-out .
#   docker run -p 8788:8788 -v sevens-data:/data sevens-out
FROM node:22-alpine
WORKDIR /app
COPY package.json engine.js index.html ./
COPY server ./server
RUN mkdir /data && chown node:node /data
ENV PORT=8788 HOST=0.0.0.0 DATA_DIR=/data NODE_ENV=production
VOLUME /data
EXPOSE 8788
USER node
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8788/health || exit 1
CMD ["node", "server/node/server.js"]
