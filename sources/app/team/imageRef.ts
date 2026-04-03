export interface ImageRef {
    id: string;
    version: number | null;
}

export interface ImageRefInput {
    sourceImageId?: string | null;
    sourceImageVersion?: number | null;
    genomeId?: string | null;
    genomeVersion?: number | null;
    specId?: string | null;
}

function normalizeImageId(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0
        ? value.trim()
        : null;
}

function normalizeImageVersion(value: unknown): number | null {
    return typeof value === 'number' && Number.isInteger(value) && value > 0
        ? value
        : null;
}

export function resolveImageRef(input: ImageRefInput | null | undefined): ImageRef | null {
    if (!input) {
        return null;
    }

    const id = normalizeImageId(input.sourceImageId)
        ?? normalizeImageId(input.genomeId)
        ?? normalizeImageId(input.specId);

    if (!id) {
        return null;
    }

    return {
        id,
        version: normalizeImageVersion(input.sourceImageVersion)
            ?? normalizeImageVersion(input.genomeVersion)
            ?? null,
    };
}

export function buildImageRefFields(
    imageRef: ImageRef | null | undefined,
    opts?: { includeLegacyGenome?: boolean; includeLegacySpec?: boolean },
): Record<string, unknown> {
    if (!imageRef) {
        return {};
    }

    return {
        sourceImageId: imageRef.id,
        sourceImageVersion: imageRef.version,
        ...(opts?.includeLegacyGenome ? { genomeId: imageRef.id } : {}),
        ...(opts?.includeLegacyGenome ? { genomeVersion: imageRef.version } : {}),
        ...(opts?.includeLegacySpec ? { specId: imageRef.id } : {}),
    };
}

export function resolveCandidateId(
    imageRef: ImageRef | null | undefined,
    candidateId?: string | null,
): string | undefined {
    if (typeof candidateId === 'string' && candidateId.trim().length > 0) {
        return candidateId;
    }
    return imageRef ? `spec:${imageRef.id}` : undefined;
}
