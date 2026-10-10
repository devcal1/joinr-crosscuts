FROM node:20-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

# Whole-context copy (filtered by .dockerignore) instead of enumerating files —
# an enumerated COPY silently drops any new server-side file from the image.
COPY . .

ENV UPLOADS_DIR=/app/uploads
ENV DB_DIR=/app/db
ENV CONFIG_DIR=/app/config
ENV PORT=3000

EXPOSE 3000
CMD ["node", "server.js"]
