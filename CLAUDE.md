# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`cocos-code-mode` is a Cocos Creator editor extension (package name in `package.json`: `cocos-code-mode`). It runs an Express HTTP server inside the Creator editor process and exposes scene manipulation, component/asset inspection, and asset management as [UTCP](https://www.utcp.io/) tools. External AI agents (via the UTCP Code Mode MCP server, or any UTCP client) call these tools over HTTP to build/inspect/modify a Cocos Creator project the same way a developer would through the editor UI.

Read `README.md` for the external-facing architecture explanation (discover-then-act pattern, tool categories, instance references, TypeScript definition generation) — it's accurate and detailed, not duplicated here.

## Build & run

- `npm run build` — `tsc` compile `source/` → `dist/` (per `tsconfig.json`, `rootDir: source`, `outDir: dist`).
- `npm run package` — builds, then zips `@types`, `dist`, `i18n`, `node_modules`, `static`, `package.json`, `package-lock.json`, `README.md` into `cocos-code-mode.zip` (via `scripts/package.js`) for import into Creator's Extension Manager.
- `preinstall` (runs automatically on `npm i`) — `scripts/preinstall.js` checks the installed `@cocos/creator-types` devDependency version against what's published on npm and warns if the editor version's type defs haven't been released yet (in which case they must be exported manually from Creator via **Developer → Export Interface Definition**).
- There is no test suite and no lint script configured in `package.json`.
- This is not a standalone Node app — `dist/main.js` only runs loaded as an extension inside the Cocos Creator editor (it depends on the global `Editor` API from `@cocos/creator-types/editor`). You cannot "run" it directly; verify changes by building and reloading the extension in Creator, or by reasoning about the `Editor.Message.request` calls being made.

## Architecture

### Entry points (`source/main.ts`, `source/scene.ts`)

- `main.ts` — the editor-process extension entry (`load`/`unload`/`methods`). On `load()`, it initializes the `UtcpConfigManager`, starts `UtcpServerManager` on a port persisted in `Editor.Profile` (0 = auto-assign), and writes/updates a `CocosEditor` entry in the UTCP config file (default `.utcp_config.json` beside the extension, resolved at runtime from `__dirname`) pointing at that port. Exposes `restartServer` for the configuration panel.
- `scene.ts` — the scene-process script (registered via `contributions.scene` in `package.json`). Runs inside the actual scene runtime context (has access to `cce`/`cc` globals), unlike `main.ts` which runs in the editor process. Tools that need scene-runtime access (prefab creation/apply/unwrap, screenshot capture, log catching) call into this via `Editor.Message.request('scene', 'execute-scene-script', { name: packageJSON.name, method: '...' })` — see the pattern in `source/utcp/tools/scene-tools.ts`'s `nodeOperate`.

### Tool registration (`source/utcp/decorators.ts`, `source/utcp/utcp-server.ts`)

- Tools are plain class methods decorated with `@utcpTool(name, description, inputSchema, outputSchema, httpMethod, tags)`. The decorator registers metadata (method, target class, UTCP `Tool` definition) into the static `ToolRegistry`.
- `UtcpServerManager` (`utcp-server.ts`) builds the Express app: on `start()`, it listens first (to resolve an auto-assigned port), then calls `registerTools()`, which instantiates one singleton per tool class, wires each tool's HTTP method/path (`/tools/<name>`) to a handler that calls the decorated method with `req.query` as args, and serves the full UTCP manual (tool list) at `GET /utcp`.
- All tool inputs currently arrive via query string (even for POST/PUT/DELETE) — note the custom query parser in `start()` that coerces `"true"`/`"false"`/numeric strings/`"__null__"` into real types.
- **Adding a new tool**: implement it as a `@utcpTool`-decorated async method on a class in `source/utcp/tools/`, then import that file (for side-effect registration) in `utcp-server.ts` alongside the existing tool imports. No other registration step needed.

### Tool modules (`source/utcp/tools/`)

- `scene-tools.ts` — scene hierarchy: get tree, get node at path, create node/primitive, move/copy/delete, and prefab operations (create/revert/apply/unwrap/open), all via `Editor.Message.request('scene', ...)`.
- `component-tools.ts` — attach/remove/list components, discover available component types.
- `get-properties-tool.ts` / `set-properties-tool.ts` — generic instance property read/write for nodes, components, assets, and the two special settings pseudo-instances (`CurrentSceneGlobals`, `ProjectSettings`).
- `typescript-defenition.ts` (`GetClassInfoTool`) — generates a synthetic TypeScript class definition string from a live property dump (`inspectorGetInstanceDefinition` / `inspectorGetSettingsDefinition`), so an AI agent can learn the real shape of a Node/Component/Asset/settings type before writing property paths. Includes a hardcoded `_commonTypesDefinition` for Cocos math types (Vec2/3/4, Color, Rect, Quat, Mat3/4, Gradient).
- `asset-tools.ts` — browse/create/import/operate on project assets, get previews.
- `editor-tools.ts` — editor-level operations (logs, scene preview capture, etc.), typically proxying to `scene.ts` scene-process methods.

Write tools generally end with `await Editor.Message.request('scene', 'snapshot')` to register the change as an undoable editor step — preserve that pattern when adding new mutating tools.

### Instance references and property dumps (`source/utcp/schemas.ts`, `source/utcp/utils/tools-utils.ts`)

- Every node/component/asset is passed across the tool boundary as a lightweight `IInstanceReference = { id: string, type?: string }` (UUID-based handle), never a full object.
- `ToolsUtils.inspectInstance(targetId)` is the central dispatcher for turning a reference (or the special ids `'CurrentSceneGlobals'` / `'ProjectSettings'`) into a normalized `{ uuid, type, props, assetInfo }` shape, trying node → component → asset lookups in order. It's the shared foundation for both the property-get/set tools and the TypeScript-definition generator.
- `ToolsUtils.unwrapProperties()` converts the editor's raw `IProperty`-wrapped dump (`{ value, default, type, visible, ... }` per field) into a plain JS object, handling nested structs/arrays and hidden (`visible: false`) fields.

### Asset importers (`source/utcp/utils/asset-importers/`)

- `ImporterManager` is a registry (singleton) of `IAssetImporter` implementations, one per Cocos asset importer name (`material`, `texture`, `sprite-frame`, `prefab`, `fbx`, `gltf`, `script`, `directory`, `project-settings`, etc. — one file each in this directory).
- `BaseAssetImporter` is the abstract base: each importer implements `getProperties(assetInfo)` (required) and optionally `setProperty(assetInfo, path, value)`. `registerAllImporters()` (called once in `UtcpServerManager`'s constructor) wires them all into the shared `ImporterManager` instance.
- Asset-type-specific property inspection/editing (via the generic get/set property tools and the definition generator) is dispatched through whichever importer matches `assetInfo.importer` — this is the extension point for supporting a new asset type's structured properties.

### Panels (`source/panels/`, `static/`)

- Two dockable editor panels declared in `package.json` (`contributions`/`panels`): **Configuration** (server port, UTCP config path, call template management) and **Asset Preview**. Each panel's TS entry is in `source/panels/<name>/index.ts`, with matching HTML/CSS under `static/template/<name>/` and `static/style/<name>/`.

### Config management (`source/utcp/config-manager.ts`)

- `UtcpConfigManager` (singleton) owns reading/writing the UTCP config JSON file (default `.utcp_config.json` beside the extension, resolved from `__dirname` so a global install is self-contained; an override path is persisted per-project via `Editor.Profile`). `ensureCocosEditorTemplate(port)` keeps a `CocosEditor` HTTP call template in that file in sync with whatever port the server actually bound to (ports are often auto-assigned, so this runs on every start/restart).

## Agent operating rules (from `prompt_example.md`)

`prompt_example.md` is a reference system prompt for AI agents *using* this extension's tools (not for developing the extension itself) — useful context if you're asked to reason about how an agent should call these tools:
- Scene/prefab files (`.scene`, `.prefab`) and material/shader/asset config files (`.mat`, `.shader`, `.asset`, `.anim`, `.spriteatlas`, etc.) must go through the UTCP/MCP tools, never be edited directly.
- Plain code/config files (`.cs`, `.ts`, `.json`, `.asmdef`, `.asmref`) can be edited directly.
- `.meta` files are always Cocos-editor-managed; never create/edit/delete them by hand.
