import * as vscode from "vscode";
import { Uri, FileType, QuickInputButton, ThemeIcon, ViewColumn, DocumentSymbol } from "vscode";
import * as OS from "os";
import * as OSPath from "path";

import { Result, None, Option, Some } from "@bodil/opt";
import { Path } from "./path";
import { Rules } from "./filter";
import { FileItem, fileRecordCompare, itemIsDir } from "./fileitem";
import { action, Action } from "./action";

// ================= 安全性保险：防止路径逃逸 =================

/**
 * 检查 URI 是否位于当前工作区范围内。
 * 如果工作区为空，则允许操作（针对单文件打开模式），否则严格限制。
 */
function isPathSafe(uri: Uri): boolean {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) return true;

    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (folder) return true;

    const targetPath = OSPath.normalize(uri.fsPath);
    return folders.some(f => {
        const rootPath = OSPath.normalize(f.uri.fsPath);
        const rel = OSPath.relative(rootPath, targetPath);
        return !rel.startsWith('..') && !OSPath.isAbsolute(rel);
    });
}

function ensureSafe(uri: Uri) {
    if (!isPathSafe(uri)) {
        throw new Error(`Access Denied: Path is outside of workspace: ${uri.fsPath}`);
    }
}

// ================= 工具函数与 UI 基础 =================

function toCaseInsensitiveGlob(str: string): string {
    return str.split('').map(c => {
        if (/[a-zA-Z]/.test(c)) {
            return `[${c.toLowerCase()}${c.toUpperCase()}]`;
        }
        return c;
    }).join('');
}

const searchDecorationType = vscode.window.createTextEditorDecorationType({
    backgroundColor: new vscode.ThemeColor('editor.findMatchHighlightBackground'),
    overviewRulerColor: new vscode.ThemeColor('editor.findMatchHighlightBackground'),
    overviewRulerLane: vscode.OverviewRulerLane.Center,
    border: '1px solid rgba(255, 255, 0, 0.2)',
    borderRadius: '2px'
});

const rangeDecorationType = vscode.window.createTextEditorDecorationType({
    backgroundColor: new vscode.ThemeColor('editor.rangeHighlightBackground'),
    isWholeLine: true,
});

function getSymbolIcon(kind: vscode.SymbolKind): string {
    switch (kind) {
        case vscode.SymbolKind.Class: return "$(symbol-class)";
        case vscode.SymbolKind.Method: return "$(symbol-method)";
        case vscode.SymbolKind.Function: return "$(symbol-function)";
        case vscode.SymbolKind.Field: return "$(symbol-field)";
        case vscode.SymbolKind.Property: return "$(symbol-property)";
        case vscode.SymbolKind.Struct: return "$(symbol-struct)";
        case vscode.SymbolKind.Interface: return "$(symbol-interface)";
        case vscode.SymbolKind.Enum: return "$(symbol-enum)";
        case vscode.SymbolKind.Event: return "$(symbol-event)";
        case vscode.SymbolKind.Constructor: return "$(symbol-method)";
        case vscode.SymbolKind.Variable: return "$(symbol-variable)";
        case vscode.SymbolKind.Constant: return "$(symbol-constant)";
        case vscode.SymbolKind.Namespace:
        case vscode.SymbolKind.Module: return "$(symbol-namespace)";
        case vscode.SymbolKind.EnumMember: return "$(symbol-enum-member)";
        default: return "$(symbol-misc)";
    }
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

// ================= 路径解析逻辑 =================

function expandBraces(str: string): string[] {
    const match = str.match(/^(.*?)\{([^{}]+)\}(.*)$/);
    if (!match) return [str];
    const results: string[] = [];
    const parts = match[2].split(',');
    for (const p of parts) {
        results.push(...expandBraces(match[1] + p.trim() + match[3]));
    }
    return results;
}
type ExpandedPath = {
    name: string;
    uri: Uri;
    exists: boolean;
    type?: FileType;
    isDir: boolean;
};
export async function expandPaths(
    baseUri: Uri,
    pattern: string,
    opts?: {
        onlyExisting?: boolean;
        onlyDirs?: boolean;
        fuzzy?: boolean;
        maxDepth?: number;
    }
): Promise<ExpandedPath[]> {
    const {
        onlyExisting = false,
        onlyDirs = false,
        fuzzy = false,
        maxDepth = 8
    } = opts || {};

    const isDirHint = pattern.endsWith('/') || pattern.endsWith('\\');
    pattern = pattern.replace(/\\/g, '/');

    // 1️⃣ brace 展开
    const patterns = expandBraces(pattern);
    const results: ExpandedPath[] = [];
    const seen = new Set<string>();

    for (const pat of patterns) {
        const clean = pat.endsWith('/') ? pat.slice(0, -1) : pat;
        const segments = clean.split('/').filter(Boolean);

        // 状态中增加 isDir 标记，初始假定 baseUri 是目录
        let current: { name: string, uri: Uri, isDir: boolean }[] = [{ name: "", uri: baseUri, isDir: true }];

        // 逐级解析路径段
        for (let i = 0; i < segments.length; i++) {
            const seg = segments[i];
            const next: typeof current = [];

            for (const cur of current) {
                // 如果当前项不是目录，无法进行下一级解析，直接跳过
                if (!cur.isDir) continue;

                // ../
                if (seg === '..') {
                    const parentUri = Uri.joinPath(cur.uri, '..');
                    next.push({
                        name: cur.name ? `${cur.name}/..` : '..',
                        uri: parentUri,
                        isDir: true // 父级必然是目录
                    });
                    continue;
                }

                // ** (递归搜索)
                if (seg === '**') {
                    const walk = async (u: Uri, rel: string, depth: number) => {
                        if (depth > maxDepth) return;
                        next.push({ name: rel, uri: u, isDir: true });

                        try {
                            const entries = await vscode.workspace.fs.readDirectory(u);
                            for (const [n, t] of entries) {
                                if (t & FileType.Directory) {
                                    await walk(
                                        Uri.joinPath(u, n),
                                        rel ? `${rel}/${n}` : n,
                                        depth + 1
                                    );
                                }
                            }
                        } catch { }
                    };

                    await walk(cur.uri, cur.name, 0);
                    continue;
                }

                // 通配符匹配 (* 或 ?) 或 模糊搜索
                if (seg.includes('*') || seg.includes('?') || fuzzy) {
                    try {
                        const entries = await vscode.workspace.fs.readDirectory(cur.uri);
                        for (const [n, t] of entries) {
                            const isDir = !!(t & FileType.Directory);
                            const patternStr = seg.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
                            const regex = fuzzy ? new RegExp(`.*${patternStr}.*`, 'i') : new RegExp(`^${patternStr}$`);

                            if (regex.test(n)) {
                                next.push({
                                    name: cur.name ? `${cur.name}/${n}` : n,
                                    uri: Uri.joinPath(cur.uri, n),
                                    isDir: isDir
                                });
                            }

                            // 如果是模糊模式且是目录，则递归寻找更多匹配
                            if (fuzzy && isDir) {
                                const subWalk = async (u: Uri, rel: string, depth: number) => {
                                    if (depth > maxDepth) return;
                                    try {
                                        const subEntries = await vscode.workspace.fs.readDirectory(u);
                                        for (const [sn, st] of subEntries) {
                                            const sIsDir = !!(st & FileType.Directory);
                                            if (regex.test(sn)) {
                                                next.push({ name: `${rel}/${sn}`, uri: Uri.joinPath(u, sn), isDir: sIsDir });
                                            }
                                            if (sIsDir) await subWalk(Uri.joinPath(u, sn), `${rel}/${sn}`, depth + 1);
                                        }
                                    } catch { }
                                };
                                await subWalk(Uri.joinPath(cur.uri, n), cur.name ? `${cur.name}/${n}` : n, 1);
                            }
                        }
                    } catch { }
                    continue;
                }

                // 普通路径段：直接拼接
                const nextUri = Uri.joinPath(cur.uri, seg);
                let nextIsDir = false;
                try {
                    const s = await vscode.workspace.fs.stat(nextUri);
                    nextIsDir = !!(s.type & FileType.Directory);
                } catch {
                    // 如果文件不存在且不是最后一段，则无法继续
                    if (i < segments.length - 1) continue;
                }

                next.push({
                    name: cur.name ? `${cur.name}/${seg}` : seg,
                    uri: nextUri,
                    isDir: nextIsDir
                });
            }
            current = next;
            if (current.length === 0) break;
        }

        // 2️⃣ 最终结果构建
        for (const p of current) {
            const key = p.uri.toString();
            if (seen.has(key)) continue;
            seen.add(key);

            let exists = false;
            let type: FileType | undefined;
            try {
                const stat = await vscode.workspace.fs.stat(p.uri);
                exists = true;
                type = stat.type;
            } catch { }

            if (onlyExisting && !exists) continue;
            const isDir = p.isDir;

            // 处理目录展示意图 (末尾斜杠)
            if (isDir && isDirHint && fuzzy) {
                try {
                    const entries = await vscode.workspace.fs.readDirectory(p.uri);
                    for (const [childName, childType] of entries) {
                        const childIsDir = !!(childType & FileType.Directory);
                        if (onlyDirs && !childIsDir) continue;

                        results.push({
                            name: p.name === "." ? childName : `${p.name}/${childName}`,
                            uri: Uri.joinPath(p.uri, childName),
                            exists: true,
                            type: childType,
                            isDir: childIsDir
                        });
                    }
                } catch { }
                continue; // 用户输入了斜杠，通常不希望看到父目录本身
            }

            if (onlyDirs && !isDir) continue;
            results.push({ name: p.name || ".", uri: p.uri, exists, type, isDir });
        }
    }

    return results;
} export async function resolveExistingPaths(baseUri: Uri, pattern: string, onlyDirs: boolean = false): Promise<{ name: string, uri: Uri, type: FileType }[]> {
    const res = await expandPaths(baseUri, pattern, {
        onlyExisting: true,
        onlyDirs,
        fuzzy: false
    });

    return res.map(r => ({
        name: r.name,
        uri: r.uri,
        type: r.type!
    }));
}

export async function searchExistingPaths(baseUri: Uri, pattern: string, onlyDirs: boolean = false): Promise<{ name: string, uri: Uri, type: FileType }[]> {
    const res = await expandPaths(baseUri, pattern, {
        onlyExisting: true,
        onlyDirs,
        fuzzy: true
    });

    return res.map(r => ({
        name: r.name,
        uri: r.uri,
        type: r.type!
    }));
}

export async function resolveCreationPaths(baseUri: Uri, pattern: string): Promise<{ name: string, uri: Uri, isDir: boolean, exists: boolean, type?: FileType }[]> {
    const res = await expandPaths(baseUri, pattern);

    return res.map(r => ({
        name: r.name + (r.isDir ? '/' : ''),
        uri: r.uri,
        isDir: r.isDir,
        exists: r.exists,
        type: r.type
    }));
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

interface ViewState {
    path: Path;
    file: Option<string>;
    inActions: boolean;
    inputValue: string;
    cachedItems: FileItem[];
    targetPayload?: any;
}

class FileBrowser {
    current: vscode.QuickPick<FileItem>;
    path: Path;
    file: Option<string>;
    items: FileItem[] = [];
    inActions: boolean = false;
    targetPayload?: any;
    stateStack: ViewState[] = [];
    private isRestoringState = false;
    pathHistory: { [path: string]: Option<string> };
    keepAlive: boolean = false;
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
            this.current.placeholder = "Type a file name, paths, or commands (@@, @, $$, $, ^, etc.)";
            this.current.busy = false;
        });
        this.current.onDidChangeActive(items => { if (items[0]) this.preview(items[0]); });
    }

    private previewTimeout?: NodeJS.Timeout;
    private urisToClose = new Set<string>();
    private async preview(item: FileItem) {
        if (this.inActions) return;
        if (this.previewTimeout) { clearTimeout(this.previewTimeout); this.previewTimeout = undefined; }
        if (!item || item.name === "") { this.closePreviewTab(); this.clearDecorations(); return; }

        const canPreview = item.action === undefined || item.action === Action.GoToLine || item.action === Action.OpenFile;
        if (!canPreview || (item.fileType !== undefined && (item.fileType & FileType.Directory))) {
            this.closePreviewTab(); this.clearDecorations(); return;
        }

        this.previewTimeout = setTimeout(async () => {
            let uri: Uri | undefined;
            let range: vscode.Range | undefined;
            let selectionRange: vscode.Range | undefined;

            if (item.payload?.uri) { uri = item.payload.uri; range = item.payload.range; selectionRange = item.payload.selectionRange; }
            else if (item.payload instanceof Uri) { uri = item.payload; }
            else if (item.name && !item.action) { uri = this.path.append(item.name).uri; }
            if (!uri) return;

            try { const stat = await vscode.workspace.fs.stat(uri); if (stat.type & FileType.Directory) return; } catch (e) { return; }
            this.urisToClose.add(uri.toString());
            let targetColumn = vscode.window.tabGroups.activeTabGroup.viewColumn == vscode.ViewColumn.One ? vscode.ViewColumn.Two : vscode.ViewColumn.One;

            try {
                const editor = await vscode.window.showTextDocument(uri, { preview: true, preserveFocus: true, viewColumn: targetColumn });
                if (range && !editor.selection.active.isEqual(range.start)) {
                    this.clearDecorations();
                    const targetPos = selectionRange || range;
                    editor.selection = new vscode.Selection(targetPos.start, targetPos.end);
                    if (item.action === Action.GoToLine) editor.setDecorations(rangeDecorationType, [range]);
                    else editor.setDecorations(searchDecorationType, [range]);
                    editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
                }
            } catch (e) { }
        }, 150);
    }

    private closePreviewTab() {
        if (this.urisToClose.size === 0) return;
        for (const group of vscode.window.tabGroups.all) {
            for (const tab of group.tabs) {
                if (tab.input instanceof vscode.TabInputText) {
                    const uriStr = tab.input.uri.toString();
                    if (this.urisToClose.has(uriStr)) {
                        if (tab.isPreview) {
                            vscode.window.tabGroups.close(tab, true);
                            this.urisToClose.delete(uriStr);
                        }
                    }
                }
            }
        }
    }
    private clearDecorations() {
        vscode.window.visibleTextEditors.forEach(editor => {
            editor.setDecorations(searchDecorationType, []);
            editor.setDecorations(rangeDecorationType, []);
        });
    }
    private getRelativeDisplayPath(uri: Uri): string {
        // 计算相对于当前 browser 所在的 this.path 的路径
        let rel = OSPath.relative(this.path.uri.fsPath, uri.fsPath);
        if (!rel) return ".";
        // 统一使用正斜杠
        rel = rel.replace(/\\/g, '/');
        // 如果是在当前目录下的文件，去掉 ./ 
        if (rel.startsWith('./')) rel = rel.substring(2);
        return rel;
    }
    private pushState() {
        this.stateStack.push({
            path: this.path.clone(),
            file: this.activeItem().map(i => i.name),
            inActions: this.inActions,
            inputValue: this.current.value,
            cachedItems: [...this.items],
            targetPayload: this.targetPayload
        });
    }

    private async popState() {
        const prevState = this.stateStack.pop();
        if (!prevState) return;
        this.path = prevState.path;
        this.file = prevState.file;
        this.inActions = prevState.inActions;
        this.targetPayload = prevState.targetPayload;
        this.isRestoringState = true;
        this.current.value = prevState.inputValue;
        this.isRestoringState = false;

        if (prevState.inputValue === "") { await this.update(); }
        else { this.items = prevState.cachedItems; this.current.items = this.items; prevState.file.ifSome(f => { this.current.activeItems = this.items.filter(i => i.name === f); }); }
    }

    dispose() { this.closePreviewTab(); this.clearDecorations(); setContext(false); this.current.dispose(); active = None; }
    hide() { this.current.hide(); setContext(false); }
    show() { setContext(true); this.current.show(); }
    activeItem(): Option<FileItem> { return Option.from(this.current.activeItems[0]); }

    onDidTriggerButton(button: QuickInputButton) {
        if (button === this.stepInButton) this.stepIn();
        else if (button === this.stepOutButton) this.stepOut();
        else if (button === this.actionsButton) this.actions();
    }

    async update() {
        this.current.show();
        this.current.busy = true;
        this.current.title = this.path.fsPath;
        if (!this.isRestoringState) { this.current.value = ""; }
        const stat = (await Result.await(vscode.workspace.fs.stat(this.path.uri))).unwrap();
        if (stat && this.inActions && (stat.type & FileType.File) === FileType.File) {
            this.items = [
                action("$(file) Open this file", Action.OpenFile, this.targetPayload),
                action("$(split-horizontal) Open this file to the side", Action.OpenFileBeside, this.targetPayload),
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
            if (config(ConfigItem.HideIgnoreFiles)) { const rules = await Rules.forPath(this.path); items = rules.filter(this.path, items); }
            if (config(ConfigItem.RemoveIgnoredFiles)) { items = items.filter((item) => item.alwaysShow); }
            this.items = items;
        } else {
            this.items = [action("$(new-folder) Create this folder", Action.NewFolder)];
        }
        this.current.items = this.items;
        this.current.activeItems = this.items.filter((item) => this.file.value === item.name);
        this.current.enabled = true;
        this.current.busy = false;
    }

    async stepIn() {
        this.activeItem().ifSome(async (item) => {
            if (item.action !== undefined && !(item.payload && item.payload.name)) { this.runAction(item); return; }
            this.pushState();
            if (item.fileType !== undefined) {
                if ((item.fileType & FileType.Directory) === FileType.Directory) {
                    let u = item.payload instanceof Uri ? item.payload : item.payload?.uri;
                    if (u && u.scheme) this.path = new Path(u); else this.path.push(item.name);
                    this.inActions = false; await this.update();
                } else if ((item.fileType & FileType.File) === FileType.File) {
                    let u = item.payload instanceof Uri ? item.payload : item.payload?.uri;
                    if (u && u.scheme) this.path = new Path(u); else this.path.push(item.name);
                    this.file = None; this.inActions = true; this.targetPayload = item.payload; await this.update();
                }
            }
        });
    }

    async stepOut() {
        if (this.stateStack.length > 0) { await this.popState(); return; }
        const folders = vscode.workspace.workspaceFolders;
        if (folders && folders.some(f => f.uri.fsPath === this.path.uri.fsPath)) {
            vscode.window.showInformationMessage("You are at the root of the workspace."); return;
        }
        if (!this.path.atTop()) {
            this.pathHistory[this.path.id] = this.activeItem().map((item) => item.name);
            this.file = this.path.pop(); this.inActions = false; await this.update();
        }
    }

    async actions() {
        if (this.inActions) return;
        this.pushState();
        this.inActions = true; this.file = None; this.targetPayload = undefined;
        this.activeItem().ifSome(item => {
            let u = item.payload instanceof Uri ? item.payload : item.payload?.uri;
            if (u && u.scheme) this.path = new Path(u); else this.path.push(item.name);
            this.targetPayload = item.payload;
        });
        await this.update();
    }

    onDidAccept() { this.stepIn(); }

    async onDidChangeValue(value: string) {
        if (this.isRestoringState || this.inActions) return;
        ++this.searchToken;
        if (this.searchTimeout) { clearTimeout(this.searchTimeout); this.searchTimeout = undefined; }
        if (value === "") { this.current.busy = false; this.current.items = this.items; this.current.activeItems = []; return; }
        if (value.startsWith("$$")) return this.debounce(() => this.handleTextSearch(value.substring(2), true));
        if (value.startsWith("$")) return this.debounce(() => this.handleTextSearch(value.substring(1), false));
        if (value.startsWith("%%")) return this.debounce(() => this.handleDiagnosticSearch(value.substring(2), true));
        if (value.startsWith("%")) return this.debounce(() => this.handleDiagnosticSearch(value.substring(1), false));
        if (value.startsWith("@@")) return this.debounce(() => this.handleWorkspaceSymbolSearch(value.substring(2)));
        if (value.startsWith("@")) return this.handleSymbolSearch(value.substring(1));
        if (value.startsWith(":")) return this.handleLineSearch(value.substring(1));
        if (value.startsWith("!")) return this.debounce(() => this.handleGlobalFileSearch(value.substring(1)));
        if (value.startsWith("#")) return this.debounce(() => this.handleGlobalFolderSearch(value.substring(1)));
        if (value.match(/^[rdcm]:/)) {
            const m: { [k: string]: Action } = { 'r': Action.BulkRename, 'd': Action.BulkDelete, 'c': Action.BulkCopy, 'm': Action.BulkMove };
            return this.debounce(() => this.handleBulkOp(value, m[value[0]]));
        }
        if (value.includes("{") || value.includes("*") || value.includes("?")) { return this.debounce(() => this.handleGlobAndCreateSearch(value)); }
        if (value.includes("/")) { return this.debounce(() => this.handlePathSearch(value), 100); }

        const query = value.toLowerCase();
        let displayItems = this.items.filter((item) => {
            if (item.action !== undefined && item.action !== Action.OpenFile) return true;
            return item.name.toLowerCase().includes(query);
        });
        if (!this.items.find((item) => item.name === value)) {
            displayItems = [{ label: `$(new-file) Create: ${value}`, name: value, description: "Open as new file", alwaysShow: true, action: Action.OpenFile } as FileItem, ...displayItems];
        }
        this.current.items = displayItems;
        if (displayItems.length > 0) this.current.activeItems = [displayItems[0]];
        this.current.busy = false;
    }

    private debounce(func: () => void | Promise<void>, delay: number = 250) {
        this.searchTimeout = setTimeout(async () => { await func(); }, delay);
    }

    async handleTextSearch(query: string, isGlobal: boolean) {
        if (query.length < 2) { this.current.items = [{ label: "Type at least 2 chars to search text...", name: "", alwaysShow: true } as FileItem]; return; }
        const token = ++this.searchToken; this.current.busy = true;
        try {
            const results: FileItem[] = []; const q = query.toLowerCase();
            if (!isGlobal) {
                const docs = vscode.workspace.textDocuments;
                for (const doc of docs) {
                    if (this.searchToken !== token) return;
                    for (let i = 0; i < doc.lineCount; i++) {
                        const line = doc.lineAt(i); const index = line.text.toLowerCase().indexOf(q);
                        if (index !== -1) { const matchRange = new vscode.Range(i, index, i, index + q.length); results.push(this.createTextMatchItem(doc.uri, line.text, i, matchRange)); }
                    }
                }
            } else {
                const files = await vscode.workspace.findFiles('**/*', '{**/node_modules/**, **/.git/**, **/dist/**, **/build/**, **/*.map, **/*.min.js}', 250);
                if (this.searchToken !== token) return;
                const decoder = new TextDecoder('utf-8'); const batchSize = 10;
                for (let i = 0; i < files.length; i += batchSize) {
                    if (this.searchToken !== token) return;
                    const batch = files.slice(i, i + batchSize);
                    await Promise.all(batch.map(async (uri) => {
                        try {
                            const data = await vscode.workspace.fs.readFile(uri); const text = decoder.decode(data); const lines = text.split(/\r?\n/);
                            for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
                                const lineText = lines[lineIdx]; const index = lineText.toLowerCase().indexOf(q);
                                if (index !== -1) { const matchRange = new vscode.Range(lineIdx, index, lineIdx, index + q.length); results.push(this.createTextMatchItem(uri, lineText, lineIdx, matchRange)); }
                            }
                        } catch (e) { }
                    }));
                }

            }
            if (this.searchToken !== token) return;
            this.current.items = results.length > 0 ? results : [{ label: "No matching text found in the first 250 files.", name: "", alwaysShow: true } as FileItem];
        } catch (e) { } finally { if (this.searchToken === token) this.current.busy = false; }
    }

    private createTextMatchItem(uri: Uri, text: string, lineIdx: number, range: vscode.Range): FileItem {
        const cleanText = text.trim().replace(/\s+/g, ' ');
        return {
            label: `$(text-size) ${cleanText.substring(0, 100)}`,
            description: `${vscode.workspace.asRelativePath(uri)} : ${lineIdx + 1}`,
            name: OSPath.basename(uri.fsPath), alwaysShow: true, fileType: FileType.File, payload: { uri, range }
        } as FileItem;
    }

    async handleDiagnosticSearch(query: string, isGlobal: boolean) {
        const token = ++this.searchToken; this.current.busy = true;
        try {
            const results: FileItem[] = []; const q = query.toLowerCase();
            let targetUris: string[] = []; if (!isGlobal) { targetUris = vscode.workspace.textDocuments.map(doc => doc.uri.toString()); }
            const allDiagnostics = vscode.languages.getDiagnostics();
            for (const [uri, diags] of allDiagnostics) {
                if (!isGlobal && !targetUris.includes(uri.toString())) continue;
                for (const diag of diags) {
                    if (q && !diag.message.toLowerCase().includes(q)) continue;
                    const isError = diag.severity === vscode.DiagnosticSeverity.Error; const icon = isError ? "$(error)" : "$(warning)";
                    results.push({
                        label: `${icon} ${diag.message.split('\n')[0]}`, description: `${vscode.workspace.asRelativePath(uri)} : ${diag.range.start.line + 1}`,
                        name: OSPath.basename(uri.fsPath), alwaysShow: true, fileType: FileType.File, payload: { uri, range: diag.range }
                    } as FileItem);
                }
            }
            if (this.searchToken !== token) return;
            this.current.items = results.length > 0 ? results : [{ label: "No errors or warnings found.", name: "", alwaysShow: true } as FileItem];
        } catch (e) { } finally { if (this.searchToken === token) this.current.busy = false; }
    }

    async handlePathSearch(value: string) {
        const token = ++this.searchToken; this.current.busy = true;
        let displayItems: FileItem[] = [];
        try {
            const matched = await searchExistingPaths(this.path.uri, value);
            displayItems = matched.map(m => {
                const item = new FileItem([m.name, m.type]);
                // 这里的 m.name 现在会包含像 "../../target" 这样的路径
                item.label = (m.type & FileType.Directory) ? `$(folder) ${m.name}` : `$(file) ${m.name}`;
                return item;
            });
        } catch (e) { }
        if (this.searchToken !== token) return;
        const exactItem = { label: `$(go-to-file) Open / Create Path: ${value}`, name: value, description: "Will create missing directories automatically", alwaysShow: true, action: Action.OpenFile, } as FileItem;
        this.current.items = [exactItem, ...displayItems];
        if (this.current.items.length > 0) this.current.activeItems = [this.current.items[0]];
        this.current.busy = false;
    }

    async handleSymbolSearch(query: string) {
        if (!this.editorUri) { this.current.items = [{ label: "No active file to search symbols...", name: "", alwaysShow: true } as FileItem]; return; }
        const token = ++this.searchToken; this.current.busy = true;
        try {
            const symbols = await vscode.commands.executeCommand<DocumentSymbol[]>('vscode.executeDocumentSymbolProvider', this.editorUri);
            if (this.searchToken !== token) return; if (!symbols) { this.current.items = [{ label: "No symbols found.", name: "", alwaysShow: true } as FileItem]; return; }
            const flatSymbols: DocumentSymbol[] = []; const extract = (syms: DocumentSymbol[]) => { for (const s of syms) { flatSymbols.push(s); if (s.children) extract(s.children); } }; extract(symbols);
            const q = query.trim().toLowerCase(); const filtered = flatSymbols.filter(s => s.name.toLowerCase().includes(q));
            this.current.items = filtered.map(s => ({
                label: `${getSymbolIcon(s.kind)} ${s.name}`, name: s.name, description: `Line ${s.range.start.line + 1}`, alwaysShow: true,
                payload: { uri: this.editorUri, range: s.range, selectionRange: s.selectionRange }, fileType: FileType.File,
            } as FileItem));
        } catch (e) { } finally { if (this.searchToken === token) this.current.busy = false; }
    }

    async handleWorkspaceSymbolSearch(query: string) {
        query = query.trim(); if (query.length < 2) { this.current.items = [{ label: "Type at least 2 chars to search workspace symbols...", name: "", alwaysShow: true } as FileItem]; return; }
        const token = ++this.searchToken; this.current.busy = true;
        try {
            const symbols = await vscode.commands.executeCommand<vscode.SymbolInformation[]>('vscode.executeWorkspaceSymbolProvider', query);
            if (this.searchToken !== token) return; if (!symbols || symbols.length === 0) { this.current.items = [{ label: "No symbols found in workspace.", name: "", alwaysShow: true } as FileItem]; return; }
            const importantKinds = new Set([vscode.SymbolKind.Class, vscode.SymbolKind.Method, vscode.SymbolKind.Function, vscode.SymbolKind.Field, vscode.SymbolKind.Property, vscode.SymbolKind.Struct, vscode.SymbolKind.Interface, vscode.SymbolKind.Enum, vscode.SymbolKind.Event, vscode.SymbolKind.Constructor]);
            const filtered = symbols.filter(s => importantKinds.has(s.kind));
            this.current.items = filtered.slice(0, 200).map(s => {
                const container = s.containerName ? `${s.containerName} • ` : ''; const path = vscode.workspace.asRelativePath(s.location.uri);
                return {
                    label: `${getSymbolIcon(s.kind)} ${s.name}`, name: s.name, description: `${container}${path} : ${s.location.range.start.line + 1}`, alwaysShow: true, fileType: FileType.File,
                    payload: { uri: s.location.uri, range: s.location.range, selectionRange: new vscode.Range(s.location.range.start, s.location.range.start) }
                } as FileItem;
            });
            if (this.current.items.length === 0) { this.current.items = [{ label: "No important symbols found.", name: "", alwaysShow: true } as FileItem]; }
        } catch (e) { } finally { if (this.searchToken === token) this.current.busy = false; }
    }

    handleLineSearch(query: string) {
        const line = parseInt(query.trim(), 10); if (isNaN(line) || !this.editorUri) { this.current.items = [{ label: "Type a line number...", name: "", alwaysShow: true } as FileItem]; return; }
        const targetLine = Math.max(0, line - 1); const range = new vscode.Range(targetLine, 0, targetLine, 0);
        this.current.items = [{ label: `$(go-to-file) Go to line ${line}`, name: query, alwaysShow: true, fileType: FileType.File, payload: { uri: this.editorUri, range } } as FileItem];
    }

    async handleGlobalFileSearch(query: string) {
        const token = ++this.searchToken; query = query.trim(); if (query.length < 2) { this.current.items = [{ label: "Type at least 2 chars to search...", name: "", alwaysShow: true } as FileItem]; return; }
        this.current.busy = true;
        try {
            const globPattern = toCaseInsensitiveGlob(query); const files = await vscode.workspace.findFiles(`**/*${globPattern}*`, '**/node_modules/**', 50);
            if (this.searchToken !== token) return;
            this.current.items = files.map(uri => {
                const relToCurrent = this.getRelativeDisplayPath(uri);
                return {
                    label: `$(file) ${OSPath.basename(uri.fsPath)}`,
                    description: `rel: ${relToCurrent}`, // 这里显示相对于当前文件夹的路径
                    name: OSPath.basename(uri.fsPath),
                    alwaysShow: true,
                    payload: uri,
                    fileType: FileType.File,
                } as FileItem;
            });
        } catch (e) { } finally { if (this.searchToken === token) this.current.busy = false; }
    }

    async handleGlobalFolderSearch(query: string) {
        const token = ++this.searchToken; query = query.trim(); if (query.length < 1) { this.current.items = [{ label: "Type to search folders globally...", name: "", alwaysShow: true } as FileItem]; return; }
        this.current.busy = true;
        try {
            const globPattern = toCaseInsensitiveGlob(query); const files = await vscode.workspace.findFiles(`**/*${globPattern}*/**`, '**/node_modules/**', 200);
            if (this.searchToken !== token) return;
            const dirSet = new Set<string>(); const dirs: Uri[] = [];
            for (const f of files) { const dirUri = Uri.joinPath(f, '..'); if (!dirSet.has(dirUri.fsPath)) { dirSet.add(dirUri.fsPath); dirs.push(dirUri); } }
            this.current.items = dirs.map(uri => ({ label: `$(folder) ${OSPath.basename(uri.fsPath)}`, description: vscode.workspace.asRelativePath(uri), name: OSPath.basename(uri.fsPath), alwaysShow: true, fileType: FileType.Directory, payload: uri } as FileItem));
        } catch (e) { } finally { if (this.searchToken === token) this.current.busy = false; }
    }

    async handleGlobAndCreateSearch(value: string) {
        const token = ++this.searchToken; this.current.busy = true;
        try {
            const finalCreatePaths: any[] = []; const existingMatches: any[] = []; const uniqueExisting = new Set<string>();
            const braced = expandBraces(value);
            for (const pattern of braced) {
                const matches = await searchExistingPaths(this.path.uri, pattern);
                for (const m of matches) { const uriStr = m.uri.toString(); if (!uniqueExisting.has(uriStr)) { uniqueExisting.add(uriStr); existingMatches.push(m); } }
            }
            const creates = await resolveCreationPaths(this.path.uri, value);
            for (const c of creates) { if (!c.exists && !uniqueExisting.has(c.uri.toString())) { finalCreatePaths.push(c); } }
            if (this.searchToken !== token) return;
            const items: FileItem[] = [];
            if (finalCreatePaths.length > 0 && (value.includes('{') || finalCreatePaths.length > 1)) {
                items.push({ label: `$(new-file) Create Pattern: ${value}`, name: value, description: `Execute bulk create (${finalCreatePaths.length} items)`, alwaysShow: true, action: Action.BulkCreate, payload: finalCreatePaths } as FileItem);
            }
            for (const m of existingMatches) {
                items.push({
                    // m.name 现在通过 expandPaths 会返回用户输入的相对形式
                    label: (m.type & FileType.Directory) ? `$(folder) ${m.name}` : `$(file) ${m.name}`,
                    name: m.name,
                    description: "Existing Match",
                    alwaysShow: true,
                    fileType: m.type,
                    payload: m.uri
                } as FileItem);
            }
            for (const p of finalCreatePaths) { items.push({ label: p.isDir ? `$(add) [Folder] ${p.name}/` : `$(add) ${p.name}`, name: p.name, description: "Preview (Click to create single item)", alwaysShow: true, action: Action.SingleCreate, payload: p } as FileItem); }
            this.current.items = items; if (items.length > 0) this.current.activeItems = [items[0]];
        } catch (e) { } this.current.busy = false;
    }

    // ================= 核心重构：Bulk 操作逻辑 =================

    async handleBulkOp(fullQuery: string, action: Action) {
        const token = ++this.searchToken;
        this.current.busy = true;

        const queryValue = fullQuery.substring(2);
        const parts = splitArgs(queryValue.trim());
        const matchPattern = parts.length > 0 ? parts[0] : "";
        const isSingleArg = parts.length === 1;

        let exactMatchedItems: FileItem[] = [];
        let finalItems: FileItem[] = [];

        // 获取精准匹配源数据
        let resolvedSources: { name: string, uri: Uri, type: FileType }[] = [];
        if (matchPattern) {
            try { resolvedSources = await resolveExistingPaths(this.path.uri, matchPattern, matchPattern.endsWith('/')); } catch (e) { }
        }
        if (this.searchToken !== token) return;
        const sourceUrisSet = new Set(resolvedSources.map(p => p.uri.toString()));
        const isEditorInCurrentDir = this.editorUri &&
            (OSPath.dirname(this.editorUri.fsPath) === OSPath.normalize(this.path.uri.fsPath));

        // --- 1. 编辑器单文件快速操作 (便捷逻辑) ---
        if (isSingleArg && isEditorInCurrentDir && this.editorUri && matchPattern && matchPattern && action !== Action.BulkDelete) {
            const oldUri = this.editorUri;
            const newUri = Uri.joinPath(oldUri, '..', matchPattern);

            if (action === Action.BulkCopy || action === Action.BulkMove) {
                const isMove = action === Action.BulkMove;
                exactMatchedItems.push({
                    label: `$(files) ${isMove ? 'Move' : 'Copy'} current file -> ${this.getRelativeDisplayPath(newUri)}`,
                    name: matchPattern,
                    alwaysShow: true, action: isMove ? Action.SingleMove : Action.SingleCopy,
                    payload: { oldUri, newUri }
                } as FileItem);
            } else if (action === Action.BulkRename) {
                exactMatchedItems.push({
                    label: `$(edit) Rename current file -> ${this.getRelativeDisplayPath(newUri)}`,
                    name: matchPattern,
                    alwaysShow: true, action: Action.SingleRename,
                    payload: { oldUri, newUri }
                } as FileItem);
            }
        }
        // --- 2. 正常 Bulk 操作 ---
        else if (matchPattern) {
            // 处理 Copy / Move / Rename 统一逻辑
            if ((action === Action.BulkCopy || action === Action.BulkMove || action === Action.BulkRename) && parts.length >= 2) {
                const fromPattern = parts[0];
                const toPattern = parts[1];

                // 判断目标是否为目录 (斜杠结尾，或者在文件系统中确实是目录)
                let isDestDir = toPattern.endsWith('/') || toPattern.endsWith('\\');
                if (!isDestDir && toPattern !== '') {
                    try {
                        const stat = await vscode.workspace.fs.stat(Uri.joinPath(this.path.uri, toPattern));
                        if (stat.type & FileType.Directory) isDestDir = true;
                    } catch { }
                }

                const toDir = isDestDir ? toPattern : OSPath.dirname(toPattern);
                const toName = isDestDir ? '*' : OSPath.basename(toPattern);
                const fromName = OSPath.basename(fromPattern);

                const mappings: { src: { name: string, uri: Uri }, target: Uri }[] = [];

                for (const src of resolvedSources) {
                    const srcBase = OSPath.basename(src.name);

                    // 应用通配符 (例如 *.ts -> *.js)
                    const newBase = isDestDir
                        ? srcBase
                        : (applyWildcard(srcBase, fromName, toName) || toName);


                    let targetUri: Uri;
                    if (toDir === '.' && !toPattern.includes('/')) {
                        // 如果目标没有指定额外路径，则保留在源文件同级目录
                        targetUri = Uri.joinPath(src.uri, '..', newBase);
                    } else {
                        // 否则基于当前工作目录拼接
                        targetUri = Uri.joinPath(this.path.uri, toDir, newBase);
                    }
                    mappings.push({ src, target: targetUri });
                }

                const opName = action === Action.BulkRename ? "Rename" : action === Action.BulkMove ? "Move" : "Copy";
                const opIcon = action === Action.BulkRename ? "$(edit)" : "$(zap)";

                // 顶部执行项
                if (mappings.length > 0) {
                    finalItems.push({
                        label: `${opIcon} ${opName} ${mappings.length} items`,
                        name: fullQuery,
                        alwaysShow: true,
                        action: action,
                        payload: { mappings }
                    } as FileItem);
                }

                // 列表预览项
                for (const m of mappings) {
                    exactMatchedItems.push({
                        label: `$(arrow-right) ${m.src.name} -> ${this.getRelativeDisplayPath(m.target)}`,
                        name: m.src.name,
                        alwaysShow: true,
                        action: action === Action.BulkCopy ? Action.SingleCopy : (action === Action.BulkMove ? Action.SingleMove : Action.SingleRename),
                        payload: {
                            oldUri: m.src.uri,
                            newUri: m.target
                        }
                    } as FileItem);
                }

            }
            // 处理 Delete 逻辑
            else if (action === Action.BulkDelete) {
                const label = matchPattern ? `Delete matching '${matchPattern}' (${resolvedSources.length} items)` : `Type pattern to delete...`;
                if (resolvedSources.length > 0) {
                    finalItems.push({
                        label: `$(trash) ${label}`,
                        name: fullQuery,
                        alwaysShow: true,
                        action,
                        payload: { uris: resolvedSources.map(r => r.uri) }
                    } as FileItem);
                }
                exactMatchedItems = resolvedSources.map(p => ({
                    label: `$(trash) ${p.name} (Ready to delete)`,
                    name: p.name, alwaysShow: true, action: Action.SingleDelete, payload: { uri: p.uri }
                } as FileItem));
            }
        }

        // --- 补充提示与合并 ---
        if (finalItems.length === 0 && exactMatchedItems.length === 0) {
            const opName = action === Action.BulkRename ? "Rename" : action === Action.BulkCopy ? "Copy" : action === Action.BulkMove ? "Move" : "Delete";
            finalItems.push({ label: `$(info) Bulk ${opName}: type pattern...`, name: fullQuery, alwaysShow: true } as FileItem);
        }

        finalItems.push(...exactMatchedItems);

        // --- 3. Context / Unmatched 模糊提示 ---
        try {
            const fuzzyResults = await searchExistingPaths(this.path.uri, matchPattern || "./");
            const contextItems = fuzzyResults.filter(m => !sourceUrisSet.has(m.uri.toString())).slice(0, 30).map(m => ({
                label: (m.type & FileType.Directory) ? `$(folder) ${m.name}` : `$(file) ${m.name}`, name: m.name,
                description: "Context", alwaysShow: true, fileType: m.type, payload: m.uri
            }));
            if (contextItems.length > 0) {
                finalItems.push({ label: "--- Context / Unmatched ---", name: "", alwaysShow: true } as FileItem);
                finalItems.push(...contextItems);
            }
        } catch (e) { }

        this.current.items = finalItems;
        if (finalItems.length > 0) this.current.activeItems = [finalItems[0]];
        this.current.busy = false;
    }

    // ================= 文件操作执行 =================

    openFile(uri: Uri, column?: ViewColumn, range?: vscode.Range, selectionRange?: vscode.Range) {
        if (this.previewTimeout) { clearTimeout(this.previewTimeout); this.previewTimeout = undefined; }
        this.clearDecorations();
        let targetColumn = column;
        if (!targetColumn) {
            for (const group of vscode.window.tabGroups.all) {
                for (const tab of group.tabs) {
                    if (tab.input instanceof vscode.TabInputText && tab.input.uri.toString() === uri.toString() && !tab.isPreview) {
                        targetColumn = group.viewColumn; break;
                    }
                }
                if (targetColumn) break;
            }
        }
        this.dispose();
        vscode.workspace.openTextDocument(uri).then((doc) => {
            vscode.window.showTextDocument(doc, { viewColumn: targetColumn || ViewColumn.Active, preview: false }).then(editor => {
                if (range) { const ts = selectionRange || range; editor.selection = new vscode.Selection(ts.start, ts.end); editor.revealRange(range, vscode.TextEditorRevealType.InCenter); }
            });
        });
    }

    private async confirmAction(message: string, detail?: string, isDestructive: boolean = false): Promise<boolean> {
        this.keepAlive = true; this.current.hide();
        const options: vscode.MessageOptions = { modal: true, detail };
        const result = isDestructive ? await vscode.window.showWarningMessage(message, options, "Confirm") : await vscode.window.showInformationMessage(message, options, "Yes");
        this.current.show(); this.keepAlive = false; return result === "Confirm" || result === "Yes";
    }

    private async ensureSafeWrite(uri: Uri): Promise<"ok" | "skip" | "cancel"> {
        try {
            await vscode.workspace.fs.stat(uri);
            this.keepAlive = true; this.current.hide();
            const choice = await vscode.window.showWarningMessage(`File already exists: ${OSPath.basename(uri.fsPath)}`, { modal: true, detail: "Overwrite it?" }, "Overwrite", "Skip");
            this.current.show(); this.keepAlive = false; return choice === "Overwrite" ? "ok" : (choice === "Skip" ? "skip" : "cancel");
        } catch { return "ok"; }
    }

    async rename() {
        const uri = this.path.uri;
        const stat = await vscode.workspace.fs.stat(uri);
        const fileName = this.path.pop().getOrElse(() => { throw new Error("Empty name"); });
        const wsf = this.path.getWorkspaceFolder().map(f => f.uri);
        const relPath = wsf.chain(f => new Path(uri).relativeTo(f)).getOr(fileName);
        const result = await vscode.window.showInputBox({ prompt: `Rename`, value: relPath, valueSelection: [relPath.length - fileName.length, relPath.length - OSPath.extname(relPath).length] });
        if (result !== undefined) {
            const newUri = wsf.match(f => Uri.joinPath(f, result), () => Uri.joinPath(this.path.uri, result));
            ensureSafe(newUri);
            await vscode.workspace.fs.rename(uri, newUri);
        }
    }

    async runAction(item: FileItem) {
        try {
            switch (item.action) {
                case Action.GoToLine: {
                    const p = item.payload as { uri: Uri, range: vscode.Range, selectionRange?: vscode.Range };
                    this.openFile(p.uri, undefined, p.range, p.selectionRange);
                    break;
                }
                case Action.SingleCreate: {
                    const { uri, isDir } = item.payload;
                    ensureSafe(uri);
                    if (isDir) { await vscode.workspace.fs.createDirectory(uri); }
                    else {
                        if (await this.ensureSafeWrite(uri) !== "ok") return;
                        await vscode.workspace.fs.createDirectory(Uri.joinPath(uri, '..'));
                        await vscode.workspace.fs.writeFile(uri, new Uint8Array(0));
                        this.openFile(uri, ViewColumn.Active);
                    }
                    await this.update(); break;
                }
                case Action.SingleRename:
                case Action.SingleMove:
                case Action.SingleCopy: {
                    const { oldUri, newUri } = item.payload;
                    ensureSafe(newUri);
                    if (await this.ensureSafeWrite(newUri) !== "ok") return;
                    await vscode.workspace.fs.createDirectory(Uri.joinPath(newUri, '..'));
                    if (item.action === Action.SingleCopy) await vscode.workspace.fs.copy(oldUri, newUri, { overwrite: true });
                    else await vscode.workspace.fs.rename(oldUri, newUri, { overwrite: true });
                    await this.update(); break;
                }
                case Action.SingleDelete: {
                    const { uri } = item.payload;
                    ensureSafe(uri);
                    if (await this.confirmAction(`Delete ${OSPath.basename(uri.fsPath)}?`, "Trash", true)) { await vscode.workspace.fs.delete(uri, { recursive: true, useTrash: true }); await this.update(); }
                    break;
                }
                case Action.BulkCreate: {
                    const paths: { uri: Uri, isDir: boolean }[] = item.payload;
                    if (paths.length > 5 && !await this.confirmAction(`Create ${paths.length} items?`)) return;
                    for (const p of paths) {
                        ensureSafe(p.uri);
                        await vscode.workspace.fs.createDirectory(Uri.joinPath(p.uri, '..'));
                        if (p.isDir) await vscode.workspace.fs.createDirectory(p.uri);
                        else { try { await vscode.workspace.fs.stat(p.uri); } catch { await vscode.workspace.fs.writeFile(p.uri, new Uint8Array(0)); } }
                    }
                    await this.update(); break;
                }

                case Action.BulkDelete: {
                    const { uris } = item.payload as { uris: Uri[] };
                    if (!uris || uris.length === 0 || !await this.confirmAction(`Delete ${uris.length} items?`, undefined, true)) return;

                    for (const uri of uris) {
                        ensureSafe(uri);
                        await vscode.workspace.fs.delete(uri, { recursive: true, useTrash: true });
                    }
                    await this.update(); break;
                }
                case Action.BulkRename:
                case Action.BulkMove:
                case Action.BulkCopy: {
                    const isCopy = item.action === Action.BulkCopy;
                    const opName = item.action === Action.BulkRename ? "Rename" : item.action === Action.BulkMove ? "Move" : "Copy";

                    const { mappings } = item.payload as {
                        mappings: { src: { name: string, uri: Uri }, target: Uri }[]
                    };

                    if (!mappings || mappings.length === 0) return;

                    if (!await this.confirmAction(`${opName} ${mappings.length} items?`)) return;

                    for (const m of mappings) {
                        const { src, target } = m;

                        ensureSafe(target);
                        await vscode.workspace.fs.createDirectory(Uri.joinPath(target, '..'));

                        try {
                            if (isCopy) {
                                await vscode.workspace.fs.copy(src.uri, target, { overwrite: false });
                            } else {
                                await vscode.workspace.fs.rename(src.uri, target, { overwrite: false });
                            }
                        } catch { }
                    }

                    await this.update();
                    break;
                }
                case Action.NewFolder: { ensureSafe(this.path.uri); await vscode.workspace.fs.createDirectory(this.path.uri); await this.update(); break; }
                case Action.OpenFile:
                case Action.OpenFileBeside: {
                    let targetUri = this.path.clone().uri;
                    if (item.payload instanceof Uri) targetUri = item.payload;
                    else if (item.payload?.uri) targetUri = item.payload.uri;
                    else if (item.name) targetUri = this.path.clone().append(...item.name.split('/')).uri;

                    try {
                        const stat = await vscode.workspace.fs.stat(targetUri);
                        if (stat.type & FileType.Directory) { this.current.activeItems = [item]; await this.stepIn(); return; }
                        this.openFile(targetUri, item.action === Action.OpenFileBeside ? ViewColumn.Beside : undefined, item.payload?.range, item.payload?.selectionRange);
                    } catch (e) {
                        ensureSafe(targetUri);
                        if (item.name.endsWith('/')) { await vscode.workspace.fs.createDirectory(targetUri); await this.update(); }
                        else { await vscode.workspace.fs.createDirectory(Uri.joinPath(targetUri, '..')); this.openFile(targetUri.with({ scheme: "untitled" }), item.action === Action.OpenFileBeside ? ViewColumn.Beside : undefined); }
                    }
                    break;
                }
                case Action.RenameFile: { this.keepAlive = true; this.hide(); await this.rename(); this.show(); this.keepAlive = false; await this.popState(); break; }
                case Action.DeleteFile: { ensureSafe(this.path.uri); if (await this.confirmAction(`Delete?`, "Trash", true)) { await vscode.workspace.fs.delete(this.path.uri, { recursive: true, useTrash: true }); await this.popState(); } break; }
                case Action.OpenFolder: { vscode.commands.executeCommand("vscode.openFolder", this.path.uri); break; }
                case Action.OpenFolderInNewWindow: { vscode.commands.executeCommand("vscode.openFolder", this.path.uri, true); break; }
                default: throw new Error(`Unhandled action`);
            }
        } catch (err: any) { vscode.window.showErrorMessage(`Failed: ${err.message}`); this.current.busy = false; }
    }

    tabCompletion() {
        if (this.inActions) return;
        const val = this.current.value;
        if (val.match(/^(\$$|\$|%%|%|@@|@|!|#|:)/)) return;
        const tokenMatch = val.match(/(\S+)$/); if (!tokenMatch) return;
        const token = tokenMatch[1];
        const prefixMatch = token.match(/^([rdcm]:)/);
        const cmdPrefix = prefixMatch ? prefixMatch[0] : "";
        const restToken = token.substring(cmdPrefix.length);
        const lastSlashIdx = restToken.lastIndexOf('/');
        const searchPart = restToken.substring(lastSlashIdx + 1);
        if (/[*?]$/.test(searchPart)) return;
        const typedTextMatch = searchPart.match(/[^*?]+$/);
        const typedText = typedTextMatch ? typedTextMatch[0] : "";
        const typedLower = typedText.toLowerCase();

        const validItems = this.current.items.filter(item =>
            item.fileType !== undefined &&
            item.name &&
            item.action === undefined
        );

        if (validItems.length === 0) return;

        const candidates: { text: string, isDir: boolean }[] = [];
        for (const item of validItems) {
            const basename = OSPath.basename(item.name);
            const basenameLower = basename.toLowerCase();

            if (typedLower === "" || basenameLower.startsWith(typedLower)) {
                candidates.push({
                    text: basename,
                    isDir: !!(item.fileType !== undefined && item.fileType & FileType.Directory)
                });
            }
        }

        if (candidates.length === 0) return;

        // 计算最长公共前缀 (LCP)
        let lcp = "";
        let j = 0;
        while (true) {
            if (j >= candidates[0].text.length) break;
            const charStrict = candidates[0].text[j];
            const charLower = charStrict.toLowerCase();
            let allMatchLower = true;
            let allMatchStrict = true;
            for (let i = 1; i < candidates.length; i++) {
                if (j >= candidates[i].text.length) { allMatchLower = false; break; }
                const compareChar = candidates[i].text[j];
                if (compareChar.toLowerCase() !== charLower) { allMatchLower = false; break; }
                if (compareChar !== charStrict) allMatchStrict = false;
            }
            if (!allMatchLower) break;
            lcp += charStrict;
            j++;
        }

        let newSuffix = lcp;
        // 如果仅匹配到一个且为目录，自动补全末尾的斜杠 /
        if (candidates.length === 1 && candidates[0].text === lcp && candidates[0].isDir) {
            newSuffix += '/';
        }

        // 替换光标前的输入文本
        const newValue = val.substring(0, val.length - typedText.length) + newSuffix;
        if (this.current.value !== newValue) {
            this.current.value = newValue;
        }
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
    context.subscriptions.push(vscode.commands.registerCommand("file-browser.rename", () => active.chainNone(() => {
        const doc = vscode.window.activeTextEditor?.document;
        const wsf = vscode.workspace.workspaceFolders?.[0];
        const path = new Path(doc?.uri || wsf?.uri || Uri.file(OS.homedir()));
        active = Some(new FileBrowser(path, None)); setContext(true); return active;
    }).ifSome(a => a.rename())));
    context.subscriptions.push(vscode.commands.registerCommand("file-browser.stepIn", () => active.ifSome(a => a.stepIn())));
    context.subscriptions.push(vscode.commands.registerCommand("file-browser.stepOut", () => active.ifSome(a => a.stepOut())));
    context.subscriptions.push(vscode.commands.registerCommand("file-browser.actions", () => active.ifSome(a => a.actions())));
    context.subscriptions.push(vscode.commands.registerCommand("file-browser.tabNext", () => active.ifSome(a => a.tabCompletion())));
    context.subscriptions.push(vscode.commands.registerCommand("file-browser.tabPrev", () => active.ifSome(a => a.tabCompletion())));
}

export function deactivate() { }