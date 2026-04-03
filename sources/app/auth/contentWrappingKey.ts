import tweetnacl from 'tweetnacl';
import * as privacyKit from 'privacy-kit';

/**
 * Manages the server-side NaCl box key pair used to receive encrypted contentSecretKey values
 * from clients. The private key is loaded from CONTENT_WRAPPING_SECRET_KEY env var.
 * In development (when env var is absent) an ephemeral key pair is generated per-process.
 *
 * Clients encrypt contentSecretKey using:
 *   tweetnacl.box(plaintext, nonce, wrappingPublicKey, ephemeralSecretKey)
 * and send { encryptedContentSecretKey, nonce, ephemeralPublicKey } to the server.
 */

let cachedKeyPair: tweetnacl.BoxKeyPair | null = null;

function loadKeyPair(): tweetnacl.BoxKeyPair {
    if (cachedKeyPair) {
        return cachedKeyPair;
    }
    const secretKeyEnv = process.env['CONTENT_WRAPPING_SECRET_KEY'];
    if (secretKeyEnv) {
        const secretKey = privacyKit.decodeBase64(secretKeyEnv);
        cachedKeyPair = tweetnacl.box.keyPair.fromSecretKey(secretKey);
    } else {
        // Dev/test: generate a fresh ephemeral key pair (not persistent across restarts)
        cachedKeyPair = tweetnacl.box.keyPair();
    }
    return cachedKeyPair;
}

export function getWrappingPublicKey(): Uint8Array {
    return loadKeyPair().publicKey;
}

export interface BoxedSecret {
    ciphertext: string;
    nonce: string;
    ephemeralPublicKey: string;
}

/**
 * Decrypts a NaCl box-encrypted contentSecretKey sent by the client.
 * Returns null if decryption fails (wrong key, tampered data, etc.).
 */
export function decryptBoxedContentSecretKey(boxed: BoxedSecret): Uint8Array | null {
    try {
        const keyPair = loadKeyPair();
        const ciphertext = privacyKit.decodeBase64(boxed.ciphertext);
        const nonce = privacyKit.decodeBase64(boxed.nonce);
        const ephemeralPublicKey = privacyKit.decodeBase64(boxed.ephemeralPublicKey);
        return tweetnacl.box.open(ciphertext, nonce, ephemeralPublicKey, keyPair.secretKey);
    } catch {
        return null;
    }
}
