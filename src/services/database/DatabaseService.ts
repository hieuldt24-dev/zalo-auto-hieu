import * as path from 'path';
import * as fs from 'fs';
import { app, safeStorage } from 'electron';
import Logger from '../../utils/Logger';
import BetterSqlite3 from 'better-sqlite3';
import type { Account, Message, Contact, CRMNote, CRMCampaign, CRMCampaignContact, CRMSendLog, CRMCampaignStatus, CRMContactStatus } from '../../models';

// better-sqlite3: native SQLite — no WASM heap, memory-mapped I/O
let db: BetterSqlite3.Database | null = null;

// ── Cached secondary DB for withDbPath (avoids repeated open/close) ─────────
let _cachedSecondaryDb: BetterSqlite3.Database | null = null;
let _cachedSecondaryPath: string | null = null;
let _cachedSecondaryTimer: ReturnType<typeof setTimeout> | null = null;
const SECONDARY_DB_TTL_MS = 30_000; // auto-close after 30s idle

function getCachedSecondaryDb(targetDbPath: string): BetterSqlite3.Database {
    if (_cachedSecondaryPath === targetDbPath && _cachedSecondaryDb) {
        // Reset idle timer
        if (_cachedSecondaryTimer) clearTimeout(_cachedSecondaryTimer);
        _cachedSecondaryTimer = setTimeout(closeCachedSecondaryDb, SECONDARY_DB_TTL_MS);
        return _cachedSecondaryDb;
    }
    // Close previous if different path
    closeCachedSecondaryDb();
    _cachedSecondaryDb = new BetterSqlite3(targetDbPath);
    _cachedSecondaryDb.pragma('journal_mode = WAL');
    _cachedSecondaryPath = targetDbPath;
    _cachedSecondaryTimer = setTimeout(closeCachedSecondaryDb, SECONDARY_DB_TTL_MS);
    return _cachedSecondaryDb;
}

function closeCachedSecondaryDb(): void {
    if (_cachedSecondaryTimer) { clearTimeout(_cachedSecondaryTimer); _cachedSecondaryTimer = null; }
    if (_cachedSecondaryDb) {
        try { _cachedSecondaryDb.close(); } catch {}
        _cachedSecondaryDb = null;
        _cachedSecondaryPath = null;
    }
}


class DatabaseService {
    private static instance: DatabaseService;
    private dbPath: string = '';
    private initialized = false;

    /** Open a better-sqlite3 database at the given path with WAL mode */
    private openDb(dbPath: string): BetterSqlite3.Database {
        const newDb = new BetterSqlite3(dbPath);
        newDb.pragma('journal_mode = WAL');
        newDb.pragma('synchronous = NORMAL');
        return newDb;
    }

    public static getInstance(): DatabaseService {
        if (!DatabaseService.instance) {
            DatabaseService.instance = new DatabaseService();
        }
        return DatabaseService.instance;
    }

    public async initialize(): Promise<void> {
        try {
            const userDataPath = app.getPath('userData');
            Logger.log(`[DatabaseService] userData path: ${userDataPath}`);

            // ─── Workspace-aware DB path resolution ─────────────────────
            let resolvedViaWorkspace = false;
            try {
                const WorkspaceManager = require('../../utils/WorkspaceManager').default;
                const wm = WorkspaceManager.getInstance();
                const activeDbPath = wm.getActiveDbPath();
                if (activeDbPath) {
                    this.dbPath = activeDbPath;
                    resolvedViaWorkspace = true;
                    Logger.log(`[DatabaseService] DB path from WorkspaceManager: ${this.dbPath}`);
                }
            } catch { /* WorkspaceManager not yet initialized — fall back to legacy */ }

            if (!resolvedViaWorkspace) {
                let dbFolder = userDataPath;
                const configPath = path.join(userDataPath, 'deplao-config.json');
                if (fs.existsSync(configPath)) {
                    try {
                        const cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
                        if (cfg.dbFolder) {
                            if (fs.existsSync(cfg.dbFolder)) {
                                dbFolder = cfg.dbFolder;
                                Logger.log(`[DatabaseService] Using custom dbFolder from config: ${dbFolder}`);
                            } else {
                                Logger.warn(`[DatabaseService] Configured dbFolder not found: ${cfg.dbFolder} — attempting to create it`);
                                try {
                                    fs.mkdirSync(cfg.dbFolder, { recursive: true });
                                    dbFolder = cfg.dbFolder;
                                    Logger.log(`[DatabaseService] Created missing dbFolder: ${dbFolder}`);
                                } catch (mkErr: any) {
                                    Logger.error(`[DatabaseService] Cannot create dbFolder ${cfg.dbFolder}: ${mkErr.message} — falling back to userData`);
                                }
                            }
                        }
                    } catch {}
                }
                this.dbPath = path.join(dbFolder, 'deplao-tool.db');
            }

            const dir = path.dirname(this.dbPath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }

            // Open DB with better-sqlite3 (native SQLite, memory-mapped I/O)
            db = this.openDb(this.dbPath);

            this.createTables();
            this.migrate();
            this.initialized = true;
            Logger.log(`[DatabaseService] Initialized at ${this.dbPath} (better-sqlite3, WAL mode)`);
        } catch (error: any) {
            Logger.error(`[DatabaseService] Failed to initialize: ${error.message}`);
            // Fall back to in-memory db so app still runs
            try {
                db = new BetterSqlite3(':memory:');
                this.createTables();
                this.migrate();
                this.initialized = true;
                Logger.warn(`[DatabaseService] Using in-memory database as fallback`);
            } catch (e2: any) {
                Logger.error(`[DatabaseService] In-memory fallback also failed: ${e2.message}`);
            }
        }
    }

    /** No-op: better-sqlite3 with WAL mode writes directly to disk. Kept for API compat. */
    public save(): void {
        // better-sqlite3 writes to disk automatically via WAL — nothing to do
    }

    /** No-op: better-sqlite3 auto-persists. Kept for API compat. */
    private scheduleSave(): void {
        // No-op — WAL mode auto-writes
    }

    /**
     * WAL checkpoint — ensures all writes are flushed to main DB file.
     * Call before copy/move DB file, switch workspace, or app quit.
     */
    public forceFlush(): void {
        try {
            if (db) {
                db.pragma('wal_checkpoint(TRUNCATE)');
                Logger.log(`[DatabaseService] WAL checkpoint completed for ${this.dbPath}`);
            }
        } catch (err: any) {
            Logger.warn(`[DatabaseService] WAL checkpoint error: ${err.message}`);
        }
    }

    /**
     * Reinitialize DatabaseService từ path mới (đọc lại deplao-config.json).
     * Gọi sau khi thay đổi dbFolder trong config để áp dụng ngay không cần restart.
     */
    public async reinitialize(): Promise<void> {
        Logger.log('[DatabaseService] Reinitializing from new config...');
        try { db?.close(); } catch {}
        db = null;
        this.initialized = false;
        this.dbPath = '';
        await this.initialize();
        Logger.log(`[DatabaseService] Reinitialized at ${this.dbPath}`);
    }

    /**
     * Switch DB to a different workspace's database file.
     * Closes current DB, opens the new one, runs migrations.
     * Used when user switches workspace in multi-workspace mode.
     */
    /** Lock to prevent concurrent DB access during workspace switch */
    private switching = false;
    private switchQueue: Array<{ resolve: (v: any) => void; fn: () => any }> = [];

    public async switchToWorkspaceDb(newDbPath: string): Promise<void> {
        Logger.log(`[DatabaseService] Switching DB to: ${newDbPath}`);

        const targetDbPath = path.resolve(newDbPath);
        const currentDbPath = this.dbPath ? path.resolve(this.dbPath) : '';
        if (currentDbPath && currentDbPath === targetDbPath) {
            Logger.log(`[DatabaseService] Switch skipped — already using ${targetDbPath}`);
            return;
        }

        // Set switching lock — queues any concurrent run()/query() calls
        this.switching = true;

        const prevDbPath = this.dbPath;
        const prevDb = db;

        try {
            const dir = path.dirname(targetDbPath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
                Logger.log(`[DatabaseService] Created directory: ${dir}`);
            }

            // Close cached secondary DB (if any) before switching
            closeCachedSecondaryDb();

            // Close old DB
            try {
                prevDb?.close();
            } catch (closeErr: any) {
                Logger.warn(`[DatabaseService] Failed to close previous DB before switch: ${closeErr.message}`);
            }
            db = null;

            // Open the new DB (better-sqlite3 handles create-if-not-exists automatically)
            try {
                db = this.openDb(targetDbPath);
                Logger.log(`[DatabaseService] Opened DB: ${targetDbPath}`);
            } catch (loadErr: any) {
                const msg = loadErr?.message || String(loadErr);
                Logger.warn(`[DatabaseService] Failed to open DB (corrupt?): ${msg}. Backing up and creating fresh DB.`);
                try {
                    const backupPath = `${targetDbPath}.corrupt-${Date.now()}.bak`;
                    fs.copyFileSync(targetDbPath, backupPath);
                    Logger.warn(`[DatabaseService] Backed up corrupt DB to: ${backupPath}`);
                } catch (backupErr: any) {
                    Logger.warn(`[DatabaseService] Failed to back up corrupt DB: ${backupErr.message}`);
                }
                // Delete corrupt file and retry
                try { fs.unlinkSync(targetDbPath); } catch {}
                db = this.openDb(targetDbPath);
                Logger.log(`[DatabaseService] Created fresh DB after failed load: ${targetDbPath}`);
            }

            this.dbPath = targetDbPath;
            this.createTables();
            this.migrate();
            this.initialized = true;

            Logger.log(`[DatabaseService] Workspace DB ready at ${this.dbPath}`);
        } catch (err: any) {
            const errMsg = err?.message || String(err);
            Logger.error(`[DatabaseService] switchToWorkspaceDb failed: ${errMsg}. Rolling back to ${prevDbPath}.`);
            this.dbPath = prevDbPath;
            try {
                if (prevDbPath && fs.existsSync(prevDbPath)) {
                    db = this.openDb(prevDbPath);
                } else {
                    db = new BetterSqlite3(':memory:');
                }
                this.initialized = true;
                Logger.warn(`[DatabaseService] Restored previous DB: ${prevDbPath}`);
            } catch (restoreErr: any) {
                Logger.error(`[DatabaseService] Failed to restore previous DB: ${restoreErr.message}`);
            }
            throw new Error(`switchToWorkspaceDb failed: ${errMsg}`);
        } finally {
            this.switching = false;
            const queued = this.switchQueue.splice(0);
            for (const item of queued) {
                try { item.resolve(item.fn()); } catch (e) { item.resolve(undefined); }
            }
        }
    }

    /**
     * Temporarily switch to a different DB file, run a synchronous callback,
     * then switch back. Used by EmployeeService to access the relay workspace DB.
     * @deprecated Use queryOtherDb() instead — withDbPath swaps the global db and is unsafe with concurrent IPC.
     */
    public withDbPath<T>(targetDbPath: string, fn: () => T): T {
        const currentPath = this.dbPath;
        const currentDb = db;
        if (currentPath === targetDbPath) {
            return fn();
        }
        try {
            db = getCachedSecondaryDb(targetDbPath);
            this.dbPath = targetDbPath;
            const result = fn();
            return result;
        } finally {
            db = currentDb;
            this.dbPath = currentPath;
        }
    }

    /**
     * Execute a callback against a SEPARATE DB instance — does NOT swap the global db.
     * Safe for use from relay/socket handlers that may run concurrently with IPC.
     */
    public queryOtherDb<T>(targetDbPath: string, fn: (otherDb: any) => T): T {
        const resolvedPath = path.resolve(targetDbPath);
        if (!fs.existsSync(resolvedPath)) {
            throw new Error(`DB file not found: ${resolvedPath}`);
        }
        const otherDb = new BetterSqlite3(resolvedPath, { readonly: false });
        otherDb.pragma('journal_mode = WAL');
        try {
            return fn(otherDb);
        } finally {
            try { otherDb.close(); } catch {}
        }
    }

    public exec(sql: string): void {
        db!.exec(sql);
    }

    public run(sql: string, params: any[] = []): void {
        db!.prepare(sql).run(...params);
    }

    /** Execute SQL without flushing to disk — same as run() now (WAL auto-writes) */
    private runNoSave(sql: string, params: any[] = []): void {
        db!.prepare(sql).run(...params);
    }

    /** Run an INSERT and return the new rowid. */
    public runInsert(sql: string, params: any[] = []): number {
        const result = db!.prepare(sql).run(...params);
        return Number(result.lastInsertRowid) || 0;
    }

    /**
     * Run `fn` inside a SQLite transaction. Returns whatever `fn` returns.
     * Uses better-sqlite3 native transaction → automatic ROLLBACK on throw.
     */
    public transaction<T>(fn: () => T): T {
        return db!.transaction(fn)();
    }

    public query<T>(sql: string, params: any[] = []): T[] {
        try {
            return db!.prepare(sql).all(...params) as T[];
        } catch (err: any) {
            Logger.error(`[DatabaseService] Query error: ${err.message} | SQL: ${sql}`);
            return [];
        }
    }

    queryOne<T>(sql: string, params: any[] = []): T | undefined {
        try {
            return db!.prepare(sql).get(...params) as T | undefined;
        } catch (err: any) {
            Logger.error(`[DatabaseService] QueryOne error: ${err.message} | SQL: ${sql}`);
            return undefined;
        }
    }

    /** Chuẩn hóa số điện thoại VN trước khi lưu DB: +84/84 -> 0 */
    private normalizeVietnamPhone(phone?: string): string {
        if (!phone) return '';
        const cleaned = String(phone).trim().replace(/[\s().-]/g, '');
        if (!cleaned) return '';
        if (cleaned.startsWith('+84')) {
            const local = cleaned.slice(3).replace(/^0+/, '');
            return `0${local}`;
        }
        if (cleaned.startsWith('84')) {
            const local = cleaned.slice(2).replace(/^0+/, '');
            return `0${local}`;
        }
        return cleaned;
    }

    private createTables(): void {
        this.exec(`
            CREATE TABLE IF NOT EXISTS accounts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                zalo_id TEXT UNIQUE NOT NULL,
                full_name TEXT NOT NULL DEFAULT '',
                avatar_url TEXT DEFAULT '',
                imei TEXT NOT NULL,
                user_agent TEXT NOT NULL,
                cookies TEXT NOT NULL,
                is_active INTEGER DEFAULT 1,
                is_business INTEGER DEFAULT 0,
                created_at TEXT NOT NULL,
                last_seen TEXT,
                listener_active INTEGER DEFAULT 1
            );
        `);

        this.exec(`
            CREATE TABLE IF NOT EXISTS messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                msg_id TEXT NOT NULL,
                cli_msg_id TEXT,
                owner_zalo_id TEXT NOT NULL,
                thread_id TEXT NOT NULL,
                thread_type INTEGER NOT NULL DEFAULT 0,
                sender_id TEXT NOT NULL,
                content TEXT NOT NULL DEFAULT '',
                msg_type TEXT NOT NULL DEFAULT 'text',
                timestamp INTEGER NOT NULL,
                is_sent INTEGER DEFAULT 0,
                attachments TEXT DEFAULT '[]',
                local_paths TEXT DEFAULT '{}',
                status TEXT DEFAULT 'received',
                is_recalled INTEGER DEFAULT 0,
                UNIQUE(msg_id, owner_zalo_id)
            );
            CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(owner_zalo_id, thread_id, timestamp);
        `);

        this.exec(`
            CREATE TABLE IF NOT EXISTS contacts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                owner_zalo_id TEXT NOT NULL,
                contact_id TEXT NOT NULL,
                display_name TEXT NOT NULL DEFAULT '',
                avatar_url TEXT DEFAULT '',
                phone TEXT DEFAULT '',
                is_friend INTEGER DEFAULT 0,
                contact_type TEXT DEFAULT 'user',
                unread_count INTEGER DEFAULT 0,
                last_message TEXT DEFAULT '',
                last_message_time INTEGER DEFAULT 0,
                UNIQUE(owner_zalo_id, contact_id)
            );
        `);

        this.exec(`
            CREATE TABLE IF NOT EXISTS app_settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
        `);

        this.exec(`
            CREATE TABLE IF NOT EXISTS friends (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                owner_zalo_id TEXT NOT NULL,
                user_id TEXT NOT NULL,
                display_name TEXT DEFAULT '',
                avatar TEXT DEFAULT '',
                phone TEXT DEFAULT '',
                updated_at INTEGER DEFAULT 0,
                UNIQUE(owner_zalo_id, user_id)
            );
            CREATE INDEX IF NOT EXISTS idx_friends_owner ON friends(owner_zalo_id);
        `);

        this.exec(`
            CREATE TABLE IF NOT EXISTS links (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                owner_zalo_id TEXT NOT NULL,
                thread_id TEXT NOT NULL,
                msg_id TEXT NOT NULL,
                url TEXT NOT NULL,
                title TEXT DEFAULT '',
                domain TEXT DEFAULT '',
                thumb_url TEXT DEFAULT '',
                timestamp INTEGER NOT NULL,
                UNIQUE(owner_zalo_id, msg_id)
            );
            CREATE INDEX IF NOT EXISTS idx_links_thread ON links(owner_zalo_id, thread_id, timestamp);
        `);

        this.exec(`
            CREATE TABLE IF NOT EXISTS page_group_member (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                owner_zalo_id TEXT NOT NULL,
                group_id TEXT NOT NULL,
                member_id TEXT NOT NULL,
                display_name TEXT DEFAULT '',
                avatar TEXT DEFAULT '',
                role INTEGER DEFAULT 0,
                updated_at INTEGER DEFAULT 0,
                UNIQUE(owner_zalo_id, group_id, member_id)
            );
            CREATE INDEX IF NOT EXISTS idx_group_member ON page_group_member(owner_zalo_id, group_id);
        `);

        // Sticker cache — device-wide (no owner_zalo_id)
        this.exec(`
            CREATE TABLE IF NOT EXISTS stickers (
                sticker_id INTEGER PRIMARY KEY,
                cat_id INTEGER DEFAULT 0,
                type INTEGER DEFAULT 0,
                text TEXT DEFAULT '',
                sticker_url TEXT DEFAULT '',
                sticker_sprite_url TEXT DEFAULT '',
                checksum TEXT DEFAULT '',
                data_json TEXT DEFAULT '{}',
                unsupported INTEGER DEFAULT 0,
                updated_at INTEGER DEFAULT 0
            );
        `);

        this.exec(`
            CREATE TABLE IF NOT EXISTS sticker_packs (
                cat_id INTEGER PRIMARY KEY,
                name TEXT DEFAULT '',
                thumb_url TEXT DEFAULT '',
                sticker_count INTEGER DEFAULT 0,
                data_json TEXT DEFAULT '{}',
                updated_at INTEGER DEFAULT 0
            );
        `);

        this.exec(`
            CREATE TABLE IF NOT EXISTS recent_stickers (
                sticker_id INTEGER PRIMARY KEY,
                used_at INTEGER NOT NULL
            );
        `);

        // Keyword → sticker IDs cache
        this.exec(`
            CREATE TABLE IF NOT EXISTS keyword_stickers (
                keyword TEXT PRIMARY KEY,
                sticker_ids TEXT DEFAULT '[]',
                updated_at INTEGER DEFAULT 0
            );
        `);

        this.exec(`
            CREATE TABLE IF NOT EXISTS pinned_messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                owner_zalo_id TEXT NOT NULL,
                thread_id TEXT NOT NULL,
                msg_id TEXT NOT NULL,
                msg_type TEXT NOT NULL DEFAULT 'text',
                content TEXT NOT NULL DEFAULT '',
                preview_text TEXT DEFAULT '',
                preview_image TEXT DEFAULT '',
                sender_id TEXT DEFAULT '',
                sender_name TEXT DEFAULT '',
                timestamp INTEGER NOT NULL DEFAULT 0,
                pinned_at INTEGER NOT NULL DEFAULT 0,
                UNIQUE(owner_zalo_id, thread_id, msg_id)
            );
            CREATE INDEX IF NOT EXISTS idx_pinned ON pinned_messages(owner_zalo_id, thread_id, pinned_at DESC);
        `);

        this.exec(`
            CREATE TABLE IF NOT EXISTS friend_requests (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                owner_zalo_id TEXT NOT NULL,
                user_id TEXT NOT NULL,
                display_name TEXT DEFAULT '',
                avatar TEXT DEFAULT '',
                phone TEXT DEFAULT '',
                direction TEXT NOT NULL DEFAULT 'received',
                msg TEXT DEFAULT '',
                created_at INTEGER DEFAULT 0,
                updated_at INTEGER DEFAULT 0,
                UNIQUE(owner_zalo_id, user_id, direction)
            );
            CREATE INDEX IF NOT EXISTS idx_friend_requests_owner ON friend_requests(owner_zalo_id, direction);
        `);

        this.exec(`
            CREATE TABLE IF NOT EXISTS local_quick_messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                owner_zalo_id TEXT NOT NULL,
                keyword TEXT NOT NULL,
                title TEXT NOT NULL DEFAULT '',
                media_json TEXT DEFAULT NULL,
                created_at INTEGER NOT NULL DEFAULT 0,
                updated_at INTEGER NOT NULL DEFAULT 0,
                UNIQUE(owner_zalo_id, keyword)
            );
            CREATE INDEX IF NOT EXISTS idx_lqm_owner ON local_quick_messages(owner_zalo_id);
        `);

        this.exec(`
            CREATE TABLE IF NOT EXISTS local_pinned_conversations (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                owner_zalo_id TEXT NOT NULL,
                thread_id TEXT NOT NULL,
                pinned_at INTEGER NOT NULL DEFAULT 0,
                UNIQUE(owner_zalo_id, thread_id)
            );
            CREATE INDEX IF NOT EXISTS idx_lpc_owner ON local_pinned_conversations(owner_zalo_id, pinned_at DESC);
        `);

        // ─── CRM tables ──────────────────────────────────────────────────────
        this.exec(`
            CREATE TABLE IF NOT EXISTS crm_tags (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                owner_zalo_id TEXT NOT NULL,
                name TEXT NOT NULL,
                color TEXT NOT NULL DEFAULT '#3B82F6',
                emoji TEXT NOT NULL DEFAULT '🏷️',
                created_at INTEGER NOT NULL DEFAULT 0,
                UNIQUE(owner_zalo_id, name)
            );
            CREATE INDEX IF NOT EXISTS idx_crm_tags_owner ON crm_tags(owner_zalo_id);
        `);

        this.exec(`
            CREATE TABLE IF NOT EXISTS crm_contact_tags (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                owner_zalo_id TEXT NOT NULL,
                contact_id TEXT NOT NULL,
                tag_id INTEGER NOT NULL,
                UNIQUE(owner_zalo_id, contact_id, tag_id),
                FOREIGN KEY(tag_id) REFERENCES crm_tags(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_crm_ct_owner ON crm_contact_tags(owner_zalo_id, contact_id);
            CREATE INDEX IF NOT EXISTS idx_crm_ct_tag ON crm_contact_tags(tag_id);
        `);

        this.exec(`
            CREATE TABLE IF NOT EXISTS crm_notes (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                owner_zalo_id TEXT NOT NULL,
                contact_id TEXT NOT NULL,
                contact_type TEXT NOT NULL DEFAULT 'user',
                content TEXT NOT NULL DEFAULT '',
                topic_id TEXT DEFAULT NULL,
                created_at INTEGER NOT NULL DEFAULT 0,
                updated_at INTEGER NOT NULL DEFAULT 0
            );
            CREATE INDEX IF NOT EXISTS idx_crm_notes ON crm_notes(owner_zalo_id, contact_id);
        `);

        this.exec(`
            CREATE TABLE IF NOT EXISTS crm_campaigns (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                owner_zalo_id TEXT NOT NULL,
                name TEXT NOT NULL,
                template_message TEXT NOT NULL DEFAULT '',
                friend_request_message TEXT NOT NULL DEFAULT '',
                campaign_type TEXT NOT NULL DEFAULT 'message',
                mixed_config TEXT NOT NULL DEFAULT '{}',
                status TEXT NOT NULL DEFAULT 'draft',
                delay_seconds INTEGER NOT NULL DEFAULT 60,
                created_at INTEGER NOT NULL DEFAULT 0,
                updated_at INTEGER NOT NULL DEFAULT 0
            );
            CREATE INDEX IF NOT EXISTS idx_crm_campaigns ON crm_campaigns(owner_zalo_id, status);
        `);
        // Migration: add new columns if they don't exist yet (existing DBs)
        try { this.exec(`ALTER TABLE crm_campaigns ADD COLUMN friend_request_message TEXT NOT NULL DEFAULT ''`); } catch {}
        try { this.exec(`ALTER TABLE crm_campaigns ADD COLUMN campaign_type TEXT NOT NULL DEFAULT 'message'`); } catch {}
        try { this.exec(`ALTER TABLE crm_campaigns ADD COLUMN mixed_config TEXT NOT NULL DEFAULT '{}'`); } catch {}
        try { this.exec(`ALTER TABLE crm_campaign_contacts ADD COLUMN phone TEXT NOT NULL DEFAULT ''`); } catch {}

        this.exec(`
            CREATE TABLE IF NOT EXISTS crm_campaign_contacts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                campaign_id INTEGER NOT NULL,
                owner_zalo_id TEXT NOT NULL,
                contact_id TEXT NOT NULL,
                display_name TEXT DEFAULT '',
                avatar TEXT DEFAULT '',
                status TEXT NOT NULL DEFAULT 'pending',
                sent_at INTEGER DEFAULT 0,
                retry_count INTEGER DEFAULT 0,
                error TEXT DEFAULT '',
                UNIQUE(campaign_id, contact_id),
                FOREIGN KEY(campaign_id) REFERENCES crm_campaigns(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_crm_cc_campaign ON crm_campaign_contacts(campaign_id, status);
            CREATE INDEX IF NOT EXISTS idx_crm_cc_owner ON crm_campaign_contacts(owner_zalo_id, status);
        `);

        this.exec(`
            CREATE TABLE IF NOT EXISTS crm_send_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                owner_zalo_id TEXT NOT NULL,
                contact_id TEXT NOT NULL,
                display_name TEXT DEFAULT '',
                phone TEXT DEFAULT '',
                contact_type TEXT DEFAULT 'user',
                campaign_id INTEGER DEFAULT NULL,
                message TEXT NOT NULL DEFAULT '',
                sent_at INTEGER NOT NULL DEFAULT 0,
                status TEXT NOT NULL DEFAULT 'sent',
                error TEXT DEFAULT '',
                data_request TEXT DEFAULT '',
                data_response TEXT DEFAULT '',
                send_type TEXT DEFAULT ''
            );
            CREATE INDEX IF NOT EXISTS idx_crm_log_owner ON crm_send_log(owner_zalo_id, sent_at DESC);
            CREATE INDEX IF NOT EXISTS idx_crm_log_contact ON crm_send_log(owner_zalo_id, contact_id);
        `);

        // ─── Local Labels (custom per-app labels, independent from Zalo) ────────
        this.exec(`
            CREATE TABLE IF NOT EXISTS local_labels (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                color TEXT NOT NULL DEFAULT '#3B82F6',
                text_color TEXT NOT NULL DEFAULT '#FFFFFF',
                emoji TEXT NOT NULL DEFAULT '🏷️',
                page_ids TEXT NOT NULL DEFAULT '',
                created_at INTEGER NOT NULL DEFAULT 0,
                updated_at INTEGER NOT NULL DEFAULT 0
            );
            CREATE INDEX IF NOT EXISTS idx_local_labels_name ON local_labels(name);
        `);

        this.exec(`
            CREATE TABLE IF NOT EXISTS local_label_threads (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                owner_zalo_id TEXT NOT NULL,
                label_id INTEGER NOT NULL,
                thread_id TEXT NOT NULL,
                created_at INTEGER NOT NULL DEFAULT 0,
                UNIQUE(owner_zalo_id, label_id, thread_id),
                FOREIGN KEY(label_id) REFERENCES local_labels(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_llt_owner ON local_label_threads(owner_zalo_id, label_id);
            CREATE INDEX IF NOT EXISTS idx_llt_thread ON local_label_threads(owner_zalo_id, thread_id);
        `);

        // ─── Proxies ─────────────────────────────────────────────────────────────
        this.exec(`
            CREATE TABLE IF NOT EXISTS proxies (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                name        TEXT NOT NULL DEFAULT '',
                type        TEXT NOT NULL DEFAULT 'http',
                host        TEXT NOT NULL DEFAULT '',
                port        INTEGER NOT NULL DEFAULT 0,
                username    TEXT DEFAULT '',
                password    TEXT DEFAULT '',
                created_at  INTEGER NOT NULL DEFAULT 0,
                updated_at  INTEGER NOT NULL DEFAULT 0
            );
        `);

    }

    /** Dọn dẹp dữ liệu cũ bị lỗi từ các phiên bản trước */
    private migrate(): void {
        try {
            // Add quote_data column if it doesn't exist
            const cols = this.query<any>(`PRAGMA table_info(messages)`);
            const hasQuoteData = cols.some((c) => c.name === 'quote_data');
            if (!hasQuoteData) {
                db!.exec(`ALTER TABLE messages ADD COLUMN quote_data TEXT DEFAULT NULL`);
                this.save();
                Logger.log('[DatabaseService] Migration: added quote_data column');
            }

            const hasReactions = cols.some((c) => c.name === 'reactions');
            if (!hasReactions) {
                db!.exec(`ALTER TABLE messages ADD COLUMN reactions TEXT DEFAULT '{}'`);
                this.save();
                Logger.log('[DatabaseService] Migration: added reactions column');
            }

            const hasIsRecalled = cols.some((c: any) => c.name === 'is_recalled');
            if (!hasIsRecalled) {
                db!.exec(`ALTER TABLE messages ADD COLUMN is_recalled INTEGER DEFAULT 0`);
                this.save();
                Logger.log('[DatabaseService] Migration: added is_recalled column');
            }

            const hasRecalledContent = cols.some((c: any) => c.name === 'recalled_content');
            if (!hasRecalledContent) {
                db!.exec(`ALTER TABLE messages ADD COLUMN recalled_content TEXT DEFAULT NULL`);
                this.save();
                Logger.log('[DatabaseService] Migration: added recalled_content column');
            }

            const hasDeletedBy = cols.some((c: any) => c.name === 'deleted_by');
            if (!hasDeletedBy) {
                db!.exec(`ALTER TABLE messages ADD COLUMN deleted_by TEXT DEFAULT NULL`);
                this.save();
                Logger.log('[DatabaseService] Migration: added deleted_by column');
            }

            const hasReplyToId = cols.some((c: any) => c.name === 'reply_to_id');
            if (!hasReplyToId) {
                db!.exec(`ALTER TABLE messages ADD COLUMN reply_to_id TEXT DEFAULT NULL`);
                this.save();
                Logger.log('[DatabaseService] Migration: added reply_to_id column');
            }

            const hasEditHistory = cols.some((c: any) => c.name === 'edit_history');
            if (!hasEditHistory) {
                db!.exec(`ALTER TABLE messages ADD COLUMN edit_history TEXT DEFAULT NULL`);
                this.save();
                Logger.log('[DatabaseService] Migration: added edit_history column');
            }

            const hasIsEdited = cols.some((c: any) => c.name === 'is_edited');
            if (!hasIsEdited) {
                db!.exec(`ALTER TABLE messages ADD COLUMN is_edited INTEGER DEFAULT 0`);
                this.save();
                Logger.log('[DatabaseService] Migration: added is_edited column');
            }

            // Add listener_active column to accounts if missing
            const accCols = this.query<any>(`PRAGMA table_info(accounts)`);
            const hasListenerActive = accCols.some((c: any) => c.name === 'listener_active');
            if (!hasListenerActive) {
                db!.exec(`ALTER TABLE accounts ADD COLUMN listener_active INTEGER DEFAULT 1`);
                this.save();
                Logger.log('[DatabaseService] Migration: added listener_active column');
            }

            // Đếm trước để log
            const badContacts = this.query<any>(`SELECT count(*) as n FROM contacts WHERE contact_id = 'undefined' OR contact_id = '' OR contact_id IS NULL`);
            const badMessages = this.query<any>(`SELECT count(*) as n FROM messages WHERE thread_id = 'undefined' OR thread_id = '' OR thread_id IS NULL`);
            const nContacts = badContacts[0]?.n || 0;
            const nMessages = badMessages[0]?.n || 0;

            if (nContacts > 0 || nMessages > 0) {
                Logger.warn(`[DatabaseService] 🧹 Migration: found ${nContacts} bad contacts, ${nMessages} bad messages — deleting...`);
                db!.exec(`DELETE FROM contacts WHERE contact_id = 'undefined' OR contact_id = '' OR contact_id IS NULL`);
                db!.exec(`DELETE FROM messages WHERE thread_id = 'undefined' OR thread_id = '' OR thread_id IS NULL`);
                this.save();
                Logger.log(`[DatabaseService] ✅ Migration: deleted ${nContacts} bad contacts, ${nMessages} bad messages`);
            } else {
                Logger.log('[DatabaseService] ✅ Migration: no bad data found');
            }
        } catch (err: any) {
            Logger.warn(`[DatabaseService] Migration warning: ${err.message}`);
        }

        // ─── Migration: add `channel` column for multi-channel support ────────────
        try {
            const contactCols = this.query<any>(`PRAGMA table_info(contacts)`);
            const hasChannel = contactCols.some((c: any) => c.name === 'channel');
            if (!hasChannel) {
                db!.exec(`ALTER TABLE contacts ADD COLUMN channel TEXT DEFAULT 'zalo'`);
                db!.exec(`ALTER TABLE messages ADD COLUMN channel TEXT DEFAULT 'zalo'`);
                db!.exec(`ALTER TABLE accounts ADD COLUMN channel TEXT DEFAULT 'zalo'`);
                this.save();
                Logger.log('[DatabaseService] ✅ Migration: added channel column to contacts, messages, accounts');
            }
        } catch (err: any) {
            Logger.warn(`[DatabaseService] Migration channel column: ${err.message}`);
        }

        try {
            const crmTagCols = this.query<any>(`PRAGMA table_info(crm_tags)`);
            if (crmTagCols.length > 0 && !crmTagCols.some((c: any) => c.name === 'channel')) {
                db!.exec(`ALTER TABLE crm_tags ADD COLUMN channel TEXT DEFAULT 'zalo'`);
                db!.exec(`ALTER TABLE crm_contact_tags ADD COLUMN channel TEXT DEFAULT 'zalo'`);
                db!.exec(`ALTER TABLE crm_notes ADD COLUMN channel TEXT DEFAULT 'zalo'`);
                this.save();
                Logger.log('[DatabaseService] ��� Migration: added channel to CRM tables');
            }
        } catch (err: any) {
            Logger.warn(`[DatabaseService] Migration CRM channel: ${err.message}`);
        }

        // ─── Migration: add proxy_id to accounts ──────────────────────────────────
        try {
            const accCols2 = this.query<any>(`PRAGMA table_info(accounts)`);
            if (!accCols2.some((c: any) => c.name === 'proxy_id')) {
                db!.exec(`ALTER TABLE accounts ADD COLUMN proxy_id INTEGER DEFAULT NULL`);
                Logger.log('[DatabaseService] ✅ Migration: added proxy_id column to accounts');
            }
        } catch (err: any) {
            Logger.warn(`[DatabaseService] Migration proxy_id: ${err.message}`);
        }

        // Migration: create friends table if missing
        try {
            const tables = this.query<any>(`SELECT name FROM sqlite_master WHERE type='table' AND name='friends'`);
            if (tables.length === 0) {
                db!.exec(`
                    CREATE TABLE IF NOT EXISTS friends (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        owner_zalo_id TEXT NOT NULL,
                        user_id TEXT NOT NULL,
                        display_name TEXT DEFAULT '',
                        avatar TEXT DEFAULT '',
                        phone TEXT DEFAULT '',
                        updated_at INTEGER DEFAULT 0,
                        UNIQUE(owner_zalo_id, user_id)
                    )
                `);
                db!.exec(`CREATE INDEX IF NOT EXISTS idx_friends_owner ON friends(owner_zalo_id)`);
                this.save();
                Logger.log('[DatabaseService] Migration: created friends table');
            }
        } catch (err: any) {
            Logger.warn(`[DatabaseService] Friends table migration warning: ${err.message}`);
        }

        // Migration: create page_group_member table if missing
        try {
            const gmt = this.query<any>(`SELECT name FROM sqlite_master WHERE type='table' AND name='page_group_member'`);
            if (gmt.length === 0) {
                db!.exec(`
                    CREATE TABLE IF NOT EXISTS page_group_member (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        owner_zalo_id TEXT NOT NULL,
                        group_id TEXT NOT NULL,
                        member_id TEXT NOT NULL,
                        display_name TEXT DEFAULT '',
                        avatar TEXT DEFAULT '',
                        role INTEGER DEFAULT 0,
                        updated_at INTEGER DEFAULT 0,
                        UNIQUE(owner_zalo_id, group_id, member_id)
                    )
                `);
                db!.exec(`CREATE INDEX IF NOT EXISTS idx_group_member ON page_group_member(owner_zalo_id, group_id)`);
                this.save();
                Logger.log('[DatabaseService] Migration: created page_group_member table');
            }
        } catch (err: any) {
            Logger.warn(`[DatabaseService] page_group_member migration warning: ${err.message}`);
        }

        // Migration: create friend_requests table if missing
        try {
            const frt = this.query<any>(`SELECT name FROM sqlite_master WHERE type='table' AND name='friend_requests'`);
            if (frt.length === 0) {
                db!.exec(`
                    CREATE TABLE IF NOT EXISTS friend_requests (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        owner_zalo_id TEXT NOT NULL,
                        user_id TEXT NOT NULL,
                        display_name TEXT DEFAULT '',
                        avatar TEXT DEFAULT '',
                        phone TEXT DEFAULT '',
                        direction TEXT NOT NULL DEFAULT 'received',
                        msg TEXT DEFAULT '',
                        created_at INTEGER DEFAULT 0,
                        updated_at INTEGER DEFAULT 0,
                        UNIQUE(owner_zalo_id, user_id, direction)
                    )
                `);
                db!.exec(`CREATE INDEX IF NOT EXISTS idx_friend_requests_owner ON friend_requests(owner_zalo_id, direction)`);
                this.save();
                Logger.log('[DatabaseService] Migration: created friend_requests table');
            }
        } catch (err: any) {
            Logger.warn(`[DatabaseService] friend_requests migration warning: ${err.message}`);
        }
        try {
            const st = this.query<any>(`SELECT name FROM sqlite_master WHERE type='table' AND name='stickers'`);
            if (st.length === 0) {
                db!.exec(`
                    CREATE TABLE IF NOT EXISTS stickers (
                        sticker_id INTEGER PRIMARY KEY,
                        cat_id INTEGER DEFAULT 0,
                        type INTEGER DEFAULT 0,
                        text TEXT DEFAULT '',
                        sticker_url TEXT DEFAULT '',
                        sticker_sprite_url TEXT DEFAULT '',
                        checksum TEXT DEFAULT '',
                        data_json TEXT DEFAULT '{}',
                        updated_at INTEGER DEFAULT 0
                    )
                `);
                db!.exec(`
                    CREATE TABLE IF NOT EXISTS recent_stickers (
                        sticker_id INTEGER PRIMARY KEY,
                        used_at INTEGER NOT NULL
                    )
                `);
                this.save();
                Logger.log('[DatabaseService] Migration: created stickers/recent_stickers tables');
            }
        } catch (err: any) {
            Logger.warn(`[DatabaseService] stickers migration warning: ${err.message}`);
        }

        // Migration: add unsupported column to stickers + sticker_packs table
        try {
            const cols = this.query<any>(`PRAGMA table_info(stickers)`);
            if (cols.length > 0 && !cols.find((c: any) => c.name === 'unsupported')) {
                db!.exec(`ALTER TABLE stickers ADD COLUMN unsupported INTEGER DEFAULT 0`);
                this.save();
                Logger.log('[DatabaseService] Migration: added unsupported column to stickers');
            }
            const sp = this.query<any>(`SELECT name FROM sqlite_master WHERE type='table' AND name='sticker_packs'`);
            if (sp.length === 0) {
                db!.exec(`
                    CREATE TABLE IF NOT EXISTS sticker_packs (
                        cat_id INTEGER PRIMARY KEY,
                        name TEXT DEFAULT '',
                        thumb_url TEXT DEFAULT '',
                        sticker_count INTEGER DEFAULT 0,
                        data_json TEXT DEFAULT '{}',
                        updated_at INTEGER DEFAULT 0
                    )
                `);
                this.save();
                Logger.log('[DatabaseService] Migration: created sticker_packs table');
            }
        } catch (err: any) {
            Logger.warn(`[DatabaseService] sticker_packs migration warning: ${err.message}`);
        }

        // Migration: create keyword_stickers table if missing
        try {
            const ks = this.query<any>(`SELECT name FROM sqlite_master WHERE type='table' AND name='keyword_stickers'`);
            if (ks.length === 0) {
                db!.exec(`
                    CREATE TABLE IF NOT EXISTS keyword_stickers (
                        keyword TEXT PRIMARY KEY,
                        sticker_ids TEXT DEFAULT '[]',
                        updated_at INTEGER DEFAULT 0
                    )
                `);
                this.save();
                Logger.log('[DatabaseService] Migration: created keyword_stickers table');
            }
        } catch (err: any) {
            Logger.warn(`[DatabaseService] keyword_stickers migration warning: ${err.message}`);
        }

        // Migration: create pinned_messages table if missing
        try {
            const pm = this.query<any>(`SELECT name FROM sqlite_master WHERE type='table' AND name='pinned_messages'`);
            if (pm.length === 0) {
                db!.exec(`
                    CREATE TABLE IF NOT EXISTS pinned_messages (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        owner_zalo_id TEXT NOT NULL,
                        thread_id TEXT NOT NULL,
                        msg_id TEXT NOT NULL,
                        msg_type TEXT NOT NULL DEFAULT 'text',
                        content TEXT NOT NULL DEFAULT '',
                        preview_text TEXT DEFAULT '',
                        preview_image TEXT DEFAULT '',
                        sender_id TEXT DEFAULT '',
                        sender_name TEXT DEFAULT '',
                        timestamp INTEGER NOT NULL DEFAULT 0,
                        pinned_at INTEGER NOT NULL DEFAULT 0,
                        UNIQUE(owner_zalo_id, thread_id, msg_id)
                    )
                `);
                db!.exec(`CREATE INDEX IF NOT EXISTS idx_pinned ON pinned_messages(owner_zalo_id, thread_id, pinned_at)`);
                this.save();
                Logger.log('[DatabaseService] Migration: created pinned_messages table');
            }
        } catch (err: any) {
            Logger.warn(`[DatabaseService] pinned_messages migration warning: ${err.message}`);
        }

        // Migration: create local_quick_messages table if missing
        try {
            const lqm = this.query<any>(`SELECT name FROM sqlite_master WHERE type='table' AND name='local_quick_messages'`);
            if (lqm.length === 0) {
                db!.exec(`
                    CREATE TABLE IF NOT EXISTS local_quick_messages (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        owner_zalo_id TEXT NOT NULL,
                        keyword TEXT NOT NULL,
                        title TEXT NOT NULL DEFAULT '',
                        media_json TEXT DEFAULT NULL,
                        created_at INTEGER NOT NULL DEFAULT 0,
                        updated_at INTEGER NOT NULL DEFAULT 0,
                        UNIQUE(owner_zalo_id, keyword)
                    )
                `);
                db!.exec(`CREATE INDEX IF NOT EXISTS idx_lqm_owner ON local_quick_messages(owner_zalo_id)`);
                this.save();
                Logger.log('[DatabaseService] Migration: created local_quick_messages table');
            }
        } catch (err: any) {
            Logger.warn(`[DatabaseService] local_quick_messages migration warning: ${err.message}`);
        }
        // Migration: add phone column to accounts if missing
        try {
            const cols = this.query<any>(`PRAGMA table_info(accounts)`);
            if (!cols.some((c: any) => c.name === 'phone')) {
                db!.exec(`ALTER TABLE accounts ADD COLUMN phone TEXT DEFAULT ''`);
                this.save();
                Logger.log('[DatabaseService] Migration: added phone column to accounts');
            }
            if (!cols.some((c: any) => c.name === 'is_business')) {
                db!.exec(`ALTER TABLE accounts ADD COLUMN is_business INTEGER DEFAULT 0`);
                this.save();
                Logger.log('[DatabaseService] Migration: added is_business column to accounts');
            }
        } catch (err: any) {
            Logger.warn(`[DatabaseService] accounts migration warning: ${err.message}`);
        }

        // Migration: add alias column to contacts if missing
        try {
            const contactCols = this.query<any>(`PRAGMA table_info(contacts)`);
            const names = contactCols.map((c: any) => c.name);
            let needSave = false;
            if (!names.includes('is_muted')) {
                db!.exec(`ALTER TABLE contacts ADD COLUMN is_muted INTEGER DEFAULT 0`);
                Logger.log('[DatabaseService] Migration: added is_muted to contacts');
                needSave = true;
            }
            if (!names.includes('mute_until')) {
                db!.exec(`ALTER TABLE contacts ADD COLUMN mute_until INTEGER DEFAULT 0`);
                Logger.log('[DatabaseService] Migration: added mute_until to contacts');
                needSave = true;
            }
            if (!names.includes('is_in_others')) {
                db!.exec(`ALTER TABLE contacts ADD COLUMN is_in_others INTEGER DEFAULT 0`);
                Logger.log('[DatabaseService] Migration: added is_in_others to contacts');
                needSave = true;
            }
            if (!names.includes('alias')) {
                db!.exec(`ALTER TABLE contacts ADD COLUMN alias TEXT DEFAULT ''`);
                Logger.log('[DatabaseService] Migration: added alias to contacts');
                needSave = true;
            }
            if (!names.includes('gender')) {
                db!.exec(`ALTER TABLE contacts ADD COLUMN gender INTEGER DEFAULT NULL`);
                Logger.log('[DatabaseService] Migration: added gender to contacts');
                needSave = true;
            }
            if (!names.includes('birthday')) {
                db!.exec(`ALTER TABLE contacts ADD COLUMN birthday TEXT DEFAULT NULL`);
                Logger.log('[DatabaseService] Migration: added birthday to contacts');
                needSave = true;
            }
            if (needSave) this.save();
        } catch (err: any) {
            Logger.warn(`[DatabaseService] contacts flags migration warning: ${err.message}`);
        }

        // Migration: add display_name and phone to crm_send_log if missing
        try {
            const logCols = this.query<any>(`PRAGMA table_info(crm_send_log)`);
            const logColNames = logCols.map((c: any) => c.name);
            let needSave = false;
            if (!logColNames.includes('display_name')) {
                db!.exec(`ALTER TABLE crm_send_log ADD COLUMN display_name TEXT DEFAULT ''`);
                Logger.log('[DatabaseService] Migration: added display_name to crm_send_log');
                needSave = true;
            }
            if (!logColNames.includes('phone')) {
                db!.exec(`ALTER TABLE crm_send_log ADD COLUMN phone TEXT DEFAULT ''`);
                Logger.log('[DatabaseService] Migration: added phone to crm_send_log');
                needSave = true;
            }
            if (!logColNames.includes('contact_type')) {
                db!.exec(`ALTER TABLE crm_send_log ADD COLUMN contact_type TEXT DEFAULT 'user'`);
                Logger.log('[DatabaseService] Migration: added contact_type to crm_send_log');
                needSave = true;
            }
            if (!logColNames.includes('data_request')) {
                db!.exec(`ALTER TABLE crm_send_log ADD COLUMN data_request TEXT DEFAULT ''`);
                Logger.log('[DatabaseService] Migration: added data_request to crm_send_log');
                needSave = true;
            }
            if (!logColNames.includes('data_response')) {
                db!.exec(`ALTER TABLE crm_send_log ADD COLUMN data_response TEXT DEFAULT ''`);
                Logger.log('[DatabaseService] Migration: added data_response to crm_send_log');
                needSave = true;
            }
            if (!logColNames.includes('send_type')) {
                db!.exec(`ALTER TABLE crm_send_log ADD COLUMN send_type TEXT DEFAULT ''`);
                Logger.log('[DatabaseService] Migration: added send_type to crm_send_log');
                needSave = true;
            }
            if (needSave) this.save();
        } catch (err: any) {
            Logger.warn(`[DatabaseService] crm_send_log migration warning: ${err.message}`);
        }

        // Migration: add text_color to local_labels if missing
        try {
            const llCols = this.query<any>(`PRAGMA table_info(local_labels)`);
            if (llCols.length > 0 && !llCols.some((c: any) => c.name === 'text_color')) {
                db!.exec(`ALTER TABLE local_labels ADD COLUMN text_color TEXT NOT NULL DEFAULT '#FFFFFF'`);
                this.save();
                Logger.log('[DatabaseService] Migration: added text_color to local_labels');
            }
        } catch (err: any) {
            Logger.warn(`[DatabaseService] local_labels text_color migration: ${err.message}`);
        }

        // Migration: add is_active + sort_order to local_quick_messages
        try {
            const lqmCols = this.query<any>(`PRAGMA table_info(local_quick_messages)`);
            if (lqmCols.length > 0) {
                const lqmNames = lqmCols.map((c: any) => c.name);
                if (!lqmNames.includes('is_active')) {
                    db!.exec(`ALTER TABLE local_quick_messages ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1`);
                    Logger.log('[DatabaseService] Migration: added is_active to local_quick_messages');
                }
                if (!lqmNames.includes('sort_order')) {
                    db!.exec(`ALTER TABLE local_quick_messages ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0`);
                    Logger.log('[DatabaseService] Migration: added sort_order to local_quick_messages');
                }
            }
        } catch (err: any) {
            Logger.warn(`[DatabaseService] local_quick_messages is_active/sort_order migration: ${err.message}`);
        }

        // Migration: add is_active + sort_order + shortcut to local_labels
        try {
            const llCols2 = this.query<any>(`PRAGMA table_info(local_labels)`);
            if (llCols2.length > 0) {
                const llNames2 = llCols2.map((c: any) => c.name);
                if (!llNames2.includes('is_active')) {
                    db!.exec(`ALTER TABLE local_labels ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1`);
                    Logger.log('[DatabaseService] Migration: added is_active to local_labels');
                }
                if (!llNames2.includes('sort_order')) {
                    db!.exec(`ALTER TABLE local_labels ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0`);
                    Logger.log('[DatabaseService] Migration: added sort_order to local_labels');
                }
                if (!llNames2.includes('shortcut')) {
                    db!.exec(`ALTER TABLE local_labels ADD COLUMN shortcut TEXT NOT NULL DEFAULT ''`);
                    Logger.log('[DatabaseService] Migration: added shortcut to local_labels');
                }
            }
        } catch (err: any) {
            Logger.warn(`[DatabaseService] local_labels is_active/sort_order/shortcut migration: ${err.message}`);
        }

        // Migration: create message_drafts table if missing
        try {
            const md = this.query<any>(`SELECT name FROM sqlite_master WHERE type='table' AND name='message_drafts'`);
            if (md.length === 0) {
                db!.exec(`
                    CREATE TABLE IF NOT EXISTS message_drafts (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        owner_zalo_id TEXT NOT NULL,
                        thread_id TEXT NOT NULL,
                        content TEXT NOT NULL DEFAULT '',
                        updated_at INTEGER NOT NULL DEFAULT 0,
                        UNIQUE(owner_zalo_id, thread_id)
                    )
                `);
                db!.exec(`CREATE INDEX IF NOT EXISTS idx_drafts_owner ON message_drafts(owner_zalo_id)`);
                this.save();
                Logger.log('[DatabaseService] Migration: created message_drafts table');
            }
        } catch (err: any) {
            Logger.warn(`[DatabaseService] message_drafts migration: ${err.message}`);
        }

        // Migration: create bank_cards table if missing
        try {
            const bc = this.query<any>(`SELECT name FROM sqlite_master WHERE type='table' AND name='bank_cards'`);
            if (bc.length === 0) {
                db!.exec(`
                    CREATE TABLE IF NOT EXISTS bank_cards (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        owner_zalo_id TEXT NOT NULL,
                        bank_name TEXT NOT NULL DEFAULT '',
                        bin_bank INTEGER NOT NULL DEFAULT 0,
                        account_number TEXT NOT NULL DEFAULT '',
                        account_name TEXT NOT NULL DEFAULT '',
                        is_default INTEGER NOT NULL DEFAULT 0,
                        created_at INTEGER NOT NULL DEFAULT 0,
                        updated_at INTEGER NOT NULL DEFAULT 0
                    )
                `);
                db!.exec(`CREATE INDEX IF NOT EXISTS idx_bank_cards_owner ON bank_cards(owner_zalo_id)`);
                this.save();
                Logger.log('[DatabaseService] Migration: created bank_cards table');
            }
        } catch (err: any) {
            Logger.warn(`[DatabaseService] bank_cards migration: ${err.message}`);
        }

        // Migration: create local_pinned_conversations table if missing
        try {
            const lpc = this.query<any>(`SELECT name FROM sqlite_master WHERE type='table' AND name='local_pinned_conversations'`);
            if (lpc.length === 0) {
                db!.exec(`
                    CREATE TABLE IF NOT EXISTS local_pinned_conversations (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        owner_zalo_id TEXT NOT NULL,
                        thread_id TEXT NOT NULL,
                        pinned_at INTEGER NOT NULL DEFAULT 0,
                        UNIQUE(owner_zalo_id, thread_id)
                    )
                `);
                db!.exec(`CREATE INDEX IF NOT EXISTS idx_lpc_owner ON local_pinned_conversations(owner_zalo_id, pinned_at DESC)`);
                this.save();
                Logger.log('[DatabaseService] Migration: created local_pinned_conversations table');
            }
        } catch (err: any) {
            Logger.warn(`[DatabaseService] local_pinned_conversations migration: ${err.message}`);
        }

        // Migration: add topic_id and contact_type to crm_notes if missing
        try {
            const noteCols = this.query<any>(`PRAGMA table_info(crm_notes)`);
            if (noteCols.length > 0) {
                const noteColNames = noteCols.map((c: any) => c.name);
                let needSave = false;
                if (!noteColNames.includes('topic_id')) {
                    db!.exec(`ALTER TABLE crm_notes ADD COLUMN topic_id TEXT DEFAULT NULL`);
                    Logger.log('[DatabaseService] Migration: added topic_id to crm_notes');
                    needSave = true;
                }
                if (!noteColNames.includes('contact_type')) {
                    db!.exec(`ALTER TABLE crm_notes ADD COLUMN contact_type TEXT NOT NULL DEFAULT 'user'`);
                    Logger.log('[DatabaseService] Migration: added contact_type to crm_notes');
                    needSave = true;
                }
                if (needSave) this.save();
            }
        } catch (err: any) {
            Logger.warn(`[DatabaseService] crm_notes migration: ${err.message}`);
        }

        // Migration: add handled_by_employee column to messages if missing
        try {
            const msgCols = this.query<any>(`PRAGMA table_info(messages)`);
            if (msgCols.length > 0 && !msgCols.some((c: any) => c.name === 'handled_by_employee')) {
                db!.exec(`ALTER TABLE messages ADD COLUMN handled_by_employee TEXT DEFAULT NULL`);
                this.save();
                Logger.log('[DatabaseService] Migration: added handled_by_employee to messages');
            }
        } catch (err: any) {
            Logger.warn(`[DatabaseService] handled_by_employee migration: ${err.message}`);
        }

        // Migration: add daily_send_limit + daily_start_time to crm_campaigns
        try {
            const campCols = this.query<any>(`PRAGMA table_info(crm_campaigns)`);
            if (campCols.length > 0 && !campCols.some((c: any) => c.name === 'daily_send_limit')) {
                db!.exec(`ALTER TABLE crm_campaigns ADD COLUMN daily_send_limit INTEGER NOT NULL DEFAULT 0`);
                db!.exec(`ALTER TABLE crm_campaigns ADD COLUMN daily_start_time TEXT NOT NULL DEFAULT '08:00'`);
                this.save();
                Logger.log('[DatabaseService] Migration: added daily_send_limit + daily_start_time to crm_campaigns');
            }
        } catch (err: any) {
            Logger.warn(`[DatabaseService] daily_send_limit migration: ${err.message}`);
        }

    }

    // ─── Account Operations ───────────────────────────────────────────────

    public saveAccount(account: Omit<Account, 'id'>): void {
        if (!this.initialized) return;
        const normalizedPhone = this.normalizeVietnamPhone(account.phone || '');
        let encryptedCookies = account.cookies;
        try {
            if (safeStorage.isEncryptionAvailable()) {
                encryptedCookies = safeStorage.encryptString(account.cookies).toString('base64');
            }
        } catch {}

        const isBusiness = account.is_business ?? 0;
        this.run(
            `INSERT INTO accounts (zalo_id, full_name, avatar_url, phone, is_business, imei, user_agent, cookies, is_active, created_at)
             VALUES (?,?,?,?,?,?,?,?,?,?)
             ON CONFLICT(zalo_id) DO UPDATE SET
               full_name=excluded.full_name,
               avatar_url=excluded.avatar_url,
               phone=excluded.phone,
               is_business=excluded.is_business,
               imei=excluded.imei,
               user_agent=excluded.user_agent,
               cookies=excluded.cookies,
               is_active=excluded.is_active,
               last_seen=datetime('now')`,
            [account.zalo_id, account.full_name, account.avatar_url, normalizedPhone, isBusiness, account.imei, account.user_agent, encryptedCookies, account.is_active, account.created_at]
        );
    }

    public getAccounts(): Account[] {
        if (!this.initialized) return [];
        const accounts = this.query<Account>('SELECT * FROM accounts WHERE is_active = 1 ORDER BY created_at');
        return accounts.map((acc) => ({ ...acc, cookies: this.decryptCookies(acc.cookies) }));
    }

    public deleteAccount(zaloId: string): void {
        this.run('UPDATE accounts SET is_active = 0 WHERE zalo_id = ?', [zaloId]);
    }

    /**
     * Xoá HOÀN TOÀN tài khoản và tất cả dữ liệu liên quan (hard delete).
     * Gọi disconnect trước đó để đảm bảo listener/connection được cleanup.
     * Hỗ trợ cả Zalo và Facebook accounts.
     */
    public deleteAccountData(zaloId: string): void {
        if (!this.initialized) return;
        Logger.log(`[DatabaseService] Permanently deleting all data for account: ${zaloId}`);

        // Zalo tables (có owner_zalo_id column) — chạy an toàn, không ảnh hưởng nếu ko có row
        this.run('DELETE FROM messages WHERE owner_zalo_id = ?', [zaloId]);
        this.run('DELETE FROM contacts WHERE owner_zalo_id = ?', [zaloId]);
        this.run('DELETE FROM friends WHERE owner_zalo_id = ?', [zaloId]);
        this.run('DELETE FROM page_group_member WHERE owner_zalo_id = ?', [zaloId]);
        this.run('DELETE FROM links WHERE owner_zalo_id = ?', [zaloId]);
        this.run('DELETE FROM friend_requests WHERE owner_zalo_id = ?', [zaloId]);
        this.run('DELETE FROM pinned_messages WHERE owner_zalo_id = ?', [zaloId]);
        this.run('DELETE FROM local_quick_messages WHERE owner_zalo_id = ?', [zaloId]);
        this.run('DELETE FROM local_label_threads WHERE owner_zalo_id = ?', [zaloId]);
        this.run('DELETE FROM local_pinned_conversations WHERE owner_zalo_id = ?', [zaloId]);
        this.run('DELETE FROM message_drafts WHERE owner_zalo_id = ?', [zaloId]);
        this.run('DELETE FROM bank_cards WHERE owner_zalo_id = ?', [zaloId]);

        // CRM tables
        this.run('DELETE FROM crm_tags WHERE owner_zalo_id = ?', [zaloId]);
        this.run('DELETE FROM crm_contact_tags WHERE owner_zalo_id = ?', [zaloId]);
        this.run('DELETE FROM crm_notes WHERE owner_zalo_id = ?', [zaloId]);
        this.run('DELETE FROM crm_send_log WHERE owner_zalo_id = ?', [zaloId]);

        // CRM campaigns (xoá campaign_contacts trước)
        this.run(`DELETE FROM crm_campaign_contacts WHERE campaign_id IN (SELECT id FROM crm_campaigns WHERE owner_zalo_id = ?)`, [zaloId]);
        this.run('DELETE FROM crm_campaigns WHERE owner_zalo_id = ?', [zaloId]);

        // Ai assistant data — không có owner_zalo_id, bỏ qua

        // Notification settings + media auto-delete config
        this.run("DELETE FROM app_settings WHERE key LIKE ?", [`notif_${zaloId}%`]);
        this.run("DELETE FROM app_settings WHERE key = ?", [`media_auto_delete_${zaloId}`]);

        // Cuối cùng: hard-delete account
        this.run('DELETE FROM accounts WHERE zalo_id = ?', [zaloId]);

        Logger.log(`[DatabaseService] Deleted all data for account: ${zaloId}`);
    }

    /**
     * Lấy cấu hình tự động xoá media cho tài khoản
     */
    public getMediaAutoDeleteConfig(zaloId: string): { enabled: boolean; days: number } | null {
        if (!this.initialized) return null;
        const val = this.getSetting(`media_auto_delete_${zaloId}`);
        if (!val) return null;
        try {
            return JSON.parse(val) as { enabled: boolean; days: number };
        } catch {
            return null;
        }
    }

    /**
     * Lưu cấu hình tự động xoá media cho tài khoản
     */
    public setMediaAutoDeleteConfig(zaloId: string, config: { enabled: boolean; days: number }): void {
        if (!this.initialized) return;
        this.setSetting(`media_auto_delete_${zaloId}`, JSON.stringify(config));
    }

    public updateAccountLastSeen(zaloId: string): void {
        this.run('UPDATE accounts SET last_seen = datetime(\'now\') WHERE zalo_id = ?', [zaloId]);
    }

    /** Cập nhật số điện thoại cho tài khoản */
    public updateAccountPhone(zaloId: string, phone: string): void {
        if (!this.initialized) return;
        this.run('UPDATE accounts SET phone = ? WHERE zalo_id = ?', [this.normalizeVietnamPhone(phone), zaloId]);
    }

    /** Cập nhật thông tin profile: phone + is_business + avatar_url + full_name */
    public updateAccountInfo(zaloId: string, phone: string, isBusiness: number, avatarUrl?: string, fullName?: string): void {
        if (!this.initialized) return;
        const fields: string[] = ['phone = ?', 'is_business = ?'];
        const values: any[] = [this.normalizeVietnamPhone(phone), isBusiness];
        if (avatarUrl !== undefined) {
            fields.push('avatar_url = ?');
            values.push(avatarUrl);
        }
        if (fullName !== undefined) {
            fields.push('full_name = ?');
            values.push(fullName);
        }
        values.push(zaloId);
        this.run(
            `UPDATE accounts SET ${fields.join(', ')} WHERE zalo_id = ?`,
            values
        );
    }

    /** Kiểm tra tài khoản đã tồn tại trong DB chưa */
    public hasAccount(zaloId: string): boolean {
        if (!this.initialized) return false;
        return !!this.queryOne<any>('SELECT id FROM accounts WHERE zalo_id = ?', [zaloId]);
    }

    /** Đánh dấu trạng thái listener (1 = active, 0 = dead/failed) */
    public setListenerActive(zaloId: string, active: boolean): void {
        this.run('UPDATE accounts SET listener_active = ? WHERE zalo_id = ?', [active ? 1 : 0, zaloId]);
    }

    // ─── Proxy CRUD ───────────────────────────────────────────────────────────

    /** Lưu proxy mới, trả về id */
    public saveProxy(proxy: { name: string; type: string; host: string; port: number; username?: string; password?: string }): number {
        const now = Date.now();
        const result = db!.prepare(
            `INSERT INTO proxies (name, type, host, port, username, password, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(proxy.name, proxy.type, proxy.host, proxy.port, proxy.username || '', proxy.password || '', now, now);
        return result.lastInsertRowid as number;
    }

    /** Cập nhật proxy theo id */
    public updateProxy(id: number, proxy: { name?: string; type?: string; host?: string; port?: number; username?: string; password?: string }): void {
        const now = Date.now();
        const sets: string[] = [];
        const vals: any[] = [];
        if (proxy.name !== undefined) { sets.push('name = ?'); vals.push(proxy.name); }
        if (proxy.type !== undefined) { sets.push('type = ?'); vals.push(proxy.type); }
        if (proxy.host !== undefined) { sets.push('host = ?'); vals.push(proxy.host); }
        if (proxy.port !== undefined) { sets.push('port = ?'); vals.push(proxy.port); }
        if (proxy.username !== undefined) { sets.push('username = ?'); vals.push(proxy.username); }
        if (proxy.password !== undefined) { sets.push('password = ?'); vals.push(proxy.password); }
        if (sets.length === 0) return;
        sets.push('updated_at = ?'); vals.push(now);
        vals.push(id);
        db!.prepare(`UPDATE proxies SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
    }

    /** Xóa proxy và gỡ khỏi mọi tài khoản đang dùng */
    public deleteProxy(id: number): void {
        db!.prepare(`UPDATE accounts SET proxy_id = NULL WHERE proxy_id = ?`).run(id);
        db!.prepare(`DELETE FROM proxies WHERE id = ?`).run(id);
    }

    /** Lấy danh sách proxies kèm số tài khoản đang dùng */
    public getProxies(): any[] {
        return this.query<any>(
            `SELECT p.*, COUNT(a.id) as account_count
             FROM proxies p
             LEFT JOIN accounts a ON a.proxy_id = p.id AND a.is_active = 1
             GROUP BY p.id
             ORDER BY p.created_at DESC`
        );
    }

    /** Lấy proxy theo id */
    public getProxyById(id: number): any | null {
        return this.queryOne<any>('SELECT * FROM proxies WHERE id = ?', [id]) || null;
    }

    /** Gắn/gỡ proxy cho tài khoản */
    public setAccountProxy(zaloId: string, proxyId: number | null): void {
        this.run('UPDATE accounts SET proxy_id = ? WHERE zalo_id = ?', [proxyId, zaloId]);
    }

    /** Lấy proxy đang gắn với tài khoản (null nếu không có) */
    public getAccountProxy(zaloId: string): any | null {
        return this.queryOne<any>(
            `SELECT p.* FROM proxies p
             INNER JOIN accounts a ON a.proxy_id = p.id
             WHERE a.zalo_id = ?`,
            [zaloId]
        ) || null;
    }

    private decryptCookies(encrypted: string): string {
        // Fast-path: empty → nothing to decrypt (e.g., Facebook accounts in unified table)
        if (!encrypted) return encrypted;
        // Fast-path: already plain JSON (saved before encryption was added, or safeStorage was unavailable)
        const trimmed = encrypted.trimStart();
        if (trimmed.startsWith('[') || trimmed.startsWith('{')) return encrypted;

        try {
            if (safeStorage.isEncryptionAvailable()) {
                const decrypted = safeStorage.decryptString(Buffer.from(encrypted, 'base64'));
                // Sanity check: result must be parseable JSON
                JSON.parse(decrypted);
                return decrypted;
            }
        } catch (err: any) {
            Logger.warn(`[DatabaseService] decryptCookies failed — cookies may be encrypted by a different app instance (${err.message}). Account will need to re-login.`);
        }
        return encrypted;
    }

    // ─── Message Operations ───────────────────────────────────────────────

    /** Check if a message already exists in DB (by msg_id) — used to skip duplicate broadcasts */
    public hasMessage(ownerZaloId: string, msgId: string): boolean {
        if (!this.initialized || !msgId) return false;
        try {
            const rows = this.query<any>(
                'SELECT 1 FROM messages WHERE owner_zalo_id = ? AND msg_id = ? LIMIT 1',
                [ownerZaloId, msgId]
            );
            return rows.length > 0;
        } catch {
            return false;
        }
    }

    public async saveMessage(ownerZaloId: string, rawMessage: any): Promise<void> {
        if (!this.initialized) return;
        try {
            const isGroup = rawMessage.type === 1;

            // zca-js đã tính sẵn isSelf và threadId đúng:
            // - isSelf = true khi uidFrom == "0" (mình gửi, selfListen)
            // - threadId = data.idTo (nếu mình gửi) hoặc data.uidFrom (nhận từ người khác)
            const isSent: boolean = rawMessage.isSelf === true;
            const threadId: string = rawMessage.threadId || '';

            // DEBUG: log toàn bộ raw fields để phát hiện lỗi
            Logger.log(`[DB.saveMessage] 📩 raw: isSelf=${rawMessage.isSelf} | type=${rawMessage.type} | threadId="${rawMessage.threadId}" | computed isSent=${isSent} | computed threadId="${threadId}" | data.uidFrom="${rawMessage.data?.uidFrom}" | data.idTo="${rawMessage.data?.idTo}" | data.msgId="${rawMessage.data?.msgId}" | top_keys=[${Object.keys(rawMessage).join(',')}]`);

            // Guard: bỏ qua nếu threadId không hợp lệ
            if (!threadId || threadId === 'undefined') {
                Logger.warn(`[DB.saveMessage] ⚠️ SKIPPED — invalid threadId="${threadId}". rawMessage.isSelf=${rawMessage.isSelf}, rawMessage.threadId=${rawMessage.threadId}. Có thể main process chưa được rebuild với code mới!`);
                return;
            }

            const contentRaw = rawMessage.data?.content;
            // typeof null === 'object' trong JS — check null/undefined trước khi check typeof object
            const content = contentRaw == null
                ? String(rawMessage.data?.message || '')
                : typeof contentRaw === 'object'
                    ? JSON.stringify(contentRaw)
                    : String(contentRaw || rawMessage.data?.message || '');

            // Tất cả metadata nằm trong rawMessage.data (không có ở top-level)
            const msgId = rawMessage.data?.msgId || String(Date.now());
            const cliMsgId = rawMessage.data?.cliMsgId || null;
            const uidFrom = rawMessage.data?.uidFrom || ownerZaloId;
            const msgType = rawMessage.data?.msgType || 'text';
            // data.ts là string timestamp ms từ server
            const timestamp = parseInt(rawMessage.data?.ts) || Date.now();

            // Trích dẫn (quote) - lưu nếu có
            let quoteData: string | null = null;
            const rawQuote = rawMessage.data?.quote;
            if (rawQuote && rawQuote.globalMsgId) {
                const quoteImageUrl = this.extractImageUrlFromQuote(rawQuote);
                // TQuote không có msgType - chỉ có cliMsgType (number), cần convert sang string
                const quoteMsgType = DatabaseService.clientMsgTypeToMsgType(rawQuote.cliMsgType ?? 0);
                quoteData = JSON.stringify({
                    msg: rawQuote.msg ?? '',
                    fromD: rawQuote.fromD || '',
                    attach: rawQuote.attach ?? '',
                    msgType: quoteMsgType,
                    msgId: String(rawQuote.globalMsgId),
                    cliMsgId: String(rawQuote.cliMsgId ?? ''),
                    ownerId: String(rawQuote.ownerId ?? ''),
                    imageUrl: quoteImageUrl,
                });
            }

            this.run(
                `INSERT OR IGNORE INTO messages
                 (msg_id, cli_msg_id, owner_zalo_id, thread_id, thread_type, sender_id, content, msg_type, timestamp, is_sent, attachments, local_paths, status, quote_data)
                 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
                [
                    msgId,
                    cliMsgId,
                    ownerZaloId,
                    threadId,
                    isGroup ? 1 : 0,
                    String(uidFrom),
                    content,
                    msgType,
                    timestamp,
                    isSent ? 1 : 0,
                    JSON.stringify(rawMessage.data?.attachments || []),
                    '{}',
                    'received',
                    quoteData,
                ]
            );

            this.updateContactLastMessage(
                ownerZaloId, threadId,
                isGroup ? 1 : 0,
                content,
                msgType,
                timestamp,
                !isSent
            );
        } catch (err: any) {
            Logger.error(`[DatabaseService] saveMessage error: ${err.message}`);
        }
    }

    /** Mark a message as handled by a specific employee */
    public setMessageHandledByEmployee(ownerZaloId: string, msgId: string, employeeId: string): void {
        if (!this.initialized || !msgId || !employeeId) return;
        try {
            this.run(
                `UPDATE messages SET handled_by_employee = ? WHERE owner_zalo_id = ? AND msg_id = ?`,
                [employeeId, ownerZaloId, msgId]
            );
        } catch (err: any) {
            Logger.warn(`[DatabaseService] setMessageHandledByEmployee error: ${err.message}`);
        }
    }

    /** Mark a message as handled by employee — matches by msg_id OR cli_msg_id (fallback for ID mismatch) */
    public setMessageHandledByEmployeeFlexible(ownerZaloId: string, msgId: string, employeeId: string): void {
        if (!this.initialized || !msgId || !employeeId) return;
        try {
            this.run(
                `UPDATE messages SET handled_by_employee = ? WHERE owner_zalo_id = ? AND (msg_id = ? OR cli_msg_id = ?)`,
                [employeeId, ownerZaloId, msgId, msgId]
            );
        } catch (err: any) {
            Logger.warn(`[DatabaseService] setMessageHandledByEmployeeFlexible error: ${err.message}`);
        }
    }

    /** Lưu tin nhắn hệ thống (sự kiện nhóm) vào DB */
    public saveSystemMessage(ownerZaloId: string, threadId: string, msgId: string, content: string, timestamp: number, updateMembers?: Array<{id: string; dName?: string; avatar?: string; avatar_25?: string}>): void {
        if (!this.initialized) return;
        try {
            const attachments = updateMembers && updateMembers.length > 0
                ? JSON.stringify(updateMembers.map(m => ({ id: m.id, dName: m.dName || '', avatar: m.avatar || m.avatar_25 || '' })))
                : '[]';
            this.run(
                `INSERT OR IGNORE INTO messages
                 (msg_id, cli_msg_id, owner_zalo_id, thread_id, thread_type, sender_id, content, msg_type, timestamp, is_sent, attachments, local_paths, status, quote_data)
                 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
                [msgId, null, ownerZaloId, threadId, 1, 'system', content, 'system', timestamp, 0, attachments, '{}', 'received', null]
            );
        } catch (err: any) {
            Logger.error(`[DatabaseService] saveSystemMessage error: ${err.message}`);
        }
    }

    public getMessages(ownerZaloId: string, threadId: string, limit = 50, offset = 0, before?: number): Message[] {
        if (!this.initialized) return [];
        if (before && before > 0) {
            const msgs = this.query<Message>(
                'SELECT * FROM messages WHERE owner_zalo_id = ? AND thread_id = ? AND timestamp < ? ORDER BY timestamp DESC LIMIT ?',
                [ownerZaloId, threadId, before, limit]
            );
            Logger.log(`[DB:getMessages] owner=${ownerZaloId} thread=${threadId} before=${before} → ${msgs.length} msgs`);
            return msgs;
        }
        const msgs = this.query<Message>(
            'SELECT * FROM messages WHERE owner_zalo_id = ? AND thread_id = ? ORDER BY timestamp DESC LIMIT ? OFFSET ?',
            [ownerZaloId, threadId, limit, offset]
        );
        Logger.log(`[DB:getMessages] owner=${ownerZaloId} thread=${threadId} limit=${limit} offset=${offset} → ${msgs.length} msgs (first: ${msgs[0]?.msg_id || 'none'}, channel: ${msgs[0]?.channel || 'none'})`);
        // Log local_paths for video messages to debug download persistence
        for (const m of msgs) {
          if (m.msg_type === 'video' || m.channel === 'facebook') {
            Logger.log(`[DB:getMessages] DETAIL: msg_id=${m.msg_id} type=${m.msg_type} channel=${m.channel} local_paths=${m.local_paths || '(empty)'} is_sent=${m.is_sent}`);
          }
        }
        if (msgs.length === 0) {
            // Diagnostic: check if there are ANY messages for this owner or thread
            try {
                const anyForOwner = this.queryOne<any>(`SELECT COUNT(*) as cnt FROM messages WHERE owner_zalo_id = ?`, [ownerZaloId]);
                const anyForThread = this.queryOne<any>(`SELECT COUNT(*) as cnt FROM messages WHERE thread_id = ?`, [threadId]);
                const sampleOwners = this.query<any>(`SELECT DISTINCT owner_zalo_id, channel FROM messages WHERE thread_id = ? LIMIT 5`, [threadId]);
                Logger.log(`[DB:getMessages] DIAGNOSTIC: anyForOwner(${ownerZaloId})=${anyForOwner?.cnt} anyForThread(${threadId})=${anyForThread?.cnt} sampleOwners=${JSON.stringify(sampleOwners)}`);
            } catch {}
        }
        return msgs;
    }

    /** Lấy tin nhắn xung quanh 1 timestamp — dùng khi cần scroll đến tin nhắn cũ ngoài trang hiện tại */
    public getMessagesAround(ownerZaloId: string, threadId: string, timestamp: number, limit = 50): Message[] {
        if (!this.initialized) return [];
        const half = Math.floor(limit / 2);
        // Lấy half tin nhắn CŨ hơn hoặc bằng timestamp + half tin nhắn MỚI hơn timestamp
        const older = this.query<Message>(
            'SELECT * FROM messages WHERE owner_zalo_id = ? AND thread_id = ? AND timestamp <= ? ORDER BY timestamp DESC LIMIT ?',
            [ownerZaloId, threadId, timestamp, half]
        );
        const newer = this.query<Message>(
            'SELECT * FROM messages WHERE owner_zalo_id = ? AND thread_id = ? AND timestamp > ? ORDER BY timestamp ASC LIMIT ?',
            [ownerZaloId, threadId, timestamp, half]
        );
        // Merge + sort ASC theo timestamp, trả về theo thứ tự cũ → mới
        const combined = [...older, ...newer];
        // Dedup by msg_id (in case timestamp overlap)
        const seen = new Set<string>();
        const deduped = combined.filter(m => {
            if (seen.has(m.msg_id)) return false;
            seen.add(m.msg_id);
            return true;
        });
        deduped.sort((a, b) => a.timestamp - b.timestamp);
        return deduped;
    }

    /** Lấy tất cả file đính kèm trong một thread — dùng cho tab File */
    public getFileMessages(ownerZaloId: string, threadId: string, limit = 50, offset = 0): Message[] {
        if (!this.initialized) return [];
        return this.query<Message>(
            `SELECT msg_id, owner_zalo_id, thread_id, sender_id, content, msg_type, timestamp, local_paths, attachments, channel
             FROM messages
             WHERE owner_zalo_id = ? AND thread_id = ?
               AND (
                 msg_type IN ('share.file', 'file', 'share.link')
                 OR (content LIKE '%"title"%' AND content LIKE '%"href"%' AND content LIKE '%"fileExt"%')
                 OR (channel = 'facebook' AND msg_type = 'file' AND attachments IS NOT NULL AND attachments != '[]' AND attachments != '')
               )
             ORDER BY timestamp DESC
             LIMIT ? OFFSET ?`,
            [ownerZaloId, threadId, limit, offset]
        );
    }
    public getMediaMessages(ownerZaloId: string, threadId: string, limit = 50, offset = 0): Message[] {
        if (!this.initialized) return [];
        return this.query<Message>(
            `SELECT msg_id, owner_zalo_id, thread_id, sender_id, content, msg_type, timestamp, local_paths, attachments, channel
             FROM messages
             WHERE owner_zalo_id = ? AND thread_id = ?
               AND (
                 (
                   msg_type NOT IN ('share.file', 'share.link', 'file', 'chat.recommended', 'chat.recommend',
                                    'webchat', 'text', 'group.poll', 'chat.sticker',
                                    'system.msg', 'notify.unread', 'chat.voice.msg', 'chat.gif')
                   AND (
                     msg_type IN ('photo', 'image', 'chat.photo', 'chat.video.msg')
                     OR (local_paths IS NOT NULL AND local_paths != '{}' AND local_paths != '' AND local_paths != 'null'
                         AND msg_type NOT IN ('share.file','share.link','file'))
                     OR content LIKE '%"rawUrl"%'
                   )
                 )
                 OR (channel = 'facebook' AND msg_type IN ('image', 'photo', 'video', 'sticker', 'animated_image')
                     AND attachments IS NOT NULL AND attachments != '[]' AND attachments != '')
               )
             ORDER BY timestamp DESC
             LIMIT ? OFFSET ?`,
            [ownerZaloId, threadId, limit, offset]
        );
    }

    /** Lấy tất cả ảnh đã lưu trong folder media cho một tài khoản (tất cả threads) */
    public getAllLocalMediaMessages(ownerZaloId: string): Message[] {
        if (!this.initialized) return [];
        return this.query<Message>(
            `SELECT msg_id, owner_zalo_id, thread_id, sender_id, content, msg_type, timestamp, local_paths
             FROM messages
             WHERE owner_zalo_id = ?
               AND local_paths IS NOT NULL AND local_paths != '{}' AND local_paths != '' AND local_paths != 'null'
             ORDER BY timestamp DESC
             LIMIT 500`,
            [ownerZaloId]
        );
    }

    public searchMessages(ownerZaloId: string, query: string): Message[] {
        if (!this.initialized) return [];
        return this.query<Message>(
            'SELECT * FROM messages WHERE owner_zalo_id = ? AND content LIKE ? ORDER BY timestamp DESC LIMIT 100',
            [ownerZaloId, `%${query}%`]
        );
    }

    // ─── Contact Operations ───────────────────────────────────────────────

    public saveContact(contact: Omit<Contact, 'id'>): void {
        if (!this.initialized) return;
        const normalizedPhone = this.normalizeVietnamPhone(contact.phone || '');
        this.run(
            `INSERT INTO contacts (owner_zalo_id, contact_id, display_name, avatar_url, phone, is_friend, contact_type, unread_count, last_message, last_message_time)
             VALUES (?,?,?,?,?,?,?,?,?,?)
             ON CONFLICT(owner_zalo_id, contact_id) DO UPDATE SET
               display_name=excluded.display_name,
               avatar_url=excluded.avatar_url,
               phone=excluded.phone,
               is_friend=excluded.is_friend,
               contact_type=excluded.contact_type`,
            [contact.owner_zalo_id, contact.contact_id, contact.display_name, contact.avatar_url, normalizedPhone, contact.is_friend, contact.contact_type, contact.unread_count || 0, contact.last_message || '', contact.last_message_time || 0]
        );
    }

    public getContacts(ownerZaloId: string): Contact[] {
        if (!this.initialized) return [];
        return this.query<Contact>(
            'SELECT * FROM contacts WHERE owner_zalo_id = ? ORDER BY last_message_time DESC',
            [ownerZaloId]
        );
    }

    /**
     * Tìm contact trong DB theo số điện thoại (normalized).
     * So khớp cả phone đã lưu (normalized) và raw phone từ user nhập.
     */
    public searchContactByPhone(ownerZaloId: string, phone: string): Contact | null {
        if (!this.initialized || !phone) return null;
        const normalized = this.normalizeVietnamPhone(phone);
        if (!normalized) return null;
        // So khớp chính xác hoặc so khớp phần cuối (cho trường hợp số nhập thiếu đầu)
        return this.queryOne<Contact>(
            `SELECT * FROM contacts
             WHERE owner_zalo_id = ?
               AND (phone = ? OR phone LIKE ?)
             LIMIT 1`,
            [ownerZaloId, normalized, `%${normalized.slice(-7)}`]
        ) || null;
    }

    /** Update one or more flag columns (is_muted, mute_until, is_in_others) for a contact row */
    public setContactFlags(ownerZaloId: string, contactId: string, flags: { is_muted?: number; mute_until?: number; is_in_others?: number }): void {
        if (!this.initialized || !contactId) return;
        const sets: string[] = [];
        const vals: any[] = [];
        if (flags.is_muted !== undefined)    { sets.push('is_muted=?');    vals.push(flags.is_muted); }
        if (flags.mute_until !== undefined)  { sets.push('mute_until=?');  vals.push(flags.mute_until); }
        if (flags.is_in_others !== undefined){ sets.push('is_in_others=?');vals.push(flags.is_in_others); }
        if (sets.length === 0) return;
        vals.push(ownerZaloId, contactId);
        this.run(`UPDATE contacts SET ${sets.join(', ')} WHERE owner_zalo_id=? AND contact_id=?`, vals);
    }

    /** Get flag columns for a specific contact */
    public getContactFlags(ownerZaloId: string, contactId: string): { is_muted: number; mute_until: number; is_in_others: number } | null {
        if (!this.initialized) return null;
        return this.queryOne<any>(
            'SELECT is_muted, mute_until, is_in_others FROM contacts WHERE owner_zalo_id=? AND contact_id=?',
            [ownerZaloId, contactId]
        ) || null;
    }

    /** Get all contacts that have flags set (for bulk load on startup) */
    public getContactsWithFlags(ownerZaloId: string): { contact_id: string; is_muted: number; mute_until: number; is_in_others: number }[] {
        if (!this.initialized) return [];
        return this.query<any>(
            'SELECT contact_id, is_muted, mute_until, is_in_others FROM contacts WHERE owner_zalo_id=? AND (is_muted=1 OR mute_until>0 OR is_in_others=1)',
            [ownerZaloId]
        );
    }

    /**
     * Lưu biệt danh (alias) cho một contact.
     * alias='' nghĩa là xóa biệt danh.
     * Không bao giờ overwrite display_name — alias là field riêng biệt.
     */
    public setContactAlias(ownerZaloId: string, contactId: string, alias: string): void {
        if (!this.initialized || !contactId) return;
        this.run(
            `UPDATE contacts SET alias=? WHERE owner_zalo_id=? AND contact_id=?`,
            [alias || '', ownerZaloId, contactId]
        );
    }

    /**
     * Cập nhật display_name và avatar_url của contact vào DB.
     * Được gọi khi có thông tin tên/ảnh (từ senderInfo trong message event hoặc getUserInfo API).
     */
    public updateContactProfile(ownerZaloId: string, contactId: string, displayName: string, avatarUrl: string, phone: string = '', contactType: string = '', gender?: number | null, birthday?: string | null): void {
        if (!this.initialized || !contactId || contactId === 'undefined') return;
        try {
            const normalizedPhone = this.normalizeVietnamPhone(phone || '');
            this.run(
                `INSERT INTO contacts (owner_zalo_id, contact_id, display_name, avatar_url, phone, is_friend, contact_type, unread_count)
                 VALUES (?,?,?,?,?,0,?,0)
                 ON CONFLICT(owner_zalo_id, contact_id) DO UPDATE SET
                   display_name=CASE WHEN ?!='' THEN ? ELSE contacts.display_name END,
                   avatar_url=CASE WHEN ?!='' THEN ? ELSE contacts.avatar_url END,
                   phone=CASE WHEN ?!='' THEN ? ELSE contacts.phone END,
                   contact_type=CASE WHEN ?!='' THEN ? ELSE contacts.contact_type END`,
                [
                    ownerZaloId, contactId,
                    displayName || contactId, avatarUrl || '', normalizedPhone,
                    contactType || 'user',
                    // ON CONFLICT params: display_name
                    displayName, displayName,
                    // avatar_url
                    avatarUrl, avatarUrl,
                    // phone
                    normalizedPhone, normalizedPhone,
                    // contact_type
                    contactType, contactType,
                ]
            );

            // Update gender & birthday if provided (separate UPDATE to keep INSERT clean)
            if (gender !== undefined && gender !== null) {
                this.run(
                    `UPDATE contacts SET gender=? WHERE owner_zalo_id=? AND contact_id=?`,
                    [gender, ownerZaloId, contactId]
                );
            }
            if (birthday !== undefined && birthday !== null && birthday !== '') {
                this.run(
                    `UPDATE contacts SET birthday=? WHERE owner_zalo_id=? AND contact_id=?`,
                    [birthday, ownerZaloId, contactId]
                );
            }
        } catch (err: any) {
            Logger.error(`[DatabaseService] updateContactProfile error: ${err.message}`);
        }
    }

    /** Chuyển content thô (JSON) thành chuỗi hiển thị cho last_message */
    private formatLastMessageContent(content: string, msgType: string): string {
        const mt = (msgType || '').toLowerCase();

        // ── Explicit type checks (fast path, no JSON parse needed) ──────────
        if (mt.includes('call')) return '📞 Cuộc gọi';
        if (mt === 'chat.voice' || mt.includes('voice') || mt.includes('audio')) return '🎙 Tin nhắn thoại';
        if (mt === 'chat.sticker' || mt.includes('sticker')) return '🎭 Nhãn dán';
        if (mt.includes('gif')) return '🎬 GIF';
        if (mt.includes('video')) return '🎥 Video';
        if (mt === 'photo' || mt === 'image' || mt === 'chat.photo' || mt.includes('photo')) return '📸 Hình ảnh';
        if (mt === 'share.file' || mt === 'file') {
            try {
                const p = JSON.parse(content);
                return p?.title ? `📂 ${p.title}` : '📂 File đính kèm';
            } catch { return '📂 File đính kèm'; }
        }

        // ── System card (chat.ecard): nhắc hẹn, thông báo nhóm ────────────────
        if (mt === 'chat.ecard') {
            try {
                const p = JSON.parse(content);
                if (p?.title) return `🔔 ${p.title}`;
            } catch {}
            return '🔔 Thông báo';
        }

        // ── Link types (chat.recommended, chat.link, share.link) ───────────────
        if (mt === 'chat.recommended' || mt === 'chat.recommend' || mt === 'chat.link' || mt === 'share.link') {
            try {
                const p = JSON.parse(content);
                const act = String(p?.action || '');
                // Call actions inside chat.recommended
                if (act === 'recommened.misscall') return '📵 Cuộc gọi nhỡ';
                if (act === 'recommened.calltime') {
                    let prm: any = {};
                    try { prm = typeof p.params === 'string' ? JSON.parse(p.params) : (p.params || {}); } catch {}
                    const secs = prm.duration || 0;
                    if (secs > 0) { const m = Math.floor(secs / 60), s = secs % 60; return `📞 Cuộc gọi (${m > 0 ? `${m}p ` : ''}${s}s)`; }
                    return '📞 Cuộc gọi';
                }
                if (p?.title) return `🔗 ${p.title}`;
            } catch {}
            return '🔗 Link';
        }

        // ── Bank card (chat.webcontent) ─────────────────────────────────────────
        if (mt === 'chat.webcontent') {
            try {
                const p = JSON.parse(content);
                if (p?.action === 'zinstant.bankcard') return '🏦 Tài khoản ngân hàng';
                if (p?.title) return p.title;
            } catch {}
        }

        // ── Poll ───────────────────────────────────────────────────────────────
        if (mt === 'group.poll') return '📊 Bình chọn';

        // ── Todo ──────────────────────────────────────────────────────────────
        if (mt === 'chat.todo') return '📝 Công việc';

        // ── JSON content: parse and detect type from fields ──────────────────
        try {
            const p = JSON.parse(content);
            if (p && typeof p === 'object') {
                // chat.recommended call actions (action field inside content)
                const action = String(p.action || '');
                if (action === 'recommened.misscall') return '📵 Cuộc gọi nhỡ';
                if (action === 'recommened.calltime') {
                    let params: any = {};
                    try { params = typeof p.params === 'string' ? JSON.parse(p.params) : (p.params || {}); } catch {}
                    const secs = params.duration || 0;
                    if (secs > 0) {
                        const m = Math.floor(secs / 60), s = secs % 60;
                        return `📞 Cuộc gọi (${m > 0 ? `${m}p ` : ''}${s}s)`;
                    }
                    return '📞 Cuộc gọi';
                }
                // Legacy call object
                if (p.call_id || p.callId || p.callType !== undefined) {
                    const missed = p.missed || p.status === 2;
                    const secs = p.duration || p.call_duration;
                    if (missed) return '📵 Cuộc gọi nhỡ';
                    if (secs) { const m = Math.floor(secs / 60), s = secs % 60; return `📞 Cuộc gọi (${m > 0 ? `${m}p ` : ''}${s}s)`; }
                    return '📞 Cuộc gọi';
                }
                // Sticker detected from content
                if (p.sticker_id || p.stickerId) return '🎭 Nhãn dán';
                // Link action (recommened.link)
                if (action === 'recommened.link' || action === 'recommended.link') {
                    if (p.title) return `🔗 ${p.title}`;
                    return '🔗 Link';
                }
                // Bank card action
                if (action === 'zinstant.bankcard') return '🏦 Tài khoản ngân hàng';
                // parse params (may be string)
                let params: any = p.params;
                if (typeof params === 'string') { try { params = JSON.parse(params); } catch { params = null; } }
                // File: has title + file-specific fields (fileSize, fileExt, fileUrl, normalUrl)
                if (p.title && (params?.fileSize || params?.fileExt || params?.fileUrl || p.normalUrl || p.fileUrl)) return `📂 ${p.title}`;
                // Link heuristic: title + href without image params → link, not image
                if (p.title && p.href && !params?.rawUrl && !params?.hd) return `🔗 ${p.title}`;
                // Image heuristic: has rawUrl/hd, or href/thumb without title
                if (params?.rawUrl || params?.hd) return '🖼 Hình ảnh';
                if ((p.href || p.thumb) && !p.title) return '🖼 Hình ảnh';
                // Plain text stored as JSON string
                if (typeof p === 'string') return p.length > 100 ? p.substring(0, 100) + '...' : p;
                // title without file markers → show title as text (e.g. reminder, link preview)
                if (p.title && typeof p.title === 'string') return p.title;
                if (p.msg && typeof p.msg === 'string') return p.msg;
                if (p.content && typeof p.content === 'string') return p.content;
                return '[Đính kèm]';
            }
            if (typeof p === 'string') return p.length > 100 ? p.substring(0, 100) + '...' : p;
        } catch {}
        return content.length > 100 ? content.substring(0, 100) + '...' : content;
    }

    /**
     * Khi nhận event vote bình chọn (group.poll action=vote):
     * - Update content của tin nhắn group.poll gốc (cùng pollId) với content mới nhất
     * - Update last_message của contact = "[dName] đã bình chọn: [question]"
     * - KHÔNG tạo tin nhắn mới
     * Trả về true nếu tìm thấy và update được tin nhắn gốc.
     */
    public updatePollVoteMessage(
        ownerZaloId: string,
        threadId: string,
        pollId: string,
        newContent: string,
        voterName: string,
        question: string,
        timestamp: number,
        isSent: boolean,
    ): boolean {
        if (!this.initialized) return false;
        try {
            // Tìm tin nhắn group.poll gốc có pollId này
            const rows = this.query<any>(
                `SELECT msg_id FROM messages
                 WHERE owner_zalo_id=? AND thread_id=? AND msg_type='group.poll'
                 ORDER BY timestamp ASC`,
                [ownerZaloId, threadId]
            );

            let foundMsgId: string | null = null;
            for (const row of rows) {
                try {
                    const contentRow = this.queryOne<any>(
                        `SELECT content FROM messages WHERE owner_zalo_id=? AND msg_id=?`,
                        [ownerZaloId, row.msg_id]
                    );
                    const c = JSON.parse(contentRow?.content || '{}');
                    const params = typeof c.params === 'string' ? JSON.parse(c.params) : (c.params || {});
                    if (String(params.pollId || '') === String(pollId)) {
                        foundMsgId = row.msg_id;
                        break;
                    }
                } catch {}
            }

            if (!foundMsgId) return false;

            // Update content và timestamp của tin nhắn gốc
            this.run(
                `UPDATE messages SET content=?, timestamp=? WHERE owner_zalo_id=? AND msg_id=?`,
                [newContent, timestamp, ownerZaloId, foundMsgId]
            );

            // Update last_message của contact
            const displayText = voterName
                ? `${voterName} đã bình chọn: ${question}`
                : `Có người bình chọn: ${question}`;
            const existing = this.queryOne<any>(
                'SELECT unread_count FROM contacts WHERE owner_zalo_id=? AND contact_id=?',
                [ownerZaloId, threadId]
            );
            if (existing) {
                const newUnread = !isSent ? (existing.unread_count || 0) + 1 : existing.unread_count;
                this.run(
                    'UPDATE contacts SET last_message=?, last_message_time=?, unread_count=? WHERE owner_zalo_id=? AND contact_id=?',
                    [displayText, timestamp, newUnread, ownerZaloId, threadId]
                );
            }
            return true;
        } catch (err: any) {
            Logger.error(`[DatabaseService] updatePollVoteMessage error: ${err.message}`);
            return false;
        }
    }

    private updateContactLastMessage(
        ownerZaloId: string, contactId: string, threadType: number,
        content: string, msgType: string, timestamp: number, incrementUnread: boolean
    ): void {
        // Guard: không tạo contact với contactId không hợp lệ
        if (!contactId || contactId === 'undefined' || contactId === 'null' || contactId === '') {
            Logger.warn(`[DB.updateContactLastMessage] ⚠️ SKIPPED — invalid contactId="${contactId}" for owner=${ownerZaloId}`);
            return;
        }
        const display = this.formatLastMessageContent(content, msgType);
        const unreadIncrement = incrementUnread ? 1 : 0;

        // Chỉ update last_message nếu tin nhắn mới hơn (hoặc chưa có contact)
        // Tránh old messages ghi đè last_message/last_message_time của hội thoại
        this.run(
            `INSERT INTO contacts (owner_zalo_id, contact_id, display_name, avatar_url, is_friend, contact_type, unread_count, last_message, last_message_time)
             VALUES (?,?,?,?,0,?,?,?,?)
             ON CONFLICT(owner_zalo_id, contact_id) DO UPDATE SET
               last_message = CASE WHEN excluded.last_message_time >= COALESCE(contacts.last_message_time, 0) THEN excluded.last_message ELSE contacts.last_message END,
               last_message_time = CASE WHEN excluded.last_message_time >= COALESCE(contacts.last_message_time, 0) THEN excluded.last_message_time ELSE contacts.last_message_time END,
               unread_count=contacts.unread_count + ?`,
            [ownerZaloId, contactId, contactId, '', threadType === 1 ? 'group' : 'user', unreadIncrement, display, timestamp, unreadIncrement]
        );
    }

    /**
     * Cập nhật reaction của 1 user lên 1 tin nhắn (PHP-like accumulation format)
     * Reactions stored as: { total, lastReact, emoji: { emojiChar: { total, users: { userId: count } } } }
     */
    public updateMessageReaction(ownerZaloId: string, msgId: string, userId: string, icon: string): void {
        if (!this.initialized || !msgId) return;
        try {
            const row = this.queryOne<{ reactions: string }>(
                'SELECT reactions FROM messages WHERE owner_zalo_id = ? AND msg_id = ?',
                [ownerZaloId, String(msgId)]
            );
            if (!row) {
                Logger.warn(`[DatabaseService] updateMessageReaction: msg_id=${msgId} not found`);
                return;
            }

            let parsed: any = {};
            try { parsed = JSON.parse(row.reactions || '{}'); } catch {}

            // Migrate old format { userId: emojiChar } → new format
            let reactions: { total: number; lastReact: string; emoji: Record<string, { total: number; users: Record<string, number> }> };
            if (parsed && parsed.emoji && typeof parsed.emoji === 'object') {
                reactions = parsed;
            } else {
                reactions = { total: 0, lastReact: '', emoji: {} };
                for (const [uid, emo] of Object.entries(parsed as Record<string, string>)) {
                    if (!emo) continue;
                    if (!reactions.emoji[emo]) reactions.emoji[emo] = { total: 0, users: {} };
                    reactions.emoji[emo].total++;
                    reactions.emoji[emo].users[uid] = (reactions.emoji[emo].users[uid] || 0) + 1;
                    reactions.total++;
                    reactions.lastReact = emo;
                }
            }

            if (!icon) {
                // Remove all reactions by this user
                for (const emo of Object.keys(reactions.emoji)) {
                    const userCount = reactions.emoji[emo].users[userId] || 0;
                    if (userCount > 0) {
                        reactions.emoji[emo].total -= userCount;
                        reactions.total -= userCount;
                        delete reactions.emoji[emo].users[userId];
                        if (reactions.emoji[emo].total <= 0) delete reactions.emoji[emo];
                    }
                }
            } else {
                // PHP-like: accumulate
                if (!reactions.emoji[icon]) {
                    reactions.emoji[icon] = { total: 1, users: { [userId]: 1 } };
                } else {
                    reactions.emoji[icon].total++;
                    reactions.emoji[icon].users[userId] = (reactions.emoji[icon].users[userId] || 0) + 1;
                }
                reactions.total++;
                reactions.lastReact = icon;
            }

            this.run(
                'UPDATE messages SET reactions = ? WHERE owner_zalo_id = ? AND msg_id = ?',
                [JSON.stringify(reactions), ownerZaloId, String(msgId)]
            );
        } catch (err: any) {
            Logger.error(`[DatabaseService] updateMessageReaction error: ${err.message}`);
        }
    }

    /**
     * Cập nhật local_paths của một tin nhắn sau khi download ảnh
     */
    public updateLocalPaths(ownerZaloId: string, msgId: string, localPaths: Record<string, string>): void {
        if (!this.initialized || !msgId) return;
        try {
            const row = this.queryOne<{ local_paths: string }>(
                'SELECT local_paths FROM messages WHERE owner_zalo_id = ? AND msg_id = ?',
                [ownerZaloId, String(msgId)]
            );
            if (!row) return;
            let existing: Record<string, string> = {};
            try { existing = JSON.parse(row.local_paths || '{}'); } catch {}
            const merged = { ...existing, ...localPaths };
            this.run(
                'UPDATE messages SET local_paths = ? WHERE owner_zalo_id = ? AND msg_id = ?',
                [JSON.stringify(merged), ownerZaloId, String(msgId)]
            );
        } catch (err: any) {
            Logger.error(`[DatabaseService] updateLocalPaths error: ${err.message}`);
        }
    }

    /**
     * Bulk-replace media path prefix in ALL messages after moving the storage folder.
     * Handles both Windows backslash paths (JSON-escaped as \\) and forward-slash paths.
     * Returns the number of messages updated.
     */
    public rewriteLocalPaths(oldPrefix: string, newPrefix: string): number {
        if (!this.initialized || !oldPrefix || !newPrefix || oldPrefix === newPrefix) return 0;
        try {
            const variants: Array<[string, string]> = [
                [oldPrefix, newPrefix],
                [oldPrefix.replace(/\\/g, '\\\\'), newPrefix.replace(/\\/g, '\\\\')],
                [oldPrefix.replace(/\\/g, '/'),    newPrefix.replace(/\\/g, '/')],
            ];
            let updated = 0;
            // UDF: no parameter binding — all logic runs in pure JS callback
            db!.function('_rewrite_local_path', (jsonStr: string): string => {
                if (!jsonStr) return jsonStr;
                let text = jsonStr;
                let changed = false;
                for (const [from, to] of variants) {
                    if (text.includes(from)) { text = text.split(from).join(to); changed = true; }
                }
                if (changed) updated++;
                return text;
            });
            db!.exec(
                `UPDATE messages SET local_paths = _rewrite_local_path(local_paths)
                 WHERE local_paths IS NOT NULL AND local_paths != '' AND local_paths != '{}' AND local_paths != 'null'`
            );
            if (updated > 0) this.save();
            Logger.log(`[DatabaseService] rewriteLocalPaths: updated ${updated} messages`);
            return updated;
        } catch (err: any) {
            Logger.error(`[DatabaseService] rewriteLocalPaths error: ${err?.message ?? String(err)}`);
            return 0;
        }
    }

    /**
     * Convert ALL absolute local_paths → "media/zaloId/date/img.jpg" (relative to configFolder).
     * Uses sql.js create_function (UDF) — single SQL UPDATE, zero parameter binding.
     * This bypasses the sql.js Wasm "unknown type undefined" error that occurs when trying
     * to bind rowid values (sql.js does not expose rowid via getAsObject).
     */
    public migrateAllAbsolutePathsToRelative(): number {
        if (!this.initialized) return 0;
        let migrationCount = 0;
        try {
            // JS UDF: receives local_paths JSON string, returns transformed string.
            // No Wasm param binding — all transformation runs in JavaScript.
            db!.function('_migrate_local_path', (jsonStr: string): string => {
                if (!jsonStr) return jsonStr;
                try {
                    const lp: Record<string, string> = JSON.parse(jsonStr);
                    let changed = false;
                    for (const key of Object.keys(lp)) {
                        const val: string = lp[key] || '';
                        if (!val || typeof val !== 'string') continue;
                        const normalized = val.replace(/\\/g, '/');
                        // Skip already-relative paths (no drive letter, no leading '/')
                        if (!/^[A-Za-z]:\//.test(normalized) && !normalized.startsWith('/')) continue;
                        const idx = normalized.lastIndexOf('/media/');
                        if (idx >= 0) {
                            lp[key] = normalized.slice(idx + 1); // → "media/zaloId/date/img.jpg"
                            changed = true;
                            migrationCount++;
                        }
                    }
                    return changed ? JSON.stringify(lp) : jsonStr;
                } catch { return jsonStr; }
            });

            // Single UPDATE — UDF handles everything, no bound params needed
            db!.exec(
                `UPDATE messages SET local_paths = _migrate_local_path(local_paths)
                 WHERE local_paths IS NOT NULL AND local_paths != '' AND local_paths != '{}' AND local_paths != 'null'`
            );

            if (migrationCount > 0) {
                this.save();
                Logger.log(`[DatabaseService] migrateAllAbsolutePathsToRelative: ${migrationCount} paths converted`);
            }
            return migrationCount;
        } catch (err: any) {
            Logger.error(`[DatabaseService] migrateAllAbsolutePathsToRelative error: ${err?.message ?? String(err)}`);
            return 0;
        }
    }

    /**
     * Convert all absolute paths in local_paths that start with baseDir to
     * folder-agnostic relative paths (forward-slash, no leading slash).
     * This is safer than rewriteLocalPaths because it parses the JSON instead
     * of doing raw string replacement.
     *
     * Example:
     *   baseDir = "C:\Users\Admin\AppData\Roaming\ZaloAuto\media"
     *   stored  = {"main":"C:\\Users\\Admin\\...\\media\\zaloId\\date\\img.jpg"}
     *   →         {"main":"zaloId/date/img.jpg"}
     *
     * Returns the number of messages updated.
     */
    public migratePathsToRelative(baseDir: string): number {
        if (!this.initialized || !baseDir) return 0;
        // Normalise baseDir to forward-slash, with trailing slash
        const normalizedBase = baseDir.replace(/\\/g, '/').replace(/\/?$/, '') + '/';
        try {
            const rows = this.query<{ rowid: number; local_paths: string }>(
                `SELECT rowid, local_paths FROM messages
                 WHERE local_paths IS NOT NULL
                   AND local_paths != ''
                   AND local_paths != '{}'
                   AND local_paths != 'null'`
            );
            let updated = 0;
            for (const row of rows) {
                try {
                    const lp: Record<string, string> = JSON.parse(row.local_paths);
                    let changed = false;
                    for (const key of Object.keys(lp)) {
                        const val: string = lp[key] || '';
                        if (!val || typeof val !== 'string') continue;
                        // Normalise value to forward-slash for comparison
                        const normalizedVal = val.replace(/\\/g, '/');
                        if (normalizedVal.startsWith(normalizedBase)) {
                            lp[key] = normalizedVal.slice(normalizedBase.length);
                            changed = true;
                        }
                    }
                    if (changed) {
                        this.run(
                            'UPDATE messages SET local_paths = ? WHERE rowid = ?',
                            [JSON.stringify(lp), row.rowid]
                        );
                        updated++;
                    }
                } catch { /* skip malformed JSON */ }
            }
            Logger.log(`[DatabaseService] migratePathsToRelative: ${updated} messages converted to relative paths (base="${baseDir}")`);
            return updated;
        } catch (err: any) {
            Logger.error(`[DatabaseService] migratePathsToRelative error: ${err.message}`);
            return 0;
        }
    }

    /**
     * Xóa nhiều tin nhắn theo danh sách msgId
     */
    public deleteMessages(ownerZaloId: string, msgIds: string[]): void {
        if (!this.initialized || !msgIds.length) return;
        try {
            const stmt = db!.prepare('DELETE FROM messages WHERE owner_zalo_id = ? AND msg_id = ?');
            for (const msgId of msgIds) {
                stmt.run(ownerZaloId, String(msgId));
            }
            this.save();
            Logger.log(`[DatabaseService] Deleted ${msgIds.length} messages for ${ownerZaloId}`);
        } catch (err: any) {
            Logger.error(`[DatabaseService] deleteMessages error: ${err.message}`);
        }
    }

    /**
     * Đánh dấu tin nhắn bị xoá bởi trưởng/phó nhóm (không xoá khỏi DB, chỉ set deleted_by)
     */
    public markMessageDeletedByAdmin(ownerZaloId: string, msgIds: string[], deletedByUid: string): void {
        if (!this.initialized || !msgIds.length) return;
        try {
            const stmt = db!.prepare(
                `UPDATE messages SET deleted_by = ? WHERE owner_zalo_id = ? AND msg_id = ?`
            );
            for (const msgId of msgIds) {
                stmt.run(deletedByUid, ownerZaloId, String(msgId));
            }
            this.save();
            Logger.log(`[DatabaseService] Marked ${msgIds.length} messages deleted_by=${deletedByUid} for ${ownerZaloId}`);
        } catch (err: any) {
            Logger.error(`[DatabaseService] markMessageDeletedByAdmin error: ${err.message}`);
        }
    }

    public getTotalUnread(ownerZaloId: string): number {
        const row = this.queryOne<{ total: number }>(
            'SELECT SUM(unread_count) as total FROM contacts WHERE owner_zalo_id = ?',
            [ownerZaloId]
        );
        return row?.total || 0;
    }

    // ─── Friend Cache Operations ──────────────────────────────────────────

    /** Kiểm tra nhanh 1 userId có trong bảng friends không */
    public checkIsFriend(ownerZaloId: string, userId: string): boolean {
        if (!this.initialized) return false;
        // 1. Check dedicated friends table (populated by saveFriends / addFriend)
        const friendRow = this.queryOne<any>(
            'SELECT 1 FROM friends WHERE owner_zalo_id=? AND user_id=? LIMIT 1',
            [ownerZaloId, userId]
        );
        if (friendRow) return true;
        // 2. Fallback: check contacts.is_friend flag (populated by Zalo contact sync)
        //    This handles the case where friends table hasn't been synced yet
        const contactRow = this.queryOne<any>(
            'SELECT is_friend FROM contacts WHERE owner_zalo_id=? AND contact_id=? LIMIT 1',
            [ownerZaloId, userId]
        );
        return contactRow?.is_friend === 1;
    }

    /** Lưu toàn bộ danh sách bạn bè vào DB (upsert) — batch: single prepare + single save */
    public saveFriends(ownerZaloId: string, friends: Array<{ userId: string; displayName?: string; zaloName?: string; avatar?: string; phoneNumber?: string }>): void {
        if (!this.initialized) return;
        const now = Date.now();
        try {
            const stmt = db!.prepare(
                `INSERT INTO friends (owner_zalo_id, user_id, display_name, avatar, phone, updated_at)
                 VALUES (?,?,?,?,?,?)
                 ON CONFLICT(owner_zalo_id, user_id) DO UPDATE SET
                   display_name=excluded.display_name,
                   avatar=excluded.avatar,
                   phone=excluded.phone,
                   updated_at=excluded.updated_at`
            );
            for (const f of friends) {
                if (!f.userId) continue;
                stmt.run(ownerZaloId, f.userId, f.displayName || f.zaloName || f.userId, f.avatar || '', this.normalizeVietnamPhone(f.phoneNumber || ''), now);
            }
            this.save();
            Logger.log(`[DatabaseService] Saved ${friends.length} friends for ${ownerZaloId}`);
        } catch (err: any) {
            Logger.error(`[DatabaseService] saveFriends error: ${err.message}`);
        }
    }

    /**
     * Batch upsert contacts — single prepare + single disk write.
     * Dùng cho fetchAllFriendsInBackground thay vì gọi saveContact() từng dòng.
     */
    public saveContactsBatch(contacts: Array<Omit<Contact, 'id'>>): void {
        if (!this.initialized || contacts.length === 0) return;
        try {
            const stmt = db!.prepare(
                `INSERT INTO contacts (owner_zalo_id, contact_id, display_name, avatar_url, phone, is_friend, contact_type, unread_count, last_message, last_message_time)
                 VALUES (?,?,?,?,?,?,?,?,?,?)
                 ON CONFLICT(owner_zalo_id, contact_id) DO UPDATE SET
                   display_name=excluded.display_name,
                   avatar_url=excluded.avatar_url,
                   phone=CASE WHEN excluded.phone != '' THEN excluded.phone ELSE contacts.phone END,
                   is_friend=excluded.is_friend,
                   contact_type=excluded.contact_type`
            );
            for (const c of contacts) {
                const normalizedPhone = this.normalizeVietnamPhone(c.phone || '');
                stmt.run(
                    c.owner_zalo_id, c.contact_id, c.display_name, c.avatar_url,
                    normalizedPhone, c.is_friend, c.contact_type,
                    c.unread_count || 0, c.last_message || '', c.last_message_time || 0,
                );
            }
            this.save();
            Logger.log(`[DatabaseService] Batch saved ${contacts.length} contacts`);
        } catch (err: any) {
            Logger.error(`[DatabaseService] saveContactsBatch error: ${err.message}`);
        }
    }

    /**
     * Kiểm tra nhanh 1 contact có tồn tại trong DB không (single-row lookup).
     * Tránh load toàn bộ contacts chỉ để check 1 row.
     */
    public getContactById(ownerZaloId: string, contactId: string): Contact | undefined {
        if (!this.initialized) return undefined;
        return this.queryOne<Contact>(
            'SELECT * FROM contacts WHERE owner_zalo_id = ? AND contact_id = ?',
            [ownerZaloId, contactId]
        );
    }

    /** Lấy danh sách bạn bè đã cache từ DB */
    public getFriends(ownerZaloId: string): Array<{ userId: string; displayName: string; avatar: string; phoneNumber: string; updatedAt: number }> {
        if (!this.initialized) return [];
        try {
            const rows = this.query<any>(
                'SELECT user_id, display_name, avatar, phone, updated_at FROM friends WHERE owner_zalo_id = ? ORDER BY display_name',
                [ownerZaloId]
            );
            return rows.map(r => ({
                userId: r.user_id,
                displayName: r.display_name || r.user_id,
                avatar: r.avatar || '',
                phoneNumber: r.phone || '',
                updatedAt: r.updated_at || 0,
            }));
        } catch (err: any) {
            Logger.error(`[DatabaseService] getFriends error: ${err.message}`);
            return [];
        }
    }

    /** Trả về timestamp lần cuối cache bạn bè, 0 nếu chưa có */
    public getFriendsLastFetched(ownerZaloId: string): number {
        if (!this.initialized) return 0;
        try {
            const row = this.queryOne<{ max_ts: number }>(
                'SELECT MAX(updated_at) as max_ts FROM friends WHERE owner_zalo_id = ?',
                [ownerZaloId]
            );
            return row?.max_ts || 0;
        } catch {
            return 0;
        }
    }

    // ─── Friend Request Cache Operations ─────────────────────────────────

    /**
     * Lưu/cập nhật một lời mời kết bạn vào DB
     * @param direction 'received' = người khác gửi cho mình | 'sent' = mình gửi đi
     */
    public upsertFriendRequest(
        ownerZaloId: string,
        request: { userId: string; displayName?: string; avatar?: string; phone?: string; msg?: string; createdAt?: number },
        direction: 'received' | 'sent'
    ): void {
        if (!this.initialized) return;
        try {
            this.run(
                `INSERT INTO friend_requests (owner_zalo_id, user_id, display_name, avatar, phone, direction, msg, created_at, updated_at)
                 VALUES (?,?,?,?,?,?,?,?,?)
                 ON CONFLICT(owner_zalo_id, user_id, direction) DO UPDATE SET
                   display_name=excluded.display_name,
                   avatar=excluded.avatar,
                   phone=excluded.phone,
                   msg=excluded.msg,
                   updated_at=excluded.updated_at`,
                [
                    ownerZaloId,
                    request.userId,
                    request.displayName || '',
                    request.avatar || '',
                    this.normalizeVietnamPhone(request.phone || ''),
                    direction,
                    request.msg || '',
                    request.createdAt || Date.now(),
                    Date.now(),
                ]
            );
        } catch (err: any) {
            Logger.error(`[DatabaseService] upsertFriendRequest error: ${err.message}`);
        }
    }

    /** Lưu hàng loạt lời mời (replace toàn bộ cho direction đó) */
    public saveFriendRequests(
        ownerZaloId: string,
        requests: Array<{ userId: string; displayName?: string; avatar?: string; phone?: string; msg?: string; createdAt?: number }>,
        direction: 'received' | 'sent'
    ): void {
        if (!this.initialized) return;
        try {
            // Xóa toàn bộ record cũ cho direction này rồi insert mới
            this.runNoSave(
                `DELETE FROM friend_requests WHERE owner_zalo_id = ? AND direction = ?`,
                [ownerZaloId, direction]
            );
            const now = Date.now();
            const stmt = db!.prepare(
                `INSERT OR IGNORE INTO friend_requests (owner_zalo_id, user_id, display_name, avatar, phone, direction, msg, created_at, updated_at)
                 VALUES (?,?,?,?,?,?,?,?,?)`
            );
            for (const req of requests) {
                if (!req.userId) continue;
                stmt.run(ownerZaloId, req.userId, req.displayName || '', req.avatar || '', this.normalizeVietnamPhone(req.phone || ''), direction, req.msg || '', req.createdAt || now, now);
            }
            this.save();
            Logger.log(`[DatabaseService] Saved ${requests.length} ${direction} friend requests for ${ownerZaloId}`);
        } catch (err: any) {
            Logger.error(`[DatabaseService] saveFriendRequests error: ${err.message}`);
        }
    }

    /** Lấy danh sách lời mời từ DB */
    public getFriendRequests(
        ownerZaloId: string,
        direction: 'received' | 'sent'
    ): Array<{ userId: string; displayName: string; avatar: string; phone: string; msg: string; createdAt: number; updatedAt: number }> {
        if (!this.initialized) return [];
        try {
            const rows = this.query<any>(
                `SELECT user_id, display_name, avatar, phone, msg, created_at, updated_at
                 FROM friend_requests
                 WHERE owner_zalo_id = ? AND direction = ?
                 ORDER BY created_at DESC`,
                [ownerZaloId, direction]
            );
            return rows.map(r => ({
                userId: r.user_id,
                displayName: r.display_name || r.user_id,
                avatar: r.avatar || '',
                phone: r.phone || '',
                msg: r.msg || '',
                createdAt: r.created_at || 0,
                updatedAt: r.updated_at || 0,
            }));
        } catch (err: any) {
            Logger.error(`[DatabaseService] getFriendRequests error: ${err.message}`);
            return [];
        }
    }

    /** Xóa một lời mời kết bạn khỏi DB (khi chấp nhận/từ chối/hủy) */
    public removeFriendRequest(ownerZaloId: string, userId: string, direction: 'received' | 'sent'): void {
        if (!this.initialized) return;
        try {
            this.run(
                `DELETE FROM friend_requests WHERE owner_zalo_id = ? AND user_id = ? AND direction = ?`,
                [ownerZaloId, userId, direction]
            );
        } catch (err: any) {
            Logger.error(`[DatabaseService] removeFriendRequest error: ${err.message}`);
        }
    }

    /** Thêm bạn bè mới vào bảng friends khi accept lời mời */
    public addFriend(
        ownerZaloId: string,
        friend: { userId: string; displayName?: string; avatar?: string; phone?: string }
    ): void {
        if (!this.initialized || !friend.userId) return;
        try {
            this.run(
                `INSERT INTO friends (owner_zalo_id, user_id, display_name, avatar, phone, updated_at)
                 VALUES (?,?,?,?,?,?)
                 ON CONFLICT(owner_zalo_id, user_id) DO UPDATE SET
                   display_name=excluded.display_name,
                   avatar=excluded.avatar,
                   phone=excluded.phone,
                   updated_at=excluded.updated_at`,
                [ownerZaloId, friend.userId, friend.displayName || '', friend.avatar || '', this.normalizeVietnamPhone(friend.phone || ''), Date.now()]
            );
        } catch (err: any) {
            Logger.error(`[DatabaseService] addFriend error: ${err.message}`);
        }
    }

    /** Xóa bạn bè khỏi bảng friends */
    public removeFriend(ownerZaloId: string, userId: string): void {
        if (!this.initialized) return;
        try {
            this.run(
                `DELETE FROM friends WHERE owner_zalo_id = ? AND user_id = ?`,
                [ownerZaloId, userId]
            );
        } catch (err: any) {
            Logger.error(`[DatabaseService] removeFriend error: ${err.message}`);
        }
    }

    /** Lấy timestamp lần cuối cache lời mời */
    public getFriendRequestsLastFetched(ownerZaloId: string, direction: 'received' | 'sent'): number {
        if (!this.initialized) return 0;
        try {
            const row = this.queryOne<{ max_ts: number }>(
                'SELECT MAX(updated_at) as max_ts FROM friend_requests WHERE owner_zalo_id = ? AND direction = ?',
                [ownerZaloId, direction]
            );
            return row?.max_ts || 0;
        } catch {
            return 0;
        }
    }

    public markAsRead(ownerZaloId: string, contactId: string): void {
        if (!this.initialized) return;
        this.runNoSave('UPDATE contacts SET unread_count = 0 WHERE owner_zalo_id = ? AND contact_id = ?', [ownerZaloId, contactId]);
        this.runNoSave('UPDATE messages SET status = "read" WHERE owner_zalo_id = ? AND thread_id = ? AND is_sent = 0', [ownerZaloId, contactId]);
        this.save();
    }

    /** Đánh dấu tin nhắn là đã thu hồi (is_recalled = 1, giữ nguyên row, lưu nội dung gốc vào recalled_content) */
    public markMessageRecalled(ownerZaloId: string, msgId: string): void {
        if (!this.initialized || !msgId) return;
        const recalledContent = JSON.stringify({ msg: 'Tin nhắn đã bị thu hồi' });

        // Lưu nội dung gốc vào recalled_content trước khi ghi đè
        const existing = this.queryOne<any>(
            'SELECT msg_id, content FROM messages WHERE owner_zalo_id = ? AND msg_id = ?',
            [ownerZaloId, String(msgId)]
        ) || this.queryOne<any>(
            'SELECT msg_id, content FROM messages WHERE owner_zalo_id = ? AND cli_msg_id = ? AND msg_type != \'recalled\'',
            [ownerZaloId, String(msgId)]
        );
        const originalContent = existing?.content ?? null;

        const SQL = 'UPDATE messages SET is_recalled = 1, msg_type = "recalled", content = ?, recalled_content = ? WHERE owner_zalo_id = ? AND ';
        if (this.queryOne<any>('SELECT 1 FROM messages WHERE owner_zalo_id = ? AND msg_id = ?', [ownerZaloId, String(msgId)])) {
            this.run(SQL + `msg_id = ?`, [recalledContent, originalContent, ownerZaloId, String(msgId)]);
        } else {
            this.run(SQL + `cli_msg_id = ? AND msg_type != 'recalled'`, [recalledContent, originalContent, ownerZaloId, String(msgId)]);
        }
    }

    /** Nếu tin nhắn bị thu hồi là last_message của conversation, cập nhật preview */
    public updateLastMessageIfRecalled(ownerZaloId: string, threadId: string, msgId: string): void {
        if (!this.initialized || !threadId) return;
        try {
            const contact = this.queryOne<any>('SELECT last_message FROM contacts WHERE owner_zalo_id = ? AND contact_id = ?', [ownerZaloId, threadId]);
            if (!contact) return;
            const lastMsg = this.queryOne<any>(
                'SELECT content, msg_type, timestamp FROM messages WHERE owner_zalo_id = ? AND thread_id = ? AND msg_id = ?',
                [ownerZaloId, threadId, String(msgId)]
            );
            if (lastMsg) {
                this.run(
                    'UPDATE contacts SET last_message = ? WHERE owner_zalo_id = ? AND contact_id = ?',
                    ['Tin nhắn đã bị thu hồi', ownerZaloId, threadId]
                );
            }
        } catch (err: any) {
            Logger.warn(`[DatabaseService] updateLastMessageIfRecalled: ${err.message}`);
        }
    }

    public getMessageById(ownerZaloId: string, msgId: string): Message | undefined {
        if (!this.initialized || !msgId) return undefined;
        return this.queryOne<Message>(
            'SELECT * FROM messages WHERE owner_zalo_id = ? AND msg_id = ?',
            [ownerZaloId, String(msgId)]
        );
    }

    /** Xóa hội thoại khỏi DB (xóa contact + toàn bộ tin nhắn) */
    public deleteConversation(ownerZaloId: string, contactId: string): void {
        if (!this.initialized) return;
        try {
            this.runNoSave('DELETE FROM messages WHERE owner_zalo_id = ? AND thread_id = ?', [ownerZaloId, contactId]);
            this.runNoSave('DELETE FROM contacts WHERE owner_zalo_id = ? AND contact_id = ?', [ownerZaloId, contactId]);
            this.save();
            Logger.log(`[DatabaseService] Deleted conversation ${contactId} for ${ownerZaloId}`);
        } catch (err: any) {
            Logger.error(`[DatabaseService] deleteConversation error: ${err.message}`);
        }
    }

    // ─── Settings Operations ──────────────────────────────────────────────

    public getSetting(key: string): string | null {
        if (!this.initialized) return null;
        const row = this.queryOne<{ value: string }>('SELECT value FROM app_settings WHERE key = ?', [key]);
        return row?.value ?? null;
    }

    public setSetting(key: string, value: string): void {
        if (!this.initialized) return;
        this.run(
            `INSERT INTO app_settings (key, value, updated_at) VALUES (?,?,datetime('now'))
             ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
            [key, value]
        );
    }

    // ─── Image URL Helpers ────────────────────────────────────────────────

    /** Trích xuất URL ảnh từ object content Zalo */
    public static extractImageUrlFromContent(contentRaw: any): string {
        if (!contentRaw || typeof contentRaw !== 'object') return '';
        let p: any = contentRaw.params;
        if (typeof p === 'string') { try { p = JSON.parse(p); } catch { p = null; } }
        return (p?.hd || p?.rawUrl) || contentRaw.normalUrl || contentRaw.hdUrl || contentRaw.hd || contentRaw.href || contentRaw.thumb || contentRaw.url || '';
    }

    /**
     * Chuyển đổi cliMsgType (số nguyên từ TQuote) sang msgType (string dùng trong zca-js)
     * Ánh xạ ngược của getClientMessageType() trong zca-js/utils.js
     */
    public static clientMsgTypeToMsgType(cliMsgType: number): string {
        switch (cliMsgType) {
            case 1:  return 'webchat';
            case 31: return 'chat.voice';
            case 32: return 'chat.photo';
            case 36: return 'chat.sticker';
            case 37: return 'chat.doodle';
            case 38: return 'chat.recommended';
            case 43: return 'chat.location.new';
            case 44: return 'chat.video.msg';
            case 46: return 'share.file';
            case 49: return 'chat.gif';
            default: return 'webchat';
        }
    }

    /** Trích xuất URL ảnh từ quote data */
    public extractImageUrlFromQuote(rawQuote: any): string {
        if (!rawQuote) return '';
        const attach = rawQuote.attach;
        const msg = rawQuote.msg;

        /** chỉ trả về URL ảnh CDN, tránh trả về href trang web thông thường */
        const isImageUrl = (url: string): boolean => {
            if (!url) return false;
            return /\.(jpe?g|png|gif|webp|bmp)(\?|$)/i.test(url) ||
                /zdn\.vn|zadn\.vn|cloudfront\.net/i.test(url);
        };

        // 1. Thử attach
        if (attach) {
            try {
                const parsed = typeof attach === 'string' ? JSON.parse(attach) : attach;
                const item = Array.isArray(parsed) ? parsed[0] : parsed;
                if (item && typeof item === 'object') {
                    const url = DatabaseService.extractImageUrlFromContent(item) || DatabaseService.extractImageUrlFromContent(item.data);
                    if (url) return url;
                }
            } catch {}
        }
        // 2. Thử msg
        const msgObj: any = (msg && typeof msg === 'string' && msg !== '' && msg !== 'null')
            ? (() => { try { return JSON.parse(msg); } catch { return null; } })()
            : (msg && typeof msg === 'object' ? msg : null);

        if (msgObj && typeof msgObj === 'object') {
            const action = String(msgObj.action || '');
            // Parse params để lấy hd/rawUrl
            let p: any = msgObj.params;
            if (typeof p === 'string') { try { p = JSON.parse(p); } catch { p = null; } }
            if (p?.hd || p?.rawUrl) return p.hd || p.rawUrl;
            // Link preview: chỉ dùng thumb (thumbnail), KHÔNG dùng href (URL trang web)
            if (action === 'recommened.link' || action === 'recommended.link') {
                return String(msgObj.thumb || '');
            }
            // Các loại khác: chỉ trả href nếu trông như ảnh CDN
            const hrefUrl = String(msgObj.href || '');
            if (hrefUrl && isImageUrl(hrefUrl)) return hrefUrl;
            return String(msgObj.thumb || '');
        }
        return '';
    }

    public close(): void {
        if (db) {
            try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch {}
            db.close();
            db = null;
        }
    }

    public getDbPath(): string {
        return this.dbPath;
    }

    // ─── Link Operations ──────────────────────────────────────────────

    public saveLink(ownerZaloId: string, threadId: string, msgId: string, url: string, title: string, domain: string, thumbUrl: string, timestamp: number): void {
        if (!this.initialized) return;
        try {
            this.run(
                'INSERT OR IGNORE INTO links (owner_zalo_id, thread_id, msg_id, url, title, domain, thumb_url, timestamp) VALUES (?,?,?,?,?,?,?,?)',
                [ownerZaloId, threadId, msgId, url, title, domain, thumbUrl, timestamp]
            );
        } catch (err: any) {
            Logger.warn(`[DatabaseService] saveLink error: ${err.message}`);
        }
    }

    public getLinks(ownerZaloId: string, threadId: string, limit = 50, offset = 0): any[] {
        if (!this.initialized) return [];
        // Migrate links table if missing (for existing DBs)
        try {
            const tables = this.query<any>(`SELECT name FROM sqlite_master WHERE type='table' AND name='links'`);
            if (tables.length === 0) {
                db!.exec(`CREATE TABLE IF NOT EXISTS links (id INTEGER PRIMARY KEY AUTOINCREMENT, owner_zalo_id TEXT NOT NULL, thread_id TEXT NOT NULL, msg_id TEXT NOT NULL, url TEXT NOT NULL, title TEXT DEFAULT '', domain TEXT DEFAULT '', thumb_url TEXT DEFAULT '', timestamp INTEGER NOT NULL, UNIQUE(owner_zalo_id, msg_id))`);
                db!.exec(`CREATE INDEX IF NOT EXISTS idx_links_thread ON links(owner_zalo_id, thread_id, timestamp)`);
                this.save();
            }
        } catch {}

        // Backfill from messages table — only if no links exist yet for this thread
        try {
            const existing = this.queryOne<any>(
                'SELECT 1 FROM links WHERE owner_zalo_id = ? AND thread_id = ? LIMIT 1',
                [ownerZaloId, threadId]
            );
            if (!existing) {
                const msgs = this.query<any>(
                    `SELECT msg_id, content, timestamp FROM messages WHERE owner_zalo_id = ? AND thread_id = ? AND msg_type IN ('chat.recommended','chat.recommend') ORDER BY timestamp DESC LIMIT 300`,
                    [ownerZaloId, threadId]
                );
                if (msgs.length > 0) {
                    const stmt = db!.prepare(
                        'INSERT OR IGNORE INTO links (owner_zalo_id, thread_id, msg_id, url, title, domain, thumb_url, timestamp) VALUES (?,?,?,?,?,?,?,?)'
                    );
                    let backfilled = 0;
                    for (const m of msgs) {
                        try {
                            const parsed = JSON.parse(m.content || '{}');
                            if (String(parsed.action || '') === 'recommened.link') {
                                const href = String(parsed.href || parsed.title || '');
                                if (!href) continue;
                                const params = (() => { try { const p = parsed.params; return typeof p === 'string' ? JSON.parse(p) : (p || {}); } catch { return {}; } })();
                                const title = String(params.mediaTitle || parsed.title || href);
                                const domain = String(params.src || '');
                                const thumbUrl = String(parsed.thumb || '');
                                stmt.run(ownerZaloId, threadId, m.msg_id, href, title, domain, thumbUrl, m.timestamp);
                                backfilled++;
                            }
                        } catch {}
                    }
                    if (backfilled > 0) this.save();
                }
            }
        } catch {}

        // Also backfill from FB text messages containing URLs
        try {
            const fbMsgs = this.query<any>(
                `SELECT msg_id, content, timestamp FROM messages
                 WHERE owner_zalo_id = ? AND thread_id = ? AND channel = 'facebook'
                   AND msg_type = 'text' AND content IS NOT NULL
                 ORDER BY timestamp DESC LIMIT 500`,
                [ownerZaloId, threadId]
            );
            if (fbMsgs.length > 0) {
                const urlRegex = /(https?:\/\/[^\s"'<>]+)/g;
                const stmt = db!.prepare(
                    'INSERT OR IGNORE INTO links (owner_zalo_id, thread_id, msg_id, url, title, domain, thumb_url, timestamp) VALUES (?,?,?,?,?,?,?,?)'
                );
                let backfilled = 0;
                for (const m of fbMsgs) {
                    const text = m.content || '';
                    const matches = text.match(urlRegex);
                    if (!matches) continue;
                    for (const url of matches) {
                        try {
                            const domain = new URL(url).hostname;
                            stmt.run(ownerZaloId, threadId, m.msg_id + '_' + url.slice(0, 20), url, url, domain, '', m.timestamp);
                            backfilled++;
                        } catch {}
                    }
                }
                if (backfilled > 0) this.save();
            }
        } catch {}

        return this.query(
            'SELECT * FROM links WHERE owner_zalo_id = ? AND thread_id = ? ORDER BY timestamp DESC LIMIT ? OFFSET ?',
            [ownerZaloId, threadId, limit, offset]
        );
    }

    // ─── Group Member Cache ───────────────────────────────────────────────

    public saveGroupMembers(
        ownerZaloId: string,
        groupId: string,
        members: Array<{ memberId: string; displayName: string; avatar: string; role: number }>
    ): void {
        if (!this.initialized) return;
        const now = Date.now();
        const stmt = db!.prepare(`
            INSERT OR REPLACE INTO page_group_member
                (owner_zalo_id, group_id, member_id, display_name, avatar, role, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `);
        for (const m of members) {
            stmt.run(ownerZaloId, groupId, m.memberId, m.displayName || '', m.avatar || '', m.role || 0, now);
        }
        this.save();
        Logger.log(`[DB] Saved ${members.length} group members for group ${groupId}`);
    }

    /** Insert or update a SINGLE group member without touching others */
    public upsertGroupMember(
        ownerZaloId: string,
        groupId: string,
        member: { memberId: string; displayName: string; avatar: string; role: number }
    ): void {
        if (!this.initialized) return;
        db!.prepare(
            `INSERT OR REPLACE INTO page_group_member
                (owner_zalo_id, group_id, member_id, display_name, avatar, role, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`
        ).run(ownerZaloId, groupId, member.memberId, member.displayName || '', member.avatar || '', member.role || 0, Date.now());
        this.save();
        Logger.log(`[DB] Upserted member ${member.memberId} role=${member.role} in group ${groupId}`);
    }

    /** Remove a SINGLE group member from DB */
    public removeGroupMember(ownerZaloId: string, groupId: string, memberId: string): void {
        if (!this.initialized) return;
        db!.prepare(
            `DELETE FROM page_group_member WHERE owner_zalo_id = ? AND group_id = ? AND member_id = ?`
        ).run(ownerZaloId, groupId, memberId);
        this.save();
        Logger.log(`[DB] Removed member ${memberId} from group ${groupId}`);
    }

    public getGroupMembers(ownerZaloId: string, groupId: string): Array<{
        member_id: string;
        display_name: string;
        avatar: string;
        role: number;
        updated_at: number;
    }> {
        if (!this.initialized) return [];
        return this.query<any>(
            `SELECT member_id, display_name, avatar, role, updated_at
             FROM page_group_member
             WHERE owner_zalo_id = ? AND group_id = ?
             ORDER BY role DESC`,
            [ownerZaloId, groupId]
        );
    }

    /** Lấy tất cả thành viên nhóm cho tất cả các nhóm của một tài khoản (bulk load) */
    public getAllGroupMembers(ownerZaloId: string): Array<{
        group_id: string;
        member_id: string;
        display_name: string;
        avatar: string;
        role: number;
        updated_at: number;
    }> {
        if (!this.initialized) return [];
        return this.query<any>(
            `SELECT group_id, member_id, display_name, avatar, role, updated_at
             FROM page_group_member
             WHERE owner_zalo_id = ?
             ORDER BY group_id, role DESC`,
            [ownerZaloId]
        );
    }

    // ─── Sticker Cache (device-wide) ─────────────────────────────────────

    /** Lưu danh sách sticker vào cache DB */
    public saveStickers(stickers: any[]): void {
        if (!this.initialized || !stickers?.length) return;
        try {
            const stmt = db!.prepare(
                `INSERT OR REPLACE INTO stickers
                 (sticker_id, cat_id, type, text, sticker_url, sticker_sprite_url, checksum, data_json, unsupported, updated_at)
                 VALUES (?,?,?,?,?,?,?,?,?,?)`
            );
            const now = Date.now();
            for (const s of stickers) {
                try {
                    stmt.run(
                        s.id,
                        s.cateId ?? s.catId ?? 0,
                        s.type ?? 0,
                        s.text ?? '',
                        s.stickerUrl ?? '',
                        s.stickerSpriteUrl ?? '',
                        s.checksum ?? '',
                        JSON.stringify(s),
                        0,
                        now,
                    );
                } catch (err: any) {
                    Logger.warn(`[DB] saveStickers skip id=${s?.id}: ${err.message}`);
                }
            }
            this.save();
        } catch (err: any) {
            Logger.warn(`[DB] saveStickers error: ${err.message}`);
        }
    }

    /** Lấy sticker theo ID từ cache DB (bao gồm cờ unsupported) */
    public getStickerById(stickerId: number): any | undefined {
        if (!this.initialized) return undefined;
        const row = this.queryOne<any>(`SELECT data_json, unsupported FROM stickers WHERE sticker_id = ?`, [stickerId]);
        if (!row) return undefined;
        try {
            const data = JSON.parse(row.data_json);
            if (data) data._unsupported = row.unsupported === 1;
            return data;
        } catch { return undefined; }
    }

    /** Đánh dấu sticker là không hỗ trợ (tránh gọi API lại) */
    public markStickerUnsupported(stickerId: number): void {
        if (!this.initialized) return;
        // Nếu sticker chưa tồn tại, tạo bản ghi tối thiểu
        this.run(
            `INSERT OR IGNORE INTO stickers (sticker_id, unsupported, data_json, updated_at) VALUES (?,1,'{}',?)`,
            [stickerId, Date.now()]
        );
        this.run(
            `UPDATE stickers SET unsupported = 1, updated_at = ? WHERE sticker_id = ?`,
            [Date.now(), stickerId]
        );
    }

    /** Kiểm tra sticker có bị đánh dấu unsupported không */
    public isStickerUnsupported(stickerId: number): boolean {
        if (!this.initialized) return false;
        const row = this.queryOne<any>(`SELECT unsupported FROM stickers WHERE sticker_id = ?`, [stickerId]);
        return row?.unsupported === 1;
    }

    // ─── Sticker Packs ───────────────────────────────────────────────────

    /** Lưu sticker packs vào DB */
    public saveStickerPacks(packs: any[]): void {
        if (!this.initialized || !packs?.length) return;
        try {
            const stmt = db!.prepare(
                `INSERT OR REPLACE INTO sticker_packs
                 (cat_id, name, thumb_url, sticker_count, data_json, updated_at)
                 VALUES (?,?,?,?,?,?)`
            );
            const now = Date.now();
            for (const p of packs) {
                try {
                    stmt.run(
                        p.catId ?? p.cat_id ?? 0,
                        p.name ?? '',
                        p.thumbUrl ?? p.thumb_url ?? '',
                        p.stickerCount ?? p.sticker_count ?? 0,
                        JSON.stringify(p),
                        now,
                    );
                } catch (err: any) {
                    Logger.warn(`[DB] saveStickerPacks skip catId=${p?.catId}: ${err.message}`);
                }
            }
            this.save();
        } catch (err: any) {
            Logger.warn(`[DB] saveStickerPacks error: ${err.message}`);
        }
    }

    /** Lấy tất cả sticker packs đã cache */
    public getStickerPacks(): any[] {
        if (!this.initialized) return [];
        const rows = this.query<any>(
            `SELECT data_json, updated_at FROM sticker_packs ORDER BY updated_at DESC`
        );
        return rows.map((r) => {
            try {
                const data = JSON.parse(r.data_json);
                data._updatedAt = r.updated_at;
                return data;
            } catch { return null; }
        }).filter(Boolean);
    }

    /** Lấy tất cả sticker thuộc một pack (catId) */
    public getStickersByPackId(catId: number): any[] {
        if (!this.initialized) return [];
        const rows = this.query<any>(
            `SELECT data_json, unsupported FROM stickers WHERE cat_id = ? AND unsupported = 0 ORDER BY sticker_id`,
            [catId]
        );
        return rows.map((r) => {
            try { return JSON.parse(r.data_json); } catch { return null; }
        }).filter(Boolean);
    }

    /** Lấy danh sách sticker gần dùng (kèm đầy đủ thông tin) */
    public getRecentStickers(limit: number = 30): any[] {
        if (!this.initialized) return [];
        const rows = this.query<any>(
            `SELECT s.data_json
             FROM stickers s
             INNER JOIN recent_stickers rs ON rs.sticker_id = s.sticker_id
             ORDER BY rs.used_at DESC
             LIMIT ?`,
            [limit]
        );
        return rows.map((r) => { try { return JSON.parse(r.data_json); } catch { return null; } }).filter(Boolean);
    }

    /** Thêm/cập nhật sticker vào danh sách gần dùng */
    public addRecentSticker(stickerId: number): void {
        if (!this.initialized) return;
        this.runNoSave(
            `INSERT OR REPLACE INTO recent_stickers (sticker_id, used_at) VALUES (?,?)`,
            [stickerId, Date.now()]
        );
        // Giữ tối đa 50 sticker gần dùng
        this.runNoSave(
            `DELETE FROM recent_stickers WHERE sticker_id NOT IN (
               SELECT sticker_id FROM recent_stickers ORDER BY used_at DESC LIMIT 50
             )`
        );
        this.save();
    }

    // ─── Keyword → Sticker IDs Cache ──────────────────────────────────────

    /** Lưu keyword → stickerIds mapping */
    public saveKeywordStickers(keyword: string, stickerIds: number[]): void {
        if (!this.initialized || !keyword) return;
        try {
            this.run(
                `INSERT OR REPLACE INTO keyword_stickers (keyword, sticker_ids, updated_at) VALUES (?,?,?)`,
                [keyword.toLowerCase().trim(), JSON.stringify(stickerIds), Date.now()]
            );
        } catch (err: any) {
            Logger.warn(`[DB] saveKeywordStickers error: ${err.message}`);
        }
    }

    /** Lấy stickerIds theo keyword (null nếu chưa cache) */
    public getKeywordStickers(keyword: string): number[] | null {
        if (!this.initialized || !keyword) return null;
        const row = this.queryOne<any>(
            `SELECT sticker_ids, updated_at FROM keyword_stickers WHERE keyword = ?`,
            [keyword.toLowerCase().trim()]
        );
        if (!row) return null;
        try {
            return JSON.parse(row.sticker_ids);
        } catch { return null; }
    }

    /** Lấy sticker details theo danh sách IDs từ bảng stickers */
    public getStickersByIds(stickerIds: number[]): any[] {
        if (!this.initialized || !stickerIds?.length) return [];
        // SQLite placeholders
        const placeholders = stickerIds.map(() => '?').join(',');
        const rows = this.query<any>(
            `SELECT data_json FROM stickers WHERE sticker_id IN (${placeholders}) AND unsupported = 0`,
            stickerIds
        );
        return rows.map((r) => {
            try { return JSON.parse(r.data_json); } catch { return null; }
        }).filter(Boolean);
    }

    /** Lấy tất cả cat_id có sticker trong cache (để build store từ DB) */
    public getAllCachedPackSummaries(): { catId: number; count: number; thumbUrl: string }[] {
        if (!this.initialized) return [];
        const rows = this.query<any>(
            `SELECT cat_id, COUNT(*) as cnt,
                    (SELECT sticker_url FROM stickers s2 WHERE s2.cat_id = s.cat_id AND s2.sticker_url != '' LIMIT 1) as thumb
             FROM stickers s
             WHERE cat_id > 0 AND unsupported = 0
             GROUP BY cat_id
             HAVING cnt >= 1
             ORDER BY MAX(updated_at) DESC`
        );
        return rows.map((r: any) => ({
            catId: r.cat_id,
            count: r.cnt,
            thumbUrl: r.thumb || '',
        }));
    }

    // ─── Pinned Messages ──────────────────────────────────────────────────────

    /** Lấy danh sách tin ghim (mới nhất trước) */
    public getPinnedMessages(ownerZaloId: string, threadId: string): any[] {
        if (!this.initialized) return [];
        return this.query<any>(
            `SELECT * FROM pinned_messages WHERE owner_zalo_id=? AND thread_id=? ORDER BY pinned_at DESC`,
            [ownerZaloId, threadId]
        );
    }

    /** Ghim một tin nhắn */
    public pinMessage(ownerZaloId: string, threadId: string, pin: {
        msgId: string; msgType: string; content: string;
        previewText: string; previewImage: string;
        senderId: string; senderName: string; timestamp: number;
    }): void {
        if (!this.initialized) return;
        this.run(
            `INSERT OR REPLACE INTO pinned_messages
             (owner_zalo_id, thread_id, msg_id, msg_type, content, preview_text, preview_image, sender_id, sender_name, timestamp, pinned_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
            [ownerZaloId, threadId, pin.msgId, pin.msgType, pin.content,
             pin.previewText, pin.previewImage, pin.senderId, pin.senderName,
             pin.timestamp, Date.now()]
        );
    }

    /** Bỏ ghim một tin nhắn */
    public unpinMessage(ownerZaloId: string, threadId: string, msgId: string): void {
        if (!this.initialized) return;
        this.run(
            `DELETE FROM pinned_messages WHERE owner_zalo_id=? AND thread_id=? AND msg_id=?`,
            [ownerZaloId, threadId, msgId]
        );
    }

    /** Đưa tin ghim lên đầu (cập nhật pinned_at về now) */
    public bringPinnedToTop(ownerZaloId: string, threadId: string, msgId: string): void {
        if (!this.initialized) return;
        this.run(
            `UPDATE pinned_messages SET pinned_at=? WHERE owner_zalo_id=? AND thread_id=? AND msg_id=?`,
            [Date.now(), ownerZaloId, threadId, msgId]
        );
    }

    /** Lấy tin nhắn theo msg_type trong một thread (mới nhất trước) */
    public getMessagesByType(ownerZaloId: string, threadId: string, msgType: string, limit: number = 100): any[] {
        if (!this.initialized) return [];
        return this.query<any>(
            `SELECT * FROM messages WHERE owner_zalo_id=? AND thread_id=? AND msg_type=? AND is_recalled=0
             ORDER BY timestamp DESC LIMIT ?`,
            [ownerZaloId, threadId, msgType, limit]
        );
    }

    // ─── Local Quick Messages ──────────────────────────────────────────────

    /** Lấy toàn bộ tin nhắn nhanh local theo zaloId */
    public getLocalQuickMessages(ownerZaloId: string): any[] {
        if (!this.initialized) return [];
        const rows = this.query<any>(
            `SELECT * FROM local_quick_messages WHERE owner_zalo_id=? ORDER BY keyword ASC`,
            [ownerZaloId]
        );
        return rows.map(r => ({
            id: r.id,
            keyword: r.keyword,
            title: r.title,
            media: r.media_json ? JSON.parse(r.media_json) : null,
            createdAt: r.created_at,
            updatedAt: r.updated_at,
        }));
    }

    /** Upsert một tin nhắn nhanh local */
    public upsertLocalQuickMessage(ownerZaloId: string, item: { keyword: string; title: string; media?: any }): number {
        if (!this.initialized) return 0;
        const now = Date.now();
        const existing = this.queryOne<any>(
            `SELECT id FROM local_quick_messages WHERE owner_zalo_id=? AND keyword=?`,
            [ownerZaloId, item.keyword]
        );
        if (existing) {
            this.run(
                `UPDATE local_quick_messages SET title=?, media_json=?, updated_at=? WHERE owner_zalo_id=? AND keyword=?`,
                [item.title, item.media ? JSON.stringify(item.media) : null, now, ownerZaloId, item.keyword]
            );
            return existing.id;
        } else {
            this.run(
                `INSERT INTO local_quick_messages (owner_zalo_id, keyword, title, media_json, created_at, updated_at) VALUES (?,?,?,?,?,?)`,
                [ownerZaloId, item.keyword, item.title, item.media ? JSON.stringify(item.media) : null, now, now]
            );
            const row = this.queryOne<any>(
                `SELECT id FROM local_quick_messages WHERE owner_zalo_id=? AND keyword=?`,
                [ownerZaloId, item.keyword]
            );
            return row?.id || 0;
        }
    }

    /** Xóa tin nhắn nhanh local theo id */
    public deleteLocalQuickMessage(ownerZaloId: string, id: number): void {
        if (!this.initialized) return;
        this.run(`DELETE FROM local_quick_messages WHERE owner_zalo_id=? AND id=?`, [ownerZaloId, id]);
    }

    /** Xóa tất cả và upsert lại toàn bộ (dùng khi sync từ Zalo) */
    public bulkReplaceLocalQuickMessages(ownerZaloId: string, items: Array<{ keyword: string; title: string; media?: any }>): void {
        if (!this.initialized) return;
        this.runNoSave(`DELETE FROM local_quick_messages WHERE owner_zalo_id=?`, [ownerZaloId]);
        const now = Date.now();
        const stmt = db!.prepare(
            `INSERT OR REPLACE INTO local_quick_messages (owner_zalo_id, keyword, title, media_json, created_at, updated_at) VALUES (?,?,?,?,?,?)`
        );
        for (const item of items) {
            stmt.run(ownerZaloId, item.keyword, item.title, item.media ? JSON.stringify(item.media) : null, now, now);
        }
        this.save();
    }

    /** Clone toàn bộ local quick messages từ một account sang account khác */
    public cloneLocalQuickMessages(sourceZaloId: string, targetZaloId: string): number {
        if (!this.initialized) return 0;
        try {
            const rows = this.query<any>(
                `SELECT keyword, title, media_json FROM local_quick_messages WHERE owner_zalo_id=? ORDER BY keyword ASC`,
                [sourceZaloId]
            );
            if (rows.length === 0) return 0;
            const now = Date.now();
            const stmt = db!.prepare(
                `INSERT OR REPLACE INTO local_quick_messages (owner_zalo_id, keyword, title, media_json, created_at, updated_at)
                 VALUES (?,?,?,?,?,?)`
            );
            let count = 0;
            for (const row of rows) {
                try {
                    stmt.run(targetZaloId, row.keyword, row.title, row.media_json, now, now);
                    count++;
                } catch {}
            }
            this.save();
            return count;
        } catch (err: any) {
            Logger.error(`[DB] cloneLocalQuickMessages: ${err.message}`);
            return 0;
        }
    }

    /** Clone labels assigned to sourceZaloId to targetZaloId.
     *  Since labels are stored with comma-separated 'page_ids', this means appending targetZaloId to relevant labels.
     */
    public cloneLocalLabels(sourceZaloId: string, targetZaloId: string): number {
        if (!this.initialized) return 0;

        let count = 0;

        try {
            const labels = this.query<any>(
                `SELECT * FROM local_labels WHERE page_ids LIKE ?`,
                [`%${sourceZaloId}%`]
            );

            for (const label of labels) {
                const pids = (label.page_ids || '').split(',').filter(Boolean);

                // 👉 Nếu đã có target → bỏ qua
                if (pids.includes(targetZaloId)) continue;

                // 👉 Check target đã có label cùng name chưa
                const existed = this.queryOne<any>(
                    `SELECT * FROM local_labels
                 WHERE name = ?
                 AND page_ids LIKE ?
                 LIMIT 1`,
                    [label.name, `%${targetZaloId}%`]
                );

                if (existed) continue;

                // 👉 thêm target vào label hiện tại
                pids.push(targetZaloId);
                const newIds = pids.join(',');

                this.runNoSave(
                    `UPDATE local_labels SET page_ids=?, updated_at=? WHERE id=?`,
                    [newIds, Date.now(), label.id]
                );

                count++;
            }

            if (count > 0) this.save();

            return count;
        } catch (err: any) {
            Logger.error(`[DB] cloneLocalLabels: ${err.message}`);
            return 0;
        }
    }


    /** Lấy toàn bộ quick messages của TẤT CẢ accounts — dùng cho Settings global list */
    public getAllLocalQuickMessages(): any[] {
        if (!this.initialized) return [];
        try {
            const rows = this.query<any>(`SELECT * FROM local_quick_messages ORDER BY owner_zalo_id ASC, sort_order ASC, keyword ASC`);
            return rows.map((r: any) => {
                const mediaObj = r.media_json ? JSON.parse(r.media_json) : null;
                const localFiles: any[] | undefined = mediaObj?.localFiles?.length ? mediaObj.localFiles : undefined;
                return {
                    id: r.id,
                    owner_zalo_id: r.owner_zalo_id,
                    keyword: r.keyword,
                    message: { title: r.title },
                    media: localFiles ? null : mediaObj,
                    _local: true,
                    _localMedia: localFiles,
                    is_active: r.is_active ?? 1,
                    sort_order: r.sort_order ?? 0,
                    createdAt: r.created_at,
                    updatedAt: r.updated_at,
                };
            });
        } catch (err: any) {
            Logger.error(`[DB] getAllLocalQuickMessages: ${err.message}`);
            return [];
        }
    }

    /** Bật/tắt trạng thái hoạt động của một quick message */
    public setLocalQMActive(id: number, isActive: number): void {
        if (!this.initialized) return;
        this.run(`UPDATE local_quick_messages SET is_active=?, updated_at=? WHERE id=?`, [isActive, Date.now(), id]);
    }

    /** Cập nhật sort_order của một quick message */
    public setLocalQMOrder(id: number, sortOrder: number): void {
        if (!this.initialized) return;
        this.run(`UPDATE local_quick_messages SET sort_order=?, updated_at=? WHERE id=?`, [sortOrder, Date.now(), id]);
    }

    // ─── Local Labels ──────────────────────────────────────────────────────────

    /** Lấy tất cả local labels.
     *  Nếu zaloId được cung cấp → chỉ trả về labels áp dụng cho account đó (page_ids rỗng = global). */
    public getLocalLabels(zaloId?: string): any[] {
        if (!this.initialized) return [];
        try {
            if (!zaloId) {
                return this.query<any>(`SELECT * FROM local_labels ORDER BY sort_order ASC, name ASC`);
            }
            return this.query<any>(
                `SELECT * FROM local_labels WHERE page_ids = '' OR page_ids LIKE ? ORDER BY sort_order ASC, name ASC`,
                [`%${zaloId}%`]
            );
        } catch (err: any) {
            Logger.error(`[DB] getLocalLabels: ${err.message}`);
            return [];
        }
    }

    /** Tạo hoặc cập nhật một local label. Trả về id */
    public upsertLocalLabel(label: {
        id?: number;
        name: string;
        color: string;
        textColor?: string;
        emoji: string;
        pageIds: string;
        isActive?: number;
        sortOrder?: number;
        shortcut?: string;
    }): number {
        if (!this.initialized) return -1;

        try {
            const now = Date.now();
            const tc = label.textColor || '#FFFFFF';
            const shortcut = label.shortcut || '';

            // 👉 Check trùng name trong từng page_id
            const pageIds = (label.pageIds || '').split(',').filter(Boolean);

            for (const pid of pageIds) {
                const existed = this.queryOne<any>(
                    `SELECT * FROM local_labels
                 WHERE name = ?
                 AND page_ids LIKE ?
                 AND (${label.id ? 'id != ?' : '1=1'})
                 LIMIT 1`,
                    label.id ? [label.name, `%${pid}%`, label.id] : [label.name, `%${pid}%`]
                );

                if (existed) {
                    // đã tồn tại label cùng tên trong page → bỏ qua
                    return existed.id;
                }
            }

            if (label.id) {
                this.run(
                    `UPDATE local_labels
                     SET name=?, color=?, text_color=?, emoji=?, page_ids=?,
                         is_active=COALESCE(?,is_active),
                         sort_order=COALESCE(?,sort_order),
                         shortcut=?,
                         updated_at=?
                     WHERE id=?`,
                    [
                        label.name,
                        label.color,
                        tc,
                        label.emoji,
                        label.pageIds,
                        label.isActive ?? null,
                        label.sortOrder ?? null,
                        shortcut,
                        now,
                        label.id
                    ]
                );
                return label.id;
            } else {
                this.run(
                    `INSERT INTO local_labels
                     (name, color, text_color, emoji, page_ids, is_active, sort_order, shortcut, created_at, updated_at)
                     VALUES (?,?,?,?,?,?,?,?,?,?)`,
                    [
                        label.name,
                        label.color,
                        tc,
                        label.emoji,
                        label.pageIds,
                        label.isActive ?? 1,
                        label.sortOrder ?? 0,
                        shortcut,
                        now,
                        now
                    ]
                );

                return this.queryOne<any>(`SELECT last_insert_rowid() as id`)?.id ?? -1;
            }
        } catch (err: any) {
            Logger.error(`[DB] upsertLocalLabel: ${err.message}`);
            return -1;
        }
    }

    /** Bật/tắt trạng thái hoạt động của một label */
    public setLocalLabelActive(id: number, isActive: number): void {
        if (!this.initialized) return;
        this.run(`UPDATE local_labels SET is_active=?, updated_at=? WHERE id=?`, [isActive, Date.now(), id]);
    }

    /** Cập nhật sort_order của một label */
    public setLocalLabelOrder(id: number, sortOrder: number): void {
        if (!this.initialized) return;
        this.run(`UPDATE local_labels SET sort_order=?, updated_at=? WHERE id=?`, [sortOrder, Date.now(), id]);
    }

    /** Xóa một local label (cascade xóa assignments) */
    public deleteLocalLabel(id: number): void {
        if (!this.initialized) return;
        try {
            this.runNoSave(`DELETE FROM local_label_threads WHERE label_id=?`, [id]);
            this.runNoSave(`DELETE FROM local_labels WHERE id=?`, [id]);
            this.save();
        } catch (err: any) {
            Logger.error(`[DB] deleteLocalLabel: ${err.message}`);
        }
    }

    /** Lấy tất cả thread assignments của một account */
    public getLocalLabelThreads(ownerZaloId: string): { label_id: number; thread_id: string }[] {
        if (!this.initialized) return [];
        try {
            return this.query<any>(
                `SELECT label_id, thread_id FROM local_label_threads WHERE owner_zalo_id=?`,
                [ownerZaloId]
            );
        } catch (err: any) {
            Logger.error(`[DB] getLocalLabelThreads: ${err.message}`);
            return [];
        }
    }

    /** Gán label cho một thread */
    public assignLocalLabelToThread(ownerZaloId: string, labelId: number, threadId: string): void {
        if (!this.initialized) return;
        try {
            this.run(
                `INSERT OR IGNORE INTO local_label_threads (owner_zalo_id, label_id, thread_id, created_at) VALUES (?,?,?,?)`,
                [ownerZaloId, labelId, threadId, Date.now()]
            );
        } catch (err: any) {
            Logger.error(`[DB] assignLocalLabelToThread: ${err.message}`);
        }
    }

    /** Gỡ label khỏi một thread */
    public removeLocalLabelFromThread(ownerZaloId: string, labelId: number, threadId: string): void {
        if (!this.initialized) return;
        try {
            this.run(
                `DELETE FROM local_label_threads WHERE owner_zalo_id=? AND label_id=? AND thread_id=?`,
                [ownerZaloId, labelId, threadId]
            );
        } catch (err: any) {
            Logger.error(`[DB] removeLocalLabelFromThread: ${err.message}`);
        }
    }

    /** Lấy tất cả local labels đang được gán cho một thread */
    public getThreadLocalLabels(ownerZaloId: string, threadId: string): any[] {
        if (!this.initialized) return [];
        try {
            return this.query<any>(
                `SELECT ll.* FROM local_labels ll
                 INNER JOIN local_label_threads llt ON ll.id = llt.label_id
                 WHERE llt.owner_zalo_id=? AND llt.thread_id=?
                 ORDER BY ll.name ASC`,
                [ownerZaloId, threadId]
            );
        } catch (err: any) {
            Logger.error(`[DB] getThreadLocalLabels: ${err.message}`);
            return [];
        }
    }

    // ─── CRM Methods ─────────────────────────────────────────────────────────

    /** Notes */
    public getCRMNotes(ownerZaloId: string, contactId: string): CRMNote[] {
        if (!this.initialized) return [];
        try {
            return this.query<any>(`SELECT * FROM crm_notes WHERE owner_zalo_id=? AND contact_id=? ORDER BY updated_at DESC`, [ownerZaloId, contactId]);
        } catch (err: any) { Logger.error(`[DB] getCRMNotes: ${err.message}`); return []; }
    }

    public saveCRMNote(note: CRMNote): number {
        if (!this.initialized) return 0;
        try {
            const now = Date.now();
            const contactType = note.contact_type ?? 'user';
            const topicId = note.topic_id ?? null;
            if (note.id) {
                this.run(
                    `UPDATE crm_notes SET content=?, topic_id=?, updated_at=? WHERE id=? AND owner_zalo_id=?`,
                    [note.content, topicId, now, note.id, note.owner_zalo_id],
                );
                return note.id;
            } else {
                return this.runInsert(
                    `INSERT INTO crm_notes (owner_zalo_id, contact_id, contact_type, content, topic_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?)`,
                    [note.owner_zalo_id, note.contact_id, contactType, note.content, topicId, now, now],
                );
            }
        } catch (err: any) { Logger.error(`[DB] saveCRMNote: ${err.message}`); return 0; }
    }

    /** Cập nhật topicId cho một ghi chú nhóm sau khi API trả về */
    public setNoteTopicId(noteId: number, ownerZaloId: string, topicId: string): void {
        if (!this.initialized) return;
        try {
            this.run(`UPDATE crm_notes SET topic_id=? WHERE id=? AND owner_zalo_id=?`, [topicId, noteId, ownerZaloId]);
        } catch (err: any) { Logger.error(`[DB] setNoteTopicId: ${err.message}`); }
    }

    public deleteCRMNote(noteId: number, ownerZaloId: string): void {
        if (!this.initialized) return;
        try { this.run(`DELETE FROM crm_notes WHERE id=? AND owner_zalo_id=?`, [noteId, ownerZaloId]); }
        catch (err: any) { Logger.error(`[DB] deleteCRMNote: ${err.message}`); }
    }

    /** Campaigns */
    public getCRMCampaigns(ownerZaloId: string): CRMCampaign[] {
        if (!this.initialized) return [];
        try {
            // sent_at là milliseconds → so sánh với đầu ngày hôm nay (ms)
            const todayStart = new Date();
            todayStart.setHours(0, 0, 0, 0);
            const todayStartMs = todayStart.getTime();
            return this.query<any>(
                `SELECT c.*,
                    (SELECT COUNT(*) FROM crm_campaign_contacts cc WHERE cc.campaign_id=c.id) as total_contacts,
                    (SELECT COUNT(*) FROM crm_campaign_contacts cc WHERE cc.campaign_id=c.id AND cc.status='sent') as sent_count,
                    (SELECT COUNT(*) FROM crm_campaign_contacts cc WHERE cc.campaign_id=c.id AND cc.status='pending') as pending_count,
                    (SELECT COUNT(*) FROM crm_campaign_contacts cc WHERE cc.campaign_id=c.id AND cc.status='failed') as failed_count,
                    (SELECT COUNT(*) FROM crm_campaign_contacts cc WHERE cc.campaign_id=c.id AND cc.status='sent' AND cc.sent_at >= ?) as sent_today_count
                 FROM crm_campaigns c WHERE c.owner_zalo_id=? ORDER BY c.created_at DESC`,
                [todayStartMs, ownerZaloId]
            );
        } catch (err: any) { Logger.error(`[DB] getCRMCampaigns: ${err.message}`); return []; }
    }

    public getCRMCampaign(campaignId: number): CRMCampaign | null {
        if (!this.initialized) return null;
        try {
            const rows = this.query<any>(`SELECT * FROM crm_campaigns WHERE id=?`, [campaignId]);
            return rows[0] || null;
        } catch (err: any) { Logger.error(`[DB] getCRMCampaign: ${err.message}`); return null; }
    }

    public saveCRMCampaign(campaign: CRMCampaign): number {
        if (!this.initialized) return 0;
        try {
            const now = Date.now();
            const type = campaign.campaign_type || 'message';
            const frMsg = campaign.friend_request_message || '';
            const status = campaign.status || 'draft';
            const mixedCfg = campaign.mixed_config || '{}';
            const dailyLimit = campaign.daily_send_limit ?? 0;
            const dailyStartTime = campaign.daily_start_time || '08:00';
            if (campaign.id) {
                this.run(
                    `UPDATE crm_campaigns SET name=?, template_message=?, friend_request_message=?, campaign_type=?, mixed_config=?, status=?, delay_seconds=?, daily_send_limit=?, daily_start_time=?, updated_at=? WHERE id=? AND owner_zalo_id=?`,
                    [campaign.name, campaign.template_message || '', frMsg, type, mixedCfg, status, campaign.delay_seconds || 60, dailyLimit, dailyStartTime, now, campaign.id, campaign.owner_zalo_id]
                );
                return campaign.id;
            } else {
                return this.runInsert(
                    `INSERT INTO crm_campaigns (owner_zalo_id, name, template_message, friend_request_message, campaign_type, mixed_config, status, delay_seconds, daily_send_limit, daily_start_time, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
                    [campaign.owner_zalo_id, campaign.name, campaign.template_message, frMsg, type, mixedCfg, campaign.status || 'draft', campaign.delay_seconds || 60, dailyLimit, dailyStartTime, now, now]
                );
            }
        } catch (err: any) { Logger.error(`[DB] saveCRMCampaign: ${err.message}`); return 0; }
    }

    public updateCRMCampaignStatus(campaignId: number, status: CRMCampaignStatus): void {
        if (!this.initialized) return;
        try { this.run(`UPDATE crm_campaigns SET status=?, updated_at=? WHERE id=?`, [status, Date.now(), campaignId]); }
        catch (err: any) { Logger.error(`[DB] updateCRMCampaignStatus: ${err.message}`); }
    }

    public deleteCRMCampaign(campaignId: number, ownerZaloId: string): void {
        if (!this.initialized) return;
        try {
            this.runNoSave(`DELETE FROM crm_campaign_contacts WHERE campaign_id=?`, [campaignId]);
            this.runNoSave(`DELETE FROM crm_campaigns WHERE id=? AND owner_zalo_id=?`, [campaignId, ownerZaloId]);
            this.save();
        } catch (err: any) { Logger.error(`[DB] deleteCRMCampaign: ${err.message}`); }
    }

    public cloneCRMCampaign(campaignId: number, ownerZaloId: string, includeContacts: boolean, newName?: string): number {
        if (!this.initialized) return 0;
        try {
            const orig = this.getCRMCampaign(campaignId);
            if (!orig) { Logger.warn(`[DB] cloneCRMCampaign: campaign ${campaignId} not found`); return 0; }

            const newId = this.saveCRMCampaign({
                ...orig,
                id: 0,
                name: (newName?.trim()) || ((orig.name || '') + ' (bản sao)'),
                status: 'draft',
                owner_zalo_id: ownerZaloId,
            });
            if (!newId) { Logger.warn(`[DB] cloneCRMCampaign: saveCRMCampaign returned 0`); return 0; }

            if (includeContacts) {
                const contacts = this.getCampaignContacts(campaignId);
                if (contacts.length > 0) {
                    // Batch insert via a prepared statement to avoid per-row save() calls
                    const stmt = db!.prepare(
                        `INSERT OR IGNORE INTO crm_campaign_contacts
                         (campaign_id, owner_zalo_id, contact_id, display_name, avatar, status, sent_at, retry_count, error)
                         VALUES (?,?,?,?,?,?,?,?,?)`
                    );
                    for (const c of contacts) {
                        stmt.run(
                            newId,
                            ownerZaloId,
                            c.contact_id ?? '',
                            c.display_name ?? '',
                            c.avatar ?? '',
                            'pending',  // luôn reset về pending khi clone
                            0,          // sent_at
                            0,          // retry_count
                            '',         // error
                        );
                    }
                    Logger.log(`[DB] cloneCRMCampaign: copied ${contacts.length} contacts to campaign ${newId}`);
                }
            }

            return newId;
        } catch (err: any) { Logger.error(`[DB] cloneCRMCampaign: ${err.message}`); return 0; }
    }

    public addCampaignContacts(campaignId: number, ownerZaloId: string, contacts: Array<{ contactId: string; displayName?: string; avatar?: string; phone?: string }>): void {
        if (!this.initialized || !contacts.length) return;
        try {
            const stmt = db!.prepare(
                `INSERT OR IGNORE INTO crm_campaign_contacts (campaign_id, owner_zalo_id, contact_id, display_name, avatar, phone, status, sent_at, retry_count, error) VALUES (?,?,?,?,?,?,'pending',0,0,'')`
            );
            for (const c of contacts) {
                stmt.run(campaignId, ownerZaloId, c.contactId, c.displayName || '', c.avatar || '', c.phone || '');
            }
            this.save();
        } catch (err: any) { Logger.error(`[DB] addCampaignContacts: ${err.message}`); }
    }

    public getCampaignContacts(campaignId: number): CRMCampaignContact[] {
        if (!this.initialized) return [];
        try {
            return this.query<any>(`SELECT * FROM crm_campaign_contacts WHERE campaign_id=? ORDER BY id`, [campaignId]);
        } catch (err: any) { Logger.error(`[DB] getCampaignContacts: ${err.message}`); return []; }
    }

    public updateCampaignContactStatus(id: number, status: CRMContactStatus, error?: string): void {
        if (!this.initialized) return;
        try {
            const sentAt = status === 'sent' ? Date.now() : 0;
            const incRetry = status === 'failed' ? 1 : 0;
            this.run(
                `UPDATE crm_campaign_contacts SET status=?, sent_at=CASE WHEN ?='sent' THEN ? ELSE sent_at END, error=?, retry_count=retry_count+? WHERE id=?`,
                [status, status, sentAt, error || '', incRetry, id]
            );
        } catch (err: any) { Logger.error(`[DB] updateCampaignContactStatus: ${err.message}`); }
    }

    /** Update contact_id and display_name after phone resolution at send time */
    public updateCampaignContactId(id: number, newContactId: string, displayName: string): void {
        if (!this.initialized) return;
        try {
            this.run(
                `UPDATE crm_campaign_contacts SET contact_id=?, display_name=? WHERE id=?`,
                [newContactId, displayName, id]
            );
        } catch (err: any) { Logger.error(`[DB] updateCampaignContactId: ${err.message}`); }
    }

    /** Lấy item tiếp theo cần gửi cho account này */
    public getNextPendingCampaignContact(ownerZaloId: string): CRMCampaignContact | null {
        if (!this.initialized) return null;
        try {
            const rows = this.query<any>(
                `SELECT cc.*, c.template_message, c.delay_seconds, c.campaign_type, c.friend_request_message, c.mixed_config,
                    COALESCE(cont.phone, fr.phone, '') as phone,
                    COALESCE(cont.contact_type, 'user') as contact_type
                 FROM crm_campaign_contacts cc
                 JOIN crm_campaigns c ON c.id=cc.campaign_id
                 LEFT JOIN contacts cont ON cont.owner_zalo_id=cc.owner_zalo_id AND cont.contact_id=cc.contact_id
                 LEFT JOIN friends fr ON fr.owner_zalo_id=cc.owner_zalo_id AND fr.user_id=cc.contact_id
                 WHERE cc.owner_zalo_id=? AND cc.status='pending' AND c.status='active' AND cc.retry_count < 3
                 ORDER BY cc.id LIMIT 1`,
                [ownerZaloId]
            );
            return rows[0] || null;
        } catch (err: any) { Logger.error(`[DB] getNextPendingCampaignContact: ${err.message}`); return null; }
    }

    /** Kiểm tra có campaign nào đang active không */
    public hasActiveCampaigns(ownerZaloId: string): boolean {
        if (!this.initialized) return false;
        try {
            const rows = this.query<any>(
                `SELECT 1 FROM crm_campaigns c
                 WHERE c.owner_zalo_id=? AND c.status='active'
                 AND EXISTS (SELECT 1 FROM crm_campaign_contacts cc WHERE cc.campaign_id=c.id AND cc.status='pending')
                 LIMIT 1`,
                [ownerZaloId]
            );
            return rows.length > 0;
        } catch { return false; }
    }

    /** Lấy danh sách distinct owner_zalo_id có campaign đang active (dùng khi resume sau restart) */
    public getActiveCampaignOwners(): string[] {
        if (!this.initialized) return [];
        try {
            return this.query<any>(
                `SELECT DISTINCT owner_zalo_id FROM crm_campaigns WHERE status='active'`, []
            ).map((r: any) => r.owner_zalo_id);
        } catch (err: any) { Logger.error(`[DB] getActiveCampaignOwners: ${err.message}`); return []; }
    }

    /** Đếm số liên hệ đã gửi trong ngày hôm nay cho 1 campaign (dùng cho daily limit check) */
    public getDailySentCountForCampaign(campaignId: number): number {
        if (!this.initialized) return 0;
        try {
            const todayStart = new Date();
            todayStart.setHours(0, 0, 0, 0);
            const rows = this.query<any>(
                `SELECT COUNT(*) as cnt FROM crm_campaign_contacts WHERE campaign_id=? AND status='sent' AND sent_at >= ?`,
                [campaignId, todayStart.getTime()]
            );
            return rows[0]?.cnt ?? 0;
        } catch { return 0; }
    }

    /** Send Log */
    public saveSendLog(log: CRMSendLog): void {
        if (!this.initialized) return;
        try {
            this.run(
                `INSERT INTO crm_send_log (owner_zalo_id, contact_id, display_name, phone, contact_type, campaign_id, message, sent_at, status, error, data_request, data_response, send_type) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
                [log.owner_zalo_id, log.contact_id, log.display_name || '', this.normalizeVietnamPhone(log.phone || ''), log.contact_type || 'user', log.campaign_id || null, log.message, log.sent_at, log.status, log.error || '', log.data_request || '', log.data_response || '', log.send_type || '']
            );
        } catch (err: any) { Logger.error(`[DB] saveSendLog failed: ${err.message}`); }
    }

    public getSendLog(ownerZaloId: string, opts: { contactId?: string; campaignId?: number; limit?: number } = {}): CRMSendLog[] {
        if (!this.initialized) return [];
        try {
            let q = `SELECT * FROM crm_send_log WHERE owner_zalo_id=?`;
            const params: any[] = [ownerZaloId];
            if (opts.contactId) { q += ` AND contact_id=?`; params.push(opts.contactId); }
            if (opts.campaignId) { q += ` AND campaign_id=?`; params.push(opts.campaignId); }
            q += ` ORDER BY sent_at DESC LIMIT ?`;
            params.push(opts.limit || 100);
            return this.query<any>(q, params);
        } catch (err: any) { Logger.error(`[DB] getSendLog: ${err.message}`); return []; }
    }

    /** Top N campaigns with detailed stats including replied count */
    public getTopCampaignStats(ownerZaloId: string, limit = 10): any[] {
        if (!this.initialized) return [];
        try {
            return this.query<any>(`
                SELECT
                    c.id, c.name, c.campaign_type, c.created_at, c.status,
                    COUNT(DISTINCT cc.id) as total_contacts,
                    COALESCE(SUM(CASE WHEN cc.status='sent' THEN 1 ELSE 0 END), 0) as sent_count,
                    COALESCE(SUM(CASE WHEN cc.status='failed' THEN 1 ELSE 0 END), 0) as failed_count,
                    COALESCE(SUM(CASE WHEN cc.status='pending' THEN 1 ELSE 0 END), 0) as pending_count,
                    COUNT(DISTINCT CASE
                        WHEN EXISTS(
                            SELECT 1 FROM messages m
                            WHERE m.owner_zalo_id = cc.owner_zalo_id
                              AND m.thread_id = cc.contact_id
                              AND m.is_sent = 0
                              AND m.timestamp > cc.sent_at
                              AND cc.status = 'sent'
                              AND cc.sent_at > 0
                        ) THEN cc.contact_id END
                    ) as replied_count
                FROM crm_campaigns c
                LEFT JOIN crm_campaign_contacts cc ON cc.campaign_id = c.id
                WHERE c.owner_zalo_id = ?
                GROUP BY c.id
                ORDER BY c.created_at DESC
                LIMIT ?
            `, [ownerZaloId, limit]);
        } catch (err: any) { Logger.error(`[DB] getTopCampaignStats: ${err.message}`); return []; }
    }

    /** CRM Contacts — aggregate friends + contacts, dedup */
    public getCRMContacts(ownerZaloId: string, opts: {
        search?: string; tagIds?: number[]; isFriendOnly?: boolean;
        contactType?: 'all' | 'friend' | 'group' | 'non_friend';
        contactTypes?: ('friend' | 'group' | 'non_friend')[];
        sortBy?: 'name' | 'last_message'; sortDir?: 'asc' | 'desc';
        limit?: number; offset?: number;
    } = {}): { contacts: any[]; total: number } {
        if (!this.initialized) return { contacts: [], total: 0 };
        try {
            const { search, isFriendOnly, contactType = 'all', contactTypes, sortBy = 'name', sortDir = 'asc', limit = 50, offset = 0 } = opts;

            let all: any[] = [];

            // Determine effective type filter
            // contactTypes (array) takes priority; fallback to legacy contactType
            const effectiveTypes: ('friend' | 'group' | 'non_friend')[] | null =
                (contactTypes && contactTypes.length > 0) ? contactTypes : null;
            const legacyType = isFriendOnly ? 'friend' : (contactType || 'all');

            if (!effectiveTypes && legacyType === 'group') {
                // Only group contacts (legacy fast path)
                all = this.query<any>(
                    `SELECT contact_id, COALESCE(alias,'') as alias, COALESCE(display_name,'') as display_name,
                        COALESCE(avatar_url,'') as avatar, '' as phone,
                        0 as is_friend, COALESCE(last_message_time,0) as last_message_time, 'group' as contact_type,
                        gender, birthday
                     FROM contacts WHERE owner_zalo_id=? AND contact_type='group'
                     AND contact_id IS NOT NULL AND contact_id != ''`,
                    [ownerZaloId]
                );
            } else if (!effectiveTypes && legacyType === 'friend') {
                // Only friends (legacy fast path)
                all = this.query<any>(
                    `SELECT f.user_id as contact_id, COALESCE(c.alias,'') as alias,
                        COALESCE(c.display_name, f.display_name,'') as display_name,
                        COALESCE(c.avatar_url, f.avatar,'') as avatar,
                        COALESCE(c.phone, f.phone,'') as phone,
                        1 as is_friend,
                        COALESCE(c.last_message_time, 0) as last_message_time, 'user' as contact_type,
                        c.gender, c.birthday
                     FROM friends f
                     LEFT JOIN contacts c ON c.owner_zalo_id=f.owner_zalo_id AND c.contact_id=f.user_id
                     WHERE f.owner_zalo_id=?`,
                    [ownerZaloId]
                );
            } else {
                // Build full list: friends + non-friend contacts (including groups)
                const friends = this.query<any>(
                    `SELECT f.user_id as contact_id, COALESCE(c.alias,'') as alias,
                        COALESCE(c.display_name, f.display_name,'') as display_name,
                        COALESCE(c.avatar_url, f.avatar,'') as avatar,
                        COALESCE(c.phone, f.phone,'') as phone,
                        1 as is_friend,
                        COALESCE(c.last_message_time, 0) as last_message_time, 'user' as contact_type,
                        c.gender, c.birthday
                     FROM friends f
                     LEFT JOIN contacts c ON c.owner_zalo_id=f.owner_zalo_id AND c.contact_id=f.user_id
                     WHERE f.owner_zalo_id=?`,
                    [ownerZaloId]
                );
                const friendIds = new Set(friends.map((f: any) => f.contact_id));
                const otherContacts = this.query<any>(
                    `SELECT contact_id, COALESCE(alias,'') as alias, COALESCE(display_name,'') as display_name,
                        COALESCE(avatar_url,'') as avatar, COALESCE(phone,'') as phone,
                        is_friend, COALESCE(last_message_time,0) as last_message_time,
                        COALESCE(contact_type,'user') as contact_type,
                        gender, birthday
                     FROM contacts WHERE owner_zalo_id=?
                     AND contact_id IS NOT NULL AND contact_id != ''`,
                    [ownerZaloId]
                ).filter((c: any) => !friendIds.has(c.contact_id));
                all = [...friends, ...otherContacts];

                // Apply multi-type filter when provided
                if (effectiveTypes && effectiveTypes.length < 3) {
                    all = all.filter((c: any) => {
                        const isFriendContact = c.is_friend === 1;
                        const isGroup = c.contact_type === 'group';
                        const isNonFriend = !isFriendContact && !isGroup;
                        return (
                            (effectiveTypes.includes('friend') && isFriendContact) ||
                            (effectiveTypes.includes('group') && isGroup) ||
                            (effectiveTypes.includes('non_friend') && isNonFriend)
                        );
                    });
                } else if (!effectiveTypes && legacyType === 'non_friend') {
                    // Legacy non_friend single type
                    all = all.filter((c: any) => c.is_friend !== 1 && c.contact_type !== 'group');
                }
            }

            // Apply search filter
            if (search?.trim()) {
                const q = search.toLowerCase();
                all = all.filter(c =>
                    (c.display_name || '').toLowerCase().includes(q) ||
                    (c.alias || '').toLowerCase().includes(q) ||
                    (c.phone || '').toLowerCase().includes(q) ||
                    c.contact_id.toLowerCase().includes(q)
                );
            }

            // Sort
            all.sort((a, b) => {
                let va: any, vb: any;
                if (sortBy === 'last_message') {
                    va = a.last_message_time; vb = b.last_message_time;
                } else {
                    va = (a.alias || a.display_name || '').toLowerCase();
                    vb = (b.alias || b.display_name || '').toLowerCase();
                }
                if (va < vb) return sortDir === 'asc' ? -1 : 1;
                if (va > vb) return sortDir === 'asc' ? 1 : -1;
                return 0;
            });

            const total = all.length;

            // Paginate + note counts
            const page = all.slice(offset, offset + limit);
            const pageIds = page.map((c: any) => c.contact_id);
            const noteCountMap: Record<string, number> = {};
            if (pageIds.length > 0) {
                const placeholders = pageIds.map(() => '?').join(',');
                this.query<any>(
                    `SELECT contact_id, COUNT(*) as n FROM crm_notes WHERE owner_zalo_id=? AND contact_id IN (${placeholders}) GROUP BY contact_id`,
                    [ownerZaloId, ...pageIds]
                ).forEach((r: any) => { noteCountMap[r.contact_id] = r.n; });
            }

            const contacts = page.map((c: any) => ({
                ...c,
                note_count: noteCountMap[c.contact_id] || 0,
            }));

            return { contacts, total };
        } catch (err: any) { Logger.error(`[DB] getCRMContacts: ${err.message}`); return { contacts: [], total: 0 }; }
    }

    /** Activity stats for a given time window — used by CRM Dashboard */
    public getActivityStats(ownerZaloId: string, sinceTs: number, untilTs: number = Date.now()): {
        conversationCount: number; messageCount: number; sentCount: number; receivedCount: number;
    } {
        if (!this.initialized) return { conversationCount: 0, messageCount: 0, sentCount: 0, receivedCount: 0 };
        try {
            const row = this.queryOne<any>(
                `SELECT COUNT(DISTINCT thread_id) as conv_cnt,
                        COUNT(*) as msg_cnt,
                        COALESCE(SUM(CASE WHEN is_sent=1 THEN 1 ELSE 0 END), 0) as sent_cnt
                 FROM messages
                 WHERE owner_zalo_id=? AND timestamp >= ? AND timestamp <= ?`,
                [ownerZaloId, sinceTs, untilTs]
            );
            const conversationCount = row?.conv_cnt || 0;
            const messageCount = row?.msg_cnt || 0;
            const sentCount = row?.sent_cnt || 0;
            return { conversationCount, messageCount, sentCount, receivedCount: messageCount - sentCount };
        } catch (err: any) {
            Logger.error(`[DB] getActivityStats: ${err.message}`);
            return { conversationCount: 0, messageCount: 0, sentCount: 0, receivedCount: 0 };
        }
    }

    /** Unfiltered aggregate stats — used by CRM Dashboard */
    public getContactStats(ownerZaloId: string): { total: number; friendCount: number; noteCount: number } {
        if (!this.initialized) return { total: 0, friendCount: 0, noteCount: 0 };
        try {
            const friendCount: number = this.query<any>(
                `SELECT COUNT(*) as cnt FROM friends WHERE owner_zalo_id=?`,
                [ownerZaloId]
            )[0]?.cnt || 0;

            const nonFriendCount: number = this.query<any>(
                `SELECT COUNT(*) as cnt FROM contacts
                 WHERE owner_zalo_id=? AND contact_type != 'group'
                 AND contact_id IS NOT NULL AND contact_id != ''
                 AND contact_id NOT IN (SELECT user_id FROM friends WHERE owner_zalo_id=?)`,
                [ownerZaloId, ownerZaloId]
            )[0]?.cnt || 0;

            const noteCount: number = this.query<any>(
                `SELECT COUNT(DISTINCT contact_id) as cnt FROM crm_notes WHERE owner_zalo_id=?`,
                [ownerZaloId]
            )[0]?.cnt || 0;

            return { total: friendCount + nonFriendCount, friendCount, noteCount };
        } catch (err: any) {
            Logger.error(`[DB] getContactStats: ${err.message}`);
            return { total: 0, friendCount: 0, noteCount: 0 };
        }
    }

    // ─── Analytics / Reporting ────────────────────────────────────────────────

    /**
     * Per-account overview: tổng tin nhắn, contacts, groups cho 1 account
     */
    public getDashboardOverview(zaloId: string): {
        totalMessages: number; totalSent: number; totalReceived: number;
        totalContacts: number; totalFriends: number; totalGroups: number;
        todayMessages: number; todaySent: number; todayReceived: number;
        yesterdayMessages: number;
        activeCampaigns: number; totalCampaigns: number;
    } {
        const empty = { totalMessages: 0, totalSent: 0, totalReceived: 0, totalContacts: 0, totalFriends: 0, totalGroups: 0, todayMessages: 0, todaySent: 0, todayReceived: 0, yesterdayMessages: 0, activeCampaigns: 0, totalCampaigns: 0 };
        if (!this.initialized || !zaloId) return empty;
        try {
            // Today range
            const now = new Date();
            const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0).getTime();
            const todayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999).getTime();
            const yesterdayStart = todayStart - 86400000;
            const yesterdayEnd = todayStart - 1;

            const msgRow = this.queryOne<any>(
                `SELECT COUNT(*) as total, COALESCE(SUM(CASE WHEN is_sent=1 THEN 1 ELSE 0 END),0) as sent FROM messages WHERE owner_zalo_id = ?`,
                [zaloId]
            );
            const todayRow = this.queryOne<any>(
                `SELECT COUNT(*) as total, COALESCE(SUM(CASE WHEN is_sent=1 THEN 1 ELSE 0 END),0) as sent FROM messages WHERE owner_zalo_id = ? AND timestamp >= ? AND timestamp <= ?`,
                [zaloId, todayStart, todayEnd]
            );
            const yestRow = this.queryOne<any>(
                `SELECT COUNT(*) as total FROM messages WHERE owner_zalo_id = ? AND timestamp >= ? AND timestamp <= ?`,
                [zaloId, yesterdayStart, yesterdayEnd]
            );
            const contactRow = this.queryOne<any>(
                `SELECT COUNT(*) as cnt FROM contacts WHERE owner_zalo_id = ? AND contact_type != 'group'`,
                [zaloId]
            );
            const friendRow = this.queryOne<any>(
                `SELECT COUNT(*) as cnt FROM friends WHERE owner_zalo_id = ?`,
                [zaloId]
            );
            const groupRow = this.queryOne<any>(
                `SELECT COUNT(DISTINCT contact_id) as cnt FROM contacts WHERE owner_zalo_id = ? AND contact_type = 'group'`,
                [zaloId]
            );
            const campRow = this.queryOne<any>(
                `SELECT COUNT(*) as total, COALESCE(SUM(CASE WHEN status='active' THEN 1 ELSE 0 END),0) as active FROM crm_campaigns WHERE owner_zalo_id = ?`,
                [zaloId]
            );

            return {
                totalMessages: msgRow?.total || 0,
                totalSent: msgRow?.sent || 0,
                totalReceived: (msgRow?.total || 0) - (msgRow?.sent || 0),
                totalContacts: contactRow?.cnt || 0,
                totalFriends: friendRow?.cnt || 0,
                totalGroups: groupRow?.cnt || 0,
                todayMessages: todayRow?.total || 0,
                todaySent: todayRow?.sent || 0,
                todayReceived: (todayRow?.total || 0) - (todayRow?.sent || 0),
                yesterdayMessages: yestRow?.total || 0,
                activeCampaigns: campRow?.active || 0,
                totalCampaigns: campRow?.total || 0,
            };
        } catch (err: any) {
            Logger.error(`[DB] getDashboardOverview: ${err.message}`);
            return empty;
        }
    }

    /**
     * Message volume timeline: messages per hour or per day
     * granularity: 'hour' (24 data points for a day) or 'day' (N data points for a range)
     */
    public getMessageVolume(zaloId: string, sinceTs: number, untilTs: number, granularity: 'hour' | 'day', threadType?: number): Array<{
        bucket: string; sent: number; received: number; total: number;
    }> {
        if (!this.initialized || !zaloId) return [];
        try {
            const threadFilter = threadType !== undefined && threadType !== -1 ? ' AND thread_type = ?' : '';
            const threadParams = threadType !== undefined && threadType !== -1 ? [threadType] : [];
            let sql: string;
            if (granularity === 'hour') {
                sql = `SELECT
                    CAST((timestamp - ?) / 3600000 AS INTEGER) as hour_idx,
                    COUNT(*) as total,
                    COALESCE(SUM(CASE WHEN is_sent=1 THEN 1 ELSE 0 END),0) as sent
                FROM messages
                WHERE owner_zalo_id = ? AND timestamp >= ? AND timestamp <= ?${threadFilter}
                GROUP BY hour_idx
                ORDER BY hour_idx`;
                const rows = this.query<any>(sql, [sinceTs, zaloId, sinceTs, untilTs, ...threadParams]);
                const totalHours = Math.ceil((untilTs - sinceTs) / 3600000);
                const result: Array<{ bucket: string; sent: number; received: number; total: number }> = [];
                const rowMap = new Map(rows.map((r: any) => [r.hour_idx, r]));
                for (let i = 0; i < totalHours; i++) {
                    const d = new Date(sinceTs + i * 3600000);
                    const label = `${d.getHours().toString().padStart(2, '0')}:00`;
                    const r = rowMap.get(i);
                    const total = r?.total || 0;
                    const sent = r?.sent || 0;
                    result.push({ bucket: label, sent, received: total - sent, total });
                }
                return result;
            } else {
                sql = `SELECT
                    CAST((timestamp - ?) / 86400000 AS INTEGER) as day_idx,
                    COUNT(*) as total,
                    COALESCE(SUM(CASE WHEN is_sent=1 THEN 1 ELSE 0 END),0) as sent
                FROM messages
                WHERE owner_zalo_id = ? AND timestamp >= ? AND timestamp <= ?${threadFilter}
                GROUP BY day_idx
                ORDER BY day_idx`;
                const rows = this.query<any>(sql, [sinceTs, zaloId, sinceTs, untilTs, ...threadParams]);
                const totalDays = Math.ceil((untilTs - sinceTs) / 86400000) + 1;
                const result: Array<{ bucket: string; sent: number; received: number; total: number }> = [];
                const rowMap = new Map(rows.map((r: any) => [r.day_idx, r]));
                for (let i = 0; i < totalDays; i++) {
                    const d = new Date(sinceTs + i * 86400000);
                    const label = `${d.getDate().toString().padStart(2, '0')}/${(d.getMonth() + 1).toString().padStart(2, '0')}`;
                    const r = rowMap.get(i);
                    const total = r?.total || 0;
                    const sent = r?.sent || 0;
                    result.push({ bucket: label, sent, received: total - sent, total });
                }
                return result;
            }
        } catch (err: any) {
            Logger.error(`[DB] getMessageVolume: ${err.message}`);
            return [];
        }
    }

    /**
     * Response time analytics: measures how long it takes to reply to incoming messages.
     *
     * For each 1-to-1 thread, finds pairs of:
     *   - incoming message (is_sent=0) followed by outgoing reply (is_sent=1)
     * and calculates the time gap.
     *
     * Returns: avgSeconds, medianSeconds, minSeconds, maxSeconds,
     *          totalConversations (threads with at least 1 reply pair),
     *          totalReplies, distribution (bucketed histogram),
     *          byHour (avg response time by hour of day)
     */
    public getResponseTimeStats(zaloId: string, sinceTs: number, untilTs: number, threadType?: number): {
        avgSeconds: number;
        medianSeconds: number;
        minSeconds: number;
        maxSeconds: number;
        totalConversations: number;
        totalReplies: number;
        distribution: Array<{ bucket: string; count: number }>;
        byHour: Array<{ hour: number; avgSeconds: number; count: number }>;
    } {
        const empty = { avgSeconds: 0, medianSeconds: 0, minSeconds: 0, maxSeconds: 0, totalConversations: 0, totalReplies: 0, distribution: [], byHour: [] };
        if (!this.initialized || !zaloId) return empty;
        try {
            // Determine thread_type filter: default to 0 (1-to-1) unless explicitly set
            const ttFilter = threadType !== undefined && threadType !== -1 ? threadType : 0;
            // Get messages in the date range, ordered by thread + time
            const msgs = this.query<any>(
                `SELECT thread_id, is_sent, timestamp
                 FROM messages
                 WHERE owner_zalo_id = ? AND thread_type = ? AND timestamp >= ? AND timestamp <= ?
                 ORDER BY thread_id, timestamp ASC`,
                [zaloId, ttFilter, sinceTs, untilTs]
            );

            if (msgs.length === 0) return empty;

            // Group by thread and find response gaps
            const gaps: number[] = [];
            const hourGaps: Map<number, number[]> = new Map();
            const threadsSeen = new Set<string>();

            let prevThreadId: string | null = null;
            let lastIncomingTs: number | null = null;

            for (const m of msgs) {
                if (m.thread_id !== prevThreadId) {
                    // New thread
                    prevThreadId = m.thread_id;
                    lastIncomingTs = null;
                }

                if (m.is_sent === 0) {
                    // Incoming message — record timestamp (always take the latest unanswered incoming)
                    lastIncomingTs = m.timestamp;
                } else if (m.is_sent === 1 && lastIncomingTs !== null) {
                    // Outgoing message after an incoming one — this is a reply
                    const gapMs = m.timestamp - lastIncomingTs;
                    if (gapMs >= 0 && gapMs < 7 * 86400000) {
                        // Only count replies within 7 days (ignore stale threads)
                        const gapSec = Math.round(gapMs / 1000);
                        gaps.push(gapSec);
                        threadsSeen.add(m.thread_id);

                        // Group by hour of the incoming message
                        const hour = new Date(lastIncomingTs).getHours();
                        if (!hourGaps.has(hour)) hourGaps.set(hour, []);
                        hourGaps.get(hour)!.push(gapSec);
                    }
                    lastIncomingTs = null; // Reset — this reply consumed the incoming
                }
            }

            if (gaps.length === 0) return empty;

            // Sort for median/min/max
            gaps.sort((a, b) => a - b);
            const sum = gaps.reduce((s, v) => s + v, 0);
            const avgSeconds = Math.round(sum / gaps.length);
            const medianSeconds = gaps[Math.floor(gaps.length / 2)];
            const minSeconds = gaps[0];
            const maxSeconds = gaps[gaps.length - 1];

            // Distribution buckets
            const bucketDefs: Array<{ label: string; maxSec: number }> = [
                { label: '< 1 phút', maxSec: 60 },
                { label: '1–5 phút', maxSec: 300 },
                { label: '5–15 phút', maxSec: 900 },
                { label: '15–30 phút', maxSec: 1800 },
                { label: '30–60 phút', maxSec: 3600 },
                { label: '1–2 giờ', maxSec: 7200 },
                { label: '2–4 giờ', maxSec: 14400 },
                { label: '4–12 giờ', maxSec: 43200 },
                { label: '12–24 giờ', maxSec: 86400 },
                { label: '> 24 giờ', maxSec: Infinity },
            ];
            const distribution = bucketDefs.map(b => ({ bucket: b.label, count: 0 }));
            for (const g of gaps) {
                for (let i = 0; i < bucketDefs.length; i++) {
                    if (g < bucketDefs[i].maxSec || i === bucketDefs.length - 1) {
                        distribution[i].count++;
                        break;
                    }
                }
            }

            // By hour of day
            const byHour: Array<{ hour: number; avgSeconds: number; count: number }> = [];
            for (let h = 0; h < 24; h++) {
                const hGaps = hourGaps.get(h) || [];
                byHour.push({
                    hour: h,
                    avgSeconds: hGaps.length > 0 ? Math.round(hGaps.reduce((s, v) => s + v, 0) / hGaps.length) : 0,
                    count: hGaps.length,
                });
            }

            return {
                avgSeconds,
                medianSeconds,
                minSeconds,
                maxSeconds,
                totalConversations: threadsSeen.size,
                totalReplies: gaps.length,
                distribution,
                byHour,
            };
        } catch (err: any) {
            Logger.error(`[DB] getResponseTimeStats: ${err.message}`);
            return empty;
        }
    }

    /**
     * Label usage analytics: tracks how local labels are assigned to threads over time.
     *
     * Uses `local_label_threads.created_at` to build:
     *   - Total assignments in the period
     *   - Timeline (assignments per day)
     *   - Breakdown per label (name, emoji, color, count)
     *   - Recent assignments with timestamp details
     */
    public getLabelUsageAnalytics(zaloId: string, sinceTs: number, untilTs: number): {
        totalAssignments: number;
        totalLabelsUsed: number;
        avgPerDay: number;
        timeline: Array<{ bucket: string; count: number }>;
        byLabel: Array<{ labelId: number; name: string; emoji: string; color: string; count: number }>;
        recentAssignments: Array<{ labelName: string; emoji: string; color: string; threadId: string; createdAt: number }>;
    } {
        const empty = { totalAssignments: 0, totalLabelsUsed: 0, avgPerDay: 0, timeline: [], byLabel: [], recentAssignments: [] };
        if (!this.initialized || !zaloId) return empty;
        try {
            // Total assignments in period
            const totalRow = this.queryOne<any>(
                `SELECT COUNT(*) as cnt FROM local_label_threads WHERE owner_zalo_id = ? AND created_at >= ? AND created_at <= ?`,
                [zaloId, sinceTs, untilTs]
            );
            const totalAssignments = totalRow?.cnt || 0;
            if (totalAssignments === 0) return empty;

            // Distinct labels used
            const labelsUsedRow = this.queryOne<any>(
                `SELECT COUNT(DISTINCT label_id) as cnt FROM local_label_threads WHERE owner_zalo_id = ? AND created_at >= ? AND created_at <= ?`,
                [zaloId, sinceTs, untilTs]
            );
            const totalLabelsUsed = labelsUsedRow?.cnt || 0;

            // Avg per day
            const days = Math.max(1, Math.ceil((untilTs - sinceTs) / 86400000));
            const avgPerDay = Math.round((totalAssignments / days) * 10) / 10;

            // Timeline: assignments per day
            const timelineRows = this.query<any>(
                `SELECT CAST((created_at - ?) / 86400000 AS INTEGER) as day_idx, COUNT(*) as cnt
                 FROM local_label_threads
                 WHERE owner_zalo_id = ? AND created_at >= ? AND created_at <= ?
                 GROUP BY day_idx
                 ORDER BY day_idx`,
                [sinceTs, zaloId, sinceTs, untilTs]
            );
            const timelineMap = new Map(timelineRows.map((r: any) => [r.day_idx, r.cnt]));
            const timeline: Array<{ bucket: string; count: number }> = [];
            for (let i = 0; i < days; i++) {
                const d = new Date(sinceTs + i * 86400000);
                const label = `${d.getDate().toString().padStart(2, '0')}/${(d.getMonth() + 1).toString().padStart(2, '0')}`;
                timeline.push({ bucket: label, count: (timelineMap.get(i) as number) || 0 });
            }

            // By label breakdown
            const byLabel = this.query<any>(
                `SELECT llt.label_id, ll.name, ll.emoji, ll.color, COUNT(*) as cnt
                 FROM local_label_threads llt
                 INNER JOIN local_labels ll ON ll.id = llt.label_id
                 WHERE llt.owner_zalo_id = ? AND llt.created_at >= ? AND llt.created_at <= ?
                 GROUP BY llt.label_id
                 ORDER BY cnt DESC`,
                [zaloId, sinceTs, untilTs]
            ).map((r: any) => ({
                labelId: r.label_id,
                name: r.name || 'Không tên',
                emoji: r.emoji || '🏷️',
                color: r.color || '#3B82F6',
                count: r.cnt,
            }));

            // Recent assignments (last 50)
            const recentAssignments = this.query<any>(
                `SELECT ll.name as label_name, ll.emoji, ll.color, llt.thread_id, llt.created_at
                 FROM local_label_threads llt
                 INNER JOIN local_labels ll ON ll.id = llt.label_id
                 WHERE llt.owner_zalo_id = ? AND llt.created_at >= ? AND llt.created_at <= ?
                 ORDER BY llt.created_at DESC
                 LIMIT 50`,
                [zaloId, sinceTs, untilTs]
            ).map((r: any) => ({
                labelName: r.label_name || 'Không tên',
                emoji: r.emoji || '🏷️',
                color: r.color || '#3B82F6',
                threadId: r.thread_id,
                createdAt: r.created_at,
            }));

            return { totalAssignments, totalLabelsUsed, avgPerDay, timeline, byLabel, recentAssignments };
        } catch (err: any) {
            Logger.error(`[DB] getLabelUsageAnalytics: ${err.message}`);
            return empty;
        }
    }

    /**
     * Peak Hours Heatmap: 7 days × 24 hours grid of message counts
     * Returns array of { dayOfWeek: 0-6 (Mon-Sun), hour: 0-23, count: number }
     */
    public getPeakHoursHeatmap(zaloId: string, sinceTs: number, untilTs: number, threadType?: number): Array<{
        dayOfWeek: number; hour: number; count: number;
    }> {
        if (!this.initialized || !zaloId) return [];
        try {
            const threadFilter = threadType !== undefined && threadType !== -1 ? ' AND thread_type = ?' : '';
            const threadParams = threadType !== undefined && threadType !== -1 ? [threadType] : [];
            const rows = this.query<any>(
                `SELECT timestamp FROM messages WHERE owner_zalo_id = ? AND timestamp >= ? AND timestamp <= ?${threadFilter}`,
                [zaloId, sinceTs, untilTs, ...threadParams]
            );
            // Build 7×24 grid
            const grid = new Map<string, number>();
            for (const r of rows) {
                const d = new Date(r.timestamp);
                const dow = d.getDay(); // 0=Sun, 1=Mon, ...6=Sat
                // Convert to Mon=0 ... Sun=6
                const dowMon = dow === 0 ? 6 : dow - 1;
                const hour = d.getHours();
                const key = `${dowMon}_${hour}`;
                grid.set(key, (grid.get(key) || 0) + 1);
            }
            const result: Array<{ dayOfWeek: number; hour: number; count: number }> = [];
            for (let d = 0; d < 7; d++) {
                for (let h = 0; h < 24; h++) {
                    result.push({ dayOfWeek: d, hour: h, count: grid.get(`${d}_${h}`) || 0 });
                }
            }
            return result;
        } catch (err: any) {
            Logger.error(`[DB] getPeakHoursHeatmap: ${err.message}`);
            return [];
        }
    }

    /**
     * Contact growth: new contacts appearing over time (by first message date)
     * Returns array of { bucket: 'dd/MM', newContacts: number, newFriends: number }
     */
    public getContactGrowth(zaloId: string, sinceTs: number, untilTs: number): Array<{
        bucket: string; newContacts: number; newFriends: number;
    }> {
        if (!this.initialized || !zaloId) return [];
        try {
            const rows = this.query<any>(
                `SELECT thread_id, owner_zalo_id, MIN(timestamp) as first_ts
                 FROM messages
                 WHERE owner_zalo_id = ? AND thread_type = 0 AND timestamp >= ? AND timestamp <= ?
                 GROUP BY owner_zalo_id, thread_id
                 HAVING first_ts >= ? AND first_ts <= ?`,
                [zaloId, sinceTs, untilTs, sinceTs, untilTs]
            );
            const friendSet = new Set<string>();
            const friendRows = this.query<any>(
                `SELECT owner_zalo_id, user_id FROM friends WHERE owner_zalo_id = ?`,
                [zaloId]
            );
            for (const f of friendRows) friendSet.add(`${f.owner_zalo_id}_${f.user_id}`);

            const totalDays = Math.ceil((untilTs - sinceTs) / 86400000) + 1;
            const buckets: Array<{ bucket: string; newContacts: number; newFriends: number }> = [];
            const dayMap = new Map<number, { contacts: number; friends: number }>();

            for (const r of rows) {
                const dayIdx = Math.floor((r.first_ts - sinceTs) / 86400000);
                const entry = dayMap.get(dayIdx) || { contacts: 0, friends: 0 };
                entry.contacts++;
                if (friendSet.has(`${r.owner_zalo_id}_${r.thread_id}`)) entry.friends++;
                dayMap.set(dayIdx, entry);
            }

            for (let i = 0; i < totalDays; i++) {
                const d = new Date(sinceTs + i * 86400000);
                const label = `${d.getDate().toString().padStart(2, '0')}/${(d.getMonth() + 1).toString().padStart(2, '0')}`;
                const entry = dayMap.get(i) || { contacts: 0, friends: 0 };
                buckets.push({ bucket: label, newContacts: entry.contacts, newFriends: entry.friends });
            }
            return buckets;
        } catch (err: any) {
            Logger.error(`[DB] getContactGrowth: ${err.message}`);
            return [];
        }
    }

    /**
     * Contact segmentation: phân bổ contacts theo type, friend status, tag, note
     */
    public getContactSegmentation(zaloId: string): {
        byType: Array<{ type: string; count: number }>;
        tagged: number; untagged: number;
        withNotes: number; withoutNotes: number;
    } {
        const empty = { byType: [], tagged: 0, untagged: 0, withNotes: 0, withoutNotes: 0 };
        if (!this.initialized || !zaloId) return empty;
        try {
            const friendCount = this.queryOne<any>(
                `SELECT COUNT(*) as cnt FROM friends WHERE owner_zalo_id = ?`,
                [zaloId]
            )?.cnt || 0;
            const nonFriendCount = this.queryOne<any>(
                `SELECT COUNT(*) as cnt FROM contacts
                 WHERE owner_zalo_id = ? AND contact_type != 'group'
                 AND contact_id NOT IN (SELECT user_id FROM friends WHERE owner_zalo_id = ?)`,
                [zaloId, zaloId]
            )?.cnt || 0;
            const groupCount = this.queryOne<any>(
                `SELECT COUNT(DISTINCT contact_id) as cnt FROM contacts WHERE owner_zalo_id = ? AND contact_type = 'group'`,
                [zaloId]
            )?.cnt || 0;

            const byType = [
                { type: 'Bạn bè', count: friendCount },
                { type: 'Người lạ', count: nonFriendCount },
                { type: 'Nhóm', count: groupCount },
            ];

            // Tagged vs untagged (CRM tags + local labels)
            const taggedContacts = this.queryOne<any>(
                `SELECT COUNT(DISTINCT contact_id) as cnt FROM crm_contact_tags WHERE owner_zalo_id = ?`,
                [zaloId]
            )?.cnt || 0;
            const labeledThreads = this.queryOne<any>(
                `SELECT COUNT(DISTINCT thread_id) as cnt FROM local_label_threads WHERE owner_zalo_id = ?`,
                [zaloId]
            )?.cnt || 0;
            const tagged = taggedContacts + labeledThreads;
            const totalContacts = friendCount + nonFriendCount;
            const untagged = Math.max(0, totalContacts - tagged);

            // With notes vs without
            const withNotes = this.queryOne<any>(
                `SELECT COUNT(DISTINCT contact_id) as cnt FROM crm_notes WHERE owner_zalo_id = ?`,
                [zaloId]
            )?.cnt || 0;
            const withoutNotes = Math.max(0, totalContacts - withNotes);

            return { byType, tagged, untagged, withNotes, withoutNotes };
        } catch (err: any) {
            Logger.error(`[DB] getContactSegmentation: ${err.message}`);
            return empty;
        }
    }

    /**
     * Campaign comparison: all campaigns with detailed metrics
     */
    public getCampaignComparison(zaloId: string): Array<{
        id: number; name: string; type: string; status: string; created_at: number;
        total: number; sent: number; failed: number; pending: number; replied: number;
        deliveryRate: number; replyRate: number;
    }> {
        if (!this.initialized || !zaloId) return [];
        try {
            const rows = this.query<any>(`
                SELECT
                    c.id, c.name, c.campaign_type, c.status, c.created_at,
                    COUNT(DISTINCT cc.id) as total_contacts,
                    COALESCE(SUM(CASE WHEN cc.status='sent' THEN 1 ELSE 0 END), 0) as sent_count,
                    COALESCE(SUM(CASE WHEN cc.status='failed' THEN 1 ELSE 0 END), 0) as failed_count,
                    COALESCE(SUM(CASE WHEN cc.status='pending' THEN 1 ELSE 0 END), 0) as pending_count,
                    COUNT(DISTINCT CASE
                        WHEN EXISTS(
                            SELECT 1 FROM messages m
                            WHERE m.owner_zalo_id = cc.owner_zalo_id
                              AND m.thread_id = cc.contact_id
                              AND m.is_sent = 0
                              AND m.timestamp > cc.sent_at
                              AND cc.status = 'sent'
                              AND cc.sent_at > 0
                        ) THEN cc.contact_id END
                    ) as replied_count
                FROM crm_campaigns c
                LEFT JOIN crm_campaign_contacts cc ON cc.campaign_id = c.id
                WHERE c.owner_zalo_id = ?
                GROUP BY c.id
                ORDER BY c.created_at DESC
            `, [zaloId]);

            return rows.map((r: any) => {
                const total = r.total_contacts || 0;
                const sent = r.sent_count || 0;
                const replied = r.replied_count || 0;
                return {
                    id: r.id,
                    name: r.name,
                    type: r.campaign_type,
                    status: r.status,
                    created_at: r.created_at,
                    total,
                    sent,
                    failed: r.failed_count || 0,
                    pending: r.pending_count || 0,
                    replied,
                    deliveryRate: total > 0 ? Math.round(sent / total * 100) : 0,
                    replyRate: sent > 0 ? Math.round(replied / sent * 100) : 0,
                };
            });
        } catch (err: any) {
            Logger.error(`[DB] getCampaignComparison: ${err.message}`);
            return [];
        }
    }

    /**
     * Friend request analytics: sent/received/accepted over time
     */
    public getFriendRequestAnalytics(zaloId: string, sinceTs: number, untilTs: number): {
        totalSent: number; totalReceived: number;
        timeline: Array<{ bucket: string; sent: number; received: number }>;
    } {
        const empty = { totalSent: 0, totalReceived: 0, timeline: [] };
        if (!this.initialized || !zaloId) return empty;
        try {
            const sentCount = this.queryOne<any>(
                `SELECT COUNT(*) as cnt FROM friend_requests WHERE owner_zalo_id = ? AND direction='sent' AND created_at >= ? AND created_at <= ?`,
                [zaloId, sinceTs, untilTs]
            )?.cnt || 0;
            const receivedCount = this.queryOne<any>(
                `SELECT COUNT(*) as cnt FROM friend_requests WHERE owner_zalo_id = ? AND direction='received' AND created_at >= ? AND created_at <= ?`,
                [zaloId, sinceTs, untilTs]
            )?.cnt || 0;

            const totalDays = Math.ceil((untilTs - sinceTs) / 86400000) + 1;
            const sentRows = this.query<any>(
                `SELECT CAST((created_at - ?) / 86400000 AS INTEGER) as day_idx, COUNT(*) as cnt
                 FROM friend_requests WHERE owner_zalo_id = ? AND direction='sent' AND created_at >= ? AND created_at <= ?
                 GROUP BY day_idx`,
                [sinceTs, zaloId, sinceTs, untilTs]
            );
            const recvRows = this.query<any>(
                `SELECT CAST((created_at - ?) / 86400000 AS INTEGER) as day_idx, COUNT(*) as cnt
                 FROM friend_requests WHERE owner_zalo_id = ? AND direction='received' AND created_at >= ? AND created_at <= ?
                 GROUP BY day_idx`,
                [sinceTs, zaloId, sinceTs, untilTs]
            );
            const sentMap = new Map(sentRows.map((r: any) => [r.day_idx, r.cnt]));
            const recvMap = new Map(recvRows.map((r: any) => [r.day_idx, r.cnt]));

            const timeline: Array<{ bucket: string; sent: number; received: number }> = [];
            for (let i = 0; i < totalDays; i++) {
                const d = new Date(sinceTs + i * 86400000);
                const label = `${d.getDate().toString().padStart(2, '0')}/${(d.getMonth() + 1).toString().padStart(2, '0')}`;
                timeline.push({ bucket: label, sent: sentMap.get(i) || 0, received: recvMap.get(i) || 0 });
            }

            return { totalSent: sentCount, totalReceived: receivedCount, timeline };
        } catch (err: any) {
            Logger.error(`[DB] getFriendRequestAnalytics: ${err.message}`);
            return empty;
        }
    }

    // ─── Message Draft Operations ─────────────────────────────────────────

    /** Upsert draft: lưu hoặc cập nhật nội dung draft cho 1 thread */
    public upsertDraft(ownerZaloId: string, threadId: string, content: string): void {
        if (!this.initialized || !threadId) return;
        try {
            this.run(
                `INSERT INTO message_drafts (owner_zalo_id, thread_id, content, updated_at)
                 VALUES (?,?,?,?)
                 ON CONFLICT(owner_zalo_id, thread_id) DO UPDATE SET
                   content=excluded.content,
                   updated_at=excluded.updated_at`,
                [ownerZaloId, threadId, content, Date.now()]
            );
        } catch (err: any) {
            Logger.error(`[DB] upsertDraft error: ${err.message}`);
        }
    }

    /** Xoá draft cho 1 thread (khi gửi tin nhắn hoặc xoá hết text) */
    public deleteDraft(ownerZaloId: string, threadId: string): void {
        if (!this.initialized || !threadId) return;
        try {
            this.run(
                `DELETE FROM message_drafts WHERE owner_zalo_id = ? AND thread_id = ?`,
                [ownerZaloId, threadId]
            );
        } catch (err: any) {
            Logger.error(`[DB] deleteDraft error: ${err.message}`);
        }
    }

    /** Lấy draft cho 1 thread */
    public getDraft(ownerZaloId: string, threadId: string): { content: string; updatedAt: number } | null {
        if (!this.initialized) return null;
        try {
            const row = this.queryOne<any>(
                `SELECT content, updated_at FROM message_drafts WHERE owner_zalo_id = ? AND thread_id = ?`,
                [ownerZaloId, threadId]
            );
            return row ? { content: row.content, updatedAt: row.updated_at } : null;
        } catch (err: any) {
            Logger.error(`[DB] getDraft error: ${err.message}`);
            return null;
        }
    }

    /** Lấy tất cả drafts cho 1 tài khoản — dùng khi khởi tạo app */
    public getDrafts(ownerZaloId: string): Array<{ threadId: string; content: string; updatedAt: number }> {
        if (!this.initialized) return [];
        try {
            return this.query<any>(
                `SELECT thread_id, content, updated_at FROM message_drafts WHERE owner_zalo_id = ? ORDER BY updated_at DESC`,
                [ownerZaloId]
            ).map(r => ({ threadId: r.thread_id, content: r.content, updatedAt: r.updated_at }));
        } catch (err: any) {
            Logger.error(`[DB] getDrafts error: ${err.message}`);
            return [];
        }
    }

    /** Xoá tất cả draft cũ hơn N ngày — cleanup */
    public deleteOldDrafts(olderThanDays: number = 7): void {
        if (!this.initialized) return;
        try {
            const cutoff = Date.now() - olderThanDays * 86400_000;
            this.run(`DELETE FROM message_drafts WHERE updated_at < ?`, [cutoff]);
        } catch (err: any) {
            Logger.error(`[DB] deleteOldDrafts error: ${err.message}`);
        }
    }

    // ─── Bank Cards ───────────────────────────────────────────────────────

    /** Lấy danh sách thẻ ngân hàng của tài khoản */
    public getBankCards(ownerZaloId: string): any[] {
        if (!this.initialized) return [];
        try {
            return this.query<any>(
                `SELECT * FROM bank_cards WHERE owner_zalo_id = ? ORDER BY is_default DESC, created_at DESC`,
                [ownerZaloId]
            );
        } catch (err: any) {
            Logger.error(`[DB] getBankCards error: ${err.message}`);
            return [];
        }
    }

    /** Thêm/sửa thẻ ngân hàng */
    public upsertBankCard(ownerZaloId: string, card: {
        id?: number; bank_name: string; bin_bank: number;
        account_number: string; account_name: string; is_default?: number;
    }): number {
        if (!this.initialized) return -1;
        try {
            const now = Date.now();
            // Nếu đặt mặc định → bỏ default của các thẻ khác
            if (card.is_default) {
                this.run(`UPDATE bank_cards SET is_default = 0 WHERE owner_zalo_id = ?`, [ownerZaloId]);
            }
            if (card.id) {
                this.run(
                    `UPDATE bank_cards SET bank_name=?, bin_bank=?, account_number=?, account_name=?, is_default=?, updated_at=?
                     WHERE id=? AND owner_zalo_id=?`,
                    [card.bank_name, card.bin_bank, card.account_number, card.account_name, card.is_default ?? 0, now, card.id, ownerZaloId]
                );
                return card.id;
            } else {
                this.run(
                    `INSERT INTO bank_cards (owner_zalo_id, bank_name, bin_bank, account_number, account_name, is_default, created_at, updated_at)
                     VALUES (?,?,?,?,?,?,?,?)`,
                    [ownerZaloId, card.bank_name, card.bin_bank, card.account_number, card.account_name, card.is_default ?? 0, now, now]
                );
                const row = this.queryOne<any>(`SELECT last_insert_rowid() as id`);
                return row?.id ?? -1;
            }
        } catch (err: any) {
            Logger.error(`[DB] upsertBankCard error: ${err.message}`);
            return -1;
        }
    }

    /** Xóa thẻ ngân hàng */
    public deleteBankCard(ownerZaloId: string, id: number): void {
        if (!this.initialized) return;
        try {
            this.run(`DELETE FROM bank_cards WHERE id = ? AND owner_zalo_id = ?`, [id, ownerZaloId]);
        } catch (err: any) {
            Logger.error(`[DB] deleteBankCard error: ${err.message}`);
        }
    }

    // ─── Local Pinned Conversations ──────────────────────────────────────

    /** Trả về danh sách threadId đang được ghim cục bộ, sắp xếp mới nhất trước. */
    public getLocalPinnedConversations(ownerZaloId: string): string[] {
        if (!this.initialized) return [];
        try {
            const rows = this.query<{ thread_id: string }>(
                `SELECT thread_id FROM local_pinned_conversations WHERE owner_zalo_id = ? ORDER BY pinned_at DESC`,
                [ownerZaloId],
            );
            return rows.map(r => r.thread_id);
        } catch (err: any) {
            Logger.error(`[DB] getLocalPinnedConversations error: ${err.message}`);
            return [];
        }
    }

    /** Ghim hoặc bỏ ghim một hội thoại cục bộ. */
    public setLocalPinnedConversation(ownerZaloId: string, threadId: string, isPinned: boolean): void {
        if (!this.initialized) return;
        try {
            if (isPinned) {
                this.run(
                    `INSERT OR REPLACE INTO local_pinned_conversations (owner_zalo_id, thread_id, pinned_at) VALUES (?,?,?)`,
                    [ownerZaloId, threadId, Date.now()],
                );
            } else {
                this.run(
                    `DELETE FROM local_pinned_conversations WHERE owner_zalo_id = ? AND thread_id = ?`,
                    [ownerZaloId, threadId],
                );
            }
        } catch (err: any) {
            Logger.error(`[DB] setLocalPinnedConversation error: ${err.message}`);
        }
    }
}

export default DatabaseService;

