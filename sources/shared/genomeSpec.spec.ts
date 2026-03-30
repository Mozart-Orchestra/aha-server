import { describe, expect, it } from 'vitest';

import { parseGenomeSpec, syncGenomeSpecVersion } from './genomeSpec';

describe('genomeSpec helpers', () => {
    it('parses a valid genome spec object', () => {
        expect(parseGenomeSpec('{"displayName":"Builder","version":2}')).toEqual({
            displayName: 'Builder',
            version: 2,
        });
    });

    it('hard-fails when parsing malformed genome spec json', () => {
        expect(() => parseGenomeSpec('{bad-json')).toThrow(/Failed to parse genome spec/);
    });

    it('hard-fails when parsing a non-object genome spec payload', () => {
        expect(() => parseGenomeSpec('"builder"')).toThrow('Genome spec must be a JSON object');
    });

    it('injects the canonical version into a valid genome spec', () => {
        expect(syncGenomeSpecVersion('{"displayName":"Builder"}', 4)).toBe('{"displayName":"Builder","version":4}');
    });

    it('hard-fails when syncing with an invalid version', () => {
        expect(() => syncGenomeSpecVersion('{"displayName":"Builder"}', 0)).toThrow(
            'Genome spec version sync requires a positive integer version, received: 0',
        );
    });

    it('hard-fails when syncing malformed genome spec json', () => {
        expect(() => syncGenomeSpecVersion('{bad-json', 3)).toThrow(/Genome spec version sync failed/);
    });

    it('hard-fails when syncing a non-object genome spec payload', () => {
        expect(() => syncGenomeSpecVersion('"builder"', 3)).toThrow(
            'Genome spec version sync requires a JSON object payload',
        );
    });
});
