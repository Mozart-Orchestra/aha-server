#!/usr/bin/env node

/**
 * V5-PERF-001 Performance Test
 * Measures query performance improvement after adding indexes
 */

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function measureQueryTime(queryFn, label) {
  const start = process.hrtime.bigint();
  const result = await queryFn();
  const end = process.hrtime.bigint();
  const durationMs = Number(end - start) / 1_000_000;

  console.log(`${label}: ${durationMs.toFixed(2)}ms`);
  return { label, durationMs, result };
}

async function main() {
  console.log('=== V5-PERF-001 Performance Test ===\n');

  try {
    // Test 1: Pattern matching query (rating_record.*)
    console.log('Test 1: Pattern matching query');
    await measureQueryTime(
      async () => await prisma.userKVStore.findMany({
        where: {
          key: { startsWith: 'rating_record.' }
        },
        orderBy: { updatedAt: 'desc' },
        take: 100
      }),
      '  Query time'
    );

    // Test 2: Pattern matching query (team_score.*)
    console.log('\nTest 2: Team score pattern query');
    await measureQueryTime(
      async () => await prisma.userKVStore.findMany({
        where: {
          key: { startsWith: 'team_score.' }
        },
        orderBy: { updatedAt: 'desc' },
        take: 100
      }),
      '  Query time'
    );

    // Test 3: Time-based query
    console.log('\nTest 3: Time-based query');
    const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    await measureQueryTime(
      async () => await prisma.userKVStore.findMany({
        where: {
          updatedAt: { gte: oneWeekAgo }
        },
        orderBy: { updatedAt: 'desc' },
        take: 100
      }),
      '  Query time'
    );

    // Test 4: Combined pattern + time query
    console.log('\nTest 4: Combined pattern + time query');
    await measureQueryTime(
      async () => await prisma.userKVStore.findMany({
        where: {
          AND: [
            { key: { startsWith: 'rating_analytics.' } },
            { updatedAt: { gte: oneWeekAgo } }
          ]
        },
        orderBy: { updatedAt: 'desc' },
        take: 100
      }),
      '  Query time'
    );

    console.log('\n=== Test Complete ===');
    console.log('\nExpected Results:');
    console.log('- Query time: < 50ms (was ~600ms before indexes)');
    console.log('- Improvement: ~12x faster');

  } catch (error) {
    console.error('Error running performance test:', error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main();
