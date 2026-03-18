import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/storage/db', () => ({
    db: {
        artifact: { findFirst: vi.fn() },
        session: { findFirst: vi.fn() },
        teamContextEntry: {
            findMany: vi.fn(),
            findUnique: vi.fn(),
            upsert: vi.fn(),
            update: vi.fn(),
            delete: vi.fn(),
        },
    },
}));

import { db } from '@/storage/db';

import {
    TeamContextAccessError,
    TeamContextService,
    normalizeTeamContextKey,
} from './teamContextService';

describe('TeamContextService', () => {
    const service = new TeamContextService();

    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(db.artifact.findFirst).mockResolvedValue({ id: 'team-1' } as never);
    });

    it('normalizes context keys by trimming surrounding whitespace', () => {
        expect(normalizeTeamContextKey('  fact.current_goal  ')).toBe('fact.current_goal');
    });

    it('lists team context entries with filters after validating access', async () => {
        vi.mocked(db.teamContextEntry.findMany).mockResolvedValue([
            {
                key: 'fact.current_goal',
                kind: 'fact',
                value: { text: 'Ship Truth Layer' },
                summary: 'Current team goal',
                tags: ['goal', 'team'],
                version: 2,
                updatedBySessionId: 'session-1',
                updatedByRole: 'org-manager',
                createdAt: new Date('2026-03-17T00:00:00Z'),
                updatedAt: new Date('2026-03-17T00:01:00Z'),
            },
        ] as never);

        const result = await service.list('user-1', 'team-1', {
            prefix: 'fact.',
            kind: 'fact',
            limit: 10,
        });

        expect(db.teamContextEntry.findMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({
                    accountId: 'user-1',
                    teamId: 'team-1',
                    key: { startsWith: 'fact.' },
                    kind: 'fact',
                }),
                take: 10,
            }),
        );
        expect(result.items[0]).toMatchObject({
            key: 'fact.current_goal',
            kind: 'fact',
            summary: 'Current team goal',
            tags: ['goal', 'team'],
            version: 2,
        });
    });

    it('upserts a team context item and increments version on update', async () => {
        vi.mocked(db.session.findFirst).mockResolvedValue({
            id: 'session-1',
            metadata: JSON.stringify({ teamId: 'team-1' }),
        } as never);
        vi.mocked(db.teamContextEntry.upsert).mockResolvedValue({
            key: 'fact.current_goal',
            kind: 'fact',
            value: { text: 'Ship shared memory' },
            summary: null,
            tags: null,
            version: 3,
            updatedBySessionId: 'session-1',
            updatedByRole: 'implementer',
            createdAt: new Date('2026-03-17T00:00:00Z'),
            updatedAt: new Date('2026-03-17T00:02:00Z'),
        } as never);

        const item = await service.put('user-1', 'team-1', {
            sessionId: 'session-1',
            role: 'implementer',
            key: ' fact.current_goal ',
            value: { text: 'Ship shared memory' },
        });

        expect(db.teamContextEntry.upsert).toHaveBeenCalledWith(
            expect.objectContaining({
                where: {
                    accountId_teamId_key: {
                        accountId: 'user-1',
                        teamId: 'team-1',
                        key: 'fact.current_goal',
                    },
                },
                update: expect.objectContaining({
                    version: { increment: 1 },
                    updatedBySessionId: 'session-1',
                }),
            }),
        );
        expect(item.version).toBe(3);
    });

    it('patches an object value via shallow merge', async () => {
        vi.mocked(db.teamContextEntry.findUnique).mockResolvedValue({
            key: 'fact.current_goal',
            kind: 'fact',
            value: { text: 'Ship', owner: 'org-manager' },
            summary: 'Goal',
            tags: ['goal'],
        } as never);
        vi.mocked(db.teamContextEntry.update).mockResolvedValue({
            key: 'fact.current_goal',
            kind: 'fact',
            value: { text: 'Ship', owner: 'implementer' },
            summary: 'Goal',
            tags: ['goal'],
            version: 2,
            updatedBySessionId: 'session-2',
            updatedByRole: 'implementer',
            createdAt: new Date('2026-03-17T00:00:00Z'),
            updatedAt: new Date('2026-03-17T00:03:00Z'),
        } as never);

        const item = await service.patch('user-1', 'team-1', {
            sessionId: 'session-2',
            role: 'implementer',
            key: 'fact.current_goal',
            patch: { owner: 'implementer' },
        });

        expect(db.teamContextEntry.update).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    value: { text: 'Ship', owner: 'implementer' },
                    version: { increment: 1 },
                }),
            }),
        );
        expect(item.value).toEqual({ text: 'Ship', owner: 'implementer' });
    });

    it('rejects session-scoped access when the session belongs to another team', async () => {
        vi.mocked(db.session.findFirst).mockResolvedValue({
            id: 'session-1',
            metadata: JSON.stringify({ teamId: 'other-team' }),
        } as never);

        await expect(() => service.list('user-1', 'team-1', { sessionId: 'session-1' }))
            .rejects
            .toMatchObject({
                statusCode: 403,
            });
    });

    it('deletes an existing team context item after access validation', async () => {
        vi.mocked(db.teamContextEntry.delete).mockResolvedValue({ id: 'deleted' } as never);

        await service.delete('user-1', 'team-1', { key: 'fact.current_goal' });

        expect(db.teamContextEntry.delete).toHaveBeenCalledWith({
            where: {
                accountId_teamId_key: {
                    accountId: 'user-1',
                    teamId: 'team-1',
                    key: 'fact.current_goal',
                },
            },
        });
    });
});
