# Happy Role Definitions

**Single Source of Truth** for the Happy team role system.

This directory contains the unified role definition system that generates:
- `SKILL.md` files (oh-my-opencode format)
- `index.cjs` (Happy role library)
- Permission configurations

## Directory Structure

```
role-definitions/
├── ROLE_DEFINITIONS.yaml    # Single source of truth
├── scripts/
│   ├── validate-roles.js         # Validate YAML structure
│   ├── generate-skill-md.js      # Generate SKILL.md files
│   ├── generate-index-cjs.js     # Generate index.cjs
│   └── generate-all.js           # Generate all artifacts
├── package.json
└── README.md
```

## Usage

### Install Dependencies

```bash
cd happy-server/shared/role-definitions
npm install
```

### Validate Role Definitions

```bash
npm run validate
```

### Generate All Artifacts

```bash
npm run generate
```

Or generate individually:

```bash
npm run generate:skill-md    # Generate SKILL.md files
npm run generate:index-cjs   # Generate index.cjs
```

### Run Tests

```bash
npm test
```

## ROLE_DEFINITIONS.yaml Structure

The YAML file contains:

1. **Metadata**: Version information
2. **Global Settings**: Default execution settings, nested task settings, read-only tools
3. **Role Definitions**: Array of role objects with:
   - `id`: Unique identifier
   - `name`: Display name
   - `category`: Role category (coordination, product-planning, ux-design, architecture, implementation, support)
   - `description`: Role description
   - `metadata`: Model configuration (model, temperature, thinkingBudget)
   - `capabilities`: List of capabilities
   - `tools`: Required tools with access levels
   - `toolsToAvoid`: Tools to avoid with reasons
   - `protocols`: Collaboration and workflow protocols
   - `policy`: Permission policy
   - `successCriteria`: Success criteria

## Role Categories

### Coordination
- **Master Coordinator**: Plans, delegates, and coordinates team workflows

### Product Planning
- **Product Owner**: Defines product vision, manages backlog
- **Business Analyst**: Analyzes requirements and user needs (pending)
- **Spec Writer**: Writes technical specifications (pending)

### UX Design
- **UX Designer**: Designs user-centered experiences
- **Product Designer**: Creates visual designs and prototypes (pending)
- **UX Researcher**: Conducts user research (pending)

### Architecture
- **Solution Architect**: Designs system architecture and makes technical decisions
- **Architect**: Reviews technical designs (pending)

### Implementation
- **Builder / Executor**: Owns server-side implementation
- **Framing Engineer**: Creates implementation-ready designs for client-side

### Support
- **Scout / Explorer**: Explores codebase and gathers information
- **Scribe / Documenter**: Maintains project documentation
- **Quality Assurance**: Tests features and validates functionality
- **Reviewer / Observer**: Audits progress and validates deliveries
- **Technical Writer**: Writes technical documentation (pending)
- **Project Manager**: Manages project schedules and risks (pending)

## Adding a New Role

1. Edit `ROLE_DEFINITIONS.yaml`
2. Add new role object to `roles` array
3. Run `npm run validate` to check for errors
4. Run `npm run generate` to generate artifacts
5. Review generated files
6. Commit changes

Example:

```yaml
- id: new-role
  name: New Role
  category: support
  description: |
    Description of the new role and its responsibilities.

  metadata:
    model: claude-sonnet-4-5
    temperature: 0.3
    thinkingBudget: 32000

  capabilities:
    - "Capability 1"
    - "Capability 2"

  tools:
    - name: read
      access: allow
      description: "Read files"

  toolsToAvoid:
    - name: bash
      reason: "Not needed for this role"

  protocols:
    collaboration:
      - "Collaboration protocol 1"

  policy:
    permissionMode: read-only

  successCriteria:
    - "Success criterion 1"
```

## Validation

The validation script checks:

- Required fields are present
- Role IDs are unique
- Model names are valid
- Temperature is between 0 and 1
- Permission modes are valid
- Tools have required fields

## Outputs

### SKILL.md Files

Generated to: `kanban/sources/team-config/skills/<role-id>/SKILL.md`

Format: oh-my-opencode SKILL.md format with YAML frontmatter

### index.cjs

Generated to: `kanban/sources/team-config/index.cjs`

Format: Happy TEAM_ROLE_LIBRARY format

## Version History

- **2.0.0** (2026-01-18): Initial unified role definition system
  - Defined 10 core roles
  - Created generation scripts
  - Added validation

## Contributing

When modifying role definitions:

1. Make changes to `ROLE_DEFINITIONS.yaml`
2. Validate changes: `npm run validate`
3. Generate artifacts: `npm run generate`
4. Review generated files
5. Test with Happy team system
6. Submit PR with both YAML and generated files

## License

MIT
