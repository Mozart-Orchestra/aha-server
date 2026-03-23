import jwt from 'jsonwebtoken';
import { auth } from '@/app/auth/auth';

export interface ResolvedPermissionUserInfo {
    userId: string;
    teamId: string;
    role: string;
    sessionId: string;
}

type HeaderMap = Record<string, unknown>;
type TokenPayload = Record<string, unknown>;

function asRecord(value: unknown): Record<string, unknown> | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return undefined;
    }

    return value as Record<string, unknown>;
}

function getHeaderString(headers: HeaderMap, name: string): string | undefined {
    const direct = headers[name] ?? headers[name.toLowerCase()];
    if (typeof direct === 'string' && direct.trim().length > 0) {
        return direct.trim();
    }

    if (Array.isArray(direct)) {
        const firstString = direct.find((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0);
        return firstString?.trim();
    }

    return undefined;
}

function pickString(
    sources: Array<Record<string, unknown> | undefined>,
    keys: string[],
): string | undefined {
    for (const source of sources) {
        if (!source) {
            continue;
        }

        for (const key of keys) {
            const value = source[key];
            if (typeof value === 'string' && value.trim().length > 0) {
                return value.trim();
            }
        }
    }

    return undefined;
}

function extractBearerToken(authHeader: string | undefined): string | undefined {
    if (!authHeader) {
        return undefined;
    }

    const match = authHeader.match(/^Bearer\s+(.+)$/i);
    return match?.[1]?.trim();
}

export function decodePermissionToken(token: string): TokenPayload {
    const decodedWithLibrary = jwt.decode(token, { json: true });
    if (decodedWithLibrary && typeof decodedWithLibrary === 'object') {
        return decodedWithLibrary as TokenPayload;
    }

    const parts = token.split('.');
    if (parts.length !== 3) {
        throw new Error('Invalid token format');
    }

    const payload = Buffer.from(parts[1], 'base64url').toString('utf8');
    const parsed = JSON.parse(payload);
    const record = asRecord(parsed);
    if (!record) {
        throw new Error('Decoded token payload is not an object');
    }

    return record;
}

export async function resolvePermissionUserInfo(headers: HeaderMap): Promise<ResolvedPermissionUserInfo> {
    const authHeader = getHeaderString(headers, 'authorization');
    const headerUserId = getHeaderString(headers, 'x-user-id');
    const headerTeamId = getHeaderString(headers, 'x-team-id');
    const headerRole = getHeaderString(headers, 'x-role');
    const headerSessionId = getHeaderString(headers, 'x-session-id');

    const token = extractBearerToken(authHeader);
    let verifiedToken: { userId: string; extras?: unknown } | null = null;
    let decodedPayload: TokenPayload | undefined;

    if (token) {
        try {
            verifiedToken = await auth.verifyToken(token);
        } catch {
            verifiedToken = null;
        }

        try {
            decodedPayload = decodePermissionToken(token);
        } catch {
            decodedPayload = undefined;
        }
    }

    const decodedExtras = asRecord(decodedPayload?.extras);
    const verifiedExtras = asRecord(verifiedToken?.extras);
    const trustedDecodedExtras = verifiedToken ? decodedExtras : undefined;
    const trustedDecodedPayload = verifiedToken ? decodedPayload : undefined;

    return {
        userId: verifiedToken?.userId
            ?? headerUserId
            ?? 'anonymous',
        teamId: pickString([verifiedExtras, trustedDecodedExtras, trustedDecodedPayload], ['teamId'])
            ?? headerTeamId
            ?? 'default-team',
        role: pickString([verifiedExtras, trustedDecodedExtras, trustedDecodedPayload], ['role'])
            ?? headerRole
            ?? 'builder',
        sessionId: pickString([verifiedExtras, trustedDecodedExtras, trustedDecodedPayload], ['sessionId', 'session'])
            ?? headerSessionId
            ?? 'default-session',
    };
}

function singularize(word: string): string {
    if (word.endsWith('ies')) {
        return `${word.slice(0, -3)}y`;
    }

    if (word.endsWith('ses') || word.endsWith('xes')) {
        return word.slice(0, -2);
    }

    if (word.endsWith('s')) {
        return word.slice(0, -1);
    }

    return word;
}

function stripApiPrefix(url: string): string {
    const withoutQuery = url.split('?')[0];

    if (/^\/api\/v\d+\//.test(withoutQuery)) {
        return withoutQuery.replace(/^\/api\/v\d+\//, '/');
    }

    if (/^\/v\d+\//.test(withoutQuery)) {
        return withoutQuery.replace(/^\/v\d+\//, '/');
    }

    if (/^\/api\//.test(withoutQuery)) {
        return withoutQuery.replace(/^\/api\//, '/');
    }

    return withoutQuery;
}

function isLikelyIdentifier(segment: string): boolean {
    if (!segment) {
        return false;
    }

    if (segment.startsWith(':')) {
        return true;
    }

    if (/^\d+$/.test(segment)) {
        return true;
    }

    if (/^[a-z0-9_-]{10,}$/i.test(segment) && /[\d_-]/.test(segment)) {
        return true;
    }

    return false;
}

function mapTaskRouteToOperation(parts: string[], method: string): string {
    if (parts.length === 1) {
        if (method === 'GET') {
            return 'list_tasks';
        }
        if (method === 'POST') {
            return 'create_task';
        }
    }

    if (parts.length === 2) {
        if (method === 'GET') {
            return 'get_task';
        }
        if (method === 'PUT' || method === 'PATCH') {
            return 'update_task';
        }
        if (method === 'DELETE') {
            return 'delete_task';
        }
    }

    const action = parts[2];
    if (action === 'human-lock') {
        return 'update_task';
    }
    if (action === 'start') {
        return 'start_task';
    }
    if (action === 'complete') {
        return 'complete_task';
    }
    if (action === 'comments') {
        return 'add_task_comment';
    }
    if (action === 'blocker') {
        if (parts[4] === 'resolve') {
            return 'resolve_blocker';
        }
        return 'report_blocker';
    }

    return `${method.toLowerCase()}_task`;
}

export function mapPermissionRouteToOperation(url: string, method: string): string {
    const route = stripApiPrefix(url);
    const parts = route.split('/').filter(Boolean);

    if (parts.length === 0) {
        return `${method.toLowerCase()}_root`;
    }

    const tasksIndex = parts.lastIndexOf('tasks');
    if (tasksIndex !== -1) {
        return mapTaskRouteToOperation(parts.slice(tasksIndex), method);
    }

    const messagesIndex = parts.lastIndexOf('messages');
    if (messagesIndex !== -1 && parts.includes('teams')) {
        if (method === 'GET') {
            return 'list_team_messages';
        }
        if (method === 'POST') {
            return 'send_team_message';
        }
    }

    if (parts.length === 1) {
        const resource = parts[0];
        if (method === 'GET') {
            return `list_${resource}`;
        }
        if (method === 'POST') {
            return `create_${singularize(resource)}`;
        }
        return `${method.toLowerCase()}_${singularize(resource)}`;
    }

    const lastSegment = parts[parts.length - 1];
    const resource = isLikelyIdentifier(lastSegment)
        ? parts[parts.length - 2]
        : lastSegment;
    const singularResource = singularize(resource);

    if (!isLikelyIdentifier(lastSegment) && (method === 'GET' || method === 'POST')) {
        if (method === 'GET') {
            return `list_${resource}`;
        }
        return `create_${singularResource}`;
    }

    if (method === 'GET') {
        return `get_${singularResource}`;
    }
    if (method === 'PUT' || method === 'PATCH') {
        return `update_${singularResource}`;
    }
    if (method === 'DELETE') {
        return `delete_${singularResource}`;
    }

    return `${method.toLowerCase()}_${singularResource}`;
}
