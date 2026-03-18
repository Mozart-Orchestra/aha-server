import type { PrismaClient } from "@prisma/client";
import { access, constants, stat } from "node:fs/promises";
import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { error, log } from "@/utils/log";
import { onShutdown } from "@/utils/shutdown";

type RawQueryClient = Pick<PrismaClient, "$queryRawUnsafe" | "$disconnect">;

type DatabaseListRow = {
    seq: number;
    name: string;
    file: string;
};

type MigrationRow = {
    migration_name: string;
    finished_at: number | null;
};

export type SqliteFileIdentity = {
    path: string;
    dev: number;
    ino: number;
};

export function findPendingPrismaMigrations(expectedMigrationNames: string[], appliedMigrationNames: string[]): string[] {
    const applied = new Set(appliedMigrationNames);
    return expectedMigrationNames.filter((migration) => !applied.has(migration));
}

export async function resolveSqliteDatabaseFilePath(db: Pick<RawQueryClient, "$queryRawUnsafe">): Promise<string | null> {
    try {
        const rows = await db.$queryRawUnsafe<DatabaseListRow[]>("PRAGMA database_list");
        const mainDatabase = rows.find((row) => row.name === "main");
        if (!mainDatabase?.file || mainDatabase.file === ":memory:") {
            return null;
        }
        return mainDatabase.file;
    } catch {
        return null;
    }
}

export async function assertPrismaMigrationsApplied(
    db: Pick<RawQueryClient, "$queryRawUnsafe">,
    prismaDir = join(process.cwd(), "prisma")
): Promise<void> {
    let migrationDirs: string[] = [];
    try {
        const dirents = await readdir(join(prismaDir, "migrations"), { withFileTypes: true });
        migrationDirs = dirents
            .filter((entry) => entry.isDirectory() && entry.name !== "migration_lock.toml")
            .map((entry) => entry.name)
            .sort();
    } catch {
        return;
    }

    if (migrationDirs.length === 0) {
        return;
    }

    let appliedRows: MigrationRow[];
    try {
        appliedRows = await db.$queryRawUnsafe<MigrationRow[]>(
            "SELECT migration_name, finished_at FROM _prisma_migrations WHERE finished_at IS NOT NULL ORDER BY migration_name"
        );
    } catch (migrationError) {
        throw new Error(
            `Prisma migration metadata is unavailable. Database schema cannot be trusted. ${migrationError instanceof Error ? migrationError.message : String(migrationError)}`
        );
    }

    const pending = findPendingPrismaMigrations(
        migrationDirs,
        appliedRows.map((row) => row.migration_name)
    );

    if (pending.length > 0) {
        throw new Error(
            `Database schema is behind the checked-in Prisma migrations. Apply pending migrations before starting happy-server: ${pending.join(", ")}`
        );
    }
}

export async function readSqliteFileIdentity(filePath: string): Promise<SqliteFileIdentity> {
    await Promise.all([
        access(filePath, constants.W_OK),
        access(dirname(filePath), constants.W_OK),
    ]);
    const fileStats = await stat(filePath);
    return {
        path: filePath,
        dev: Number(fileStats.dev),
        ino: Number(fileStats.ino),
    };
}

export function hasSqliteFileIdentityChanged(initialIdentity: SqliteFileIdentity, currentIdentity: SqliteFileIdentity): boolean {
    return initialIdentity.dev !== currentIdentity.dev || initialIdentity.ino !== currentIdentity.ino;
}

async function terminateProcessForSqliteReplacement(db: RawQueryClient, message: string, metadata: Record<string, unknown>) {
    error({
        module: "sqlite-database-guard",
        level: "error",
        ...metadata,
    }, message);
    try {
        await db.$disconnect();
    } catch {
        // Ignore disconnect failures during fatal shutdown.
    }
    process.exit(1);
}

export async function startSqliteDatabaseGuard(db: RawQueryClient, pollIntervalMs = 5_000): Promise<void> {
    const filePath = await resolveSqliteDatabaseFilePath(db);
    if (!filePath) {
        return;
    }

    await assertPrismaMigrationsApplied(db);

    const initialIdentity = await readSqliteFileIdentity(filePath);
    log({
        module: "sqlite-database-guard",
        path: filePath,
        ino: initialIdentity.ino,
    }, "Monitoring SQLite database file for replacement");

    let stopped = false;
    let isChecking = false;
    const interval = setInterval(() => {
        if (stopped || isChecking) {
            return;
        }
        isChecking = true;
        void (async () => {
            try {
                const currentIdentity = await readSqliteFileIdentity(filePath);
                if (hasSqliteFileIdentityChanged(initialIdentity, currentIdentity)) {
                    stopped = true;
                    clearInterval(interval);
                    await terminateProcessForSqliteReplacement(
                        db,
                        "SQLite database file changed while happy-server was running. Restart the server before continuing.",
                        {
                            path: filePath,
                            initialIno: initialIdentity.ino,
                            currentIno: currentIdentity.ino,
                            initialDev: initialIdentity.dev,
                            currentDev: currentIdentity.dev,
                        }
                    );
                }
            } catch (guardError) {
                stopped = true;
                clearInterval(interval);
                await terminateProcessForSqliteReplacement(
                    db,
                    "SQLite database file is no longer writable while happy-server is running. Restart the server after restoring the database file.",
                    {
                        path: filePath,
                        initialIno: initialIdentity.ino,
                        error: guardError instanceof Error ? guardError.message : String(guardError),
                    }
                );
            } finally {
                isChecking = false;
            }
        })();
    }, pollIntervalMs);

    interval.unref?.();
    onShutdown("sqlite-database-guard", async () => {
        stopped = true;
        clearInterval(interval);
    });
}
