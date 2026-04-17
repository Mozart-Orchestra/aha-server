import { z } from "zod";
import { type Fastify } from "../types";

const IP_LOOKUP_TIMEOUT_MS = 2500;
const IP_LOOKUP_ENDPOINTS = [
    {
        buildUrl: (ip: string) => `https://ipapi.co/${encodeURIComponent(ip)}/json/`,
        pickCountryCode: (payload: any) => payload?.country_code ?? payload?.country ?? null,
    },
    {
        buildUrl: (ip: string) => `https://ipwho.org/ip/${encodeURIComponent(ip)}`,
        pickCountryCode: (payload: any) => payload?.countryCode ?? payload?.country_code ?? null,
    },
];

async function fetchCountryCodeForIp(ip: string): Promise<string | null> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), IP_LOOKUP_TIMEOUT_MS);

    try {
        for (const endpoint of IP_LOOKUP_ENDPOINTS) {
            try {
                const url = endpoint.buildUrl(ip);
                const response = await fetch(url, {
                    headers: { Accept: 'application/json' },
                    signal: controller.signal,
                });
                if (!response.ok) continue;
                const payload = await response.json();
                const code = endpoint.pickCountryCode(payload);
                if (typeof code === 'string' && code.length >= 2) {
                    return code.trim().toUpperCase();
                }
            } catch {
                // try next endpoint
            }
        }
        return null;
    } finally {
        clearTimeout(timeout);
    }
}

function extractClientIp(request: any): string | null {
    const forwarded = request.headers['x-forwarded-for'];
    if (forwarded) {
        const first = (typeof forwarded === 'string' ? forwarded : forwarded[0]).split(',')[0].trim();
        if (first) return first;
    }

    const realIp = request.headers['x-real-ip'];
    if (typeof realIp === 'string' && realIp.trim()) {
        return realIp.trim();
    }

    return request.ip ?? null;
}

export function geoRoutes(app: Fastify) {
    /**
     * GET /v1/geo/country-code
     *
     * Returns the ISO 3166-1 alpha-2 country code for the requesting client IP.
     * No authentication required. Used by web clients to determine language preference
     * without CORS-restricted direct calls to third-party IP services.
     *
     * Response: { countryCode: string | null }
     */
    app.get('/v1/geo/country-code', {
        schema: {
            response: {
                200: z.object({
                    countryCode: z.string().nullable(),
                }),
            },
        },
    }, async (request, reply) => {
        const clientIp = extractClientIp(request);

        if (!clientIp) {
            return reply.send({ countryCode: null });
        }

        const countryCode = await fetchCountryCodeForIp(clientIp);
        return reply.send({ countryCode });
    });
}
