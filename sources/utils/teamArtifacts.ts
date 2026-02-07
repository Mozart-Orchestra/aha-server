export type TeamArtifactBody = Record<string, unknown>;

const coerceTeamArtifactBody = (value: unknown): TeamArtifactBody => {
    if (typeof value === 'string') {
        try {
            return coerceTeamArtifactBody(JSON.parse(value));
        } catch {
            return {};
        }
    }

    if (!value || typeof value !== 'object') {
        return {};
    }

    if ('body' in value) {
        const inner = (value as { body?: unknown }).body;
        if (typeof inner === 'string') {
            try {
                return coerceTeamArtifactBody(JSON.parse(inner));
            } catch {
                return {};
            }
        }
        if (inner && typeof inner === 'object') {
            return inner as TeamArtifactBody;
        }
        return {};
    }

    return value as TeamArtifactBody;
};

export const parseTeamArtifactBody = (body: Uint8Array): TeamArtifactBody => {
    const bodyStr = Buffer.from(body).toString('utf-8');
    try {
        const parsed = JSON.parse(bodyStr);
        return coerceTeamArtifactBody(parsed);
    } catch {
        return {};
    }
};
