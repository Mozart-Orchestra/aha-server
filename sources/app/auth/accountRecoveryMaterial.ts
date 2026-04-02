import { encryptBytes, decryptBytes } from "@/modules/encrypt";
import { db } from "@/storage/db";
import * as privacyKit from "privacy-kit";
import tweetnacl from "tweetnacl";

const RECOVERY_PATH_SUFFIX = ['account-recovery', 'content-secret-key'] as const;

function buildRecoveryPath(accountId: string): string[] {
    return ['user', accountId, ...RECOVERY_PATH_SUFFIX];
}

export function publicKeyHexFromContentSecretKey(contentSecretKey: Uint8Array): string {
    const keypair = tweetnacl.sign.keyPair.fromSeed(contentSecretKey);
    return privacyKit.encodeHex(keypair.publicKey);
}

export async function upsertAccountRecoveryMaterial(accountId: string, contentSecretKey: Uint8Array) {
    const wrappedSecret = encryptBytes(buildRecoveryPath(accountId), contentSecretKey) as Uint8Array;
    const publicKey = publicKeyHexFromContentSecretKey(contentSecretKey);

    await db.account.update({
        where: { id: accountId },
        data: {
            encryptedContentSecretKey: wrappedSecret,
            contentKeyVersion: 1,
        },
    });

    return db.accountRecoveryMaterial.upsert({
        where: { accountId },
        create: {
            accountId,
            publicKey,
            wrappedSecret,
        },
        update: {
            publicKey,
            wrappedSecret,
            updatedAt: new Date(),
        },
    });
}

export async function readAccountRecoverySecret(accountId: string): Promise<Uint8Array | null> {
    const account = await db.account.findUnique({
        where: { id: accountId },
        select: { encryptedContentSecretKey: true },
    });

    if (account?.encryptedContentSecretKey) {
        try {
            return decryptBytes(buildRecoveryPath(accountId), account.encryptedContentSecretKey as Uint8Array);
        } catch {
            // Fall back to legacy storage below.
        }
    }

    const row = await db.accountRecoveryMaterial.findUnique({
        where: { accountId },
    });

    if (!row?.wrappedSecret) {
        return null;
    }

    try {
        return decryptBytes(buildRecoveryPath(accountId), row.wrappedSecret as Uint8Array);
    } catch {
        return null;
    }
}

export async function markAccountRecoveryUsed(accountId: string): Promise<void> {
    await db.accountRecoveryMaterial.update({
        where: { accountId },
        data: { lastRecoveredAt: new Date() },
    }).catch(() => {
        // Ignore missing rows; recovery readiness is enforced by the caller.
    });
}
