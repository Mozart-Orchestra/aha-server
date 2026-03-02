import { describe, expect, it } from 'vitest';
import { generateTeamCompositionPlan } from './teamComposition';

describe('generateTeamCompositionPlan', () => {
    it('creates dual-track multi-team plan for v1/v2 deployment goals', () => {
        const plan = generateTeamCompositionPlan({
            goal: '在 wow 上同时维护 v1 与 v2，完成 webappv2 + api/v2 部署回归',
            deploymentTarget: 'wow',
            mode: 'multi',
        });

        expect(plan.mode).toBe('multi');
        expect(plan.versionTrack).toBe('dual');
        expect(plan.teams.length).toBeGreaterThanOrEqual(2);
        expect(plan.teams.some((team) => team.versionTrack === 'v1')).toBe(true);
        expect(plan.teams.some((team) => team.versionTrack === 'v2')).toBe(true);
        expect(plan.teams.every((team) => typeof team.branchSuggestion === 'string' && team.branchSuggestion.length > 0)).toBe(true);
    });

    it('applies noise guard when history indicates readiness ping spam', () => {
        const plan = generateTeamCompositionPlan({
            goal: '多团队协作推进后端与前端任务',
            mode: 'multi',
            evolutionSignals: {
                readyPingRatio: 0.45,
                coordinatorMessageRatio: 0.55,
                historySampleSize: 120,
            },
        });

        expect(plan.recommendations.some((item) => item.includes('噪声偏高'))).toBe(true);
        for (const team of plan.teams) {
            expect(team.roleCounts.observer).toBeUndefined();
            if (team.roleCounts.orchestrator) {
                expect(team.roleCounts.orchestrator).toBeLessThanOrEqual(1);
            }
        }
    });

    it('keeps single-team mode compact for focused v2 delivery', () => {
        const plan = generateTeamCompositionPlan({
            goal: '迭代 v2 kanban 角色编辑体验',
            mode: 'single',
            versionTrack: 'v2',
        });

        expect(plan.mode).toBe('single');
        expect(plan.teams).toHaveLength(1);
        expect(plan.teams[0]?.roleCounts.master).toBe(1);
        expect(plan.teams[0]?.roleCounts.implementer).toBeGreaterThanOrEqual(1);
        expect(plan.teams[0]?.branchSuggestion.startsWith('feat/v2-')).toBe(true);
    });

    it('builds version release gates with three-end checks for wow deployment', () => {
        const plan = generateTeamCompositionPlan({
            goal: '在 wow 上做 v1/v2 双轨发布，要求同版本三端调试后才能关分支',
            mode: 'multi',
            deploymentTarget: 'wow',
        });

        expect(plan.releaseGates.length).toBeGreaterThanOrEqual(2);
        for (const gate of plan.releaseGates) {
            expect(gate.completionRule).toContain('三端调试');
            expect(gate.requiredChecks.map((check) => check.component)).toEqual([
                'aha-cli',
                'happy-server',
                'kanban',
            ]);
            for (const check of gate.requiredChecks) {
                expect(check.environments).toEqual(['uv1', 'uv2', 'wow']);
                expect(check.status).toBe('pending');
            }
        }
    });

    it('attaches evoMap scores for each recommended team', () => {
        const plan = generateTeamCompositionPlan({
            goal: '多团队推进前后端与发布联调',
            mode: 'multi',
            evolutionSignals: {
                readyPingRatio: 0.32,
                coordinatorMessageRatio: 0.46,
                deploymentIncidentRatio: 0.15,
                historySampleSize: 180,
            },
        });

        expect(plan.teams.length).toBeGreaterThan(0);
        for (const team of plan.teams) {
            expect(team.evoMap.score).toBeGreaterThanOrEqual(1);
            expect(team.evoMap.score).toBeLessThanOrEqual(5);
            expect(['S', 'A', 'B', 'C']).toContain(team.evoMap.tier);
            expect(['up', 'flat', 'down']).toContain(team.evoMap.trend);
            expect(team.evoMap.highlights.length).toBeGreaterThan(0);

            // V7-IMPL-005: Validate dimensions are included
            expect(team.evoMap.dimensions).toBeDefined();
            expect(team.evoMap.dimensions.delivery).toBeGreaterThanOrEqual(0);
            expect(team.evoMap.dimensions.delivery).toBeLessThanOrEqual(100);
            expect(team.evoMap.dimensions.quality).toBeGreaterThanOrEqual(0);
            expect(team.evoMap.dimensions.quality).toBeLessThanOrEqual(100);
            expect(team.evoMap.dimensions.collaboration).toBeGreaterThanOrEqual(0);
            expect(team.evoMap.dimensions.collaboration).toBeLessThanOrEqual(100);
            expect(team.evoMap.dimensions.release).toBeGreaterThanOrEqual(0);
            expect(team.evoMap.dimensions.release).toBeLessThanOrEqual(100);
        }
    });

    it('calculates EvoMap dimensions correctly based on team composition', () => {
        const plan = generateTeamCompositionPlan({
            goal: '高质量团队测试',
            mode: 'single',
            evolutionSignals: {
                readyPingRatio: 0.1,
                coordinatorMessageRatio: 0.2,
                deploymentIncidentRatio: 0.05,
                idleStatusRatio: 0.15,
            },
        });

        const team = plan.teams[0];
        expect(team).toBeDefined();

        // Verify dimensions affect overall score
        const avgDimensions =
            (team.evoMap.dimensions.delivery +
                team.evoMap.dimensions.quality +
                team.evoMap.dimensions.collaboration +
                team.evoMap.dimensions.release) /
            4;
        const expectedScore = Number((avgDimensions / 20).toFixed(1));
        expect(team.evoMap.score).toBeCloseTo(expectedScore, 1);
    });

    it('applies delivery penalties for high idle ratio', () => {
        const planHighIdle = generateTeamCompositionPlan({
            goal: '高闲置率团队测试',
            mode: 'single',
            evolutionSignals: {
                idleStatusRatio: 0.6,
                readyPingRatio: 0.3,
            },
        });

        const planLowIdle = generateTeamCompositionPlan({
            goal: '低闲置率团队测试',
            mode: 'single',
            evolutionSignals: {
                idleStatusRatio: 0.1,
                readyPingRatio: 0.1,
            },
        });

        const highIdleDelivery = planHighIdle.teams[0].evoMap.dimensions.delivery;
        const lowIdleDelivery = planLowIdle.teams[0].evoMap.dimensions.delivery;

        expect(highIdleDelivery).toBeLessThan(lowIdleDelivery);
    });

    it('applies quality and release penalties for deployment incidents', () => {
        const planWithIncidents = generateTeamCompositionPlan({
            goal: '高事故率团队测试',
            mode: 'single',
            evolutionSignals: {
                deploymentIncidentRatio: 0.25,
            },
        });

        const planClean = generateTeamCompositionPlan({
            goal: '低事故率团队测试',
            mode: 'single',
            evolutionSignals: {
                deploymentIncidentRatio: 0.02,
            },
        });

        const withIncidents = planWithIncidents.teams[0].evoMap.dimensions;
        const clean = planClean.teams[0].evoMap.dimensions;

        expect(withIncidents.quality).toBeLessThan(clean.quality);
        expect(withIncidents.release).toBeLessThan(clean.release);
    });

    it('awards bonus for wow deployment target in release dimension', () => {
        const planWow = generateTeamCompositionPlan({
            goal: 'WoW 部署测试',
            mode: 'single',
            deploymentTarget: 'wow',
        });

        const planLocal = generateTeamCompositionPlan({
            goal: '本地部署测试',
            mode: 'single',
            deploymentTarget: 'local',
        });

        const wowRelease = planWow.teams[0].evoMap.dimensions.release;
        const localRelease = planLocal.teams[0].evoMap.dimensions.release;

        expect(wowRelease).toBeGreaterThan(localRelease);
        expect(wowRelease - localRelease).toBe(8); // +8 bonus for wow
    });
});
