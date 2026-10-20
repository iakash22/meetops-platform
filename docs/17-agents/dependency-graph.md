# Dependency graph (high level)

- apps/api → @meetops/logger, @meetops/config
- apps/web → React, Vite, TanStack Router
- apps/worker → @meetops/queue, @meetops/logger, @meetops/config
- @meetops/queue → bullmq, ioredis, @meetops/config, @meetops/logger
- @meetops/storage → aws sdk s3, @meetops/contracts
- @meetops/ai-core → contracts only (no providers yet)
- @meetops/database → prisma client (schema minimal)
