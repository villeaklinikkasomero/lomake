FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN apk add --no-cache --virtual .build python3 make g++ && npm ci --omit=dev && apk del .build
COPY src ./src
COPY public ./public
ENV NODE_ENV=production PORT=3000 DB_PATH=/data/kohtaamiset.db
VOLUME /data
EXPOSE 3000
CMD ["node", "src/server.js"]
