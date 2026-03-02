import { describe, expect, it, beforeEach } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import * as path from 'path';

/**
 * Deployment Pipeline Tests
 *
 * Tests the V1/V2 deployment pipeline with:
 * - Progressive deployment: uv1 -> uv2 -> wow
 * - Three-endpoint synchronization validation
 * - Release gate enforcement
 */

// Get the correct scripts directory path
const getScriptsDir = () => {
    // If running from happy-server, go up to happy level then into scripts
    const currentDir = process.cwd();
    if (currentDir.includes('happy-server')) {
        return path.join(currentDir.replace('happy-server', ''), 'scripts');
    }
    return path.join(currentDir, '../../scripts');
};

const scriptsDir = getScriptsDir();

describe('Deployment Pipeline', () => {
    const deployPipelineScript = path.join(scriptsDir, 'deploy-vx-pipeline.sh');
    const deployVersionScript = path.join(scriptsDir, 'deploy-version.sh');
    const checkThreeEndsScript = path.join(scriptsDir, 'check-three-ends.sh');
    const deployUv1Script = path.join(scriptsDir, 'deploy-uv1.sh');
    const deployUv2Script = path.join(scriptsDir, 'deploy-uv2.sh');
    const versionConfigScript = path.join(scriptsDir, 'lib', 'version-config.sh');

    describe('Progressive Deployment Pipeline', () => {
        it('should define deployment pipeline with correct order: uv1 -> uv2 -> wow', () => {
            // Verify the pipeline script exists and has correct structure
            expect(existsSync(deployPipelineScript)).toBe(true);

            const pipelineContent = readFileSync(deployPipelineScript, 'utf8');

            // Check that the pipeline follows correct order
            expect(pipelineContent).toContain('Deploy uv1');
            expect(pipelineContent).toContain('Deploy uv2');
            expect(pipelineContent).toContain('Deploy wow');

            // Verify deployment order is correct (uv1 first, wow last)
            const uv1Index = pipelineContent.indexOf('Deploy uv1');
            const uv2Index = pipelineContent.indexOf('Deploy uv2');
            const wowIndex = pipelineContent.indexOf('Deploy wow');

            expect(uv1Index).toBeLessThan(uv2Index);
            expect(uv2Index).toBeLessThan(wowIndex);
        });

        it('should deploy uv1 environment with correct configuration', () => {
            expect(existsSync(deployUv1Script)).toBe(true);

            const content = readFileSync(deployUv1Script, 'utf8');

            // Verify uv1 configuration
            expect(content).toContain('uv');
            expect(content).toContain('3006');
            expect(content).toContain('happy-server-v2');
        });

        it('should deploy uv2 environment with correct configuration', () => {
            expect(existsSync(deployUv2Script)).toBe(true);

            const content = readFileSync(deployUv2Script, 'utf8');

            // Verify uv2 configuration
            expect(content).toContain('uv2');
            expect(content).toContain('3006');
            expect(content).toContain('happy-server-v2');
        });
    });

    describe('Three-Endpoint Synchronization', () => {
        it('should validate three-endpoint sync script exists', () => {
            expect(existsSync(checkThreeEndsScript)).toBe(true);

            const content = readFileSync(checkThreeEndsScript, 'utf8');

            // Verify all three endpoints are checked
            expect(content).toContain('aha-cli');
            expect(content).toContain('happy-server');
            expect(content).toContain('kanban');
        });

        it('should check TypeScript compilation for all endpoints', () => {
            const content = readFileSync(checkThreeEndsScript, 'utf8');

            // Verify TypeScript checks
            expect(content).toContain('typecheck');
            expect(content).toContain('yarn build');
        });

        it('should validate health checks for happy-server', () => {
            const content = readFileSync(checkThreeEndsScript, 'utf8');

            // Verify health check implementation
            expect(content).toContain('curl');
            expect(content).toContain('/health');
        });
    });

    describe('Release Gate Enforcement', () => {
        it('should require three-endpoint completion before branch closure', () => {
            const content = readFileSync(checkThreeEndsScript, 'utf8');

            // Verify completion rule enforcement
            expect(content).toContain('all_passed');
            expect(content).toContain('All three endpoints are in sync');
            expect(content).toContain('Please fix the issues above');
        });

        it('should return non-zero exit code on validation failure', () => {
            const content = readFileSync(checkThreeEndsScript, 'utf8');

            // Verify error handling with exit codes
            expect(content).toContain('exit 1');
            expect(content).toContain('return 1');
        });
    });

    describe('Version Configuration', () => {
        it('should define V1 and V2 version configurations', () => {
            expect(existsSync(versionConfigScript)).toBe(true);

            const content = readFileSync(versionConfigScript, 'utf8');

            // Verify V1 configuration
            expect(content).toContain('v1');
            expect(content).toContain('3005');
            expect(content).toContain('happy-server');

            // Verify V2 configuration
            expect(content).toContain('v2');
            expect(content).toContain('3006');
            expect(content).toContain('happy-server-v2');
        });

        it('should support version field extraction via jq', () => {
            const content = readFileSync(versionConfigScript, 'utf8');

            // Verify jq-based field extraction
            expect(content).toContain('get_version_field');
            expect(content).toContain('jq -r');
        });
    });
});

describe('Release Gates Integration', () => {
    /**
     * Integration tests for release gates system
     * Verifies the TypeScript release gate implementation works with shell scripts
     */

    it('should generate release gates with three-endpoint checks', async () => {
        // This test verifies the TypeScript implementation matches shell script behavior
        const { generateTeamCompositionPlan } = await import('./teamComposition.js');

        const plan = generateTeamCompositionPlan({
            goal: '在 wow 上完成 V2 部署，需要三端同步验证',
            deploymentTarget: 'wow',
            mode: 'multi',
        });

        // Verify release gates are generated
        expect(plan.releaseGates).toBeDefined();
        expect(Array.isArray(plan.releaseGates)).toBe(true);

        // Verify each gate has three-endpoint checks
        for (const gate of plan.releaseGates) {
            expect(gate.requiredChecks).toHaveLength(3);
            const components = gate.requiredChecks.map((check: any) => check.component);
            expect(components).toContain('aha-cli');
            expect(components).toContain('happy-server');
            expect(components).toContain('kanban');
        }
    });

    it('should validate environments matrix for wow deployment', async () => {
        const { generateTeamCompositionPlan } = await import('./teamComposition.js');

        const plan = generateTeamCompositionPlan({
            goal: '生产环境部署验证',
            deploymentTarget: 'wow',
        });

        // Verify environments for each gate
        for (const gate of plan.releaseGates) {
            for (const check of gate.requiredChecks) {
                expect(check.environments).toEqual(['uv1', 'uv2', 'wow']);
            }
        }
    });

    it('should enforce completion rule for branch closure', async () => {
        const { generateTeamCompositionPlan } = await import('./teamComposition.js');

        const plan = generateTeamCompositionPlan({
            goal: '版本发布：同版本三端调试全通过才可完成分支',
            deploymentTarget: 'wow',
        });

        // Verify completion rule is enforced
        for (const gate of plan.releaseGates) {
            expect(gate.completionRule).toBeDefined();
            expect(gate.completionRule).toContain('三端调试');
            expect(gate.completionRule).toContain('关闭分支');
        }
    });
});

describe('Deployment Pipeline End-to-End', () => {
    describe('script validation', () => {
        it('should have executable deployment scripts', () => {
            const scripts = [
                'deploy-uv1.sh',
                'deploy-uv2.sh',
                'deploy-vx-pipeline.sh',
                'deploy-version.sh',
                'check-three-ends.sh',
            ];

            for (const script of scripts) {
                const scriptPath = path.join(scriptsDir, script);
                expect(existsSync(scriptPath)).toBe(true);

                // Note: We can't easily test actual execution in CI environment
                // This is a structural validation test
            }
        });

        it('should have correct shebang in all scripts', () => {
            const scripts = ['deploy-uv1.sh', 'deploy-uv2.sh', 'deploy-version.sh'];

            for (const script of scripts) {
                const scriptPath = path.join(scriptsDir, script);
                const content = readFileSync(scriptPath, 'utf8');
                expect(content.startsWith('#!/bin/bash')).toBe(true);
            }
        });
    });
});
