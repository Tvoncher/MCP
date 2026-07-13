import { readFileSync, writeFileSync, existsSync } from 'fs-extra';
import { join } from 'path';

// @ts-ignore
import packageJSON from '../../package.json';


export class UtcpConfigManager {
    private static instance: UtcpConfigManager;
    private configPath: string = '';

    private constructor() {}

    static getInstance(): UtcpConfigManager {
        if (!UtcpConfigManager.instance) {
            UtcpConfigManager.instance = new UtcpConfigManager();
        }
        return UtcpConfigManager.instance;
    }

    async initialize(): Promise<void> {
        const savedPath = await Editor.Profile.getConfig(packageJSON.name, 'utcpConfigPath');
        if (savedPath && typeof savedPath === 'string') {
            this.configPath = savedPath;
        } else {
            this.configPath = this.getDefaultConfigPath();
        }
        console.log(`[UtcpConfigManager] Initialized with config path: ${this.configPath}`);
    }

    getConfigPath(): string {
        if (!this.configPath) {
            this.configPath = this.getDefaultConfigPath();
        }
        return this.configPath;
    }

    // The UTCP config lives beside the extension so a global install is fully self-contained
    // and needs no per-machine edits. This module compiles to <ext>/dist/utcp/config-manager.js,
    // so '../..' resolves to the extension root on any machine/user (no username literal).
    // (Alternative: Editor.Package.getPackages({ name })[0].path — depth-independent.)
    private getDefaultConfigPath(): string {
        const extensionRoot = join(__dirname, '..', '..');
        return join(extensionRoot, '.utcp_config.json').replace(/\\/g, '/');
    }

    // Writes a ready-to-use .mcp.json into the current project root so any agent opened in
    // that project auto-discovers the server with no manual setup. Always overwrites: the file
    // may already exist with a stale UTCP_CONFIG_FILE path. The UTCP_CONFIG_FILE value is the
    // runtime-resolved config path (beside the extension), so it is correct on any machine/user.
    writeProjectMcpConfig(): void {
        const projectPath = Editor.Project.path;
        if (!projectPath) {
            console.warn('[UtcpConfigManager] No project path available; skipping .mcp.json');
            return;
        }

        // npx is a shell script on Windows, so it must be launched via `cmd /c`; on macOS/Linux
        // it is executable directly. Keeps the generated config cross-platform.
        const isWindows = process.platform === 'win32';
        const mcpConfig = {
            mcpServers: {
                'code-mode': {
                    type: 'stdio',
                    command: isWindows ? 'cmd' : 'npx',
                    args: isWindows
                        ? ['/c', 'npx', '@utcp/code-mode-mcp']
                        : ['@utcp/code-mode-mcp'],
                    env: {
                        UTCP_CONFIG_FILE: this.getConfigPath().replace(/\\/g, '/'),
                    },
                },
            },
        };

        const mcpPath = join(projectPath, '.mcp.json');
        try {
            writeFileSync(mcpPath, JSON.stringify(mcpConfig, null, 2));
            console.log(`[UtcpConfigManager] Wrote MCP config to ${mcpPath}`);
        } catch (e) {
            console.error('[UtcpConfigManager] Failed to write .mcp.json:', e);
        }
    }

    async setConfigPath(path: string): Promise<void> {
        this.configPath = path;
        await Editor.Profile.setConfig(packageJSON.name, 'utcpConfigPath', path);
        console.log(`[UtcpConfigManager] Config path updated to: ${path}`);
    }

    readConfig(): any {
        const path = this.getConfigPath();
        if (path && existsSync(path)) {
            try {
                const content = readFileSync(path, 'utf-8');
                return JSON.parse(content);
            } catch (e) {
                console.error('[UtcpConfigManager] Failed to parse UTCP config:', e);
                return { manual_call_templates: [] };
            }
        }
        return { manual_call_templates: [] };
    }

    writeConfig(config: any): void {
        const path = this.getConfigPath();
        if (!path) {
            console.error('[UtcpConfigManager] Config path is not set');
            return;
        }
        try {
            writeFileSync(path, JSON.stringify(config, null, 2));
            console.log(`[UtcpConfigManager] Saved UTCP config to ${path}`);
        } catch (e) {
            console.error('[UtcpConfigManager] Failed to write UTCP config:', e);
        }
    }

    async ensureCocosEditorTemplate(port: number): Promise<boolean> {
        if (!port || port <= 0) {
            console.warn('[UtcpConfigManager] Invalid port provided:', port);
            return false;
        }

        const expectedUrl = `http://localhost:${port}/utcp`;
        const config = this.readConfig();

        if (!config.manual_call_templates) {
            config.manual_call_templates = [];
        }

        const templates = config.manual_call_templates;
        const idx = templates.findIndex((t: any) => t.name === 'CocosEditor');

        let changed = false;
        if (idx === -1) {
            templates.push({
                name: 'CocosEditor',
                call_template_type: 'http',
                url: expectedUrl,
                http_method: 'GET',
                content_type: 'application/json',
            });
            changed = true;
            console.log(`[UtcpConfigManager] Created CocosEditor template with port ${port}`);
        } else {
            if (templates[idx].url !== expectedUrl) {
                templates[idx].url = expectedUrl;
                changed = true;
                console.log(`[UtcpConfigManager] Updated CocosEditor template port to ${port}`);
            }
        }

        if (changed) {
            this.writeConfig(config);
        }

        return changed;
    }

    async getCurrentPort(): Promise<number> {
        const port = await Editor.Profile.getConfig(packageJSON.name, 'serverPort');
        return typeof port === 'number' ? port : 0;
    }

    async updatePort(port: number): Promise<void> {
        await Editor.Profile.setConfig(packageJSON.name, 'serverPort', port);
        await this.ensureCocosEditorTemplate(port);
    }
}

export function getConfigManager(): UtcpConfigManager {
    return UtcpConfigManager.getInstance();
}
