export type VersionTrack = 'v1' | 'v2' | 'dual';
export type TeamPlanMode = 'single' | 'multi';
export type DeploymentTarget = 'wow' | 'uv1' | 'uv2' | 'local' | 'generic';
export type ReleaseEnvironment = 'uv1' | 'uv2' | 'wow' | 'local';
export type TeamEvoTier = 'S' | 'A' | 'B' | 'C';
export type TeamEvoTrend = 'up' | 'flat' | 'down';

export interface TeamEvolutionSignals {
    readyPingRatio?: number;
    coordinatorMessageRatio?: number;
    deploymentIncidentRatio?: number;
    idleStatusRatio?: number;
    cliFocusRatio?: number;
    serverFocusRatio?: number;
    kanbanFocusRatio?: number;
    historySampleSize?: number;
}

export interface TeamCompositionRequest {
    goal: string;
    context?: string;
    versionTrack?: VersionTrack;
    mode?: TeamPlanMode;
    maxTeams?: number;
    deploymentTarget?: DeploymentTarget;
    evolutionSignals?: TeamEvolutionSignals;
}

export interface TeamEvolutionMap {
    score: number;
    tier: TeamEvoTier;
    trend: TeamEvoTrend;
    highlights: string[];
    dimensions: {
        delivery: number;
        quality: number;
        collaboration: number;
        release: number;
    };
}

export interface TeamPlanSlice {
    key: string;
    name: string;
    objective: string;
    versionTrack: 'v1' | 'v2' | 'shared';
    branchSuggestion: string;
    roleCounts: Record<string, number>;
    evoMap: TeamEvolutionMap;
    rationale: string[];
    risks: string[];
}

export interface VersionReleaseGateCheck {
    component: 'aha-cli' | 'happy-server' | 'kanban';
    environments: ReleaseEnvironment[];
    status: 'pending' | 'passed' | 'failed';
}

export interface VersionReleaseGate {
    versionTrack: 'v1' | 'v2' | 'shared';
    branch: string;
    completionRule: string;
    requiredChecks: VersionReleaseGateCheck[];
}

export interface TeamCompositionPlan {
    mode: TeamPlanMode;
    versionTrack: VersionTrack;
    deploymentTarget: DeploymentTarget;
    inferredFocus: string[];
    constraints: string[];
    recommendations: string[];
    signalsUsed: Required<TeamEvolutionSignals>;
    teams: TeamPlanSlice[];
    releaseGates: VersionReleaseGate[];
}

const READY_PING_HIGH = 0.25;
const COORDINATOR_CHAT_HIGH = 0.4;
const DEPLOY_INCIDENT_HIGH = 0.08;
const IDLE_STATUS_HIGH = 0.35;
const FOCUS_RATIO_STRONG = 0.1;

function hasKeyword(text: string, keywords: string[]): boolean {
    return keywords.some((keyword) => text.includes(keyword));
}

export function detectFocus(goal: string, context?: string): string[] {
    const text = `${goal} ${context || ''}`.toLowerCase();
    const focus = new Set<string>();

    if (hasKeyword(text, ['deploy', '部署', '发布', 'ssh', 'wow', 'nginx', 'pm2', '上线', 'api/v2', 'webappv2', 'uv1', 'uv2'])) {
        focus.add('deployment');
    }
    if (hasKeyword(text, ['api', 'server', 'backend', 'route', 'prisma', 'redis', 'db', '数据库', '后端'])) {
        focus.add('backend');
    }
    if (hasKeyword(text, ['kanban', 'webapp', 'ui', 'frontend', 'expo', 'react', '前端', '页面', '交互'])) {
        focus.add('frontend');
    }
    if (hasKeyword(text, ['role', 'agent', 'team', 'orchestrator', '调度', '编组', '多团队', '角色', '协作'])) {
        focus.add('orchestration');
    }
    if (hasKeyword(text, ['research', 'investigate', 'analyze', '调研', '分析', '复盘'])) {
        focus.add('research');
    }
    if (hasKeyword(text, ['test', 'qa', '验证', '质量', '回归'])) {
        focus.add('quality');
    }

    if (focus.size === 0) {
        focus.add('delivery');
    }

    return Array.from(focus);
}

function inferVersionTrack(request: TeamCompositionRequest, inferredFocus: string[]): VersionTrack {
    if (request.versionTrack) {
        return request.versionTrack;
    }

    const text = `${request.goal} ${request.context || ''}`.toLowerCase();
    const hasV1 = hasKeyword(text, [' v1', 'v1 ', '/webapp', 'legacy', '旧版']);
    const hasV2 = hasKeyword(text, [' v2', 'v2 ', '/api/v2', '/webappv2', '新版']);

    if (hasV1 && hasV2) {
        return 'dual';
    }

    if (hasV1) {
        return 'v1';
    }

    if (hasV2 || inferredFocus.includes('deployment')) {
        return 'v2';
    }

    return 'v2';
}

function inferMode(request: TeamCompositionRequest, versionTrack: VersionTrack, inferredFocus: string[]): TeamPlanMode {
    if (request.mode) {
        return request.mode;
    }

    if (versionTrack === 'dual' || inferredFocus.includes('orchestration')) {
        return 'multi';
    }

    return 'single';
}

function normalizeSignals(signals?: TeamEvolutionSignals): Required<TeamEvolutionSignals> {
    return {
        readyPingRatio: Math.max(0, Math.min(1, signals?.readyPingRatio ?? 0)),
        coordinatorMessageRatio: Math.max(0, Math.min(1, signals?.coordinatorMessageRatio ?? 0)),
        deploymentIncidentRatio: Math.max(0, Math.min(1, signals?.deploymentIncidentRatio ?? 0)),
        idleStatusRatio: Math.max(0, Math.min(1, signals?.idleStatusRatio ?? 0)),
        cliFocusRatio: Math.max(0, Math.min(1, signals?.cliFocusRatio ?? 0)),
        serverFocusRatio: Math.max(0, Math.min(1, signals?.serverFocusRatio ?? 0)),
        kanbanFocusRatio: Math.max(0, Math.min(1, signals?.kanbanFocusRatio ?? 0)),
        historySampleSize: Math.max(0, Math.floor(signals?.historySampleSize ?? 0)),
    };
}

function trimZeroRoles(roleCounts: Record<string, number>): Record<string, number> {
    return Object.fromEntries(
        Object.entries(roleCounts).filter(([, count]) => count > 0)
    );
}

function toBranchSlug(key: string): string {
    return key.replace(/[^a-z0-9-]/gi, '-').replace(/-{2,}/g, '-').replace(/^-|-$/g, '').toLowerCase();
}

function buildBranchSuggestion(versionTrack: 'v1' | 'v2' | 'shared', key: string): string {
    const slug = toBranchSlug(key || 'team');
    if (versionTrack === 'v1') {
        return `feat/v1-${slug}`;
    }
    if (versionTrack === 'v2') {
        return `feat/v2-${slug}`;
    }
    return `feat/v1v2-${slug}`;
}

function emptyEvoMap(): TeamEvolutionMap {
    return {
        score: 3,
        tier: 'B',
        trend: 'flat',
        highlights: ['等待历史信号回填以生成更精准评分'],
        dimensions: {
            delivery: 60,
            quality: 60,
            collaboration: 60,
            release: 60,
        },
    };
}

function buildSingleTeam(versionTrack: VersionTrack, inferredFocus: string[]): TeamPlanSlice {
    const backendHeavy = inferredFocus.includes('backend');
    const frontendHeavy = inferredFocus.includes('frontend');
    const orchestrationHeavy = inferredFocus.includes('orchestration');
    const researchHeavy = inferredFocus.includes('research');
    const qualityHeavy = inferredFocus.includes('quality') || inferredFocus.includes('deployment');

    const implementerCount = 1 + (backendHeavy ? 1 : 0) + (frontendHeavy ? 1 : 0);

    return {
        key: 'core-delivery',
        name: versionTrack === 'v1' ? 'V1 核心保障组' : versionTrack === 'v2' ? 'V2 核心迭代组' : '双轨核心交付组',
        objective: '集中完成核心任务并保持可交付节奏',
        versionTrack: versionTrack === 'dual' ? 'shared' : versionTrack,
        branchSuggestion: buildBranchSuggestion(versionTrack === 'dual' ? 'shared' : versionTrack, 'core-delivery'),
        roleCounts: trimZeroRoles({
            master: 1,
            orchestrator: orchestrationHeavy ? 1 : 0,
            architect: backendHeavy || frontendHeavy || qualityHeavy ? 1 : 0,
            implementer: Math.min(3, implementerCount),
            builder: backendHeavy ? 1 : 0,
            framer: frontendHeavy ? 1 : 0,
            'qa-engineer': qualityHeavy ? 1 : 0,
            researcher: researchHeavy ? 1 : 0,
        }),
        evoMap: emptyEvoMap(),
        rationale: [
            '单团队模式优先缩短沟通链路',
            '按后端/前端负载自动调整 implementer 数量',
        ],
        risks: [
            '当目标跨 V1/V2 时，单团队容易在发布窗口出现上下文切换成本',
        ],
    };
}

function buildDualTrackTeams(inferredFocus: string[]): TeamPlanSlice[] {
    const deploymentHeavy = inferredFocus.includes('deployment');
    const backendHeavy = inferredFocus.includes('backend');
    const frontendHeavy = inferredFocus.includes('frontend');

    const v1Guard: TeamPlanSlice = {
        key: 'v1-guard',
        name: 'V1 稳定性保障组',
        objective: '保证 /webapp 与 v1 API 兼容稳定，避免回归',
        versionTrack: 'v1',
        branchSuggestion: buildBranchSuggestion('v1', 'v1-guard'),
        roleCounts: trimZeroRoles({
            master: 1,
            architect: 1,
            implementer: 1,
            builder: backendHeavy ? 1 : 0,
            framer: frontendHeavy ? 1 : 0,
            'qa-engineer': 1,
        }),
        evoMap: emptyEvoMap(),
        rationale: [
            'V1 以稳定性为先，避免引入多余角色噪声',
            '以最小团队守住兼容与回归验证',
        ],
        risks: [
            '若需求快速变化，单 implementer 可能形成瓶颈',
        ],
    };

    const v2Delivery: TeamPlanSlice = {
        key: 'v2-delivery',
        name: 'V2 功能迭代组',
        objective: '推进 /webappv2 + /api/v2 的核心需求迭代',
        versionTrack: 'v2',
        branchSuggestion: buildBranchSuggestion('v2', 'v2-delivery'),
        roleCounts: trimZeroRoles({
            master: 1,
            orchestrator: 1,
            architect: 1,
            implementer: inferredFocus.includes('frontend') && inferredFocus.includes('backend') ? 3 : 2,
            builder: backendHeavy ? 1 : 0,
            framer: frontendHeavy ? 1 : 0,
            'qa-engineer': 1,
            researcher: inferredFocus.includes('research') ? 1 : 0,
        }),
        evoMap: emptyEvoMap(),
        rationale: [
            'V2 组承接主要功能增量与实验性改造',
            '保留 orchestrator 处理并行任务编排',
        ],
        risks: [
            '若未同步发布策略，可能与 V1 环境配置产生偏差',
        ],
    };

    const teams = [v1Guard, v2Delivery];

    if (deploymentHeavy) {
        teams.push({
            key: 'release-bridge',
            name: '发布联调组',
            objective: '负责 wow 环境联调、Nginx/PM2 验证与回滚预案',
            versionTrack: 'shared',
            branchSuggestion: buildBranchSuggestion('shared', 'release-bridge'),
            roleCounts: trimZeroRoles({
                master: 1,
                architect: 1,
                implementer: 1,
                'qa-engineer': 1,
            }),
            evoMap: emptyEvoMap(),
            rationale: [
                '将发布联调从功能开发中解耦，缩短问题定位路径',
            ],
            risks: [
                '需要与两条研发流水线严格同步版本号与部署时间窗',
            ],
        });
    }

    return teams;
}

function buildMultiTeams(versionTrack: VersionTrack, inferredFocus: string[]): TeamPlanSlice[] {
    if (versionTrack === 'dual') {
        return buildDualTrackTeams(inferredFocus);
    }

    const core = buildSingleTeam(versionTrack, inferredFocus);
    const qualityBridge: TeamPlanSlice = {
        key: 'quality-bridge',
        name: versionTrack === 'v1' ? 'V1 质量护栏组' : 'V2 质量护栏组',
        objective: '聚焦测试、发布验证与回滚演练',
        versionTrack,
        branchSuggestion: buildBranchSuggestion(versionTrack, 'quality-bridge'),
        roleCounts: trimZeroRoles({
            master: 1,
            architect: 1,
            'qa-engineer': 1,
            implementer: 1,
        }),
        evoMap: emptyEvoMap(),
        rationale: [
            '拆分质量护栏组可降低主实现组被测试上下文打断',
        ],
        risks: [
            '若需求规模较小，多团队可能引入额外协调成本',
        ],
    };

    return [core, qualityBridge];
}

function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
}

function applyComponentSignals(
    teams: TeamPlanSlice[],
    signals: Required<TeamEvolutionSignals>,
    recommendations: string[]
): void {
    if (signals.serverFocusRatio >= FOCUS_RATIO_STRONG) {
        for (const team of teams) {
            if (team.versionTrack === 'v2' || team.versionTrack === 'shared') {
                team.roleCounts.builder = Math.max(team.roleCounts.builder || 0, 1);
            }
            team.roleCounts = trimZeroRoles(team.roleCounts);
        }
        recommendations.push('日志显示后端关注度较高，已为 V2/共享团队补齐 builder 角色。');
    }

    if (signals.kanbanFocusRatio >= FOCUS_RATIO_STRONG) {
        for (const team of teams) {
            if (team.versionTrack === 'v2' || team.versionTrack === 'shared') {
                team.roleCounts.framer = Math.max(team.roleCounts.framer || 0, 1);
            }
            team.roleCounts = trimZeroRoles(team.roleCounts);
        }
        recommendations.push('日志显示 Kanban 前端关注度较高，已为 V2/共享团队补齐 framer 角色。');
    }

    if (signals.cliFocusRatio >= FOCUS_RATIO_STRONG / 2) {
        for (const team of teams) {
            team.roleCounts.implementer = Math.max(team.roleCounts.implementer || 0, 1);
            team.roleCounts['qa-engineer'] = Math.max(team.roleCounts['qa-engineer'] || 0, 1);
            team.roleCounts = trimZeroRoles(team.roleCounts);
        }
        recommendations.push('日志显示 CLI 协作链路活跃，已强化 implementer + qa-engineer 基线配置。');
    }
}

function applyEvolutionSignals(
    teams: TeamPlanSlice[],
    signals: Required<TeamEvolutionSignals>,
    recommendations: string[]
): void {
    const noisy = signals.readyPingRatio >= READY_PING_HIGH
        || signals.coordinatorMessageRatio >= COORDINATOR_CHAT_HIGH
        || signals.idleStatusRatio >= IDLE_STATUS_HIGH;

    if (noisy) {
        for (const team of teams) {
            if (team.roleCounts.master > 1) {
                team.roleCounts.master = 1;
            }
            if (team.roleCounts.orchestrator && team.roleCounts.orchestrator > 1) {
                team.roleCounts.orchestrator = 1;
            }
            if (team.roleCounts.researcher && team.roleCounts.researcher > 1) {
                team.roleCounts.researcher = 1;
            }
            delete team.roleCounts.observer;
            team.roleCounts = trimZeroRoles(team.roleCounts);
        }

        recommendations.push('检测到历史 ready/standby 噪声偏高，已自动收敛协调角色数量并禁用 observer 默认编入。');
    }

    if (signals.deploymentIncidentRatio >= DEPLOY_INCIDENT_HIGH) {
        for (const team of teams) {
            team.roleCounts['qa-engineer'] = Math.max(team.roleCounts['qa-engineer'] || 0, 1);
            team.roleCounts.architect = Math.max(team.roleCounts.architect || 0, 1);
            team.roleCounts = trimZeroRoles(team.roleCounts);
        }

        recommendations.push('历史部署异常偏高，已为每个团队强制补齐 architect + qa-engineer 组合。');
    }

    if (signals.historySampleSize < 20) {
        recommendations.push('历史样本较少，建议先按当前编组执行 1~2 个迭代并回填数据后再自动进化。');
    }
}

function buildTeamEvoMap(
    team: TeamPlanSlice,
    signals: Required<TeamEvolutionSignals>,
    deploymentTarget: DeploymentTarget
): TeamEvolutionMap {
    const implementerCount = team.roleCounts.implementer || 0;
    const builderCount = team.roleCounts.builder || 0;
    const framerCount = team.roleCounts.framer || 0;
    const qaCount = team.roleCounts['qa-engineer'] || 0;
    const architectCount = team.roleCounts.architect || 0;
    const orchestratorCount = team.roleCounts.orchestrator || 0;

    const idlePenalty = signals.idleStatusRatio * 18 + signals.readyPingRatio * 10;
    const incidentPenalty = signals.deploymentIncidentRatio * 28;
    const coordinatorPenalty = signals.coordinatorMessageRatio * 16;

    const deliveryScore = clamp(
        45 + (implementerCount + builderCount + framerCount) * 10 - idlePenalty,
        0,
        100
    );
    const qualityScore = clamp(
        40 + qaCount * 22 + architectCount * 15 - incidentPenalty,
        0,
        100
    );
    const collaborationScore = clamp(
        65 + orchestratorCount * 6 - coordinatorPenalty - signals.readyPingRatio * 8,
        0,
        100
    );
    const releaseScore = clamp(
        48 + qaCount * 18 + architectCount * 14 + (deploymentTarget === 'wow' ? 8 : 0) - incidentPenalty,
        0,
        100
    );

    const average100 = (deliveryScore + qualityScore + collaborationScore + releaseScore) / 4;
    const score = Number(clamp(average100 / 20, 1, 5).toFixed(1));
    const tier: TeamEvoTier = score >= 4.5 ? 'S' : score >= 4 ? 'A' : score >= 3.2 ? 'B' : 'C';

    let trend: TeamEvoTrend = 'flat';
    if (signals.deploymentIncidentRatio >= 0.12 || signals.idleStatusRatio >= 0.45) {
        trend = 'down';
    } else if (signals.deploymentIncidentRatio <= 0.05 && signals.idleStatusRatio <= 0.25) {
        trend = 'up';
    }

    const highlights: string[] = [];
    if (qaCount > 0 && architectCount > 0) {
        highlights.push('质量护栏完整（architect + qa-engineer）');
    }
    if (builderCount > 0 || framerCount > 0) {
        highlights.push('覆盖三端实现角色（builder/framer）');
    }
    if (signals.deploymentIncidentRatio >= DEPLOY_INCIDENT_HIGH) {
        highlights.push('部署风险偏高，建议加密 uv1/uv2 预发布回归');
    }
    if (highlights.length === 0) {
        highlights.push('建议继续回填评分与交付数据，提升 EvoMap 可信度');
    }

    return {
        score,
        tier,
        trend,
        highlights,
        dimensions: {
            delivery: deliveryScore,
            quality: qualityScore,
            collaboration: collaborationScore,
            release: releaseScore,
        },
    };
}

function attachTeamEvoMap(
    teams: TeamPlanSlice[],
    signals: Required<TeamEvolutionSignals>,
    deploymentTarget: DeploymentTarget,
    recommendations: string[]
): void {
    for (const team of teams) {
        team.evoMap = buildTeamEvoMap(team, signals, deploymentTarget);
    }

    if (teams.some((team) => team.evoMap.tier === 'C')) {
        recommendations.push('EvoMap 显示存在 C 级团队，建议先补齐角色与发布门禁再推进大规模并行开发。');
    }
}

function resolveEnvironmentMatrix(target: DeploymentTarget): ReleaseEnvironment[] {
    if (target === 'wow') {
        return ['uv1', 'uv2', 'wow'];
    }
    if (target === 'uv1') {
        return ['uv1'];
    }
    if (target === 'uv2') {
        return ['uv2'];
    }
    if (target === 'local') {
        return ['local'];
    }
    return ['uv2', 'wow'];
}

function buildReleaseGates(teams: TeamPlanSlice[], deploymentTarget: DeploymentTarget): VersionReleaseGate[] {
    const seen = new Set<'v1' | 'v2' | 'shared'>();
    const orderedTracks: Array<'v1' | 'v2' | 'shared'> = ['v1', 'v2', 'shared'];
    for (const team of teams) {
        seen.add(team.versionTrack);
    }

    const environments = resolveEnvironmentMatrix(deploymentTarget);
    const gates: VersionReleaseGate[] = [];

    for (const track of orderedTracks) {
        if (!seen.has(track)) {
            continue;
        }
        const branch = track === 'shared' ? 'release/v1v2-integration' : `release/${track}-integration`;
        gates.push({
            versionTrack: track,
            branch,
            completionRule: '同版本分支必须完成三端调试（aha-cli/happy-server/kanban）后才能关闭分支',
            requiredChecks: [
                { component: 'aha-cli', environments, status: 'pending' },
                { component: 'happy-server', environments, status: 'pending' },
                { component: 'kanban', environments, status: 'pending' },
            ],
        });
    }

    return gates;
}

export function generateTeamCompositionPlan(request: TeamCompositionRequest): TeamCompositionPlan {
    const goal = request.goal?.trim();
    if (!goal) {
        throw new Error('goal is required');
    }

    const inferredFocus = detectFocus(goal, request.context);
    const versionTrack = inferVersionTrack(request, inferredFocus);
    const mode = inferMode(request, versionTrack, inferredFocus);
    const deploymentTarget = request.deploymentTarget || 'wow';
    const maxTeams = Math.min(5, Math.max(1, request.maxTeams ?? 3));
    const signals = normalizeSignals(request.evolutionSignals);

    const constraints: string[] = [];
    if (deploymentTarget === 'wow') {
        constraints.push('wow 当前采用 V1(3005,/webapp) + V2(3006,/api/v2,/webappv2) 双通道部署。');
        constraints.push('发布验证顺序固定为 uv1 -> uv2 -> wow。');
    } else if (deploymentTarget === 'uv1' || deploymentTarget === 'uv2') {
        constraints.push(`${deploymentTarget} 作为预发布环境，仅允许对应阶段调试通过后再推进下一阶段。`);
    }
    constraints.push('默认关闭 observer 的自动编入，避免团队状态噪声放大。');
    constraints.push('同一版本分支必须完成 aha-cli/happy-server/kanban 三端调试后，才可标记完成。');

    const recommendations: string[] = [];

    const initialTeams = mode === 'multi'
        ? buildMultiTeams(versionTrack, inferredFocus)
        : [buildSingleTeam(versionTrack, inferredFocus)];

    applyComponentSignals(initialTeams, signals, recommendations);
    applyEvolutionSignals(initialTeams, signals, recommendations);

    const teams = initialTeams.slice(0, maxTeams);
    if (initialTeams.length > maxTeams) {
        recommendations.push(`已根据 maxTeams=${maxTeams} 截断建议团队数量。`);
    }

    attachTeamEvoMap(teams, signals, deploymentTarget, recommendations);

    if (deploymentTarget === 'wow' && versionTrack === 'dual') {
        recommendations.push('发布顺序建议：先 V2 灰度验证，再执行 V1 回归，最后统一刷新 Nginx/PM2 观测。');
    }

    return {
        mode,
        versionTrack,
        deploymentTarget,
        inferredFocus,
        constraints,
        recommendations,
        signalsUsed: signals,
        teams,
        releaseGates: buildReleaseGates(teams, deploymentTarget),
    };
}
