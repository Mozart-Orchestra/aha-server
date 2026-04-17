import fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from 'fastify-type-provider-zod';

import { geoRoutes } from './geoRoutes';

function buildApp() {
    const app = fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider<ZodTypeProvider>() as any;
    geoRoutes(typed);
    return typed;
}

describe('geoRoutes', () => {
    beforeEach(() => {
        vi.stubGlobal('fetch', vi.fn());
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('queries provider endpoints with the client IP and falls back to the second provider', async () => {
        const fetchMock = vi.mocked(fetch)
            .mockResolvedValueOnce({ ok: false } as Response)
            .mockResolvedValueOnce({
                ok: true,
                json: async () => ({ countryCode: 'sg' }),
            } as Response);

        const app = buildApp();
        const response = await app.inject({
            method: 'GET',
            url: '/v1/geo/country-code',
            headers: {
                'x-forwarded-for': '203.0.113.7, 10.0.0.1',
            },
        });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({ countryCode: 'SG' });
        expect(fetchMock).toHaveBeenNthCalledWith(
            1,
            'https://ipapi.co/203.0.113.7/json/',
            expect.objectContaining({ headers: { Accept: 'application/json' } }),
        );
        expect(fetchMock).toHaveBeenNthCalledWith(
            2,
            'https://ipwho.org/ip/203.0.113.7',
            expect.objectContaining({ headers: { Accept: 'application/json' } }),
        );

        await app.close();
    });

    it('returns null when all providers fail', async () => {
        vi.mocked(fetch)
            .mockResolvedValue({ ok: false } as Response);

        const app = buildApp();
        const response = await app.inject({
            method: 'GET',
            url: '/v1/geo/country-code',
            headers: {
                'x-real-ip': '198.51.100.8',
            },
        });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({ countryCode: null });

        await app.close();
    });
});
