FROM node:20-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

# Whole-context copy (filtered by .dockerignore) instead of enumerating files —
# an enumerated COPY silently drops any new server-side file from the image.
COPY . .

# Data lives OUTSIDE /app: app/db/ is source code (migrations), so a volume
# mounted at /app/db would hide it. Host layout (data/db etc.) is unchanged.
ENV UPLOADS_DIR=/data/uploads
ENV DB_DIR=/data/db
ENV CONFIG_DIR=/data/config
ENV PORT=3000

EXPOSE 3000
CMD ["node", "server.js"]
