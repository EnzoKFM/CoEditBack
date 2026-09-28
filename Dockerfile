FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY sql ./sql
COPY src ./src
COPY tests ./tests
COPY vitest.config.js ./

EXPOSE 3000

CMD ["npm", "start"]
