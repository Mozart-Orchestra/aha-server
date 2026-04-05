const DEFAULT_PUBLIC_WEBAPP_URL = 'https://ahaagi.com/webappv3';
const DEFAULT_PUBLIC_API_URL = 'https://ahaagi.com/api/v3';
const DEFAULT_LOCAL_WEBAPP_URL = 'http://localhost:8081';

type HeaderValue = string | string[] | undefined;
type HeaderBag = { headers?: Record<string, HeaderValue> | undefined } | undefined;

function normalizeUrl(input: string | null | undefined): string | null {
    if (!input) {
        return null;
    }

    const trimmed = input.trim();
    if (!trimmed) {
        return null;
    }

    try {
        return new URL(trimmed).toString().replace(/\/+$/, '');
    } catch {
        return null;
    }
}

function firstHeaderValue(value: HeaderValue): string | null {
    if (Array.isArray(value)) {
        return typeof value[0] === 'string' ? value[0].trim() || null : null;
    }

    if (typeof value !== 'string') {
        return null;
    }

    const first = value.split(',')[0]?.trim();
    return first || null;
}

function isLocalHostname(hostname: string): boolean {
    return hostname === 'localhost'
        || hostname === '127.0.0.1'
        || hostname.startsWith('10.')
        || hostname.startsWith('192.168.')
        || /^172\.(1[6-9]|2\d|3[01])\./.test(hostname);
}

function getRequestOrigin(request: HeaderBag): string | null {
    const headers = request?.headers;
    if (!headers) {
        return null;
    }

    const host = firstHeaderValue(headers['x-forwarded-host']) ?? firstHeaderValue(headers.host);
    if (!host) {
        return null;
    }

    const hostname = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
    if (isLocalHostname(hostname)) {
        return null;
    }

    const proto = firstHeaderValue(headers['x-forwarded-proto'])
        ?? firstHeaderValue(headers['x-forwarded-scheme'])
        ?? 'https';

    return `${proto}://${host}`.replace(/\/+$/, '');
}

export function getPublicWebappUrl(request?: HeaderBag): string {
    const envUrl = normalizeUrl(process.env.AHA_WEBAPP_URL ?? process.env.PUBLIC_WEBAPP_URL);
    if (envUrl) {
        return envUrl;
    }

    const requestOrigin = getRequestOrigin(request);
    if (requestOrigin) {
        return `${requestOrigin}/webappv3`;
    }

    return process.env.NODE_ENV === 'development'
        ? DEFAULT_LOCAL_WEBAPP_URL
        : DEFAULT_PUBLIC_WEBAPP_URL;
}

export function getPublicApiUrl(): string {
    return normalizeUrl(process.env.AHA_PUBLIC_API_URL ?? process.env.PUBLIC_API_URL) ?? DEFAULT_PUBLIC_API_URL;
}

export function getPublicApiServers(): Array<{ url: string; description: string }> {
    return [
        {
            url: 'http://localhost:3005',
            description: 'Local development server',
        },
        {
            url: getPublicApiUrl(),
            description: 'Public server',
        },
    ];
}
