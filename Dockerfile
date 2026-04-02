FROM node:22-alpine AS build
WORKDIR /app
ENV NODE_ENV=production
ARG AGENT_BUILD_DATE=0
ENV AGENT_BUILD_DATE=${AGENT_BUILD_DATE}
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .
RUN addgroup -S appuser && adduser -S appuser -G appuser && chown -R appuser:appuser /app
USER appuser
CMD ["node", "app.js"]