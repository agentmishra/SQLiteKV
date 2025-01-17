import sqlite3 from "sqlite3";
import { open, Database } from "sqlite";
import fs from "fs/promises";
import path from "path";
import { ValueType, JournalMode, SQLiteMode, Row } from "./types";

export class SQLiteDatabase {
    private db: Database | null = null;
    private tableName: string;
    private autoCommit: boolean;
    private inTransaction: boolean = false;
    private dbPath: string;
    private journalMode: JournalMode;
    private sqliteMode: SQLiteMode;

    constructor(
        private dbFilename: string = "database.sqlite",
        tableName: string = "kv_store",
        autoCommit: boolean = true,
        journalMode: JournalMode = "WAL",
        sqliteMode: SQLiteMode = "disk"
    ) {
        this.tableName = tableName;
        this.autoCommit = autoCommit;
        this.journalMode = journalMode;
        this.sqliteMode = sqliteMode;
        this.dbPath = this.getDbPathByMode(dbFilename, sqliteMode);
    }

    private getDbPathByMode(dbFilename: string, mode: SQLiteMode): string {
        switch (mode) {
            case "memory":
                return ":memory:";
            case "temp":
                return path.join(process.cwd(), "temp.sqlite");
            case "disk":
            default:
                return path.join(process.cwd(), dbFilename);
        }
    }

    async init(): Promise<void> {
        if (this.db) {
            return;
        }
        if (this.sqliteMode === "disk") {
            await this.ensureDirectoryExists(path.dirname(this.dbPath));
        }
        this.db = await open({
            filename: this.dbPath,
            driver: sqlite3.Database
        });
        await this.createTable();
        await this.setJournalMode(this.journalMode);
    }

    private async createTable(): Promise<void> {
        if (!this.db) {
            throw new Error("Database not initialized");
        }
        await this.db.run(
            `CREATE TABLE IF NOT EXISTS ${this.tableName} (
                key TEXT PRIMARY KEY,
                value TEXT,
                expiry INTEGER,
                one_time INTEGER DEFAULT 0
            )`
        );
    }

    public async setJournalMode(mode: JournalMode): Promise<void> {
        if (!this.db) {
            throw new Error("Database not initialized");
        }

        await this.db.run(`PRAGMA journal_mode = ${mode.toUpperCase()};`);

        const result = await this.db.get("PRAGMA journal_mode;");
        const currentMode = result?.["journal_mode"];
    }

    getDbPath(): string {
        return this.dbPath;
    }

    getDbFilename(): string {
        return this.dbFilename;
    }

    getTableName(): string {
        return this.tableName;
    }

    public async getJournalMode(): Promise<JournalMode> {
        if (!this.db) {
            throw new Error("Database not initialized");
        }
        const result = await this.db.get("PRAGMA journal_mode;");
        return result?.["journal_mode"] as JournalMode;
    }

    async set(
        key: string,
        value: ValueType,
        oneTime: boolean = false
    ): Promise<boolean> {
        return this.setWithExpiry(key, value, null, oneTime);
    }

    async setex(
        key: string,
        seconds: number,
        value: ValueType
    ): Promise<boolean> {
        const expiry = Date.now() + seconds * 1000;
        return this.setWithExpiry(key, value, expiry, false);
    }

    private async setWithExpiry(
        key: string,
        value: ValueType,
        expiry: number | null,
        oneTime: boolean
    ): Promise<boolean> {
        if (!this.db) {
            throw new Error("Database not initialized");
        }
        const jsonValue = JSON.stringify(value);
        await this.db.run(
            `INSERT OR REPLACE INTO ${this.tableName} (key, value, expiry, one_time) VALUES (?, ?, ?, ?)`,
            [key, jsonValue, expiry, oneTime ? 1 : 0]
        );
        if (this.autoCommit && !this.inTransaction) {
            await this.commitTransaction();
        }
        return true;
    }

    async get(key: string): Promise<ValueType | string> {
        if (!this.db) {
            throw new Error("Database not initialized");
        }
        const result = await this.db.get(
            `SELECT value, expiry, one_time FROM ${this.tableName} WHERE key = ?`,
            [key]
        );

        if (!result || !result.value) {
            return "Key does not exist";
        }

        if (
            result.expiry &&
            typeof result.expiry === "number" &&
            result.expiry < Date.now()
        ) {
            await this.delete(key);
            return "Key has expired";
        }

        if (result.one_time && result.one_time === 1) {
            await this.delete(key);
        }

        return JSON.parse(result.value);
    }

    async delete(key: string): Promise<boolean> {
        if (!this.db) {
            throw new Error("Database not initialized");
        }
        const result = await this.db.run(
            `DELETE FROM ${this.tableName} WHERE key = ?`,
            [key]
        );
        if (this.autoCommit && !this.inTransaction) {
            await this.commitTransaction();
        }
        return result && result.changes !== undefined
            ? result.changes > 0
            : false;
    }

    async exists(key: string): Promise<boolean> {
        if (!this.db) {
            throw new Error("Database not initialized");
        }
        const result = await this.db.get(
            `SELECT 1 FROM ${this.tableName} WHERE key = ?`,
            [key]
        );
        return result !== undefined;
    }

    async keys(pattern?: string): Promise<string[]> {
        if (!this.db) {
            throw new Error("Database not initialized");
        }

        let query = `SELECT key FROM ${this.tableName}`;
        const params: any[] = [];

        if (pattern) {
            query += ` WHERE key LIKE ?`;
            params.push(pattern.replace(/%/g, "\\%").replace(/_/g, "\\_"));
        }

        const result = await this.db.all(query, params);
        return result.map((row: Row) => row.key);
    }

    async convertToJson(jsonFilePath?: string): Promise<boolean> {
        if (!this.db) {
            throw new Error("Database not initialized");
        }
        const result = await this.db.all(
            `SELECT key, value FROM ${this.tableName}`
        );
        const jsonObject: { [key: string]: ValueType } = {};
        result.forEach((row: Row) => {
            const key = row.key;
            const value = JSON.parse(row.value);
            jsonObject[key] = value;
        });

        const jsonString = JSON.stringify(jsonObject, null, 2);
        const filePath =
            jsonFilePath || path.join(process.cwd(), "database_export.json");

        try {
            await fs.writeFile(filePath, jsonString);
            return true;
        } catch (error) {
            return false;
        }
    }

    async close(): Promise<void> {
        if (!this.db) {
            throw new Error("Database not initialized");
        }
        await this.db.close();
        this.db = null;
    }

    private async ensureDirectoryExists(dirPath: string): Promise<void> {
        try {
            await fs.mkdir(dirPath, { recursive: true });
        } catch (err: unknown) {
            if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
                throw err;
            }
        }
    }

    async beginTransaction(): Promise<void> {
        if (!this.db) {
            throw new Error("Database not initialized");
        }
        await this.db.run("BEGIN TRANSACTION");
        this.inTransaction = true;
    }

    async commitTransaction(): Promise<void> {
        if (!this.db) {
            throw new Error("Database not initialized");
        }
        if (this.inTransaction) {
            await this.db.run("COMMIT");
            this.inTransaction = false;
        }
    }

    async ttl(key: string): Promise<number | string> {
        if (!this.db) {
            throw new Error("Database not initialized");
        }
        const result = await this.db.get(
            `SELECT expiry FROM ${this.tableName} WHERE key = ?`,
            [key]
        );

        if (!result || !result.expiry) {
            return "Key does not exist";
        }

        if (typeof result.expiry === "number") {
            const timeLeft = result.expiry - Date.now();
            return Math.max(timeLeft, 0);
        } else {
            return "Invalid expiry time";
        }
    }

    async clear(): Promise<void> {
        if (!this.db) {
            throw new Error("Database not initialized");
        }
        await this.db.run(`DELETE FROM ${this.tableName}`);
    }

    async getInfo(): Promise<{
        journalMode: JournalMode;
        dbPath: string;
        dbFilename: string;
        tableName: string;
        dbSize: number;
        keysCount: number;
    }> {
        if (!this.db) {
            throw new Error("Database not initialized");
        }
        const journalMode = await this.getJournalMode();
        const dbSize = (await fs.stat(this.dbPath)).size;
        const keysCount = (await this.keys()).length;

        return {
            journalMode,
            dbPath: this.dbPath,
            dbFilename: this.dbFilename,
            tableName: this.tableName,
            dbSize,
            keysCount
        };
    }

    async checkJournalFile(): Promise<boolean> {
        const journalPath = this.dbPath + "-journal";
        try {
            await fs.access(journalPath);
            return true;
        } catch {
            return false;
        }
    }

    async performLoopOperations(
        operations: () => Promise<void>,
        iterations: number
    ): Promise<void> {
        if (!this.db) {
            throw new Error("Database not initialized");
        }
        for (let i = 0; i < iterations; i++) {
            await operations();
        }
    }
}
