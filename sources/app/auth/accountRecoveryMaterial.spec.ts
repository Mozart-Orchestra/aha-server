import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/storage/db', () => ({
    db: {
        account: {
            update: vi.fn(),
            findUnique: vi.fn(),
        },
        accountRecoveryMaterial: {
            upsert: vi.fn(),
            findUnique: vi.fn(),
            update: vi.fn(),
        },
    },
}));

vi.mock('@/modules/encrypt', () => ({
    encryptBytes: vi.fn(() => new Uint8Array([7, 8, 9])),
    decryptBytes: vi.fn(() => new Uint8Array([1, 2, 3])),
}));

vi.mock('privacy-kit', () => ({
    encodeHex: vi.fn(() => 'hex-public-key'),
}));

vi.mock('tweetnacl', () => ({
    default: {
        sign: {
            keyPair: {
                fromSeed: vi.fn(() => ({
                    publicKey: new Uint8Array(32).fill(1),
                })),
            },
        },
    },
}));

import { decryptBytes, encryptBytes } from '@/modules/encrypt';
import { db } from '@/storage/db';
import {
    markAccountRecoveryUsed,
    readAccountRecoverySecret,
    upsertAccountRecoveryMaterial,
} from './accountRecoveryMaterial';

describe('accountRecoveryMaterial', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(db.account.update).mockResolvedValue({ id: 'user-1' } as never);
        vi.mocked(db.account.findUnique).mockResolvedValue(null as never);
        vi.mocked(db.accountRecoveryMaterial.upsert).mockResolvedValue({ accountId: 'user-1' } as never);
        vi.mocked(db.accountRecoveryMaterial.findUnique).mockResolvedValue(null as never);
        vi.mocked(db.accountRecoveryMaterial.update).mockResolvedValue({} as never);
        vi.mocked(decryptBytes).mockReturnValue(new Uint8Array([1, 2, 3]) as never);
    });

    it('writes recovery material to Account and legacy AccountRecoveryMaterial', async () => {
        const secret = new Uint8Array(32).fill(9);

        await upsertAccountRecoveryMaterial('user-1', secret);

        expect(vi.mocked(encryptBytes)).toHaveBeenCalledWith(
            ['user', 'user-1', 'account-recovery', 'content-secret-key'],
            secret,
        );
        expect(vi.mocked(db.account.update)).toHaveBeenCalledWith({
            where: { id: 'user-1' },
            data: {
                encryptedContentSecretKey: new Uint8Array([7, 8, 9]),
                contentKeyVersion: 1,
            },
        });
        expect(vi.mocked(db.accountRecoveryMaterial.upsert)).toHaveBeenCalledWith({
            where: { accountId: 'user-1' },
            create: {
                accountId: 'user-1',
                publicKey: 'hex-public-key',
                wrappedSecret: new Uint8Array([7, 8, 9]),
            },
            update: {
                publicKey: 'hex-public-key',
                wrappedSecret: new Uint8Array([7, 8, 9]),
                updatedAt: expect.any(Date),
            },
        });
    });

    it('reads recovery secret from Account encryptedContentSecretKey first', async () => {
        vi.mocked(db.account.findUnique).mockResolvedValue({
            encryptedContentSecretKey: new Uint8Array([7, 8, 9]),
        } as never);

        const result = await readAccountRecoverySecret('user-1');

        expect(result).toEqual(new Uint8Array([1, 2, 3]));
        expect(vi.mocked(db.accountRecoveryMaterial.findUnique)).not.toHaveBeenCalled();
    });

    it('falls back to legacy AccountRecoveryMaterial when Account field is missing', async () => {
        vi.mocked(db.account.findUnique).mockResolvedValue({
            encryptedContentSecretKey: null,
        } as never);
        vi.mocked(db.accountRecoveryMaterial.findUnique).mockResolvedValue({
            wrappedSecret: new Uint8Array([7, 8, 9]),
        } as never);

        const result = await readAccountRecoverySecret('user-1');

        expect(result).toEqual(new Uint8Array([1, 2, 3]));
        expect(vi.mocked(db.accountRecoveryMaterial.findUnique)).toHaveBeenCalledWith({
            where: { accountId: 'user-1' },
        });
    });

    it('ignores missing legacy row when marking recovery used', async () => {
        vi.mocked(db.accountRecoveryMaterial.update).mockRejectedValue(new Error('missing') as never);

        await expect(markAccountRecoveryUsed('user-1')).resolves.toBeUndefined();
    });
});
