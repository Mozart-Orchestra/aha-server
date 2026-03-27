import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
    eventRouter,
    type ClientConnection,
    type RecipientFilter,
    type UpdatePayload,
} from './eventRouter';

type MockConnectionInput =
    | { connectionType: 'session-scoped'; userId: string; sessionId: string }
    | { connectionType: 'user-scoped'; userId: string }
    | { connectionType: 'machine-scoped'; userId: string; machineId: string };

function makeConnection(connection: MockConnectionInput) {
    return {
        ...connection,
        socket: {
            emit: vi.fn(),
        } as any,
    };
}

function emitUpdate(filter: RecipientFilter, skipSenderConnection?: ClientConnection) {
    const payload: UpdatePayload = {
        id: 'update-1',
        seq: 1,
        body: { t: 'task-updated', teamId: 'team-1', taskId: 'task-1', task: {} },
        createdAt: 1,
    };

    eventRouter.emitUpdate({
        userId: 'user-1',
        payload,
        recipientFilter: filter,
        skipSenderConnection,
    });

    return payload;
}

describe('eventRouter', () => {
    beforeEach(() => {
        (eventRouter as any).userConnections = new Map();
    });

    it('routes specific-sessions updates to matching session-scoped and all user-scoped connections', () => {
        const allowedSession = makeConnection({
            connectionType: 'session-scoped',
            userId: 'user-1',
            sessionId: 'session-1',
        });
        const otherSession = makeConnection({
            connectionType: 'session-scoped',
            userId: 'user-1',
            sessionId: 'session-2',
        });
        const userScoped = makeConnection({
            connectionType: 'user-scoped',
            userId: 'user-1',
        });
        const machineScoped = makeConnection({
            connectionType: 'machine-scoped',
            userId: 'user-1',
            machineId: 'machine-1',
        });

        eventRouter.addConnection('user-1', allowedSession);
        eventRouter.addConnection('user-1', otherSession);
        eventRouter.addConnection('user-1', userScoped);
        eventRouter.addConnection('user-1', machineScoped);

        const payload = emitUpdate({ type: 'specific-sessions', sessionIds: new Set(['session-1']) });

        expect((allowedSession.socket.emit as any)).toHaveBeenCalledWith('update', payload);
        expect((userScoped.socket.emit as any)).toHaveBeenCalledWith('update', payload);
        expect((otherSession.socket.emit as any)).not.toHaveBeenCalled();
        expect((machineScoped.socket.emit as any)).not.toHaveBeenCalled();
    });

    it('routes machine-scoped updates to user-scoped plus the targeted machine only', () => {
        const userScoped = makeConnection({
            connectionType: 'user-scoped',
            userId: 'user-1',
        });
        const matchingMachine = makeConnection({
            connectionType: 'machine-scoped',
            userId: 'user-1',
            machineId: 'machine-1',
        });
        const otherMachine = makeConnection({
            connectionType: 'machine-scoped',
            userId: 'user-1',
            machineId: 'machine-2',
        });
        const sessionScoped = makeConnection({
            connectionType: 'session-scoped',
            userId: 'user-1',
            sessionId: 'session-1',
        });

        eventRouter.addConnection('user-1', userScoped);
        eventRouter.addConnection('user-1', matchingMachine);
        eventRouter.addConnection('user-1', otherMachine);
        eventRouter.addConnection('user-1', sessionScoped);

        const payload = emitUpdate({ type: 'machine-scoped-only', machineId: 'machine-1' });

        expect((userScoped.socket.emit as any)).toHaveBeenCalledWith('update', payload);
        expect((matchingMachine.socket.emit as any)).toHaveBeenCalledWith('update', payload);
        expect((otherMachine.socket.emit as any)).not.toHaveBeenCalled();
        expect((sessionScoped.socket.emit as any)).not.toHaveBeenCalled();
    });

    it('routes session-interest updates to matching session-scoped plus user-scoped connections', () => {
        const matchingSession = makeConnection({
            connectionType: 'session-scoped',
            userId: 'user-1',
            sessionId: 'session-1',
        });
        const otherSession = makeConnection({
            connectionType: 'session-scoped',
            userId: 'user-1',
            sessionId: 'session-2',
        });
        const userScoped = makeConnection({
            connectionType: 'user-scoped',
            userId: 'user-1',
        });
        const machineScoped = makeConnection({
            connectionType: 'machine-scoped',
            userId: 'user-1',
            machineId: 'machine-1',
        });

        eventRouter.addConnection('user-1', matchingSession);
        eventRouter.addConnection('user-1', otherSession);
        eventRouter.addConnection('user-1', userScoped);
        eventRouter.addConnection('user-1', machineScoped);

        const payload = emitUpdate({ type: 'all-interested-in-session', sessionId: 'session-1' });

        expect((matchingSession.socket.emit as any)).toHaveBeenCalledWith('update', payload);
        expect((userScoped.socket.emit as any)).toHaveBeenCalledWith('update', payload);
        expect((otherSession.socket.emit as any)).not.toHaveBeenCalled();
        expect((machineScoped.socket.emit as any)).not.toHaveBeenCalled();
    });

    it('skips echoing to the sender connection when skipSenderConnection is provided', () => {
        const sender = makeConnection({
            connectionType: 'session-scoped',
            userId: 'user-1',
            sessionId: 'session-1',
        });
        const teammate = makeConnection({
            connectionType: 'session-scoped',
            userId: 'user-1',
            sessionId: 'session-2',
        });

        eventRouter.addConnection('user-1', sender);
        eventRouter.addConnection('user-1', teammate);

        const payload = emitUpdate(
            { type: 'all-user-authenticated-connections' },
            sender,
        );

        expect((sender.socket.emit as any)).not.toHaveBeenCalled();
        expect((teammate.socket.emit as any)).toHaveBeenCalledWith('update', payload);
    });
});
