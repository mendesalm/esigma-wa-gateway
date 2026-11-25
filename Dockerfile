FROM node:22-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY src ./src

RUN mkdir -p /app/data/sessions

ENV HOST=0.0.0.0
ENV PORT=8004
ENV DATA_DIR=/app/data

EXPOSE 8004

CMD ["node", "src/server.js"]
