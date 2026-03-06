import { z } from "zod";

export const META_CONTRACT_VERSION = "aha.meta.v1alpha1" as const;

const UnixTimestampSchema = z.coerce.number().int().min(0);

export const SharedStatusPropagationSchema = z.object({
    autoCompleteParent: z.boolean(),
    blockParentOnBlocked: z.boolean(),
    cascadeDeleteSubtasks: z.boolean(),
}).passthrough();

export const SharedExecutionSettingsSchema = z.object({
    requirePlan: z.boolean(),
    autoLinkSessions: z.boolean(),
    broadcastStatus: z.boolean(),
}).passthrough();

export const SharedNestedTaskSettingsSchema = z.object({
    maxDepth: z.number(),
    statusPropagation: SharedStatusPropagationSchema,
    execution: SharedExecutionSettingsSchema,
}).passthrough();

export const SharedTeamAgreementsSchema = z.object({
    statusUpdates: z.string().optional(),
    handoffs: z.string().optional(),
    escalation: z.string().optional(),
    definitionOfDone: z.string().optional(),
}).passthrough();

export const AgentRuntimeTargetSchema = z.object({
    flavor: z.string().optional(),
    provider: z.string().optional(),
    model: z.string().nullable().optional(),
    fallbackModel: z.string().nullable().optional(),
}).passthrough();

export const AgentPromptPolicySchema = z.object({
    seedRole: z.string().optional(),
    systemPrompt: z.string().nullable().optional(),
    appendPrompt: z.string().nullable().optional(),
}).passthrough();

export const AgentToolPolicySchema = z.object({
    allowed: z.array(z.string()).optional(),
    disallowed: z.array(z.string()).optional(),
    watchers: z.array(z.string()).optional(),
}).passthrough();

export const AgentPermissionPolicySchema = z.object({
    accessLevel: z.enum(["read-only", "full-access"]).optional(),
    permissionMode: z.string().optional(),
}).passthrough();

export const AgentBudgetPolicySchema = z.object({
    maxTurns: z.number().nullable().optional(),
    maxInputTokens: z.number().nullable().optional(),
    maxOutputTokens: z.number().nullable().optional(),
}).passthrough();

export const AgentMemoryPolicySchema = z.object({
    mode: z.enum(["inherit", "session", "task", "team", "external"]).optional(),
    strategy: z.enum(["none", "summary", "evidence-backed"]).optional(),
    storeId: z.string().nullable().optional(),
}).passthrough();

export const AgentEvaluationPolicySchema = z.object({
    mode: z.enum(["inherit", "manual", "sidecar", "milestone"]).optional(),
    triggers: z.array(z.string()).optional(),
    scorecardId: z.string().nullable().optional(),
}).passthrough();

export const AgentHookDefinitionSchema = z.object({
    id: z.string(),
    phase: z.enum(["before-start", "before-tool", "after-tool", "after-message", "before-finish"]),
    target: z.string().optional(),
}).passthrough();

export const AgentGenomeSchema = z.object({
    schemaVersion: z.string().default(META_CONTRACT_VERSION),
    id: z.string(),
    title: z.string().optional(),
    summary: z.string().optional(),
    runtime: AgentRuntimeTargetSchema.optional(),
    prompt: AgentPromptPolicySchema.optional(),
    tools: AgentToolPolicySchema.optional(),
    permissions: AgentPermissionPolicySchema.optional(),
    budgets: AgentBudgetPolicySchema.optional(),
    memory: AgentMemoryPolicySchema.optional(),
    evaluation: AgentEvaluationPolicySchema.optional(),
    hooks: z.array(AgentHookDefinitionSchema).optional(),
    defaults: z.object({
        inheritRolePolicy: z.boolean().optional(),
    }).optional(),
}).passthrough();

export type AgentGenome = z.infer<typeof AgentGenomeSchema>;

export const TeamBlueprintMemberSchema = z.object({
    id: z.string(),
    roleId: z.string().optional(),
    genomeId: z.string().optional(),
    title: z.string().optional(),
    count: z.number().optional(),
    machineId: z.string().nullable().optional(),
    agentType: z.string().nullable().optional(),
    agentLanguage: z.string().nullable().optional(),
}).passthrough();

export const TeamBlueprintSchema = z.object({
    schemaVersion: z.string().default(META_CONTRACT_VERSION),
    id: z.string(),
    title: z.string(),
    summary: z.string().optional(),
    agreements: SharedTeamAgreementsSchema.optional(),
    members: z.array(TeamBlueprintMemberSchema),
    taskSettings: SharedNestedTaskSettingsSchema.optional(),
    coordinationMode: z.enum(["strong", "weak"]).optional(),
}).passthrough();

export type TeamBlueprint = z.infer<typeof TeamBlueprintSchema>;

export const TaskRuntimeContextSchema = z.object({
    teamId: z.string().optional(),
    roomId: z.string().optional(),
    roomName: z.string().optional(),
    roleId: z.string().optional(),
    machineId: z.string().optional(),
    rootPath: z.string().optional(),
    agentLanguage: z.string().optional(),
    agentType: z.string().optional(),
    permissionMode: z.string().optional(),
}).passthrough();

export const TaskInputRefSchema = z.object({
    kind: z.enum(["text", "artifact", "task", "url", "file"]),
    value: z.string(),
    label: z.string().optional(),
}).passthrough();

export const TaskConstraintSchema = z.object({
    id: z.string(),
    text: z.string(),
}).passthrough();

export const TaskSuccessCriterionSchema = z.object({
    id: z.string(),
    text: z.string(),
}).passthrough();

export const TaskEnvelopeSchema = z.object({
    schemaVersion: z.string().default(META_CONTRACT_VERSION),
    id: z.string(),
    title: z.string(),
    summary: z.string().optional(),
    inputs: z.array(TaskInputRefSchema).optional(),
    constraints: z.array(TaskConstraintSchema).optional(),
    successCriteria: z.array(TaskSuccessCriterionSchema).optional(),
    runtimeContext: TaskRuntimeContextSchema.optional(),
    maxTurns: z.number().nullable().optional(),
    mode: z.string().nullable().optional(),
}).passthrough();

export const LogEnvelopeActorSchema = z.object({
    sessionId: z.string().optional(),
    roleId: z.string().optional(),
    userId: z.string().optional(),
    machineId: z.string().optional(),
}).passthrough();

export const LogEnvelopeSchema = z.object({
    schemaVersion: z.string().default(META_CONTRACT_VERSION),
    id: z.string(),
    eventType: z.string(),
    timestamp: z.number(),
    teamId: z.string().optional(),
    taskId: z.string().optional(),
    actor: LogEnvelopeActorSchema.optional(),
    payload: z.record(z.unknown()).optional(),
    evidence: z.array(z.string()).optional(),
}).passthrough();


export const TeamRoleSchema = z.object({
    id: z.string(),
    teamId: z.string(),
    name: z.string(),
    createdAt: UnixTimestampSchema,
    updatedAt: UnixTimestampSchema,
}).passthrough();
export type TeamRole = z.infer<typeof TeamRoleSchema>;

export const TeamMemberSchema = z.object({
    id: z.string().optional(),
    teamId: z.string(),
    sessionId: z.string(),
    roleId: z.string(),
    displayName: z.string().nullable().optional(),
    agentType: z.string().optional(),
    machineId: z.string().optional(),
    joinedAt: UnixTimestampSchema.optional(),
    createdAt: UnixTimestampSchema,
}).passthrough();
export type TeamMember = z.infer<typeof TeamMemberSchema>;

export const TeamSummarySchema = z.object({
    id: z.string(),
    name: z.string(),
    description: z.string().optional(),
    status: z.enum(['active', 'archived']).default('active'),
    memberCount: z.number().int().min(0).optional(),
    roleCount: z.number().int().min(0).optional(),
    taskCount: z.number().int().min(0).optional(),
    createdAt: UnixTimestampSchema,
    updatedAt: UnixTimestampSchema.optional(),
    blueprint: TeamBlueprintSchema.optional(),
    members: z.array(TeamMemberSchema).optional(),
    roles: z.array(TeamRoleSchema).optional(),
}).passthrough();
export type TeamSummary = z.infer<typeof TeamSummarySchema>;

export const TaskExecutionLinkSchema = z.object({
    sessionId: z.string(),
    linkedAt: UnixTimestampSchema,
    role: z.enum(['primary', 'supporting']),
    status: z.enum(['active', 'completed', 'abandoned']),
}).passthrough();

export const TaskBlockerSchema = z.object({
    id: z.string(),
    type: z.enum(['dependency', 'question', 'resource', 'technical']),
    description: z.string(),
    raisedAt: UnixTimestampSchema,
    raisedBy: z.string().optional(),
    resolvedAt: UnixTimestampSchema.optional(),
    resolvedBy: z.string().optional(),
    resolution: z.string().optional(),
}).passthrough();

export const TaskStageSchema = z.enum(['todo', 'in-progress', 'review', 'blocked', 'done']);

export const TeamTaskSchema = z.object({
    id: z.string(),
    title: z.string(),
    description: z.string().optional(),
    status: TaskStageSchema,
    assigneeId: z.string().nullable().optional(),
    reporterId: z.string().optional(),
    priority: z.enum(['low', 'medium', 'high', 'urgent']).optional(),
    createdAt: UnixTimestampSchema,
    updatedAt: UnixTimestampSchema,
    parentTaskId: z.string().nullable().optional(),
    subtaskIds: z.array(z.string()).optional(),
    depth: z.number().optional(),
    statusPropagation: SharedStatusPropagationSchema.optional(),
    hasBlockedChild: z.boolean().optional(),
    executionLinks: z.array(TaskExecutionLinkSchema).optional(),
    blockers: z.array(TaskBlockerSchema).optional(),
    labels: z.array(z.string()).optional(),
    dueDate: UnixTimestampSchema.nullable().optional(),
    dependencies: z.array(z.string()).optional(),
    approvalStatus: z.enum(['pending', 'approved', 'rejected']).optional(),
}).passthrough();
export type TeamTask = z.infer<typeof TeamTaskSchema>;

export const TaskItemSchema = TeamTaskSchema.extend({
    teamId: z.string(),
    assigneeDisplayName: z.string().nullable().optional(),
}).passthrough();
export type TaskItem = z.infer<typeof TaskItemSchema>;

export const TeamMessageTypeSchema = z.enum([
    'chat',
    'task-update',
    'task-created',
    'task-assigned',
    'notification',
    'role-assignment',
    'system',
    'collaboration-request',
    'help-needed',
    'handoff',
    'approval-request',
    'approval-decision'
]);

export const TeamMessageReactionSchema = z.object({
    emoji: z.string(),
    sessionIds: z.array(z.string())
}).passthrough();

export const TeamMessageMetadataSchema = z.object({
    taskId: z.string().optional(),
    taskSnapshot: TaskItemSchema.optional(),
    taskChange: z.object({
        field: z.string(),
        oldValue: z.unknown(),
        newValue: z.unknown()
    }).optional(),
    todoId: z.string().optional(),
    priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(),
    replyToId: z.string().optional(),
    attachmentIds: z.array(z.string()).optional(),
    edited: z.boolean().optional(),
    editedAt: z.number().optional(),
    reactions: z.array(TeamMessageReactionSchema).optional(),
    handshake: z.object({
        type: z.string().optional(),
        version: z.string().optional(),
        payload: z.record(z.unknown()).optional()
    }).optional()
}).passthrough();

export const TeamMessageSchema = z.object({
    id: z.string(),
    teamId: z.string(),
    fromSessionId: z.string().optional(),
    fromRole: z.string().optional(),
    fromDisplayName: z.string().optional(),
    content: z.string().max(2000),
    shortContent: z.string().optional(),
    type: TeamMessageTypeSchema,
    mentions: z.array(z.string()).optional(),
    timestamp: z.number(),
    metadata: TeamMessageMetadataSchema.optional()
}).passthrough();
export type TeamMessage = z.infer<typeof TeamMessageSchema>;

export const TeamMessageListResponseSchema = z.object({
    messages: z.array(TeamMessageSchema),
    hasMore: z.boolean(),
    cursor: z.string().optional()
});
