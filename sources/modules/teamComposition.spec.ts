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
        }
    });
});
