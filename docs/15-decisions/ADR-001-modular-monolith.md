# ADR-001: Stack and Modular Monolith

Date: 2026-10-20

## Status
Accepted

## Context
We need a maintainable backend that avoids premature complexity. The product requires fast iteration with clear module boundaries and testability.

## Decision
- Use a TypeScript monorepo (pnpm + Turborepo) with strict type-checking.
- Implement a modular monolith: domain code is framework-agnostic and must not import Fastify, Prisma, or Redis.
- Use Fastify for the HTTP API, Pino for logging, PostgreSQL with Prisma and pgvector, Redis with BullMQ for jobs.
- No Next.js, no MongoDB, no Kubernetes at this stage.

## Consequences
- Lower operational complexity early on; easy to extract services later.
- Clear separation of domain vs. infrastructure code.
- Shared tooling (lint, typecheck, tests) across apps and packages.
