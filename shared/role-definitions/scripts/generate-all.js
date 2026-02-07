#!/usr/bin/env node

/**
 * Generate all artifacts from ROLE_DEFINITIONS.yaml
 *
 * This script runs validation, generates SKILL.md files, and generates index.cjs.
 *
 * Usage: node scripts/generate-all.js
 */

const { execSync } = require('child_process');
const path = require('path');

console.log('🚀 Starting complete generation process...\n');

try {
  // Step 1: Validate
  console.log('📋 Step 1: Validating ROLE_DEFINITIONS.yaml...');
  execSync('node scripts/validate-roles.js', {
    cwd: path.join(__dirname, '..'),
    stdio: 'inherit'
  });
  console.log('✅ Validation passed\n');

  // Step 2: Generate SKILL.md files
  console.log('📝 Step 2: Generating SKILL.md files...');
  execSync('node scripts/generate-skill-md.js', {
    cwd: path.join(__dirname, '..'),
    stdio: 'inherit'
  });
  console.log('✅ SKILL.md files generated\n');

  // Step 3: Generate index.cjs
  console.log('📦 Step 3: Generating index.cjs...');
  execSync('node scripts/generate-index-cjs.js', {
    cwd: path.join(__dirname, '..'),
    stdio: 'inherit'
  });
  console.log('✅ index.cjs generated\n');

  console.log('─'.repeat(50));
  console.log('\n✨ All artifacts generated successfully!');
  console.log('\nNext steps:');
  console.log('  1. Review generated files');
  console.log('  2. Commit changes to git');
  console.log('  3. Test with Aha team system');

} catch (error) {
  console.error('\n❌ Generation failed!');
  console.error(error.message);
  process.exit(1);
}
