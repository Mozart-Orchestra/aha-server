#!/usr/bin/env node

/**
 * Generate SKILL.md files from ROLE_DEFINITIONS.yaml
 *
 * This script reads the unified ROLE_DEFINITIONS.yaml and generates
 * individual SKILL.md files for each role in the oh-my-opencode format.
 *
 * Usage: node scripts/generate-skill-md.js
 */

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

// Paths
const ROLE_DEFINITIONS_PATH = path.join(__dirname, '../ROLE_DEFINITIONS.yaml');
const OUTPUT_BASE_DIR = path.join(__dirname, '../../../../kanban/sources/team-config/skills');

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
 * Generate SKILL.md content for a role
 */
function generateSkillMd(role) {
  const {
    name,
    description,
    metadata,
    capabilities = [],
    tools = [],
    toolsToAvoid = [],
    protocols = {},
    policy = {},
    successCriteria = []
  } = role;

  // YAML frontmatter
  let content = `---
name: ${name}
description: ${description.trim()}
license: MIT
compatibility: ohmyopencode
metadata:
  model: ${metadata.model}
  temperature: ${metadata.temperature}
  thinkingBudget: ${metadata.thinkingBudget}
---

`;

  // Capabilities
  if (capabilities.length > 0) {
    content += `### Capabilities
${capabilities.map(cap => `- ${cap}`).join('\n')}
`;
  }

  // Required Tools
  if (tools.length > 0) {
    content += `### Required Tools
${tools.map(tool => `- ${tool.name} (${tool.description || tool.access})`).join('\n')}
`;
  }

  // Tools To Avoid
  if (toolsToAvoid.length > 0) {
    content += `### Tools To Avoid
${toolsToAvoid.map(tool => `- ${tool.name}${tool.reason ? ` (${tool.reason})` : ''}`).join('\n')}
`;
  }

  // Collaboration Protocol
  if (protocols.collaboration && protocols.collaboration.length > 0) {
    content += `### Collaboration Protocol
${protocols.collaboration.map((p, i) => `${i + 1}. ${p}`).join('\n')}
`;
  }

  // Common Workflows
  if (protocols.workflows && protocols.workflows.length > 0) {
    content += `### Common Workflows
${protocols.workflows.map(workflow => {
  let workflowStr = `1. **${workflow.name}**:\n`;
  if (workflow.steps && workflow.steps.length > 0) {
    workflowStr += `   ${workflow.steps.map(s => `- ${s}`).join('\n   ')}\n`;
  }
  return workflowStr;
}).join('')}
`;
  }

  // Role-specific protocols (master, builder, framer, etc.)
  const roleSpecificProtocolKey = Object.keys(protocols).find(key =>
    ['master', 'builder', 'framer', 'scout', 'scribe', 'qa', 'reviewer'].includes(key)
  );

  if (roleSpecificProtocolKey) {
    const protocolLines = protocols[roleSpecificProtocolKey];
    if (protocolLines && protocolLines.length > 0) {
      content += `### ${roleSpecificProtocolKey.charAt(0).toUpperCase() + roleSpecificProtocolKey.slice(1)} Protocol
${protocolLines.join('\n')}
`;
    }
  }

  // Success Criteria
  if (successCriteria.length > 0) {
    content += `### Success Criteria
${successCriteria.map(criterion => `- ${criterion}`).join('\n')}
`;
  }

  return content;
}

/**
 * Write SKILL.md file for a role
 */
function writeSkillFile(role, outputDir) {
  const roleDir = path.join(outputDir, role.id);

  // Create role directory if it doesn't exist
  if (!fs.existsSync(roleDir)) {
    fs.mkdirSync(roleDir, { recursive: true });
  }

  // Generate SKILL.md content
  const content = generateSkillMd(role);

  // Write file
  const skillFilePath = path.join(roleDir, 'SKILL.md');
  fs.writeFileSync(skillFilePath, content, 'utf8');

  console.log(`✅ Generated: ${skillFilePath}`);
}

/**
 * Main function
 */
function main() {
  console.log('🚀 Generating SKILL.md files from ROLE_DEFINITIONS.yaml...\n');

  // Load role definitions
  const roleDefinitions = loadRoleDefinitions();
  const roles = roleDefinitions.roles;

  console.log(`📋 Found ${roles.length} roles to generate\n`);

  // Generate SKILL.md for each role
  let generated = 0;
  let skipped = 0;

  for (const role of roles) {
    try {
      writeSkillFile(role, OUTPUT_BASE_DIR);
      generated++;
    } catch (e) {
      console.error(`❌ Failed to generate SKILL.md for ${role.id}: ${e.message}`);
      skipped++;
    }
  }

  console.log(`\n✨ Generation complete!`);
  console.log(`   ✅ Generated: ${generated}`);
  console.log(`   ❌ Skipped: ${skipped}`);
  console.log(`   📁 Output directory: ${OUTPUT_BASE_DIR}`);
}

// Run if executed directly
if (require.main === module) {
  main();
}

module.exports = { generateSkillMd, loadRoleDefinitions };
