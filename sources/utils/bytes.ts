export function toPrismaBytes(value: Uint8Array | ArrayBuffer): Uint8Array<ArrayBuffer> {
    if (value instanceof ArrayBuffer) {
        return new Uint8Array(value.slice(0));
    }
    return value as unknown as Uint8Array<ArrayBuffer>;
}

export function utf8Bytes(value: string): Uint8Array<ArrayBuffer> {
    return Uint8Array.from(Buffer.from(value, 'utf8'));
}
