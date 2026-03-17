type ExecutionLinkStatus = 'active' | 'completed' | 'abandoned';

export interface ExecutionLinkLike {
    sessionId: string;
    status: ExecutionLinkStatus;
}

export function cleanupActiveExecutionLinks<T extends ExecutionLinkLike>(
    executionLinks: T[] | undefined,
    preferredCompletedSessionId?: string | null,
): T[] | undefined {
    if (!executionLinks?.length) {
        return executionLinks;
    }

    let changed = false;

    const nextLinks = executionLinks.map((link) => {
        if (link.status !== 'active') {
            return link;
        }

        const nextStatus: ExecutionLinkStatus = preferredCompletedSessionId && link.sessionId !== preferredCompletedSessionId
            ? 'abandoned'
            : 'completed';

        if (nextStatus === link.status) {
            return link;
        }

        changed = true;
        return {
            ...link,
            status: nextStatus,
        };
    });

    return changed ? nextLinks : executionLinks;
}
