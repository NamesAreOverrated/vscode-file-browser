// --- START OF FILE extension.ts ---
import * as vscode from "vscode";
import { Uri, FileType, QuickInputButton, ThemeIcon, ViewColumn, DocumentSymbol } from "vscode";
import * as OS from "os";
import * as OSPath from "path";

import { Result, None, Option, Some } from "@bodil/opt";
import { Path } from "./path";
import { Rules } from "./filter";
import { FileItem, fileRecordCompare, itemIsDir } from "./fileitem";
import { action, Action } from "./action";

// ================= 工具函数 =================

function expandBraces(str: string): string[] {
    const results: string[] = [];
    const match = str.match(/^(.*?)\{([^}]+)\}(.*)$/);
    if (match) {
        const parts = match[2].split(',');
        for (const p of parts) {
            results.push(...expandBraces(match[1] + p + match[3]));
        }
    } else {
        results.push(str);
    }
    return results;
}

function splitArgs(str: string): string[] {
    const regex = /[^\s"']+|"([^"]*)"|'([^']*)'/g;
    const result: string[] = [];
    let match;
    while ((match = regex.exec(str)) !== null) {
        result.push(match[1] || match[2] || match[0]);
    }
    return result;
}

function applyWildcard(name: string, from: string, to: string): string | null {
    if (!from.includes('*')) return name === from ? to : null;
    const escapedFrom = from.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
    const regexStr = '^' + escapedFrom.replace(/\*/g, '(.*)') + '$';
    const regex = new RegExp(regexStr);
    const match = name.match(regex);
    if (!match) return null;

    let result = '';
    let groupIndex = 1;
    for (let i = 0; i < to.length; i++) {
        if (to[i] === '*') {
            if (groupIndex < match.length) result += match[groupIndex++];
        } else {
            result += to[i];
        }
    }
    return result;
}

async function expandPathWildcards(baseUri: Uri, pattern: string, mustExist: boolean, onlyDirs: boolean = false): Promise<{ name: string, uri: Uri }[]> {
    const segments = pattern.split('/').filter(s => s.length > 0);
    let currentPaths: { name: string, uri: Uri }[] = [{ name: "", uri: baseUri }];

    for (let i = 0; i < segments.length; i++) {
        const seg = segments[i];
        const isLastSegment = i === segments.length - 1;
        const nextPathsMap = new Map<string, { name: string, uri: Uri }>();

        for (const cur of currentPaths) {
            if (seg === '**') {
                async function collectDirs(u: Uri, rel: string, depth: number) {
                    if (depth > 5) return;
                    const key = u.toString();
                    if (!nextPathsMap.has(key)) nextPathsMap.set(key, { name: rel, uri: u });
                    try {
                        const entries = await vscode.workspace.fs.readDirectory(u);
                        for (const [n, t] of entries) {
                            if (t & FileType.Directory) await collectDirs(Uri.joinPath(u, n), rel ? `${rel}/${n}` : n, depth + 1);
                        }
                    } catch { }
                }
                await collectDirs(cur.uri, cur.name, 0);
            } else if (seg.includes('*') || seg.includes('?')) {
                try {
                    const entries = await vscode.workspace.fs.readDirectory(cur.uri);
                    const regexStr = '^' + seg.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$';
                    const regex = new RegExp(regexStr, 'i');

                    for (const [name, type] of entries) {
                        if (regex.test(name)) {
                            const isDir = !!(type & FileType.Directory);
                            if (!isLastSegment && !isDir) continue;
                            if (isLastSegment && onlyDirs && !isDir) continue;

                            const nextUri = Uri.joinPath(cur.uri, name);
                            nextPathsMap.set(nextUri.toString(), { name: cur.name ? `${cur.name}/${name}` : name, uri: nextUri });
                        }
                    }
                } catch (e) { }
            } else {
                const nextUri = Uri.joinPath(cur.uri, seg);
                const nextName = cur.name ? `${cur.name}/${seg}` : seg;
                try {
                    const stat = await vscode.workspace.fs.stat(nextUri);
                    const isDir = !!(stat.type & FileType.Directory);
                    if (isLastSegment && onlyDirs && !isDir) continue;
                    nextPathsMap.set(nextUri.toString(), { name: nextName, uri: nextUri });
                } catch {
                    if (!mustExist) nextPathsMap.set(nextUri.toString(), { name: nextName, uri: nextUri });
                }
            }
        }
        currentPaths = Array.from(nextPathsMap.values());
        if (currentPaths.length === 0) break;
    }
    return currentPaths.filter(p => p.name !== "");
}

// ================= 配置与上下文 =================

export enum ConfigItem {
    RemoveIgnoredFiles = "removeIgnoredFiles",
    HideDotfiles = "hideDotfiles",
    HideIgnoreFiles = "hideIgnoredFiles",
    IgnoreFileTypes = "ignoreFileTypes",
    LabelIgnoredFiles = "labelIgnoredFiles",
}

export function config<A>(item: ConfigItem): A | undefined {
    return vscode.workspace.getConfiguration("file-browser").get(item);
}

let active: Option<FileBrowser> = None;

function setContext(state: boolean) {
    vscode.commands.executeCommand("setContext", "inFileBrowser", state);
}

// ======== 新架构：视图状态定义 ========
interface ViewState {
    path: Path;
    file: Option<string>;
    inActions: boolean;
    inputValue: string;
    cachedItems: FileItem[];
}

interface AutoCompletion {
    index: number;
    items: FileItem[];
}

class FileBrowser {
    current: vscode.QuickPick<FileItem>;

    // 核心状态
    path: Path;
    file: Option<string>;
    items: FileItem[] = [];
    inActions: boolean = false;

    // 视图路由历史栈 (解决深层嵌套退出的终极方案)
    stateStack: ViewState[] = [];
    private isRestoringState = false;

    pathHistory: { [path: string]: Option<string> };
    keepAlive: boolean = false;
    autoCompletion?: AutoCompletion;

    editorUri?: Uri;
    private searchToken = 0;
    private searchTimeout?: NodeJS.Timeout;

    actionsButton: QuickInputButton = { iconPath: new ThemeIcon("ellipsis"), tooltip: "Actions on selected file" };
    stepOutButton: QuickInputButton = { iconPath: new ThemeIcon("arrow-left"), tooltip: "Step out of folder" };
    stepInButton: QuickInputButton = { iconPath: new ThemeIcon("arrow-right"), tooltip: "Step into folder" };

    constructor(path: Path, file: Option<string>) {
        this.path = path;
        this.file = file;
        this.pathHistory = { [this.path.id]: this.file };

        const editor = vscode.window.activeTextEditor;
        if (editor) this.editorUri = editor.document.uri;

        this.current = vscode.window.createQuickPick();
        this.current.buttons = [this.actionsButton, this.stepOutButton, this.stepInButton];
        this.current.placeholder = "Preparing the file list...";

        this.current.onDidHide(() => { if (!this.keepAlive) this.dispose(); });
        this.current.onDidAccept(this.onDidAccept.bind(this));
        this.current.onDidChangeValue(this.onDidChangeValue.bind(this));
        this.current.onDidTriggerButton(this.onDidTriggerButton.bind(this));

        this.update().then(() => {
            this.current.placeholder = "Type a file name, paths (e.g. a/b.js), or commands (*, d:, r:)";
            this.current.busy = false;
        });
    }

    // ================= 核心架构：视图状态管理 =================

    /** 压栈：进入下一个视图前，保存当前视图上下文 */
    private pushState() {
        this.stateStack.push({
            path: this.path.clone(),
            file: this.activeItem().map(i => i.name),
            inActions: this.inActions,
            inputValue: this.current.value,
            cachedItems: [...this.items]
        });
    }

    /** 弹栈：退出当前视图，恢复上级上下文 (如退回全局搜索结果) */
    private async popState() {
        const prevState = this.stateStack.pop();
        if (!prevState) return;

        this.path = prevState.path;
        this.file = prevState.file;
        this.inActions = prevState.inActions;

        // 屏蔽由代码引发的 onDidChangeValue，防止重置搜素状态和闪烁
        this.isRestoringState = true;
        this.current.value = prevState.inputValue;
        this.isRestoringState = false;

        if (prevState.inputValue === "") {
            // 普通目录浏览返回，完全刷新获取最新文件状态
            await this.update();
        } else {
            // 搜索界面返回，直接恢复缓存结果，体验极佳
            this.items = prevState.cachedItems;
            this.current.items = this.items;

            prevState.file.ifSome(f => {
                this.current.activeItems = this.items.filter(i => i.name === f);
            })
        }
    }

    // ================= UI 生命周期与事件 =================

    dispose() {
        setContext(false);
        this.current.dispose();
        active = None;
    }

    hide() { this.current.hide(); setContext(false); }
    show() { setContext(true); this.current.show(); }

    activeItem(): Option<FileItem> {
        return Option.from(this.current.activeItems[0]);
    }

    onDidTriggerButton(button: QuickInputButton) {
        if (button === this.stepInButton) this.stepIn();
        else if (button === this.stepOutButton) this.stepOut();
        else if (button === this.actionsButton) this.actions();
    }

    async update() {
        this.current.show();
        this.current.busy = true;
        this.current.title = this.path.fsPath;

        // 此处只在非恢复状态下清理值
        if (!this.isRestoringState) {
            this.current.value = "";
        }

        const stat = (await Result.await(vscode.workspace.fs.stat(this.path.uri))).unwrap();
        if (stat && this.inActions && (stat.type & FileType.File) === FileType.File) {
            this.items = [
                action("$(file) Open this file", Action.OpenFile),
                action("$(split-horizontal) Open this file to the side", Action.OpenFileBeside),
                action("$(edit) Rename this file", Action.RenameFile),
                action("$(trash) Delete this file", Action.DeleteFile),
            ];
        } else if (stat && this.inActions && (stat.type & FileType.Directory) === FileType.Directory) {
            this.items = [
                action("$(folder-opened) Open this folder", Action.OpenFolder),
                action("$(folder-opened) Open this folder in a new window", Action.OpenFolderInNewWindow),
                action("$(edit) Rename this folder", Action.RenameFile),
                action("$(trash) Delete this folder", Action.DeleteFile),
            ];
        } else if (stat && (stat.type & FileType.Directory) === FileType.Directory) {
            const records = await vscode.workspace.fs.readDirectory(this.path.uri);
            records.sort(fileRecordCompare);
            let items = records.map((entry) => new FileItem(entry));
            if (config(ConfigItem.HideIgnoreFiles)) {
                const rules = await Rules.forPath(this.path);
                items = rules.filter(this.path, items);
            }
            if (config(ConfigItem.RemoveIgnoredFiles)) {
                items = items.filter((item) => item.alwaysShow);
            }
            this.items = items;
        } else {
            this.items = [action("$(new-folder) Create this folder", Action.NewFolder)];
        }

        this.current.items = this.items;
        this.current.activeItems = this.items.filter((item) => this.file.value === item.name);
        this.current.enabled = true;
        this.current.busy = false;
    }

    // ================= 路由与导航 (Navigation) =================

    async stepIn() {
        // 修改这里：使用 ifSome 处理 Option
        this.activeItem().ifSome(async (item) => {
            // 1. 如果是具体的动作且不是“创建预览项”，直接执行
            // 注意：通过判断 payload.name 是否存在来区分“创建预览项”和“普通动作”
            if (item.action !== undefined && !(item.payload && item.payload.name)) {
                this.runAction(item);
                return;
            }

            // 2. 压栈并转入新视图
            this.pushState();

            if (item.fileType !== undefined) {
                if ((item.fileType & FileType.Directory) === FileType.Directory) {
                    if (item.payload && item.payload.scheme) this.path = new Path(item.payload);
                    else this.path.push(item.name);
                    this.inActions = false;
                    await this.update();
                } else if ((item.fileType & FileType.File) === FileType.File) {
                    if (item.payload && item.payload.scheme) this.path = new Path(item.payload);
                    else this.path.push(item.name);
                    this.file = None;
                    this.inActions = true;
                    await this.update();
                }
            }
        });
    }

    async stepOut() {
        // 如果历史栈有记录，优先弹栈返回上一级（解决搜索页面的退出问题）
        if (this.stateStack.length > 0) {
            await this.popState();
            return;
        }

        // 兜底逻辑：到达文件树顶层提示，否则向上一级目录跳转
        const folders = vscode.workspace.workspaceFolders;
        if (folders && folders.some(f => f.uri.fsPath === this.path.uri.fsPath)) {
            vscode.window.showInformationMessage("You are at the root of the workspace.");
            return;
        }

        if (!this.path.atTop()) {
            this.pathHistory[this.path.id] = this.activeItem().map((item) => item.name);
            this.file = this.path.pop();
            this.inActions = false;
            await this.update();
        }
    }

    async actions() {
        if (this.inActions) return;
        this.pushState();

        this.inActions = true;
        this.file = None;

        this.activeItem().ifSome(item => {
            if (item.payload && item.payload.scheme) this.path = new Path(item.payload);
            else this.path.push(item.name);
        });

        await this.update();
    }

    onDidAccept() {
        this.autoCompletion = undefined;
        this.activeItem().ifSome((item) => {
            if (item.action !== undefined) {
                this.runAction(item);
            } else if (item.fileType !== undefined && (item.fileType & FileType.Directory) === FileType.Directory) {
                this.stepIn();
            } else {
                if (item.payload?.scheme) this.openFile(item.payload);
                else this.openFile(this.path.append(item.name).uri);
            }
        });
    }

    // ================= 搜索与输入处理 (Input Handlers) =================

    async onDidChangeValue(value: string, isAutoComplete = false) {
        if (this.isRestoringState || this.inActions) return;
        if (!isAutoComplete) this.autoCompletion = undefined;

        if (this.searchTimeout) {
            clearTimeout(this.searchTimeout);
            this.searchTimeout = undefined;
        }
        if (value === "") {
            this.current.items = this.items;
            this.current.activeItems = [];
            return;
        }

        // 命令前缀分发
        if (value.startsWith("@")) return this.handleSymbolSearch(value.substring(1));
        if (value.startsWith(":")) return this.handleLineSearch(value.substring(1));
        if (value.startsWith("!")) return this.debounce(() => this.handleGlobalFileSearch(value.substring(1)));
        if (value.startsWith("#")) return this.debounce(() => this.handleGlobalFolderSearch(value.substring(1)));

        if (value.match(/^[rdcm]:/)) {
            const m: { [k: string]: Action } = { 'r': Action.BulkRename, 'd': Action.BulkDelete, 'c': Action.BulkCopy, 'm': Action.BulkMove };
            return this.debounce(() => this.handleBulkOp(value.substring(2), m[value[0]]));
        }

        if (value.includes("{") || value.includes("*") || value.includes("?")) {
            return this.debounce(() => this.handleGlobAndCreateSearch(value));
        }

        if (value.includes("/")) {
            return this.debounce(() => this.handlePathSearch(value), 100);
        }

        // 普通字符过滤
        const query = value.toLowerCase();
        let displayItems = this.items.filter((item) => {
            if (item.action !== undefined && item.action !== Action.OpenFile) return true;
            return item.name.toLowerCase().includes(query);
        });

        if (!this.items.find((item) => item.name === value)) {
            displayItems = [{
                label: `$(new-file) Create: ${value}`, name: value, description: "Open as new file",
                alwaysShow: true, action: Action.OpenFile
            } as FileItem, ...displayItems];
        }

        this.current.items = displayItems;
        if (displayItems.length > 0) this.current.activeItems = [displayItems[0]];
    }

    private debounce(func: () => void | Promise<void>, delay: number = 250) {
        this.searchTimeout = setTimeout(async () => {
            await func();
        }, delay);
    }

    async handlePathSearch(value: string) { /* 保留原有逻辑 */
        const token = ++this.searchToken;
        this.current.busy = true;

        const parts = value.split('/');
        const searchName = parts.pop()!.toLowerCase();
        const dirPath = parts.join('/');

        let displayItems: FileItem[] = [];

        try {
            const targetDirUri = this.path.append(...dirPath.split('/')).uri;
            const stat = await vscode.workspace.fs.stat(targetDirUri);

            if ((stat.type & FileType.Directory) === FileType.Directory) {
                const entries = await vscode.workspace.fs.readDirectory(targetDirUri);
                const matched = entries
                    .filter(([name]) => name.toLowerCase().includes(searchName))
                    .map(([name, type]) => new FileItem([dirPath === "" ? name : `${dirPath}/${name}`, type]));
                displayItems.push(...matched);
            }
        } catch (e) { }

        if (this.searchToken !== token) return;

        const exactItem = {
            label: `$(go-to-file) Open / Create Path: ${value}`, name: value,
            description: "Will create missing directories automatically", alwaysShow: true, action: Action.OpenFile,
        } as FileItem;

        this.current.items = [exactItem, ...displayItems];
        if (this.current.items.length > 0) this.current.activeItems = [this.current.items[0]];
        this.current.busy = false;
    }

    async handleSymbolSearch(query: string) { /* 保留原有逻辑 */
        if (!this.editorUri) {
            this.current.items = [{ label: "No active file to search symbols...", name: "", alwaysShow: true } as FileItem];
            return;
        }

        const token = ++this.searchToken;
        this.current.busy = true;

        try {
            const symbols = await vscode.commands.executeCommand<DocumentSymbol[]>('vscode.executeDocumentSymbolProvider', this.editorUri);
            if (this.searchToken !== token) return;

            if (!symbols) {
                this.current.items = [{ label: "No symbols found.", name: "", alwaysShow: true } as FileItem];
                return;
            }

            const flatSymbols: DocumentSymbol[] = [];
            const extract = (syms: DocumentSymbol[]) => {
                for (const s of syms) {
                    flatSymbols.push(s);
                    if (s.children) extract(s.children);
                }
            };
            extract(symbols);

            const q = query.trim().toLowerCase();
            const filtered = flatSymbols.filter(s => s.name.toLowerCase().includes(q));

            this.current.items = filtered.map(s => ({
                label: `$(symbol-method) ${s.name}`, name: s.name, description: `Line ${s.range.start.line + 1}`,
                alwaysShow: true, action: Action.GoToSymbol, payload: { uri: this.editorUri, range: s.range }
            } as FileItem));
        } catch (e) { } finally {
            if (this.searchToken === token) this.current.busy = false;
        }
    }

    handleLineSearch(query: string) { /* 保留原有逻辑 */
        const line = parseInt(query.trim(), 10);
        if (isNaN(line)) {
            this.current.items = [{ label: "Type a line number...", name: "", alwaysShow: true } as FileItem];
            return;
        }
        this.current.items = [{
            label: `$(go-to-file) Go to line ${line}`, name: query, alwaysShow: true, action: Action.GoToLine, payload: line
        } as FileItem];
    }

    async handleGlobalFileSearch(query: string) {
        query = query.trim();
        if (query.length < 2) {
            this.current.items = [{ label: "Type at least 2 chars to search...", name: "", alwaysShow: true } as FileItem];
            return;
        }
        const token = ++this.searchToken;
        this.current.busy = true;
        try {
            const files = await vscode.workspace.findFiles(`**/*${query}*`, '**/node_modules/**', 50);
            if (this.searchToken !== token) return;
            this.current.items = files.map(uri => ({
                label: `$(file) ${OSPath.basename(uri.fsPath)}`, description: vscode.workspace.asRelativePath(uri),
                name: OSPath.basename(uri.fsPath), alwaysShow: true, payload: uri, fileType: FileType.File,
            } as FileItem));
        } catch (e) { } finally {
            if (this.searchToken === token) this.current.busy = false;
        }
    }

    async handleGlobalFolderSearch(query: string) {
        query = query.trim();
        if (query.length < 1) {
            this.current.items = [{ label: "Type to search folders globally...", name: "", alwaysShow: true } as FileItem];
            return;
        }
        const token = ++this.searchToken;
        this.current.busy = true;
        try {
            const files = await vscode.workspace.findFiles(`**/*${query}*/**`, '**/node_modules/**', 200);
            if (this.searchToken !== token) return;

            const dirSet = new Set<string>();
            const dirs: Uri[] = [];
            for (const f of files) {
                const dirUri = Uri.joinPath(f, '..');
                if (!dirSet.has(dirUri.fsPath)) { dirSet.add(dirUri.fsPath); dirs.push(dirUri); }
            }
            this.current.items = dirs.map(uri => ({
                label: `$(folder) ${OSPath.basename(uri.fsPath)}`, description: vscode.workspace.asRelativePath(uri),
                name: OSPath.basename(uri.fsPath), alwaysShow: true, fileType: FileType.Directory, payload: uri
            } as FileItem));
        } catch (e) { } finally {
            if (this.searchToken === token) this.current.busy = false;
        }
    }

    async handleGlobAndCreateSearch(value: string) { /* 保留原有逻辑 */
        const token = ++this.searchToken;
        this.current.busy = true;
        try {
            const finalCreatePaths: { name: string, isDir: boolean }[] = [];
            const existingMatches: { name: string, uri: Uri, type: FileType }[] = [];
            const braced = expandBraces(value);
            let hasCreation = false;

            for (const pattern of braced) {
                const isDirCreate = pattern.endsWith('/');
                const cleanPattern = isDirCreate ? pattern.slice(0, -1) : pattern;

                try {
                    const matches = await expandPathWildcards(this.path.uri, cleanPattern, true, isDirCreate);
                    for (const m of matches) {
                        try {
                            const stat = await vscode.workspace.fs.stat(m.uri);
                            existingMatches.push({ name: m.name, uri: m.uri, type: stat.type });
                        } catch (e) { }
                    }
                } catch (e) { }

                const lastSlashIdx = cleanPattern.lastIndexOf('/');
                const dirPart = lastSlashIdx === -1 ? "" : cleanPattern.substring(0, lastSlashIdx);
                const leafPart = lastSlashIdx === -1 ? cleanPattern : cleanPattern.substring(lastSlashIdx + 1);

                if (leafPart.includes('*') || leafPart.includes('?')) continue;

                hasCreation = true;
                if (dirPart === "") {
                    finalCreatePaths.push({ name: cleanPattern, isDir: isDirCreate });
                } else {
                    const resolvedDirs = await expandPathWildcards(this.path.uri, dirPart, false, true);
                    for (const r of resolvedDirs) {
                        finalCreatePaths.push({ name: `${r.name}/${leafPart}`, isDir: isDirCreate });
                    }
                }
            }

            if (this.searchToken !== token) return;

            const items: FileItem[] = [];
            const uniqueExisting = new Set<string>();

            if (hasCreation && finalCreatePaths.length > 0) {
                items.push({
                    label: `$(new-file) Create Pattern: ${value}`, name: value, description: "Execute bulk create",
                    alwaysShow: true, action: Action.BulkCreate, payload: finalCreatePaths
                } as FileItem);
            }

            for (const m of existingMatches) {
                if (!uniqueExisting.has(m.name)) {
                    uniqueExisting.add(m.name);
                    items.push({
                        label: (m.type & FileType.Directory) ? `$(folder) ${m.name}` : `$(file) ${m.name}`, name: m.name,
                        description: "Existing Match", alwaysShow: true, fileType: m.type, payload: m.uri
                    } as FileItem);
                }
            }

            for (const p of finalCreatePaths) {
                if (!uniqueExisting.has(p.name)) {
                    items.push({
                        label: p.isDir ? `$(add) [Folder] ${p.name}/` : `$(add) ${p.name}`, name: p.name,
                        description: "Preview (Click to create single item)", alwaysShow: true, action: Action.SingleCreate, payload: p
                    } as FileItem);
                }
            }

            this.current.items = items;
            if (items.length > 0) this.current.activeItems = [items[0]];
        } catch (e) { }
        this.current.busy = false;
    }

    async handleBulkOp(query: string, action: Action) { /* 保留原有逻辑 */
        const token = ++this.searchToken;
        this.current.busy = true;

        const parts = splitArgs(query.trim());
        let label = "";
        let payload: any = {};
        let matchedFiles: FileItem[] = [];

        if (parts.length > 0) {
            const matchPattern = parts[0];
            const onlyDirs = matchPattern.endsWith('/');
            const isSingleArg = parts.length === 1;

            if (isSingleArg && this.editorUri) {
                if ((action === Action.BulkCopy || action === Action.BulkMove)) {
                    const oldUri = this.editorUri;
                    const newBase = parts[0];
                    const isMove = action === Action.BulkMove;
                    const item = {
                        label: `$(files) ${isMove ? 'Move' : 'Copy'} current file to '${newBase}'`, name: newBase,
                        alwaysShow: true, action: isMove ? Action.SingleMove : Action.SingleCopy, payload: { oldUri, newUri: Uri.joinPath(oldUri, '..', newBase) }
                    } as FileItem;
                    this.current.items = [item];
                    this.current.busy = false;
                    return;
                } else if (action === Action.BulkRename) {
                    const oldUri = this.editorUri;
                    const newBase = parts[0];
                    const item = {
                        label: `$(edit) Rename current file to '${newBase}'`, name: newBase,
                        alwaysShow: true, action: Action.SingleRename, payload: { oldUri, newUri: Uri.joinPath(oldUri, '..', newBase) }
                    } as FileItem;
                    this.current.items = [item];
                    this.current.busy = false;
                    return;
                }
            }
            try {
                const resolvedPaths = await expandPathWildcards(this.path.uri, matchPattern, true);
                if (this.searchToken !== token) return;

                if ((action === Action.BulkCopy || action === Action.BulkMove) && parts.length >= 2) {
                    const isMove = action === Action.BulkMove;
                    const fromPattern = parts[0], toPattern = parts[1];
                    const isDestDir = toPattern.endsWith('/') || toPattern.endsWith('\\');
                    const destDirPart = isDestDir ? toPattern : OSPath.dirname(toPattern);
                    const destFilePart = isDestDir ? "*" : OSPath.basename(toPattern);

                    let resolvedDests: { name: string, uri: Uri }[] = [];
                    if (destDirPart.includes('*') || destDirPart.includes('?')) {
                        resolvedDests = await expandPathWildcards(this.path.uri, destDirPart, true, true);
                    } else {
                        resolvedDests = [{ name: destDirPart, uri: this.path.append(...destDirPart.split('/')).uri }];
                    }

                    label = `${isMove ? 'Move' : 'Copy'} matching items to ${resolvedDests.length} location(s)`;
                    payload = { match: fromPattern, dest: toPattern };

                    matchedFiles = resolvedPaths.map(p => {
                        const oldBase = OSPath.basename(p.name);
                        const targetDir = resolvedDests[0]?.uri || this.path.uri;
                        let newBase = oldBase;
                        if (!isDestDir) newBase = applyWildcard(oldBase, OSPath.basename(fromPattern), destFilePart) || oldBase;
                        const newUri = Uri.joinPath(targetDir, newBase);
                        const countSuffix = resolvedDests.length > 1 ? ` (+${resolvedDests.length - 1} dirs)` : "";

                        return {
                            label: `$(arrow-right) ${p.name} -> ${vscode.workspace.asRelativePath(newUri)}${countSuffix}`,
                            name: p.name, alwaysShow: true, action: isMove ? Action.SingleMove : Action.SingleCopy, payload: { oldUri: p.uri, newUri }
                        } as FileItem;
                    });
                } else if (action === Action.BulkRename && parts.length >= 2) {
                    const from = parts[0], to = parts[1];
                    label = `Rename matching '${from}' to '${to}'`;
                    payload = { from, to };
                    matchedFiles = resolvedPaths.map(p => {
                        const oldBase = OSPath.basename(p.name);
                        const newBase = applyWildcard(oldBase, OSPath.basename(from), OSPath.basename(to)) || oldBase;
                        const dir = OSPath.dirname(p.name);
                        const newUri = Uri.joinPath(Uri.joinPath(p.uri, '..'), newBase);

                        return {
                            label: `$(arrow-right) ${p.name} -> ${dir === "." ? newBase : `${dir}/${newBase}`}`,
                            name: p.name, alwaysShow: true, action: Action.SingleRename, payload: { oldUri: p.uri, newUri }
                        } as FileItem;
                    });
                } else if (action === Action.BulkDelete) {
                    label = `Delete matching '${matchPattern}' (${resolvedPaths.length} items)`;
                    payload = { match: matchPattern, onlyDirs };
                    matchedFiles = resolvedPaths.map(p => ({
                        label: `$(trash) ${p.name}`, name: p.name, alwaysShow: true, action: Action.SingleDelete, payload: { uri: p.uri }
                    } as FileItem));
                }
            } catch (e) { }
        }

        const items: FileItem[] = [];
        if (label) items.push({ label: `$(zap) ${label}`, name: query, alwaysShow: true, action, payload } as FileItem);
        else items.push({ label: "Keep typing pattern...", name: "", alwaysShow: true } as FileItem);

        items.push(...matchedFiles);
        this.current.items = items;
        this.current.busy = false;
    }

    // ================= 文件操作与执行 (Actions) =================

    openFile(uri: Uri, column: ViewColumn = ViewColumn.Active) {
        this.dispose();
        vscode.workspace.openTextDocument(uri).then((doc) => vscode.window.showTextDocument(doc, column));
    }

    private async confirmAction(message: string, detail?: string, isDestructive: boolean = false): Promise<boolean> {
        this.keepAlive = true;
        this.current.hide();
        const options: vscode.MessageOptions = { modal: true, detail };
        const result = isDestructive
            ? await vscode.window.showWarningMessage(message, options, "Confirm")
            : await vscode.window.showInformationMessage(message, options, "Yes");
        this.current.show();
        this.keepAlive = false;
        return result === "Confirm" || result === "Yes";
    }

    private async ensureSafeWrite(uri: Uri): Promise<"ok" | "skip" | "cancel"> {
        try {
            await vscode.workspace.fs.stat(uri);
            this.keepAlive = true;
            this.current.hide();
            const choice = await vscode.window.showWarningMessage(
                `File already exists: ${OSPath.basename(uri.fsPath)}`,
                { modal: true, detail: "Do you want to overwrite it?" }, "Overwrite", "Skip"
            );
            this.current.show();
            this.keepAlive = false;
            return choice === "Overwrite" ? "ok" : (choice === "Skip" ? "skip" : "cancel");
        } catch { return "ok"; }
    }

    async rename() {
        const uri = this.path.uri;
        const stat = await vscode.workspace.fs.stat(uri);
        const isDir = (stat.type & FileType.Directory) === FileType.Directory;
        const fileName = this.path.pop().getOrElse(() => { throw new Error("Can't rename an empty file name!"); });
        const workspaceFolder = this.path.getWorkspaceFolder().map((wsf) => wsf.uri);
        const relPath = workspaceFolder.chain((wsf) => new Path(uri).relativeTo(wsf)).getOr(fileName);
        const extension = OSPath.extname(relPath);
        const startSelection = relPath.length - fileName.length;

        const result = await vscode.window.showInputBox({
            prompt: `Enter the new ${isDir ? "folder" : "file"} name`,
            value: relPath,
            valueSelection: [startSelection, startSelection + (fileName.length - extension.length)],
        });

        this.file = Some(fileName);
        if (result !== undefined) {
            const newUri = workspaceFolder.match((wsf) => Uri.joinPath(wsf, result), () => Uri.joinPath(this.path.uri, result));
            if ((await Result.await(vscode.workspace.fs.rename(uri, newUri))).isOk()) this.file = Some(OSPath.basename(result));
            else vscode.window.showErrorMessage(`Failed to rename "${fileName}"`);
        }
    }

    async runAction(item: FileItem) {
        try {
            switch (item.action) {
                case Action.GoToLine: {
                    const line = item.payload - 1;
                    this.dispose();
                    if (this.editorUri) {
                        vscode.workspace.openTextDocument(this.editorUri).then(doc => {
                            vscode.window.showTextDocument(doc).then(editor => {
                                const range = doc.lineAt(Math.max(0, Math.min(line, doc.lineCount - 1))).range;
                                editor.selection = new vscode.Selection(range.start, range.start);
                                editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
                            });
                        });
                    }
                    break;
                }
                case Action.GoToSymbol: {
                    const payload = item.payload as { uri: Uri, range: vscode.Range };
                    this.dispose();
                    vscode.workspace.openTextDocument(payload.uri).then(doc => {
                        vscode.window.showTextDocument(doc).then(editor => {
                            editor.selection = new vscode.Selection(payload.range.start, payload.range.start);
                            editor.revealRange(payload.range, vscode.TextEditorRevealType.InCenter);
                        });
                    });
                    break;
                }
                case Action.SingleCreate: {
                    const { name, isDir } = item.payload;
                    const uri = Uri.joinPath(this.path.uri, ...name.split('/'));
                    if (isDir) {
                        await vscode.workspace.fs.createDirectory(uri);
                    } else {
                        if (await this.ensureSafeWrite(uri) !== "ok") return;
                        await vscode.workspace.fs.createDirectory(Uri.joinPath(uri, '..'));
                        await vscode.workspace.fs.writeFile(uri, new Uint8Array(0));
                        this.openFile(uri, ViewColumn.Active);
                    }
                    this.update();
                    break;
                }
                case Action.SingleRename:
                case Action.SingleMove:
                case Action.SingleCopy: {
                    const { oldUri, newUri } = item.payload;
                    if (await this.ensureSafeWrite(newUri) !== "ok") return;
                    await vscode.workspace.fs.createDirectory(Uri.joinPath(newUri, '..'));
                    if (item.action === Action.SingleCopy) await vscode.workspace.fs.copy(oldUri, newUri, { overwrite: true });
                    else await vscode.workspace.fs.rename(oldUri, newUri, { overwrite: true });
                    this.update();
                    break;
                }
                case Action.SingleDelete: {
                    const { uri } = item.payload;
                    if (await this.confirmAction(`Delete ${OSPath.basename(uri.fsPath)}?`, "Move to trash.", true)) {
                        await vscode.workspace.fs.delete(uri, { recursive: true, useTrash: true });
                        this.update();
                    }
                    break;
                }
                case Action.BulkCreate: {
                    const paths: { name: string, isDir: boolean }[] = item.payload;
                    if (paths.length > 10 && !await this.confirmAction(`Create ${paths.length} items?`)) return;
                    for (const p of paths) {
                        const uri = Uri.joinPath(this.path.uri, ...p.name.split('/'));
                        await vscode.workspace.fs.createDirectory(Uri.joinPath(uri, '..'));
                        if (p.isDir) await vscode.workspace.fs.createDirectory(uri);
                        else { try { await vscode.workspace.fs.stat(uri); } catch { await vscode.workspace.fs.writeFile(uri, new Uint8Array(0)); } }
                    }
                    this.update();
                    break;
                }
                case Action.BulkRename: {
                    const { from, to } = item.payload;
                    const resolved = await expandPathWildcards(this.path.uri, from, true);
                    if (resolved.length === 0 || !await this.confirmAction(`Rename ${resolved.length} matching items?`)) return;

                    for (const r of resolved) {
                        const oldBase = OSPath.basename(r.name);
                        const newBase = applyWildcard(oldBase, OSPath.basename(from), OSPath.basename(to)) || oldBase;
                        if (newBase !== oldBase) {
                            const newUri = Uri.joinPath(Uri.joinPath(r.uri, '..'), newBase);
                            try { await vscode.workspace.fs.stat(newUri); }
                            catch { await vscode.workspace.fs.rename(r.uri, newUri); }
                        }
                    }
                    this.update();
                    break;
                }
                case Action.BulkDelete: {
                    const { match } = item.payload;
                    const resolved = await expandPathWildcards(this.path.uri, match, true);
                    if (resolved.length === 0 || !await this.confirmAction(`Delete ${resolved.length} items?`, undefined, true)) return;
                    for (const r of resolved) await vscode.workspace.fs.delete(r.uri, { recursive: true, useTrash: true });
                    this.update();
                    break;
                }
                case Action.BulkMove:
                case Action.BulkCopy: {
                    const { match, dest } = item.payload;
                    const isMove = item.action === Action.BulkMove;
                    const resolvedSources = await expandPathWildcards(this.path.uri, match, true);
                    if (resolvedSources.length === 0) return;

                    const isDestDir = dest.endsWith('/') || dest.endsWith('\\');
                    const destDirPart = isDestDir ? dest : OSPath.dirname(dest);
                    const destFilePart = isDestDir ? "*" : OSPath.basename(dest);

                    let resolvedDests: Uri[] = [];
                    if (destDirPart.includes('*') || destDirPart.includes('?')) {
                        resolvedDests = (await expandPathWildcards(this.path.uri, destDirPart, true, true)).map(e => e.uri);
                    } else {
                        resolvedDests = [this.path.append(...destDirPart.split('/')).uri];
                    }

                    if (resolvedDests.length === 0) { vscode.window.showErrorMessage("No destination found."); return; }
                    if (!await this.confirmAction(`${isMove ? 'Move' : 'Copy'} ${resolvedSources.length} items to ${resolvedDests.length} folders?`)) return;

                    for (const r of resolvedSources) {
                        const oldBase = OSPath.basename(r.name);
                        const newBase = isDestDir ? oldBase : (applyWildcard(oldBase, OSPath.basename(match), destFilePart) || oldBase);
                        for (const dUri of resolvedDests) {
                            const newUri = Uri.joinPath(dUri, newBase);
                            try {
                                await vscode.workspace.fs.createDirectory(Uri.joinPath(newUri, '..'));
                                if (isMove) await vscode.workspace.fs.rename(r.uri, newUri, { overwrite: false });
                                else await vscode.workspace.fs.copy(r.uri, newUri, { overwrite: false });
                            } catch (e) { }
                        }
                    }
                    this.update();
                    break;
                }
                case Action.NewFolder: {
                    await vscode.workspace.fs.createDirectory(this.path.uri);
                    this.update();
                    break;
                }
                case Action.OpenFile:
                case Action.OpenFileBeside: {
                    const path = this.path.clone();
                    if (item.name && item.name.length > 0) path.push(...item.name.split('/'));
                    try {
                        const stat = await vscode.workspace.fs.stat(path.uri);
                        if ((stat.type & FileType.Directory) === FileType.Directory) {
                            // 调用现有的 stepIn 以统一压栈
                            this.current.activeItems = [item];
                            await this.stepIn();
                            return;
                        }
                        this.openFile(path.uri, item.action === Action.OpenFileBeside ? ViewColumn.Beside : ViewColumn.Active);
                    } catch (e) {
                        if (item.name.endsWith('/')) {
                            await vscode.workspace.fs.createDirectory(path.uri);
                            this.update();
                        } else {
                            await vscode.workspace.fs.createDirectory(Uri.joinPath(path.uri, '..'));
                            this.openFile(path.uri.with({ scheme: "untitled" }), item.action === Action.OpenFileBeside ? ViewColumn.Beside : ViewColumn.Active);
                        }
                    }
                    break;
                }
                case Action.RenameFile: {
                    this.keepAlive = true;
                    this.hide();
                    await this.rename();
                    this.show();
                    this.keepAlive = false;

                    // Rename 结束后自动弹栈退回上一层目录刷新
                    await this.popState();
                    break;
                }
                case Action.DeleteFile: {
                    if (await this.confirmAction(`Delete ${OSPath.basename(this.path.uri.fsPath)}?`, "Move to trash.", true)) {
                        await vscode.workspace.fs.delete(this.path.uri, { recursive: true, useTrash: true });
                        // 删完以后直接弹栈回到目录列表
                        await this.popState();
                    }
                    break;
                }
                case Action.OpenFolder: { vscode.commands.executeCommand("vscode.openFolder", this.path.uri); break; }
                case Action.OpenFolderInNewWindow: { vscode.commands.executeCommand("vscode.openFolder", this.path.uri, true); break; }
                default: throw new Error(`Unhandled action ${item.action}`);
            }
        } catch (err: any) {
            vscode.window.showErrorMessage(`Operation failed: ${err.message}`);
            this.current.busy = false;
        }
    }

    tabCompletion(tabNext: boolean) {
        if (this.inActions) return;
        if (!this.autoCompletion || this.autoCompletion.items.length !== this.current.items.length) {
            const currentVisibleItems = this.current.items as FileItem[];
            if (currentVisibleItems.length === 0) return;
            this.autoCompletion = { index: -1, items: currentVisibleItems };
        }

        const { items } = this.autoCompletion;
        const length = items.length;
        const step = tabNext ? 1 : -1;

        this.autoCompletion.index = (this.autoCompletion.index + step + length) % length;
        const selectedItem = items[this.autoCompletion.index];

        const val = this.current.value;
        const prefixMatch = val.match(/^([rdcm]:|[:@!#])/);
        const prefix = prefixMatch ? prefixMatch[0] : "";

        let newValue = selectedItem.name;
        if (prefix && !newValue.startsWith(prefix)) newValue = prefix + newValue;
        if (selectedItem.fileType === FileType.Directory && !newValue.endsWith('/')) newValue += "/";

        this.current.value = newValue;
        this.current.activeItems = [selectedItem];
        this.onDidChangeValue(this.current.value, true);
    }
}

export function activate(context: vscode.ExtensionContext) {
    setContext(false);
    context.subscriptions.push(vscode.commands.registerCommand("file-browser.open", () => {
        const doc = vscode.window.activeTextEditor?.document;
        const wsf = vscode.workspace.workspaceFolders?.[0];
        let path = new Path(wsf?.uri || Uri.file(OS.homedir()));
        let file: Option<string> = None;
        if (doc && !doc.isUntitled) { path = new Path(doc.uri); file = path.pop(); }
        active = Some(new FileBrowser(path, file));
        setContext(true);
    }));
    context.subscriptions.push(vscode.commands.registerCommand("file-browser.rename", () =>
        active.chainNone(() => {
            const doc = vscode.window.activeTextEditor?.document;
            const wsf = vscode.workspace.workspaceFolders?.[0];
            const path = new Path(doc?.uri || wsf?.uri || Uri.file(OS.homedir()));
            active = Some(new FileBrowser(path, None));
            setContext(true);
            return active;
        }).ifSome((active) => active.rename())
    ));
    context.subscriptions.push(vscode.commands.registerCommand("file-browser.stepIn", () => active.ifSome(a => a.stepIn())));
    context.subscriptions.push(vscode.commands.registerCommand("file-browser.stepOut", () => active.ifSome(a => a.stepOut())));
    context.subscriptions.push(vscode.commands.registerCommand("file-browser.actions", () => active.ifSome(a => a.actions())));
    context.subscriptions.push(vscode.commands.registerCommand("file-browser.tabNext", () => active.ifSome(a => a.tabCompletion(true))));
    context.subscriptions.push(vscode.commands.registerCommand("file-browser.tabPrev", () => active.ifSome(a => a.tabCompletion(false))));
}

export function deactivate() { }