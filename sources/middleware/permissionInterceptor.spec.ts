import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    PermissionInterceptor,
    createPermissionMiddleware,
    PermissionInterceptorOptions,
} from './permissionInterceptor';

// ── mock logger ───────────────────────────────────────────────────────────────
vi.mock('@/utils/log', () => ({
    logger: {
        info: vi.fn(),
        debug: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
    },
}));

// ── helpers ───────────────────────────────────────────────────────────────────

function makeService(overrides: Record<string, any> = {}) {
    return {
        isOperationAllowed: vi.fn().mockReturnValue({ allowed: true, requiresConfirmation: false }),
        ...overrides,
    } as any;
}

function makeReq(overrides: Record<string, any> = {}): any {
    return {
        path: '/api/tasks',
        method: 'GET',
        headers: {},
        body: {},
        ...overrides,
    };
}

function makeRes(): any {
    const res: any = {};
    res.status = vi.fn().mockReturnValue(res);
    res.json = vi.fn().mockReturnValue(res);
    return res;
}

/** A valid 3-part JWT whose payload decodes to a known user */
const VALID_JWT = (() => {
    const payload = Buffer.from(
        JSON.stringify({ userId: 'u1', teamId: 't1', role: 'supervisor', sessionId: 's1' }),
    ).toString('base64url');
    return `hdr.${payload}.sig`;
})();

// ── tests ─────────────────────────────────────────────────────────────────────

describe('PermissionInterceptor', () => {
    let service: ReturnType<typeof makeService>;

    beforeEach(() => {
        service = makeService();
    });

    // ── intercept() ───────────────────────────────────────────────────────────

    describe('intercept()', () => {
        it('calls next() immediately when interceptor is disabled', async () => {
            const opts: PermissionInterceptorOptions = {
                enabled: false,
                strictMode: false,
                auditLog: false,
                bypassPaths: [],
            };
            const interceptor = new PermissionInterceptor(service, opts);
            const next = vi.fn();
            await interceptor.intercept(makeReq(), makeRes(), next);
            expect(next).toHaveBeenCalledTimes(1);
            expect(service.isOperationAllowed).not.toHaveBeenCalled();
        });

        it('calls next() without permission check for exact bypass path /health', async () => {
            const interceptor = new PermissionInterceptor(service);
            const next = vi.fn();
            await interceptor.intercept(makeReq({ path: '/health' }), makeRes(), next);
            expect(next).toHaveBeenCalledTimes(1);
            expect(service.isOperationAllowed).not.toHaveBeenCalled();
        });

        it('calls next() without permission check for exact bypass path /ping', async () => {
            const interceptor = new PermissionInterceptor(service);
            const next = vi.fn();
            await interceptor.intercept(makeReq({ path: '/ping' }), makeRes(), next);
            expect(next).toHaveBeenCalledTimes(1);
            expect(service.isOperationAllowed).not.toHaveBeenCalled();
        });

        it('bypasses wildcard paths that match the prefix', async () => {
            const interceptor = new PermissionInterceptor(service, {
                enabled: true,
                strictMode: false,
                auditLog: false,
                bypassPaths: ['/internal/*'],
            });
            const next = vi.fn();
            await interceptor.intercept(makeReq({ path: '/internal/heartbeat' }), makeRes(), next);
            expect(next).toHaveBeenCalledTimes(1);
            expect(service.isOperationAllowed).not.toHaveBeenCalled();
        });

        it('does NOT bypass paths that only partially match without wildcard', async () => {
            // /metrics is in the bypass list but /metricsX is not
            const interceptor = new PermissionInterceptor(service);
            const next = vi.fn();
            await interceptor.intercept(makeReq({ path: '/metricsX' }), makeRes(), next);
            expect(service.isOperationAllowed).toHaveBeenCalledTimes(1);
        });

        it('calls next() when isOperationAllowed returns allowed=true', async () => {
            service.isOperationAllowed.mockReturnValue({ allowed: true, requiresConfirmation: false });
            const interceptor = new PermissionInterceptor(service);
            const next = vi.fn();
            await interceptor.intercept(makeReq(), makeRes(), next);
            expect(next).toHaveBeenCalledTimes(1);
        });

        it('returns 403 and does not call next() when isOperationAllowed returns allowed=false', async () => {
            service.isOperationAllowed.mockReturnValue({
                allowed: false,
                reason: 'Insufficient permissions',
                requiresConfirmation: false,
            });
            const interceptor = new PermissionInterceptor(service);
            const res = makeRes();
            const next = vi.fn();
            await interceptor.intercept(makeReq(), res, next);
            expect(res.status).toHaveBeenCalledWith(403);
            expect(res.json).toHaveBeenCalledWith(
                expect.objectContaining({
                    error: 'Forbidden',
                    message: 'Insufficient permissions',
                }),
            );
            expect(next).not.toHaveBeenCalled();
        });

        it('includes requiresConfirmation=true in 403 body when set by service', async () => {
            service.isOperationAllowed.mockReturnValue({
                allowed: false,
                reason: 'Plan mode restriction',
                requiresConfirmation: true,
            });
            const interceptor = new PermissionInterceptor(service);
            const res = makeRes();
            await interceptor.intercept(makeReq(), res, vi.fn());
            expect(res.json).toHaveBeenCalledWith(
                expect.objectContaining({ requiresConfirmation: true }),
            );
        });

        it('returns 403 with default message when reason is not provided', async () => {
            service.isOperationAllowed.mockReturnValue({
                allowed: false,
                reason: undefined,
                requiresConfirmation: false,
            });
            const interceptor = new PermissionInterceptor(service);
            const res = makeRes();
            await interceptor.intercept(makeReq(), res, vi.fn());
            expect(res.status).toHaveBeenCalledWith(403);
            expect(res.json).toHaveBeenCalledWith(
                expect.objectContaining({
                    message: 'You do not have permission to perform this operation',
                }),
            );
        });

        it('returns 500 when isOperationAllowed throws an unexpected error', async () => {
            service.isOperationAllowed.mockImplementation(() => {
                throw new Error('Unexpected DB failure');
            });
            const interceptor = new PermissionInterceptor(service);
            const res = makeRes();
            await interceptor.intercept(makeReq(), res, vi.fn());
            expect(res.status).toHaveBeenCalledWith(500);
            expect(res.json).toHaveBeenCalledWith(
                expect.objectContaining({ error: 'Internal Server Error' }),
            );
        });

        it('passes the correct role and operation to isOperationAllowed', async () => {
            const interceptor = new PermissionInterceptor(service);
            await interceptor.intercept(
                makeReq({
                    path: '/api/tasks/42',
                    method: 'PUT',
                    headers: { 'x-role': 'builder' },
                }),
                makeRes(),
                vi.fn(),
            );
            expect(service.isOperationAllowed).toHaveBeenCalledWith(
                'builder',
                expect.objectContaining({ name: 'update_task', type: 'api_call' }),
            );
        });
    });

    // ── extractUserInfo (tested via intercept) ────────────────────────────────

    describe('extractUserInfo — via intercept()', () => {
        it('extracts role from a valid Bearer JWT', async () => {
            const interceptor = new PermissionInterceptor(service);
            await interceptor.intercept(
                makeReq({ headers: { authorization: `Bearer ${VALID_JWT}` } }),
                makeRes(),
                vi.fn(),
            );
            expect(service.isOperationAllowed).toHaveBeenCalledWith('supervisor', expect.any(Object));
        });

        it('falls back to x-role header when Bearer token has wrong number of parts', async () => {
            const interceptor = new PermissionInterceptor(service);
            await interceptor.intercept(
                makeReq({
                    headers: {
                        authorization: 'Bearer bad-token',
                        'x-role': 'qa',
                        'x-user-id': 'u99',
                        'x-team-id': 'team-x',
                        'x-session-id': 'sess-x',
                    },
                }),
                makeRes(),
                vi.fn(),
            );
            expect(service.isOperationAllowed).toHaveBeenCalledWith('qa', expect.any(Object));
        });

        it('falls back to x-role header when JWT payload is not valid JSON', async () => {
            // Construct a token with 3 parts where the payload is not valid JSON
            const badPayload = Buffer.from('not-json').toString('base64url');
            const badToken = `hdr.${badPayload}.sig`;
            const interceptor = new PermissionInterceptor(service);
            await interceptor.intercept(
                makeReq({
                    headers: {
                        authorization: `Bearer ${badToken}`,
                        'x-role': 'reviewer',
                    },
                }),
                makeRes(),
                vi.fn(),
            );
            expect(service.isOperationAllowed).toHaveBeenCalledWith('reviewer', expect.any(Object));
        });

        it('defaults to role=builder and userId=anonymous when no headers are provided', async () => {
            const interceptor = new PermissionInterceptor(service);
            await interceptor.intercept(makeReq({ headers: {} }), makeRes(), vi.fn());
            // builder is the default role
            expect(service.isOperationAllowed).toHaveBeenCalledWith('builder', expect.any(Object));
        });
    });

    // ── mapRouteToOperation (tested via intercept) ────────────────────────────

    describe('mapRouteToOperation()', () => {
        const cases: Array<[string, string, string]> = [
            // [method, path, expectedOperationName]
            ['GET',    '/api/tasks',        'list_tasks'],
            ['POST',   '/api/tasks',        'create_task'],
            ['GET',    '/api/tasks/123',    'get_task'],
            ['PUT',    '/api/tasks/123',    'update_task'],
            ['PATCH',  '/api/tasks/123',    'update_task'],
            ['DELETE', '/api/tasks/123',    'delete_task'],
            // singularize: ies → y
            ['GET',    '/api/activities',   'list_activities'],
            ['POST',   '/api/activities',   'create_activity'],
            // singularize: xes → x
            ['GET',    '/api/boxes/42',     'get_box'],
            // path without /api/ prefix
            ['GET',    '/tasks',            'list_tasks'],
        ];

        for (const [method, path, expectedOp] of cases) {
            it(`${method} ${path} → ${expectedOp}`, async () => {
                const interceptor = new PermissionInterceptor(service);
                await interceptor.intercept(makeReq({ method, path }), makeRes(), vi.fn());
                expect(service.isOperationAllowed).toHaveBeenCalledWith(
                    expect.any(String),
                    expect.objectContaining({ name: expectedOp }),
                );
            });
        }

        it('uses method_resource (plural) for unknown HTTP methods', async () => {
            const interceptor = new PermissionInterceptor(service);
            await interceptor.intercept(
                makeReq({ method: 'OPTIONS', path: '/api/tasks/5' }),
                makeRes(),
                vi.fn(),
            );
            // Default branch: `${method.toLowerCase()}_${resource}` where resource is the plural form
            expect(service.isOperationAllowed).toHaveBeenCalledWith(
                expect.any(String),
                expect.objectContaining({ name: 'options_tasks' }),
            );
        });
    });

    // ── PermissionInterceptor.create() ────────────────────────────────────────

    describe('PermissionInterceptor.create()', () => {
        it('returns a bound function usable as Express middleware', async () => {
            const middleware = PermissionInterceptor.create(service);
            expect(typeof middleware).toBe('function');
        });

        it('returned middleware correctly calls next() when access is granted', async () => {
            const middleware = PermissionInterceptor.create(service);
            const next = vi.fn();
            await middleware(makeReq(), makeRes(), next);
            expect(next).toHaveBeenCalledTimes(1);
        });

        it('returned middleware returns 403 when access is denied', async () => {
            service.isOperationAllowed.mockReturnValue({
                allowed: false,
                reason: 'Denied',
                requiresConfirmation: false,
            });
            const middleware = PermissionInterceptor.create(service);
            const res = makeRes();
            await middleware(makeReq(), res, vi.fn());
            expect(res.status).toHaveBeenCalledWith(403);
        });

        it('accepts optional options override', async () => {
            const middleware = PermissionInterceptor.create(service, {
                enabled: false,
                strictMode: false,
                auditLog: false,
                bypassPaths: [],
            });
            const next = vi.fn();
            await middleware(makeReq(), makeRes(), next);
            expect(service.isOperationAllowed).not.toHaveBeenCalled();
            expect(next).toHaveBeenCalledTimes(1);
        });
    });
});

// ── createPermissionMiddleware() ──────────────────────────────────────────────

describe('createPermissionMiddleware()', () => {
    afterEach(() => {
        delete process.env.PERMISSION_INTERCEPTOR_ENABLED;
        delete process.env.PERMISSION_STRICT_MODE;
        delete process.env.PERMISSION_AUDIT_LOG;
    });

    it('creates a middleware function with default options', () => {
        const service = makeService();
        const middleware = createPermissionMiddleware(service);
        expect(typeof middleware).toBe('function');
    });

    it('calls next() when permission is granted (default options)', async () => {
        const service = makeService();
        const middleware = createPermissionMiddleware(service);
        const next = vi.fn();
        await middleware(makeReq(), makeRes(), next);
        expect(next).toHaveBeenCalledTimes(1);
    });

    it('merges custom options over defaults', async () => {
        // Custom bypassPaths should override default ones
        const service = makeService();
        const middleware = createPermissionMiddleware(service, {
            bypassPaths: ['/custom-health'],
        });
        const next = vi.fn();
        // /health is NOT in the custom bypass list, so permission IS checked
        await middleware(makeReq({ path: '/health' }), makeRes(), next);
        expect(service.isOperationAllowed).toHaveBeenCalledTimes(1);
        // /custom-health IS bypassed
        service.isOperationAllowed.mockClear();
        const next2 = vi.fn();
        await middleware(makeReq({ path: '/custom-health' }), makeRes(), next2);
        expect(service.isOperationAllowed).not.toHaveBeenCalled();
        expect(next2).toHaveBeenCalledTimes(1);
    });

    it('disables the interceptor when PERMISSION_INTERCEPTOR_ENABLED=false', async () => {
        process.env.PERMISSION_INTERCEPTOR_ENABLED = 'false';
        const service = makeService();
        const middleware = createPermissionMiddleware(service);
        const next = vi.fn();
        await middleware(makeReq(), makeRes(), next);
        expect(service.isOperationAllowed).not.toHaveBeenCalled();
        expect(next).toHaveBeenCalledTimes(1);
    });

    it('enables strict mode when PERMISSION_STRICT_MODE=true', () => {
        process.env.PERMISSION_STRICT_MODE = 'true';
        const service = makeService();
        // Just verify it constructs without throwing
        expect(() => createPermissionMiddleware(service)).not.toThrow();
    });
});
