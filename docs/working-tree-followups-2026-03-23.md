# Working Tree Follow-ups — 2026-03-23

- Full `yarn build` is still blocked by pre-existing route-schema typing errors in `sources/app/api/routes/feedRoutes.ts`, `sources/app/api/routes/userRoutes.ts`, and `sources/app/api/routes/versionRoutes.ts`.
- After those unrelated typing issues are fixed, rerun `yarn build` and the full Vitest suite from a clean shell.
- Exercise the `/v1/genomes/:namespace/:name/feedback` proxy against a real genome-hub instance with `GENOME_HUB_PUBLISH_KEY` set.
