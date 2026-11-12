FROM node:20-alpine
RUN apk add --no-cache ffmpeg
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY cricket-relay.js cricket-studio.html ./
ENV NODE_ENV=production
CMD ["node", "cricket-relay.js"]
