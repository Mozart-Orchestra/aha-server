# Genome Hub Proxy Routing

## Problem

`happy-server` proxies evolution and trial requests to genome-hub. In Docker, `localhost:3006` points back to the `happy-server` container, not the sibling `genome-hub` service. When `GENOME_HUB_URL` is unset, any proxy route that depends on genome-hub can fail with connection-level `AggregateError`, which surfaces to clients as `502`.

## Fix

- Keep honoring `GENOME_HUB_URL` when it is explicitly configured.
- When running inside Docker and no override is present, default to `http://genome-hub:3006`.
- Outside Docker, keep the local development default `http://localhost:3006`.

## Operational Note

If deployment wants a non-default topology, set `GENOME_HUB_URL` explicitly. The Docker fallback is only meant to cover the standard compose/network alias path and prevent silent regressions when the env var is missing.
