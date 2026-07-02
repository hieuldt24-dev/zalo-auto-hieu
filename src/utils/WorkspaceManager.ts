import * as path from 'path';
import * as fs from 'fs';
import { app } from 'electron';
import Logger from './Logger';

export interface Workspace {
    id: string;
    name: string;
    type: 'local' | 'remote';
    icon?: string;
    createdAt: number;
    dbPath?: string;
    relayEnabled?: boolean;
    relayPort?: number;
    relayAutoStart?: boolean;
    bossUrl?: string;
    token?: string;
    employeeId?: string;
    employeeName?: string;
    employeeUsername?: string;
    autoConnect?: boolean;
    lastSyncTs?: number;
    cachedPermissions?: Array<{ module: string; can_access: boolean }>;
    cachedAssignedAccounts?: string[];
    cachedErpRole?: string;
    cachedErpExtraJson?: string;
    cachedEmployeesData?: any[];
    cachedAccountsData?: any[];
}

const DEFAULT_WORKSPACE_ID = 'default';
const DEFAULT_DB_NAME = 'deplao-tool.db';

class WorkspaceManager {
    private static instance: WorkspaceManager;
    private userDataPath = '';
    private initialized = false;

    private readonly defaultWorkspace: Workspace = {
        id: DEFAULT_WORKSPACE_ID,
        name: 'Mac dinh',
        type: 'local',
        icon: 'home',
        createdAt: 0,
        dbPath: DEFAULT_DB_NAME,
        relayEnabled: false,
        relayPort: 9900,
    };

    public static getInstance(): WorkspaceManager {
        if (!WorkspaceManager.instance) {
            WorkspaceManager.instance = new WorkspaceManager();
        }
        return WorkspaceManager.instance;
    }

    public initialize(): void {
        if (this.initialized) return;
        this.userDataPath = app.getPath('userData');
        this.initialized = true;
        Logger.log('[WorkspaceManager] Workspace feature disabled; using legacy single database mode.');
    }

    public listWorkspaces(): Workspace[] {
        return [{ ...this.defaultWorkspace }];
    }

    public getWorkspaceById(id: string): Workspace | undefined {
        return id === DEFAULT_WORKSPACE_ID ? { ...this.defaultWorkspace } : undefined;
    }

    public createWorkspace(..._args: any[]): { success: boolean; workspace?: Workspace; error?: string } {
        return { success: false, error: 'Chuc nang workspace da duoc tat' };
    }

    public updateWorkspace(..._args: any[]): { success: boolean; error?: string } {
        return { success: false, error: 'Chuc nang workspace da duoc tat' };
    }

    public deleteWorkspace(..._args: any[]): { success: boolean; error?: string } {
        return { success: false, error: 'Chuc nang workspace da duoc tat' };
    }

    public getActiveWorkspace(): Workspace {
        return { ...this.defaultWorkspace };
    }

    public getActiveWorkspaceId(): string {
        return DEFAULT_WORKSPACE_ID;
    }

    public switchWorkspace(id: string): { success: boolean; workspace?: Workspace; error?: string } {
        if (id === DEFAULT_WORKSPACE_ID) {
            return { success: true, workspace: this.getActiveWorkspace() };
        }
        return { success: false, error: 'Chuc nang workspace da duoc tat' };
    }

    public restoreActiveWorkspace(id: string): { success: boolean; workspace?: Workspace; error?: string } {
        return this.switchWorkspace(id);
    }

    public onWorkspaceSwitch(): () => void {
        return () => {};
    }

    public resolveDbPath(relativeDbPath: string): string {
        let dbFolder = this.userDataPath || app.getPath('userData');
        const deplaoConfigPath = path.join(dbFolder, 'deplao-config.json');
        if (fs.existsSync(deplaoConfigPath)) {
            try {
                const cfg = JSON.parse(fs.readFileSync(deplaoConfigPath, 'utf-8'));
                if (cfg.dbFolder && fs.existsSync(cfg.dbFolder)) {
                    dbFolder = cfg.dbFolder;
                }
            } catch { /* ignore invalid legacy config */ }
        }
        return path.join(dbFolder, relativeDbPath || DEFAULT_DB_NAME);
    }

    public getActiveDbPath(): string {
        return this.resolveDbPath(DEFAULT_DB_NAME);
    }

    public resolveMediaPath(): string {
        return path.join(path.dirname(this.getActiveDbPath()), 'media');
    }

    public getActiveMediaPath(): string {
        return this.resolveMediaPath();
    }

    public getActiveModeType(): 'standalone' | 'boss' | 'employee' {
        return 'standalone';
    }

    public isActiveRemote(): boolean {
        return false;
    }

    public isMultiWorkspace(): boolean {
        return false;
    }

    public getAutoConnectRemotes(): Workspace[] {
        return [];
    }

    public getUserDataPath(): string {
        return this.userDataPath || app.getPath('userData');
    }
}

export default WorkspaceManager;
