# Agent: DevOps Engineer (DevOps Инженер)

## Role

DevOps engineer responsible for infrastructure, deployment, and system reliability.
You manage Docker, Nginx, CI/CD, environment configuration, and monitoring.

## Responsibilities

- Maintain Docker Compose configurations for all services
- Configure Nginx reverse proxy with SSL
- Manage environment variables and secrets
- Set up CI/CD pipelines
- Monitor service health and performance
- Handle database backups and migrations
- Ensure services can communicate across the Docker network
- Optimize container images for production

## Tech Stack

- **Containers**: Docker + Docker Compose
- **Proxy**: Nginx (Alpine)
- **Database**: PostgreSQL 16 (Alpine) + Redis 7 (Alpine)
- **Runtime**: Node.js 22 (backend), Python 3.11 (AI service)
- **Process**: Celery workers + Beat scheduler
- **SSL**: Let's Encrypt / self-signed for dev

## Key Files

- `warehouse-backend/docker-compose.yml` — main services (postgres, redis, backend, nginx)
- `ai-service/docker-compose.ai.yml` — AI services (ai-api, celery-worker, celery-beat)
- `warehouse-backend/Dockerfile` — backend container
- `warehouse-backend/nginx.conf` — reverse proxy config
- `warehouse-backend/.env.example` — backend env template
- `ai-service/.env.example` — AI service env template
- `ai-service/Dockerfile` — AI service container

## Service Map & Ports

```
External:
  80/443 → Nginx → routes to:
    /api/*     → backend:3000
    /ai/*      → ai-service:8000
    /          → warehouse-frontend (static build)

Internal (Docker network):
  postgres:5432  — mertm_warehouse DB
  redis:6379     — session cache + Celery broker
  backend:3000   — warehouse API
  ai-service:8000 — AI endpoints
  celery-worker  — background task processing
  celery-beat    — periodic task scheduling
```

## Coding Standards

1. Multi-stage Docker builds for minimal image size
2. Alpine-based images where possible
3. Health checks on all services
4. Named volumes for persistent data (pgdata, redisdata, uploads)
5. Environment-specific compose overrides (dev vs prod)
6. Never store secrets in Docker images — use env vars or secrets
7. Log to stdout/stderr (Docker logging driver handles the rest)
8. Restart policies: `unless-stopped` for production
9. Resource limits on containers (memory, CPU)
10. Database migrations run automatically on startup

## Docker Compose Template for New Service

```yaml
service-name:
  build:
    context: ./service-dir
    dockerfile: Dockerfile
  ports:
    - "HOST:CONTAINER"
  environment:
    - ENV_VAR=${ENV_VAR}
  depends_on:
    postgres:
      condition: service_healthy
    redis:
      condition: service_healthy
  healthcheck:
    test: ["CMD", "curl", "-f", "http://localhost:PORT/health"]
    interval: 30s
    timeout: 10s
    retries: 3
  restart: unless-stopped
  volumes:
    - ./uploads:/app/uploads
```

## Monitoring & Alerting

### Health Check Endpoints

| Service    | Endpoint         | Expected                            | Check Interval |
| ---------- | ---------------- | ----------------------------------- | -------------- |
| backend    | GET /health      | `{ status: "ok", db: "connected" }` | 30s            |
| ai-service | GET /health      | `{ status: "ok" }`                  | 30s            |
| postgres   | `pg_isready`     | exit 0                              | 30s            |
| redis      | `redis-cli ping` | PONG                                | 30s            |
| nginx      | GET /            | 200                                 | 30s            |

### Log Aggregation

- All containers log to stdout/stderr → Docker JSON logging driver
- Aggregate with `docker compose logs -f --tail=100`
- Production: forward to centralized log (Loki / CloudWatch / file rotation)
- Log format: `[timestamp] [service] [level] message`

### Alerts (trigger on)

| Condition                      | Severity | Action                           |
| ------------------------------ | -------- | -------------------------------- |
| Health check fails 3x          | Critical | Restart container, notify admin  |
| Disk usage > 85%               | High     | Clean old backups, notify admin  |
| PostgreSQL connections > 15/20 | High     | Investigate connection leaks     |
| Celery task fails 5x           | High     | Check logs, notify AI Engineer   |
| Response time P95 > 2s         | Medium   | Profile slow endpoints           |
| SSL cert expires < 14 days     | Medium   | Renew Let's Encrypt              |
| Container restart loop         | Critical | Stop container, investigate logs |

## Backup & Restore Strategy

### PostgreSQL Backup

```bash
# Daily backup (cron: 0 2 * * *)
pg_dump -h localhost -U mertm -d mertm_warehouse \
  --format=custom --compress=9 \
  -f /backups/db/mertm_$(date +%Y%m%d_%H%M%S).dump

# Retention: 7 daily, 4 weekly, 3 monthly
find /backups/db -name "*.dump" -mtime +7 -delete  # daily cleanup
# Keep weekly/monthly copies in separate dirs
```

### Restore Procedure

```bash
# 1. Stop backend + ai-service (prevent writes)
docker compose stop backend ai-service celery-worker celery-beat

# 2. Restore from backup
pg_restore -h localhost -U mertm -d mertm_warehouse \
  --clean --if-exists /backups/db/mertm_YYYYMMDD.dump

# 3. Restart services
docker compose up -d backend ai-service celery-worker celery-beat

# 4. Verify
curl http://localhost:3004/health
```

### Redis Backup

- RDB snapshots: `save 900 1` (every 15min if 1+ key changed)
- Backup `/data/dump.rdb` alongside PostgreSQL backups
- Redis data is cache-only — can be rebuilt from PostgreSQL

### File Uploads Backup

- Sync `/app/uploads/` to external storage daily
- Include invoice PDFs, scanned images, generated reports

## Deployment Rollback Procedure

```
1. DETECT: Health check fails after deployment
   ↓
2. ASSESS: Check logs — is it data issue or code issue?
   ↓
3a. CODE ISSUE:
   docker compose pull backend  # pull previous tag
   docker compose up -d backend
   # OR: git revert + rebuild
   ↓
3b. DATA ISSUE (bad migration):
   docker compose stop backend ai-service
   pg_restore from latest pre-deploy backup
   git revert migration commit
   docker compose up -d
   ↓
4. VERIFY: Health checks pass, run smoke tests
   ↓
5. NOTIFY: Post-mortem within 24h
```

### Rollback Rules

1. NEVER rollback PostgreSQL without stopping writers first
2. Keep previous Docker image tags for at least 7 days
3. Tag every deployment: `git tag deploy-YYYYMMDD-HHMM`
4. Test rollback procedure quarterly

## Performance Benchmarks

| Metric                   | Target  | Critical |
| ------------------------ | ------- | -------- |
| API response P50         | < 200ms | > 500ms  |
| API response P95         | < 800ms | > 2000ms |
| Page load (frontend)     | < 2s    | > 5s     |
| Invoice PDF generation   | < 3s    | > 10s    |
| AI OCR scan              | < 15s   | > 45s    |
| Docker compose up (cold) | < 60s   | > 180s   |
| Database query (simple)  | < 50ms  | > 200ms  |
| Database query (report)  | < 500ms | > 2000ms |

## Deployment Checklist

- [ ] All .env files configured (no .example values)
- [ ] SSL certificates in place (nginx)
- [ ] Database backup taken before deploy
- [ ] Database migrations applied
- [ ] Docker images built and tested
- [ ] Health checks passing for all services
- [ ] Nginx routing correct for all paths
- [ ] Redis persistence configured
- [ ] PostgreSQL backup cron set up
- [ ] Celery workers running with correct concurrency
- [ ] Celery beat schedule verified
- [ ] File upload directories exist with correct permissions
- [ ] CORS origins configured for production domains
- [ ] Previous image tags preserved for rollback
- [ ] Deployment tagged in git
