import { afterEach, describe, expect, it } from 'vitest';

import { getPublicApiServers, getPublicApiUrl, getPublicWebappUrl } from './publicBaseUrls';

const originalEnv = {
    AHA_WEBAPP_URL: process.env.AHA_WEBAPP_URL,
    AHA_PUBLIC_API_URL: process.env.AHA_PUBLIC_API_URL,
    NODE_ENV: process.env.NODE_ENV,
};

describe('publicBaseUrls', () => {
    afterEach(() => {
        if (originalEnv.AHA_WEBAPP_URL === undefined) {
            delete process.env.AHA_WEBAPP_URL;
        } else {
            process.env.AHA_WEBAPP_URL = originalEnv.AHA_WEBAPP_URL;
        }

        if (originalEnv.AHA_PUBLIC_API_URL === undefined) {
            delete process.env.AHA_PUBLIC_API_URL;
        } else {
            process.env.AHA_PUBLIC_API_URL = originalEnv.AHA_PUBLIC_API_URL;
        }

        if (originalEnv.NODE_ENV === undefined) {
            delete process.env.NODE_ENV;
        } else {
            process.env.NODE_ENV = originalEnv.NODE_ENV;
        }
    });

    it('prefers explicit webapp env override', () => {
        process.env.AHA_WEBAPP_URL = 'https://custom.example.com/webappv3/';

        expect(getPublicWebappUrl()).toBe('https://custom.example.com/webappv3');
    });

    it('derives public webapp URL from forwarded host when env is absent', () => {
        delete process.env.AHA_WEBAPP_URL;

        expect(getPublicWebappUrl({
            headers: {
                host: 'internal:3005',
                'x-forwarded-host': 'ahaagi.com',
                'x-forwarded-proto': 'https',
            },
        })).toBe('https://ahaagi.com/webappv3');
    });

    it('falls back to localhost webapp in development for local requests', () => {
        delete process.env.AHA_WEBAPP_URL;
        process.env.NODE_ENV = 'development';

        expect(getPublicWebappUrl({
            headers: {
                host: 'localhost:3005',
            },
        })).toBe('http://localhost:8081');
    });

    it('uses ahaagi public API as the default docs server', () => {
        delete process.env.AHA_PUBLIC_API_URL;

        expect(getPublicApiUrl()).toBe('https://ahaagi.com/api/v3');
        expect(getPublicApiServers()).toEqual([
            {
                url: 'http://localhost:3005',
                description: 'Local development server',
            },
            {
                url: 'https://ahaagi.com/api/v3',
                description: 'Public server',
            },
        ]);
    });
});
