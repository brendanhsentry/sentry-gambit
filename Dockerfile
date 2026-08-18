FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN node scripts/fetch-maia-assets.mjs
RUN npm run build

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/.next ./.next
COPY --from=build /app/public ./public
COPY server.mjs game-store.mjs firestore-game-store.mjs next.config.mjs ./
EXPOSE 8080
CMD ["node", "server.mjs"]
