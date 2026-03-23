import { db } from "@/storage/db";
import { encryptString, decryptString } from "@/modules/encrypt";
import * as privacyKit from "privacy-kit";

const CREDS_KEY = 'channels.weixin.credentials';

export interface WeixinCredentials {
    token: string;
    baseUrl: string;
    weixinUserId?: string;
    accountId?: string;
    pushPolicy: 'all' | 'important' | 'silent';
}

function encryptionPath(uid: string): string[] {
    return ['channels', 'weixin', uid];
}

/**
 * Load WeChat credentials for a user from UserKVStore.
 * Returns null if not bound.
 */
export async function loadWeixinCredentials(uid: string): Promise<(WeixinCredentials & { version: number }) | null> {
    const row = await db.userKVStore.findUnique({
        where: { accountId_key: { accountId: uid, key: CREDS_KEY } }
    });
    if (!row || !row.value) return null;

    try {
        const decrypted = decryptString(encryptionPath(uid), row.value as Uint8Array);
        const creds = JSON.parse(decrypted) as WeixinCredentials;
        return { ...creds, version: row.version };
    } catch {
        return null;
    }
}

/**
 * Save or update WeChat credentials for a user.
 * Uses upsert to handle both first-time bind and updates.
 */
export async function saveWeixinCredentials(uid: string, creds: WeixinCredentials): Promise<void> {
    const encrypted = encryptString(encryptionPath(uid), JSON.stringify(creds));
    const value = new Uint8Array(encrypted instanceof Uint8Array ? encrypted : encrypted as any);
    const b64 = privacyKit.encodeBase64(value);

    const existing = await db.userKVStore.findUnique({
        where: { accountId_key: { accountId: uid, key: CREDS_KEY } },
        select: { version: true }
    });

    if (existing) {
        await db.userKVStore.update({
            where: { accountId_key: { accountId: uid, key: CREDS_KEY } },
            data: {
                value: privacyKit.decodeBase64(b64) as Uint8Array,
                version: existing.version + 1
            }
        });
    } else {
        await db.userKVStore.create({
            data: {
                accountId: uid,
                key: CREDS_KEY,
                value: privacyKit.decodeBase64(b64) as Uint8Array,
                version: 0
            }
        });
    }
}

/**
 * Delete WeChat credentials (unbind).
 */
export async function deleteWeixinCredentials(uid: string): Promise<void> {
    await db.userKVStore.updateMany({
        where: { accountId: uid, key: CREDS_KEY },
        data: { value: null }
    });
}
