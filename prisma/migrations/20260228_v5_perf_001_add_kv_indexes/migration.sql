-- V5-PERF-001: Add performance indexes for UserKVStore
-- Target: Reduce query time from ~600ms to <50ms
--
-- Problem: Pattern matching queries on UserKVStore.key cause full table scans
-- Example queries:
--   - WHERE key LIKE 'rating_record.%'
--   - WHERE key LIKE 'team_score.%'
--   - WHERE key LIKE 'rating_analytics.%'
--
-- Solution: Add indexes for pattern matching and time-based queries

-- Index 1: Enable efficient pattern matching on key prefix
-- Supports queries like: WHERE key LIKE 'rating_record.%'
CREATE INDEX IF NOT EXISTS "UserKVStore_key_idx" ON "UserKVStore"("key");

-- Index 2: Enable efficient time-based queries
-- Supports queries like: ORDER BY updatedAt DESC
CREATE INDEX IF NOT EXISTS "UserKVStore_updatedAt_idx" ON "UserKVStore"("updatedAt" DESC);

-- Index 3: Composite index for pattern + time queries
-- Supports queries like: WHERE key LIKE 'rating_record.%' ORDER BY updatedAt DESC
CREATE INDEX IF NOT EXISTS "UserKVStore_key_updatedAt_idx" ON "UserKVStore"("key", "updatedAt" DESC);

-- Expected impact:
-- - Query time: ~600ms → <50ms (12x improvement)
-- - p95 latency: ~650ms → <200ms (3.25x improvement)
-- - Cache hit rate: N/A → Will be optimized in V5-PERF-002
