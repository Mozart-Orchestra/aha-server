import { describe, expect, it, vi } from "vitest";
import { findPendingPrismaMigrations, hasSqliteFileIdentityChanged, resolveSqliteDatabaseFilePath } from "./sqliteDatabaseGuard";

describe("resolveSqliteDatabaseFilePath", () => {
    it("returns the main sqlite file path", async () => {
        const db = {
            $queryRawUnsafe: vi.fn().mockResolvedValue([
                { seq: 0, name: "main", file: "/tmp/happy-server.db" },
            ]),
        };

        await expect(resolveSqliteDatabaseFilePath(db as never)).resolves.toBe("/tmp/happy-server.db");
        expect(db.$queryRawUnsafe).toHaveBeenCalledWith("PRAGMA database_list");
    });

    it("returns null when prisma is not backed by sqlite", async () => {
        const db = {
            $queryRawUnsafe: vi.fn().mockRejectedValue(new Error("syntax error at or near \"PRAGMA\"")),
        };

        await expect(resolveSqliteDatabaseFilePath(db as never)).resolves.toBeNull();
    });
});

describe("hasSqliteFileIdentityChanged", () => {
    it("returns false when inode and device stay the same", () => {
        expect(hasSqliteFileIdentityChanged(
            { path: "/tmp/a.db", dev: 10, ino: 20 },
            { path: "/tmp/a.db", dev: 10, ino: 20 }
        )).toBe(false);
    });

    it("returns true when the database file was replaced", () => {
        expect(hasSqliteFileIdentityChanged(
            { path: "/tmp/a.db", dev: 10, ino: 20 },
            { path: "/tmp/a.db", dev: 10, ino: 21 }
        )).toBe(true);
    });
});

describe("findPendingPrismaMigrations", () => {
    it("returns pending migrations that were not applied to the database", () => {
        expect(findPendingPrismaMigrations(
            ["20260101_init", "20260102_add_feature", "20260103_fix_index"],
            ["20260101_init"]
        )).toEqual(["20260102_add_feature", "20260103_fix_index"]);
    });

    it("returns an empty list when all migrations are already applied", () => {
        expect(findPendingPrismaMigrations(
            ["20260101_init", "20260102_add_feature"],
            ["20260101_init", "20260102_add_feature"]
        )).toEqual([]);
    });
});
