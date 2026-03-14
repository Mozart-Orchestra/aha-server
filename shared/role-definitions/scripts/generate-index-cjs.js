#!/usr/bin/env node

/**
 * Generate index.cjs from ROLE_DEFINITIONS.yaml
 *
 * This script reads the unified ROLE_DEFINITIONS.yaml and generates
 * the index.cjs file that defines the TEAM_ROLE_LIBRARY.
 *
 * Usage: node scripts/generate-index-cjs.js
 */

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

// Paths
const ROLE_DEFINITIONS_PATH = path.join(__dirname, '../ROLE_DEFINITIONS.yaml');
const OUTPUT_PATH = path.join(__dirname, '../../../../kanban/sources/team-config/index.cjs');

/**
 * Load ROLE_DEFINITIONS.yaml
 */
function loadRoleDefinitions() {
  try {
    const fileContents = fs.readFileSync(ROLE_DEFINITIONS_PATH, 'utf8');
    return yaml.load(fileContents);
  } catch (e) {
    console.error(`Failed to load ROLE_DEFINITIONS.yaml: ${e.message}`);
    process.exit(1);
  }
}

/**
 * Convert role to index.cjs format
 */
function convertRoleToIndexCjs(role, globalSettings) {
  const {
    id,
    name,
    category,
    description,
    capabilities = [],
    tools = [],
    toolsToAvoid = [],
    protocols = {},
    policy = {},
    successCriteria = []
  } = role;

  // Build role object
  const indexRole = {
    id,
    title: name,
    summary: description.split('\n')[0].trim(), // First line of description
    responsibilities: capabilities,
    abilityBoundaries: toolsToAvoid.map(tool => tool.reason || `Avoid ${tool.name}`),
    handoffProtocol: protocols.collaboration || [],
    protocol: []
  };

  // Add role-specific protocol if available
  const roleSpecificProtocolKey = Object.keys(protocols).find(key =>
    ['master', 'org-manager', 'builder', 'framer', 'scout', 'scribe', 'qa', 'reviewer'].includes(key)
  );

  if (roleSpecificProtocolKey && protocols[roleSpecificProtocolKey]) {
    indexRole.protocol = protocols[roleSpecificProtocolKey];
  }

  // Add policy if available
  if (Object.keys(policy).length > 0) {
    indexRole.policy = {};

    if (policy.permissionMode) {
      indexRole.policy.permissionMode = policy.permissionMode;
    }

    if (policy.accessLevel) {
      indexRole.policy.accessLevel = policy.accessLevel;
    }

    if (policy.autoStartMaster !== undefined) {
      indexRole.policy.autoStartMaster = policy.autoStartMaster;
    }

    if (policy.watchers) {
      indexRole.policy.watchers = [...policy.watchers];
    }

    if (policy.disallowedTools) {
      indexRole.policy.disallowedTools = [...policy.disallowedTools];
    }

    if (policy.taskSettings) {
      indexRole.policy.taskSettings = { ...policy.taskSettings };
    }
  }

  return indexRole;
}

/**
 * Generate index.cjs content
 */
function generateIndexCjs(roleDefinitions) {
  const { roles, globalSettings, teamConfiguration } = roleDefinitions;

  // Extract constants from global settings
  const readOnlyTools = globalSettings.readOnlyTools || [];
  const defaultStatusPropagation = globalSettings.defaultNestedTaskSettings?.statusPropagation || {};
  const defaultExecutionSettings = globalSettings.defaultNestedTaskSettings?.execution || {};
  const defaultNestedTaskSettings = globalSettings.defaultNestedTaskSettings || {};

  // Build content
  let content = `const READ_ONLY_TOOLS = ${JSON.stringify(readOnlyTools, null, 2)};

const DEFAULT_STATUS_PROPAGATION = ${JSON.stringify(defaultStatusPropagation, null, 2)};

const DEFAULT_EXECUTION_SETTINGS = ${JSON.stringify(defaultExecutionSettings, null, 2)};

const DEFAULT_NESTED_TASK_SETTINGS = ${JSON.stringify(defaultNestedTaskSettings, null, 2)};

`;

  // Generate TEAM_ROLE_LIBRARY
  content += `const TEAM_ROLE_LIBRARY = [
`;

  for (const role of roles) {
    const indexRole = convertRoleToIndexCjs(role, globalSettings);
    content += `  ${JSON.stringify(indexRole, null, 2).split('\n').join('\n  ')},
`;
  }

  content += `];

`;

  // Generate DEFAULT_TEAM_AGREEMENTS
  if (teamConfiguration && teamConfiguration.defaultAgreements) {
    content += `const DEFAULT_TEAM_AGREEMENTS = ${JSON.stringify(teamConfiguration.defaultAgreements, null, 2)};

`;
  }

  // Generate DEFAULT_KANBAN_COLUMNS
  if (teamConfiguration && teamConfiguration.kanbanColumns) {
    content += `const DEFAULT_KANBAN_COLUMNS = ${JSON.stringify(teamConfiguration.kanbanColumns, null, 2)};

`;
  }

  // Generate DEFAULT_KANBAN_BOARD
  content += `const DEFAULT_KANBAN_BOARD = {
  columns: DEFAULT_KANBAN_COLUMNS,
  tasks: [],
  taskSettings: { ...DEFAULT_NESTED_TASK_SETTINGS },
  team: {
    members: [],
    roles: TEAM_ROLE_LIBRARY.map(role => ({
      ...role,
      responsibilities: [...role.responsibilities],
      abilityBoundaries: [...role.abilityBoundaries],
      handoffProtocol: [...role.handoffProtocol],
      protocol: [...role.protocol],
      policy: role.policy ? {
        ...role.policy,
        watchers: role.policy.watchers ? [...role.policy.watchers] : undefined,
        disallowedTools: role.policy.disallowedTools ? [...role.policy.disallowedTools] : undefined,
        taskSettings: role.policy.taskSettings ? { ...role.policy.taskSettings } : undefined
      } : undefined
    })),
    agreements: { ...DEFAULT_TEAM_AGREEMENTS }
  }
};

`;

  // Generate TEAM_ROLE_MAP
  content += `const TEAM_ROLE_MAP = TEAM_ROLE_LIBRARY.reduce((acc, role) => {
  acc[role.id] = role;
  return acc;
}, {});

`;

  // Generate exports
  content += `module.exports = {
  READ_ONLY_TOOLS,
  TEAM_ROLE_LIBRARY,
  TEAM_ROLE_MAP,
  DEFAULT_TEAM_AGREEMENTS,
  DEFAULT_KANBAN_COLUMNS,
  DEFAULT_KANBAN_BOARD,
  DEFAULT_STATUS_PROPAGATION,
  DEFAULT_NESTED_TASK_SETTINGS
};
`;

  return content;
}

/**
 * Main function
 */
function main() {
  console.log('🚀 Generating index.cjs from ROLE_DEFINITIONS.yaml...\n');

  // Load role definitions
  const roleDefinitions = loadRoleDefinitions();

  // Generate index.cjs content
  const content = generateIndexCjs(roleDefinitions);

  // Write file
  fs.writeFileSync(OUTPUT_PATH, content, 'utf8');

  console.log(`✅ Generated: ${OUTPUT_PATH}`);
  console.log(`📋 Generated ${roleDefinitions.roles.length} roles\n`);
  console.log('✨ Generation complete!');
}

// Run if executed directly
if (require.main === module) {
  main();
}

module.exports = { generateIndexCjs, loadRoleDefinitions };
