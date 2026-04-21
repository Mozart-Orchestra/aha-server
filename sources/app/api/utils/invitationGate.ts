function parseBooleanEnv(value: string | undefined): boolean {
    return ['1', 'true', 'yes', 'on'].includes((value ?? '').trim().toLowerCase());
}

export function isInvitationGateEnabled(
    envValue = process.env.INVITATION_GATE_ENABLED ?? process.env.AHA_INVITATION_GATE_ENABLED,
): boolean {
    return parseBooleanEnv(envValue);
}

export function invitationVerifiedForResponse(verifiedAt: Date | string | null | undefined): boolean {
    return !isInvitationGateEnabled() || Boolean(verifiedAt);
}
