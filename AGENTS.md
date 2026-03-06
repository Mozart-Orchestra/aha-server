# Repository Guidelines

## Workspace Context First

Before changing code here, read these files in order:

1. `../AGENTS.md`
2. `../docs/context/00-system-map.md`
3. `../docs/context/01-contracts.md`
4. `../docs/context/03-current-focus.md`
5. `CLAUDE.md`

Do not begin by scanning the whole workspace.

## Repository Role

`happy-server-v20303` owns backend APIs, sync persistence, role and rating endpoints, team/task/board APIs, and server-side orchestration data.

## Project Structure

- `sources/app/` — application bootstrap and server entry code
- `sources/modules/` — reusable backend logic
- `sources/services/` — service-layer orchestration
- `sources/storage/` — database and persistence helpers
- `prisma/` — schema and migrations
- `tests/` — API and service tests

## Build, Test, and Development Commands

- `yarn build` — typecheck/build the server
- `yarn start` — start the server
- `yarn test` — run Vitest
- `yarn migrate` — apply Prisma migrations
- `yarn generate` — regenerate Prisma client
- `yarn db` — start local PostgreSQL helpers if configured

## Cross-Repo Hotspots

- role endpoints and role library semantics
- team board and task API response shapes
- auth, machine, and sync contract surfaces consumed by CLI and Kanban
- local role loading versus `../shared/team-config`

## Working Rules

- Changes to API response shape are cross-repo changes by default
- If you change role IDs, task payloads, or board payloads, update `../docs/context/01-contracts.md`
- Prefer durable backend rules in code or shared contracts, not one-off docs
- Keep root-level historical reports in `../docs/archive`, not in this repo
- For machine-scoped lifecycle routes, treat daemon-control ACKs as the source of truth: pass the target `machineId` through the control payload and avoid flipping DB session state before the daemon responds
- For team usage surfaces, keep `/v1/teams/:teamId/stats` as the canonical summary payload and share aggregation helpers with `/info` and `/usage/models` instead of recomputing token/model fields independently
