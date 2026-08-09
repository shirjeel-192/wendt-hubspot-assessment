# --- build stage ---
FROM node:20-alpine AS build
WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev=false

COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts

RUN npx tsc

# --- runtime stage ---
FROM node:20-alpine
WORKDIR /app

# Only prod deps in the runtime image.
COPY package.json ./
RUN npm install --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist

ENV NODE_ENV=production
EXPOSE 8080

CMD ["node", "dist/src/server.js"]
