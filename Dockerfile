FROM node:22-alpine AS build
WORKDIR /app
ENV NODE_ENV=production
ARG AGENT_BUILD_DATE=0
ENV AGENT_BUILD_DATE=${AGENT_BUILD_DATE}
# git binary — required by diagnostics/gitops.js (GitOps-aware remediation:
# clone/commit/push the minimal repo edit for an approved Doctor action).
RUN apk add --no-cache git
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .
RUN addgroup -S appuser && adduser -S appuser -G appuser && chown -R appuser:appuser /app
USER appuser
CMD ["node", "app.js"]