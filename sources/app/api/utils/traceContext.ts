import { randomUUID } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';

export const AHA_TRACE_HEADERS = {
    traceId: 'x-aha-trace-id',
    spanId: 'x-aha-span-id',
    parentSpanId: 'x-aha-parent-span-id',
    requestId: 'x-aha-request-id',
    sessionId: 'x-aha-session-id',
    machineId: 'x-aha-machine-id',
    teamId: 'x-aha-team-id',
    taskId: 'x-aha-task-id',
} as const;

export interface AhaTraceContext {
    traceId: string;
    spanId: string;
    parentSpanId?: string;
    requestId: string;
    sessionId?: string;
    machineId?: string;
    teamId?: string;
    taskId?: string;
}

declare module 'fastify' {
    interface FastifyRequest {
        ahaTrace?: AhaTraceContext;
    }
}

function getHeader(request: FastifyRequest, name: string): string | undefined {
    const value = request.headers[name];
    if (Array.isArray(value)) {
        return value.find((item) => item.trim().length > 0);
    }
    return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function newId(prefix: string): string {
    return `${prefix}_${randomUUID()}`;
}

export function createAhaTraceContext(request: FastifyRequest): AhaTraceContext {
    const parentSpanId = getHeader(request, AHA_TRACE_HEADERS.spanId);

    return {
        traceId: getHeader(request, AHA_TRACE_HEADERS.traceId) ?? newId('trc'),
        spanId: newId('spn'),
        parentSpanId,
        requestId: getHeader(request, AHA_TRACE_HEADERS.requestId) ?? newId('req'),
        sessionId: getHeader(request, AHA_TRACE_HEADERS.sessionId),
        machineId: getHeader(request, AHA_TRACE_HEADERS.machineId),
        teamId: getHeader(request, AHA_TRACE_HEADERS.teamId),
        taskId: getHeader(request, AHA_TRACE_HEADERS.taskId),
    };
}

export function applyAhaTraceResponseHeaders(reply: FastifyReply, trace: AhaTraceContext): void {
    reply.header(AHA_TRACE_HEADERS.traceId, trace.traceId);
    reply.header(AHA_TRACE_HEADERS.spanId, trace.spanId);
    reply.header(AHA_TRACE_HEADERS.requestId, trace.requestId);
    if (trace.parentSpanId) {
        reply.header(AHA_TRACE_HEADERS.parentSpanId, trace.parentSpanId);
    }
}

export function getAhaTraceLogFields(request: FastifyRequest): Record<string, unknown> {
    const trace = request.ahaTrace;
    if (!trace) {
        return {};
    }

    return {
        traceId: trace.traceId,
        spanId: trace.spanId,
        parentSpanId: trace.parentSpanId,
        requestId: trace.requestId,
        sessionId: trace.sessionId,
        machineId: trace.machineId,
        teamId: trace.teamId,
        taskId: trace.taskId,
    };
}
