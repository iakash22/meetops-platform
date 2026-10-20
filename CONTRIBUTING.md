## Contributing to MeetOps AI

- Branches: `feat/*`, `fix/*`, `chore/*`, `docs/*`
- Commits: follow Conventional Commits (feat:, fix:, chore:, docs:, ci:, refactor:, test:)
- Open a pull request to `main`; all PRs must pass CI and review

### Local development
1. cp .env.example .env
2. pnpm install
3. docker compose -f infra/compose/compose.dev.yml up -d
4. pnpm dev

### Code quality
- pnpm lint
- pnpm typecheck
- pnpm test
