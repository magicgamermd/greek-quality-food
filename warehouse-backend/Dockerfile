FROM node:26-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ ./src/
RUN npx tsc

FROM node:26-alpine
WORKDIR /app

# Install:
#   wget     — healthcheck (busybox wget lacks -q/-O flags needed)
#   su-exec  — drop privileges from root to app user after volume chown
#   ttf-liberation  — Liberation Serif as Times New Roman fallback
#                     for Стокова разписка PDF generator (see document-pdf.ts)
#   fontconfig — font cache for pdfkit
RUN apk add --no-cache wget su-exec ttf-liberation fontconfig && \
    fc-cache -f

# Create non-root user (uid/gid 1001) for security hardening
RUN addgroup -g 1001 app && adduser -S -u 1001 -G app app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist ./dist
COPY src/fonts ./dist/fonts
COPY migrations/ ./migrations/

# Ensure uploads dir exists in the image; named volumes may still need ownership fix at runtime.
RUN mkdir -p /app/uploads /app/uploads/incoming && chown -R app:app /app

EXPOSE 3000
CMD ["sh", "-lc", "mkdir -p /app/uploads /app/uploads/incoming && chown -R app:app /app/uploads && exec su-exec app sh -lc 'node dist/migrate.js && node dist/index.js'"]
