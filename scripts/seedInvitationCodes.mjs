#!/usr/bin/env node
// Usage:
//   node scripts/seedInvitationCodes.mjs --count 20 --prefix aha --maxUses 1 --expires 30 --note "initial seed"
// Reads DATABASE_URL from env. Outputs the generated codes on stdout for copy/paste.

import { PrismaClient } from '@prisma/client';
import crypto from 'node:crypto';

function parseArgs(argv) {
    const out = { count: 10, prefix: 'aha', maxUses: 1, expires: 30, note: null };
    for (let i = 2; i < argv.length; i++) {
        const arg = argv[i];
        const next = argv[i + 1];
        switch (arg) {
            case '--count':     out.count = parseInt(next, 10); i++; break;
            case '--prefix':    out.prefix = String(next); i++; break;
            case '--maxUses':   out.maxUses = parseInt(next, 10); i++; break;
            case '--expires':   out.expires = parseInt(next, 10); i++; break;
            case '--note':      out.note = String(next); i++; break;
            case '--help':
            case '-h':
                console.log('Usage: node scripts/seedInvitationCodes.mjs --count N --prefix aha --maxUses 1 --expires 30 --note "..."');
                process.exit(0);
            default:
                if (arg.startsWith('--')) {
                    console.error(`Unknown flag: ${arg}`);
                    process.exit(1);
                }
        }
    }
    if (!Number.isFinite(out.count) || out.count <= 0 || out.count > 500) {
        console.error('Invalid --count: must be 1..500');
        process.exit(1);
    }
    return out;
}

function generateCode(prefix) {
    const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
    const bytes = crypto.randomBytes(10);
    let body = '';
    for (let i = 0; i < bytes.length; i++) {
        body += alphabet[bytes[i] % alphabet.length];
    }
    return `${prefix}-${body.slice(0, 4)}-${body.slice(4, 8)}`;
}

async function main() {
    const args = parseArgs(process.argv);
    const prisma = new PrismaClient();
    const expiresAt = new Date(Date.now() + args.expires * 24 * 60 * 60 * 1000);
    const created = [];

    try {
        for (let i = 0; i < args.count; i++) {
            let attempts = 0;
            let success = false;
            while (!success && attempts < 5) {
                attempts++;
                const code = generateCode(args.prefix);
                try {
                    const row = await prisma.invitationCode.create({
                        data: {
                            code,
                            maxUses: args.maxUses,
                            expiresAt,
                            note: args.note,
                        },
                        select: { code: true, maxUses: true, expiresAt: true },
                    });
                    created.push(row);
                    success = true;
                } catch (error) {
                    if (error?.code === 'P2002') continue;
                    throw error;
                }
            }
            if (!success) {
                console.error(`Failed to generate unique code after 5 attempts (slot ${i})`);
            }
        }
    } finally {
        await prisma.$disconnect();
    }

    console.log(`Created ${created.length} invitation code(s) (expiresAt=${expiresAt.toISOString()}):`);
    for (const row of created) {
        console.log(`  ${row.code}  (maxUses=${row.maxUses})`);
    }
}

main().catch((err) => {
    console.error('Seed failed:', err);
    process.exit(1);
});
