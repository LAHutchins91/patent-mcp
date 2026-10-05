# Build Patent by Ouroboros and serve Streamable HTTP on /mcp.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY api ./api
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8787
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY logo.jpg ./logo.jpg
USER node
EXPOSE 8787
CMD ["node", "dist/src/server.js"]
