# No npm packages needed: Node 24 has SQLite built in.
FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=8080 DB_FILE=/data/data.db
COPY package.json ./
COPY src ./src
COPY public ./public
# shortcut: runs as root so it can write to the host's mounted disk at /data; switch to USER node once the disk's owner is known.
RUN mkdir -p /data
EXPOSE 8080
CMD ["node", "--disable-warning=ExperimentalWarning", "src/server.js"]
