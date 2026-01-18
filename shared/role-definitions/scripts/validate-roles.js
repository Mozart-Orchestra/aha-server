#!/usr/bin/env node

/**
 * Validate ROLE_DEFINITIONS.yaml
 *
 * This script validates the structure and content of ROLE_DEFINITIONS.yaml
 * to ensure it meets the schema requirements.
 *
 * Usage: node scripts/validate-roles.js
 */

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

// Paths
const ROLE_DEFINITIONS_PATH = path.join(__dirname, '../ROLE_DEFINITIONS.yaml');

/**
 * Load ROLE_DEFINITIONS.yaml
 */
function loadRoleDefinitions() {
  try {
    const fileContents = fs.readFileSync(ROLE_DEFINITIONS_PATH, 'utf8');
    return yaml.load(fileContents);
  } catch (e) {
    console.error(`❌ Failed to load ROLE_DEFINITIONS.yaml: ${e.message}`);
    process.exit(1);
  }
}

/**
 * Validate role structure
 */
function validateRole(role, index) {
  const errors = [];
  const warnings = [];

  // Required fields
  const requiredFields = ['id', 'name', 'category', 'description', 'metadata'];
  for (const field of requiredFields) {
    if (!role[field]) {
      errors.push(`Role #${index + 1}: Missing required field '${field}'`);
    }
  }

  // Validate metadata
  if (role.metadata) {
    const requiredMetadata = ['model', 'temperature', 'thinkingBudget'];
    for (const field of requiredMetadata) {
      if (!role.metadata[field]) {
        errors.push(`Role ${role.id || index}: Missing required metadata field '${field}'`);
      }
    }

    // Validate model name
    if (role.metadata.model) {
      const validModels = [
        'claude-opus-4-5',
        'claude-sonnet-4-5',
        'claude-haiku-4',
        'gemini-2.5-pro',
        'gpt-4',
        'gpt-4-turbo'
      ];
      if (!validModels.includes(role.metadata.model)) {
        warnings.push(`Role ${role.id}: Unknown model '${role.metadata.model}'`);
      }
    }

    // Validate temperature range
    if (typeof role.metadata.temperature === 'number') {
      if (role.metadata.temperature < 0 || role.metadata.temperature > 1) {
        errors.push(`Role ${role.id}: Temperature must be between 0 and 1, got ${role.metadata.temperature}`);
      }
    }
  }

  // Validate tools
  if (role.tools) {
    for (const tool of role.tools) {
      if (!tool.name) {
        errors.push(`Role ${role.id}: Tool missing 'name' field`);
      }
      if (!tool.access) {
        warnings.push(`Role ${role.id}: Tool '${tool.name}' missing 'access' field`);
      }
    }
  }

  // Validate toolsToAvoid
  if (role.toolsToAvoid) {
    for (const tool of role.toolsToAvoid) {
      if (!tool.name) {
        errors.push(`Role ${role.id}: Tool to avoid missing 'name' field`);
      }
    }
  }

  // Validate policy
  if (role.policy) {
    const validPermissionModes = ['plan', 'yolo', 'read-only'];
    if (role.policy.permissionMode && !validPermissionModes.includes(role.policy.permissionMode)) {
      errors.push(`Role ${role.id}: Invalid permissionMode '${role.policy.permissionMode}'`);
    }
  }

  return { errors, warnings };
}

/**
 * Validate role definitions
 */
function validateRoleDefinitions(roleDefinitions) {
  const errors = [];
  const warnings = [];

  // Validate metadata
  if (!roleDefinitions.metadata) {
    errors.push('Missing top-level metadata');
  } else {
    if (!roleDefinitions.metadata.version) {
      errors.push('Missing metadata.version');
    }
    if (!roleDefinitions.metadata.schemaVersion) {
      warnings.push('Missing metadata.schemaVersion');
    }
  }

  // Validate global settings
  if (!roleDefinitions.globalSettings) {
    warnings.push('Missing globalSettings');
  }

  // Validate roles
  if (!roleDefinitions.roles || !Array.isArray(roleDefinitions.roles)) {
    errors.push('Missing or invalid roles array');
  } else {
    if (roleDefinitions.roles.length === 0) {
      errors.push('Roles array is empty');
    }

    // Check for duplicate role IDs
    const roleIds = new Set();
    for (const role of roleDefinitions.roles) {
      if (role.id) {
        if (roleIds.has(role.id)) {
          errors.push(`Duplicate role ID: ${role.id}`);
        }
        roleIds.add(role.id);
      }
    }

    // Validate each role
    for (let i = 0; i < roleDefinitions.roles.length; i++) {
      const role = roleDefinitions.roles[i];
      const validation = validateRole(role, i);
      errors.push(...validation.errors);
      warnings.push(...validation.warnings);
    }
  }

  // Validate team configuration
  if (!roleDefinitions.teamConfiguration) {
    warnings.push('Missing teamConfiguration');
  }

  return { errors, warnings };
}

/**
 * Main function
 */
function main() {
  console.log('🔍 Validating ROLE_DEFINITIONS.yaml...\n');

  // Load role definitions
  const roleDefinitions = loadRoleDefinitions();

  // Validate
  const { errors, warnings } = validateRoleDefinitions(roleDefinitions);

  // Print results
  if (errors.length > 0) {
    console.log('❌ Validation Errors:\n');
    errors.forEach(error => console.log(`   ❌ ${error}\n`));
  }

  if (warnings.length > 0) {
    console.log('⚠️  Warnings:\n');
    warnings.forEach(warning => console.log(`   ⚠️  ${warning}\n`));
  }

  // Print summary
  console.log('─'.repeat(50));
  console.log(`\n📊 Validation Summary:`);
  console.log(`   ✅ Valid: ${errors.length === 0}`);
  console.log(`   ❌ Errors: ${errors.length}`);
  console.log(`   ⚠️  Warnings: ${warnings.length}`);
  console.log(`   📋 Roles: ${roleDefinitions.roles?.length || 0}`);

  // Exit with appropriate code
  if (errors.length > 0) {
    console.log('\n❌ Validation failed!');
    process.exit(1);
  } else {
    console.log('\n✅ Validation passed!');
    if (warnings.length > 0) {
      console.log(`⚠️  Found ${warnings.length} warning(s)`);
    }
    process.exit(0);
  }
}

// Run if executed directly
if (require.main === module) {
  main();
}

module.exports = { validateRoleDefinitions, loadRoleDefinitions };
