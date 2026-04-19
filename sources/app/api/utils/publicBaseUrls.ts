const DEFAULT_PUBLIC_WEBAPP_URL = 'https://aha-agi.com/webappv3';
const DEFAULT_PUBLIC_API_URL = 'https://aha-agi.com/api';
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

function normalizeHostname(host: string | null): string | null {
    if (!host) {
        return null;
    }

    return host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '').trim().toLowerCase() || null;
}

function normalizeProto(value: string | null): 'http' | 'https' | null {
    if (value === 'http' || value === 'https') {
        return value;
    }
    return null;
}

function getTrustedPublicHosts(): Set<string> {
    const trusted = new Set<string>();
    const candidates = [
        process.env.AHA_WEBAPP_URL,
        process.env.PUBLIC_WEBAPP_URL,
        process.env.AHA_PUBLIC_API_URL,
        process.env.PUBLIC_API_URL,
        DEFAULT_PUBLIC_WEBAPP_URL,
        DEFAULT_PUBLIC_API_URL,
    ];

    for (const candidate of candidates) {
        const normalized = normalizeUrl(candidate);
        if (!normalized) {
            continue;
        }
        trusted.add(new URL(normalized).hostname.toLowerCase());
    }

    return trusted;
}

function buildTrustedOrigin(host: string | null, proto: string | null, trustedHosts: Set<string>): string | null {
    const normalizedHost = normalizeHostname(host);
    if (!normalizedHost || isLocalHostname(normalizedHost) || !trustedHosts.has(normalizedHost)) {
        return null;
    }

    const normalizedProto = normalizeProto(proto) ?? 'https';
    return `${normalizedProto}://${host}`.replace(/\/+$/, '');
}

function getRequestOrigin(request: HeaderBag): string | null {
    const headers = request?.headers;
    if (!headers) {
        return null;
    }

    const trustedHosts = getTrustedPublicHosts();
    const forwardedHost = firstHeaderValue(headers['x-forwarded-host']);
    const forwardedProto = firstHeaderValue(headers['x-forwarded-proto'])
        ?? firstHeaderValue(headers['x-forwarded-scheme']);
    const forwardedOrigin = buildTrustedOrigin(forwardedHost, forwardedProto, trustedHosts);
    if (forwardedOrigin) {
        return forwardedOrigin;
    }

    return buildTrustedOrigin(firstHeaderValue(headers.host), forwardedProto, trustedHosts);
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
