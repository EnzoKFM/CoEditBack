FROM node:22-alpine

WORKDIR /app

RUN chown node:node /app

USER node

COPY --chown=node:node package.json package-lock.json ./
RUN npm ci

COPY --chown=node:node sql ./sql
COPY --chown=node:node src ./src
COPY --chown=node:node tests ./tests
COPY --chown=node:node vitest.config.js ./

EXPOSE 3000

CMD ["npm", "start"]
