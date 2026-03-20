/**
 * seedSystemGenomes — ensures @official namespace system genomes exist on startup.
 *
 * Equivalent of "docker pull ubuntu:latest" for built-in agent roles:
 * supervisor, help-agent, org-manager get a genome record in the DB
 * so they are usable out-of-the-box without a CLI release.
 *
 * Strategy: upsert by namespace+name+version=1; never overwrites higher versions.
 */
import { db } from '@/storage/db';
import { log } from '@/utils/log';

interface SystemGenomeSeed {
    name: string;
    description: string;
    category: string;
    tags: string[];
    spec: object;
}

const SYSTEM_GENOMES: SystemGenomeSeed[] = [
    {
        name: 'supervisor',
        description: 'Seed supervisor agent. Periodically observes team activity, scores agents, and triggers intervention when stuck (two-phase: diff check then full analysis)',
        category: 'coordination',
        tags: ['supervisor', 'bypass', 'monitoring', 'periodic'],
        spec: {
            displayName: 'Supervisor',
            baseRoleId: 'supervisor',
            executionPlane: 'bypass',
            permissionMode: 'bypassPermissions',
            accessLevel: 'read-only',
            allowedTools: [
                'read_team_log', 'read_cc_log', 'read_runtime_log', 'list_team_cc_logs', 'list_team_runtime_logs',
                'list_team_agents', 'score_agent', 'score_supervisor_self', 'update_genome_feedback',
                'compact_agent', 'kill_agent', 'request_help',
                'save_supervisor_state', 'send_team_message',
            ],
            capabilities: ['monitor_agents', 'score_agents', 'detect_stuck', 'trigger_help'],
            responsibilities: [
                'Observe team agent activity via logs',
                'Score agents on delivery, integrity, efficiency',
                'Detect stuck or misbehaving agents',
                'Upload aggregate genome feedback back to the marketplace',
                'Trigger help-agent when needed via pendingAction',
            ],
            protocol: [
                'Phase 1: read_team_log with cursor, check hasNewContent',
                'If no new content and pendingAction exists: execute action, exit',
                'If no new content and no action: exit immediately (idle)',
                'Phase 2 (new content only): full log analysis + scoring + set pendingAction if stuck',
                'After scoring, call update_genome_feedback for each role/genome that now has enough evaluations',
                'Always call save_supervisor_state before exiting',
                'Output SUPERVISOR_COMPLETE when done',
            ],
        },
    },
    {
        name: 'help-agent',
        description: 'Seed help-agent. Responds to supervisor intervention requests, performs targeted repair, then auto-retires',
        category: 'support',
        tags: ['help-agent', 'bypass', 'repair', 'on-demand'],
        spec: {
            displayName: 'Help Agent',
            baseRoleId: 'help-agent',
            executionPlane: 'bypass',
            permissionMode: 'bypassPermissions',
            accessLevel: 'full-access',
            capabilities: ['fix_stuck_agents', 'context_repair', 'targeted_intervention'],
            responsibilities: [
                'Respond to a specific help request from supervisor',
                'Fix the described problem with minimal footprint',
                'Auto-terminate after completing the repair',
            ],
            protocol: [
                'Read the help request context carefully',
                'Fix only what was requested — do not expand scope',
                'Output HELP_COMPLETE when done',
                'Do NOT call send_team_message during repair',
            ],
        },
    },
    {
        name: 'org-manager',
        description: 'Seed org-manager. Receives user tasks, analyzes requirements, and assembles the right agent team to execute',
        category: 'coordination',
        tags: ['org-manager', 'bootstrap', 'team-builder', 'orchestrator'],
        spec: {
            displayName: 'Org Manager',
            baseRoleId: 'org-manager',
            executionPlane: 'mainline',
            permissionMode: 'bypassPermissions',
            accessLevel: 'full-access',
            allowedTools: [
                'get_team_info',
                'list_tasks',
                'list_available_agents',
                'create_agent',
                'create_task',
                'send_team_message',
                'read_team_log',
            ],
            capabilities: ['analyze_requirements', 'spawn_team', 'coordinate_agents'],
            responsibilities: [
                'Analyze user task and break it down into sub-tasks',
                'Inspect current team state before adding more agents',
                'Select appropriate agent roles for each sub-task',
                'Use create_agent to spawn team members',
                'Treat the marketplace as a memory warehouse, never as a blocking dependency',
                'Monitor high-level progress and unblock agents',
            ],
            protocol: [
                'On receiving task: analyze immediately, do NOT wait',
                'Inspect live team state via get_team_info and list_tasks first',
                'Marketplace is optional memory only — if no fit exists, continue assembling the team',
                'Use create_agent to spawn agents with specific roles',
                'Use create_task to seed the initial backlog',
                'Assign clear tasks to each agent via send_team_message',
                'Monitor team log for completion or blockers',
            ],
        },
    },
];

/**
 * Seeds @official system genomes into the database.
 * Uses the first existing account as the owner (avoids creating a dummy system account
 * that might collide with the unique publicKey constraint on Account).
 * If no accounts exist yet, seeding is skipped — it will run again on next startup.
 */
export async function seedSystemGenomes(): Promise<void> {
    log({ module: 'startup' }, 'Seeding system genomes (@official namespace)...');

    const anyAccount = await db.account.findFirst();
    if (!anyAccount) {
        log({ module: 'startup' }, 'No accounts found, skipping system genome seeding (will retry on next startup)');
        return;
    }
    const accountId = anyAccount.id;

    for (const seed of SYSTEM_GENOMES) {
        try {
            const existing = await db.genome.findFirst({
                where: { namespace: '@official', name: seed.name },
                orderBy: { version: 'desc' },
            });

            if (!existing) {
                await db.genome.create({
                    data: {
                        accountId,
                        namespace: '@official',
                        name: seed.name,
                        description: seed.description,
                        category: seed.category,
                        tags: JSON.stringify(seed.tags),
                        spec: JSON.stringify(seed.spec),
                        parentSessionId: 'system',
                        isPublic: true,
                        version: 1,
                    },
                });
                log({ module: 'startup' }, `Created @official/${seed.name}:v1`);
            } else {
                log({ module: 'startup' }, `@official/${seed.name}:v${existing.version} already exists, skipping`);
            }
        } catch (error: any) {
            log({ module: 'startup', level: 'error' }, `Failed to seed @official/${seed.name}: ${error.message}`);
        }
    }

    log({ module: 'startup' }, 'System genome seeding complete');
}
