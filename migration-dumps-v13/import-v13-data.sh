#!/usr/bin/env bash
# import-v13-data.sh — 导入 v13 (15433) 的进化数据到目标 postgres
#
# 用法:
#   ./import-v13-data.sh <target-container> <target-port>
#
# 示例:
#   ./import-v13-data.sh redefine-login-v15-postgres-1 15435
#   ./import-v13-data.sh redefine-login-v13-postgres-1 15433   # 重新导入
#
# 前提: 目标 container 已运行，genome_hub/handy 数据库已存在

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

CONTAINER="${1:?用法: $0 <target-container> [target-port]}"
PORT="${2:-5432}"

echo "=== 导入目标: $CONTAINER (port $PORT) ==="

# ---------- 1. genome_hub ----------
echo ""
echo "--- genome_hub: schema ---"
docker exec -i "$CONTAINER" psql -U postgres -d genome_hub < "$SCRIPT_DIR/genome_hub_v13_schema.sql"

echo ""
echo "--- genome_hub: data (41 rows: Entity/Diff/DiffLedger/Trial/Verdict/EntityFavorite) ---"
docker exec -i "$CONTAINER" psql -U postgres -d genome_hub < "$SCRIPT_DIR/genome_hub_v13_data.sql"

# ---------- 2. handy (进化相关表) ----------
echo ""
echo "--- handy: schema (全量建表) ---"
docker exec -i "$CONTAINER" psql -U postgres -d handy < "$SCRIPT_DIR/handy_v13_schema.sql"

echo ""
echo "--- handy: evolution data (Account/Machine/Genome/Trial/Verdict) ---"
docker exec -i "$CONTAINER" psql -U postgres -d handy < "$SCRIPT_DIR/handy_v13_evolution.sql"

# ---------- 3. 验证 ----------
echo ""
echo "=== 验证 ==="
for db in genome_hub handy; do
  echo "--- $db ---"
  docker exec "$CONTAINER" psql -U postgres -d "$db" -c "
    SELECT schemaname, tablename,
           (xpath('/row/cnt/text()', xml_count))[1]::text::int AS row_count
    FROM (
      SELECT schemaname, tablename,
             query_to_xml(format('SELECT count(*) AS cnt FROM %I.%I', schemaname, tablename), false, true, '') AS xml_count
      FROM pg_tables
      WHERE schemaname = 'public'
    ) t
    ORDER BY tablename;
  " 2>/dev/null || echo "(表为空或不存在)"
done

echo ""
echo "=== 导入完成 ==="
