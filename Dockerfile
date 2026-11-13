FROM node:22-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm install --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
COPY sql ./sql
COPY public ./public
RUN npm run build
FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package*.json ./
RUN npm install --no-audit --no-fund --omit=dev && npm cache clean --force
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/sql ./sql
COPY --from=builder /app/public ./public
USER node
EXPOSE 8080
CMD ["node","dist/server.js"]
