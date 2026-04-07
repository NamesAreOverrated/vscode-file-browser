
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
    targetPayload?: any;
}

class FileBrowser {
    current: vscode.QuickPick<FileItem>;

    // 核心状态
    path: Path;
    file: Option<string>;
    items: FileItem[] = [];
    inActions: boolean = false;
    targetPayload?: any;

    // 视图路由历史栈
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
        this.current.onDidChangeActive(items => {
            if (items[0]) this.preview(items[0]);
        });
    }

    // ================= Preview =================
    private previewTimeout?: NodeJS.Timeout;
    private urisToClose = new Set<string>();
    private async preview(item: FileItem) {
        if (this.inActions) return;
        if (this.previewTimeout) {
            clearTimeout(this.previewTimeout);
            this.previewTimeout = undefined;
        }

        if (!item || item.name === "") {
            this.closePreviewTab();
            this.clearDecorations();
            return;
        }

        const canPreview = item.action === undefined ||
            item.action === Action.GoToLine ||
            item.action === Action.OpenFile;

        if (!canPreview || (item.fileType !== undefined && (item.fileType & FileType.Directory))) {
            this.closePreviewTab();
            this.clearDecorations();
            return;
        }

        this.previewTimeout = setTimeout(async () => {
            let uri: Uri | undefined;
            let range: vscode.Range | undefined;
            let selectionRange: vscode.Range | undefined;

            if (item.payload?.uri) {
                uri = item.payload.uri;
                range = item.payload.range;
                selectionRange = item.payload.selectionRange;
            } else if (item.payload instanceof Uri) {
                uri = item.payload;
            } else if (item.name && !item.action) {
                uri = this.path.append(item.name).uri;
            }

            if (!uri) {
                return;
            }

            try {
                const stat = await vscode.workspace.fs.stat(uri);
                if (stat.type & FileType.Directory) {
                    return;
                }
            } catch (e) {
                return;
            }

            this.urisToClose.add(uri.toString());

            let targetColumn = vscode.window.tabGroups.activeTabGroup.viewColumn == vscode.ViewColumn.One ? vscode.ViewColumn.Two : vscode.ViewColumn.One;

            try {
                const editor = await vscode.window.showTextDocument(uri, {
                    preview: true,
                    preserveFocus: true,
                    viewColumn: targetColumn
                });

                if (range && !editor.selection.active.isEqual(range.start)) {
                    this.clearDecorations();
                    const targetPos = selectionRange || range;
                    editor.selection = new vscode.Selection(targetPos.start, targetPos.end);

                    if (item.action === Action.GoToLine) {
                        editor.setDecorations(rangeDecorationType, [range]);
                    } else {
                        editor.setDecorations(searchDecorationType, [range]);
                    }

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
                        }
                        this.urisToClose.delete(uriStr);
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

    // ================= 核心架构：视图状态管理 =================
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

        if (prevState.inputValue === "") {
            await this.update();
        } else {
            this.items = prevState.cachedItems;
            this.current.items = this.items;
            prevState.file.ifSome(f => {
                this.current.activeItems = this.items.filter(i => i.name === f);
            });
        }
    }

    // ================= UI 生命周期与事件 =================
    dispose() {
        this.closePreviewTab();
        this.clearDecorations();
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

        if (!this.isRestoringState) {
            this.current.value = "";
        }

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
        this.activeItem().ifSome(async (item) => {
            if (item.action !== undefined && !(item.payload && item.payload.name)) {
                this.runAction(item);
                return;
            }

            this.pushState();

            if (item.fileType !== undefined) {
                if ((item.fileType & FileType.Directory) === FileType.Directory) {
                    let u = item.payload instanceof Uri ? item.payload : item.payload?.uri;
                    if (u && u.scheme) this.path = new Path(u);
                    else this.path.push(item.name);
                    this.inActions = false;
                    await this.update();
                } else if ((item.fileType & FileType.File) === FileType.File) {
                    let u = item.payload instanceof Uri ? item.payload : item.payload?.uri;
                    if (u && u.scheme) this.path = new Path(u);
                    else this.path.push(item.name);

                    this.file = None;
                    this.inActions = true;
                    this.targetPayload = item.payload;
                    await this.update();
                }
            }
        });
    }

    async stepOut() {
        if (this.stateStack.length > 0) {
            await this.popState();
            return;
        }

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
        this.targetPayload = undefined;

        this.activeItem().ifSome(item => {
            let u = item.payload instanceof Uri ? item.payload : item.payload?.uri;
            if (u && u.scheme) this.path = new Path(u);
            else this.path.push(item.name);

            this.targetPayload = item.payload;
        });

        await this.update();
    }

    onDidAccept() {
        this.stepIn();
    }

    // ================= 搜索与输入处理 (Input Handlers) =================
    async onDidChangeValue(value: string) {
        if (this.isRestoringState || this.inActions) return;

        ++this.searchToken;

        if (this.searchTimeout) {
            clearTimeout(this.searchTimeout);
            this.searchTimeout = undefined;
        }

        if (value === "") {
            this.current.busy = false;
            this.current.items = this.items;
            this.current.activeItems = [];
            return;
        }

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

        if (value.includes("{") || value.includes("*") || value.includes("?")) {
            return this.debounce(() => this.handleGlobAndCreateSearch(value));
        }

        if (value.includes("/")) {
            return this.debounce(() => this.handlePathSearch(value), 100);
        }

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
        this.current.busy = false;
    }

    private debounce(func: () => void | Promise<void>, delay: number = 250) {
        this.searchTimeout = setTimeout(async () => {
            await func();
        }, delay);
    }

    async handleTextSearch(query: string, isGlobal: boolean) {
        if (query.length < 2) {
            this.current.items = [{ label: "Type at least 2 chars to search text...", name: "", alwaysShow: true } as FileItem];
            return;
        }
        const token = ++this.searchToken;
        this.current.busy = true;

        try {
            const results: FileItem[] = [];
            const q = query.toLowerCase();

            if (!isGlobal) {
                const docs = vscode.workspace.textDocuments;
                for (const doc of docs) {
                    if (this.searchToken !== token) return;
                    for (let i = 0; i < doc.lineCount; i++) {
                        const line = doc.lineAt(i);
                        const index = line.text.toLowerCase().indexOf(q);
                        if (index !== -1) {
                            const matchRange = new vscode.Range(i, index, i, index + q.length);
                            results.push(this.createTextMatchItem(doc.uri, line.text, i, matchRange));
                        }
                    }
                }
            } else {
                const files = await vscode.workspace.findFiles('**/*', '{**/node_modules/**,**/.git/**,**/dist/**,**/build/**}', 250);
                if (this.searchToken !== token) return;

                const decoder = new TextDecoder('utf-8');
                const batchSize = 10;

                for (let i = 0; i < files.length; i += batchSize) {
                    if (this.searchToken !== token) return;
                    const batch = files.slice(i, i + batchSize);
                    await Promise.all(batch.map(async (uri) => {
                        try {
                            const data = await vscode.workspace.fs.readFile(uri);
                            const text = decoder.decode(data);
                            const lines = text.split(/\r?\n/);
                            for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
                                const lineText = lines[lineIdx];
                                const index = lineText.toLowerCase().indexOf(q);
                                if (index !== -1) {
                                    const matchRange = new vscode.Range(lineIdx, index, lineIdx, index + q.length);
                                    results.push(this.createTextMatchItem(uri, lineText, lineIdx, matchRange));
                                }
                            }
                        } catch (e) { /* skip */ }
                    }));
                }
            }

            if (this.searchToken !== token) return;
            this.current.items = results.length > 0 ? results : [{ label: "No matching text found.", name: "", alwaysShow: true } as FileItem];
        } catch (e) { } finally {
            if (this.searchToken === token) this.current.busy = false;
        }
    }

    private createTextMatchItem(uri: Uri, text: string, lineIdx: number, range: vscode.Range): FileItem {
        const cleanText = text.trim().replace(/\s+/g, ' ');
        return {
            label: `$(text-size) ${cleanText.substring(0, 100)}`,
            description: `${vscode.workspace.asRelativePath(uri)} : ${lineIdx + 1}`,
            name: OSPath.basename(uri.fsPath),
            alwaysShow: true,
            fileType: FileType.File,
            payload: { uri, range }
        } as FileItem;
    }

    async handleDiagnosticSearch(query: string, isGlobal: boolean) {
        const token = ++this.searchToken;
        this.current.busy = true;
        try {
            const results: FileItem[] = [];
            const q = query.toLowerCase();

            let targetUris: string[] = [];
            if (!isGlobal) {
                targetUris = vscode.workspace.textDocuments.map(doc => doc.uri.toString());
            }

            const allDiagnostics = vscode.languages.getDiagnostics();
            for (const [uri, diags] of allDiagnostics) {
                if (!isGlobal && !targetUris.includes(uri.toString())) continue;

                for (const diag of diags) {
                    if (q && !diag.message.toLowerCase().includes(q)) continue;

                    const isError = diag.severity === vscode.DiagnosticSeverity.Error;
                    const icon = isError ? "$(error)" : "$(warning)";

                    results.push({
                        label: `${icon} ${diag.message.split('\n')[0]}`,
                        description: `${vscode.workspace.asRelativePath(uri)} : ${diag.range.start.line + 1}`,
                        name: OSPath.basename(uri.fsPath),
                        alwaysShow: true,
                        fileType: FileType.File,
                        payload: { uri, range: diag.range }
                    } as FileItem);
                }
            }

            if (this.searchToken !== token) return;
            this.current.items = results.length > 0 ? results : [{ label: "No errors or warnings found.", name: "", alwaysShow: true } as FileItem];
        } catch (e) { } finally {
            if (this.searchToken === token) this.current.busy = false;
        }
    }

    async handlePathSearch(value: string) {
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

    async handleSymbolSearch(query: string) {
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
                label: `${getSymbolIcon(s.kind)} ${s.name}`,
                name: s.name,
                description: `Line ${s.range.start.line + 1}`,
                alwaysShow: true,
                payload: {
                    uri: this.editorUri,
                    range: s.range,
                    selectionRange: s.selectionRange
                },
                fileType: FileType.File,
            } as FileItem));
        } catch (e) { } finally {
            if (this.searchToken === token) this.current.busy = false;
        }
    }

    async handleWorkspaceSymbolSearch(query: string) {
        query = query.trim();
        if (query.length < 2) {
            this.current.items = [{ label: "Type at least 2 chars to search workspace symbols...", name: "", alwaysShow: true } as FileItem];
            return;
        }
        const token = ++this.searchToken;
        this.current.busy = true;
        try {
            const symbols = await vscode.commands.executeCommand<vscode.SymbolInformation[]>('vscode.executeWorkspaceSymbolProvider', query);
            if (this.searchToken !== token) return;
            if (!symbols || symbols.length === 0) {
                this.current.items = [{ label: "No symbols found in workspace.", name: "", alwaysShow: true } as FileItem];
                return;
            }
            const importantKinds = new Set([
                vscode.SymbolKind.Class,
                vscode.SymbolKind.Method,
                vscode.SymbolKind.Function,
                vscode.SymbolKind.Field,
                vscode.SymbolKind.Property,
                vscode.SymbolKind.Struct,
                vscode.SymbolKind.Interface,
                vscode.SymbolKind.Enum,
                vscode.SymbolKind.Event,
                vscode.SymbolKind.Constructor
            ]);

            const filtered = symbols.filter(s => importantKinds.has(s.kind));

            this.current.items = filtered.slice(0, 200).map(s => {
                const container = s.containerName ? `${s.containerName} • ` : '';
                const path = vscode.workspace.asRelativePath(s.location.uri);
                return {
                    label: `${getSymbolIcon(s.kind)} ${s.name}`,
                    name: s.name,
                    description: `${container}${path} : ${s.location.range.start.line + 1}`,
                    alwaysShow: true,
                    fileType: FileType.File,

                    payload: {
                        uri: s.location.uri,
                        range: s.location.range,
                        selectionRange: new vscode.Range(s.location.range.start, s.location.range.start)
                    }
                } as FileItem;
            });
            if (this.current.items.length === 0) {
                this.current.items = [{ label: "No important symbols found.", name: "", alwaysShow: true } as FileItem];
            }
        } catch (e) { } finally {
            if (this.searchToken === token) this.current.busy = false;
        }
    }

    handleLineSearch(query: string) {
        const line = parseInt(query.trim(), 10);
        if (isNaN(line) || !this.editorUri) {
            this.current.items = [{ label: "Type a line number...", name: "", alwaysShow: true } as FileItem];
            return;
        }

        const targetLine = Math.max(0, line - 1);
        const range = new vscode.Range(targetLine, 0, targetLine, 0);

        this.current.items = [{
            label: `$(go-to-file) Go to line ${line}`, name: query, alwaysShow: true, fileType: FileType.File, payload: { uri: this.editorUri, range }
        } as FileItem];
    }

    async handleGlobalFileSearch(query: string) {
        const token = ++this.searchToken;
        query = query.trim();
        if (query.length < 2) {
            this.current.items = [{ label: "Type at least 2 chars to search...", name: "", alwaysShow: true } as FileItem];
            return;
        }
        this.current.busy = true;
        try {
            const globPattern = toCaseInsensitiveGlob(query);
            const files = await vscode.workspace.findFiles(`**/*${globPattern}*`, '**/node_modules/**', 50);
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
        const token = ++this.searchToken;
        query = query.trim();
        if (query.length < 1) {
            this.current.items = [{ label: "Type to search folders globally...", name: "", alwaysShow: true } as FileItem];
            return;
        }
        this.current.busy = true;
        try {
            const globPattern = toCaseInsensitiveGlob(query);
            const files = await vscode.workspace.findFiles(`**/*${globPattern}*/**`, '**/node_modules/**', 200);
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

    async handleGlobAndCreateSearch(value: string) {
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

    // 重构的 Bulk Operation：完美解决盲打问题
    async handleBulkOp(fullQuery: string, action: Action) {
        const token = ++this.searchToken;
        this.current.busy = true;

        const queryValue = fullQuery.substring(2); // 取出前缀后的内容 (e.g. "d:*")
        const parts = splitArgs(queryValue.trim());

        let label = "";
        let payload: any = {};
        let matchedFiles: FileItem[] = [];

        const matchPattern = parts.length > 0 ? parts[0] : "";
        const onlyDirs = matchPattern.endsWith('/');
        const isSingleArg = parts.length === 1;

        // --- 编辑器单文件快速操作 ---
        if (isSingleArg && this.editorUri && matchPattern) {
            if ((action === Action.BulkCopy || action === Action.BulkMove)) {
                const oldUri = this.editorUri;
                const newBase = matchPattern;
                const isMove = action === Action.BulkMove;
                this.current.items = [{
                    label: `$(files) ${isMove ? 'Move' : 'Copy'} current file to '${newBase}'`, name: newBase,
                    alwaysShow: true, action: isMove ? Action.SingleMove : Action.SingleCopy, payload: { oldUri, newUri: Uri.joinPath(oldUri, '..', newBase) }
                } as FileItem];
                this.current.busy = false;
                return;
            } else if (action === Action.BulkRename) {
                const oldUri = this.editorUri;
                const newBase = matchPattern;
                this.current.items = [{
                    label: `$(edit) Rename current file to '${newBase}'`, name: newBase,
                    alwaysShow: true, action: Action.SingleRename, payload: { oldUri, newUri: Uri.joinPath(oldUri, '..', newBase) }
                } as FileItem];
                this.current.busy = false;
                return;
            }
        }

        let resolvedPaths: { name: string, uri: Uri }[] = [];
        if (matchPattern) {
            try {
                resolvedPaths = await expandPathWildcards(this.path.uri, matchPattern, true);
            } catch (e) { }
        }

        if (this.searchToken !== token) return;

        // --- 构建批量操作菜单与精确匹配项 ---
        if (matchPattern && (action === Action.BulkCopy || action === Action.BulkMove) && parts.length >= 2) {
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
        } else if (matchPattern && action === Action.BulkRename && parts.length >= 2) {
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
            label = matchPattern
                ? `Delete matching '${matchPattern}' (${resolvedPaths.length} items)`
                : `Type to bulk delete items...`;
            payload = { match: matchPattern, onlyDirs };
            matchedFiles = resolvedPaths.map(p => ({
                label: `$(trash) ${p.name} (Matched)`,
                name: p.name, alwaysShow: true, action: Action.SingleDelete, payload: { uri: p.uri }
            } as FileItem));
        } else {
            // 参数不足时显示提示信息
            const opName = action === Action.BulkRename ? "Rename" : action === Action.BulkCopy ? "Copy" : "Move";
            label = matchPattern ? `${opName} '${matchPattern}'... (provide destination)` : `Bulk ${opName}: type pattern and destination...`;
        }

        const items: FileItem[] = [];

        // 1. 插入执行操作主按钮
        if (matchPattern && resolvedPaths.length > 0 && payload && Object.keys(payload).length > 0) {
            items.push({ label: `$(zap) ${label}`, name: fullQuery, alwaysShow: true, action, payload } as FileItem);
        } else {
            items.push({ label: `$(info) ${label}`, name: fullQuery, alwaysShow: true } as FileItem);
        }

        // 2. 插入命中操作的具体文件列表
        items.push(...matchedFiles);

        // 3. 将当前目录尚未匹配到的文件也一并列出 (打破盲打)
        const matchedNames = new Set(resolvedPaths.map(p => p.name));
        const filterStr = matchPattern.replace(/[*?^{}()|[\]\\]/g, '').toLowerCase();

        const envItems = this.items.filter(item => {
            if (item.action !== undefined) return false;
            if (matchedNames.has(item.name)) return false;
            return item.name.toLowerCase().includes(filterStr);
        });

        if (envItems.length > 0) {
            items.push({ label: "--- Directory Contents ---", name: "", alwaysShow: true, description: "Unmatched / Context" } as FileItem);
            items.push(...envItems);
        }

        this.current.items = items;
        if (items.length > 0) this.current.activeItems = [items[0]];
        this.current.busy = false;
    }

    // ================= 文件操作与执行 (Actions) =================
    openFile(uri: Uri, column?: ViewColumn, range?: vscode.Range, selectionRange?: vscode.Range) {
        if (this.previewTimeout) {
            clearTimeout(this.previewTimeout);
            this.previewTimeout = undefined;
        }
        this.clearDecorations();
        let targetColumn = column;
        if (!targetColumn) {
            for (const group of vscode.window.tabGroups.all) {
                for (const tab of group.tabs) {
                    if (tab.input instanceof vscode.TabInputText &&
                        tab.input.uri.toString() === uri.toString() &&
                        !tab.isPreview) {
                        targetColumn = group.viewColumn;
                        break;
                    }
                }
                if (targetColumn) break;
            }
        }

        this.dispose();

        vscode.workspace.openTextDocument(uri).then((doc) => {
            vscode.window.showTextDocument(doc, {
                viewColumn: targetColumn || ViewColumn.Active,
                preview: false
            }).then(editor => {
                if (range) {
                    const targetSelection = selectionRange || range;
                    editor.selection = new vscode.Selection(targetSelection.start, targetSelection.end);
                    editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
                }
            });
        });
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
                    const payload = item.payload as { uri: Uri, range: vscode.Range, selectionRange?: vscode.Range };
                    this.openFile(payload.uri, undefined, payload.range, payload.selectionRange);
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
                    let targetUri = this.path.clone().uri;
                    let targetRange: vscode.Range | undefined;
                    let targetSelection: vscode.Range | undefined;
                    if (item.payload) {
                        if (item.payload instanceof Uri) {
                            targetUri = item.payload;
                        } else if (item.payload.uri) {
                            targetUri = item.payload.uri;
                            targetRange = item.payload.range;
                            targetSelection = item.payload.selectionRange;
                        }
                    } else if (item.name && item.name.length > 0) {
                        targetUri = this.path.clone().append(...item.name.split('/')).uri;
                    }

                    try {
                        const stat = await vscode.workspace.fs.stat(targetUri);
                        if ((stat.type & FileType.Directory) === FileType.Directory) {
                            this.current.activeItems = [item];
                            await this.stepIn();
                            return;
                        }

                        const targetCol = item.action === Action.OpenFileBeside ? ViewColumn.Beside : undefined;
                        this.openFile(targetUri, targetCol, targetRange, targetSelection);
                    } catch (e) {
                        if (item.name.endsWith('/')) {
                            await vscode.workspace.fs.createDirectory(targetUri);
                            this.update();
                        } else {
                            await vscode.workspace.fs.createDirectory(Uri.joinPath(targetUri, '..'));
                            this.openFile(targetUri.with({ scheme: "untitled" }), item.action === Action.OpenFileBeside ? ViewColumn.Beside : undefined);
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
                    await this.popState();
                    break;
                }
                case Action.DeleteFile: {
                    if (await this.confirmAction(`Delete ${OSPath.basename(this.path.uri.fsPath)}?`, "Move to trash.", true)) {
                        await vscode.workspace.fs.delete(this.path.uri, { recursive: true, useTrash: true });
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


    tabCompletion() {
        if (this.inActions) return;

        const val = this.current.value;

        // 1. 禁用特殊模式下的补全
        if (val.match(/^(\$$|\$|%%|%|@@|@|!|#|:)/)) {
            return;
        }

        // 2. 提取当前正在输入的最后一个 Token (支持多参数)
        const tokenMatch = val.match(/(\S+)$/);
        if (!tokenMatch) return;
        const token = tokenMatch[1];

        // 3. 提取命令前缀 (如 d:, r:) 并找到搜索部分
        const prefixMatch = token.match(/^([rdcm]:)/);
        const cmdPrefix = prefixMatch ? prefixMatch[0] : "";
        const restToken = token.substring(cmdPrefix.length);

        // 4. 分离路径和搜索词
        const lastSlashIdx = restToken.lastIndexOf('/');
        const searchPart = restToken.substring(lastSlashIdx + 1);

        // 如果以通配符结尾，不执行普通后缀补全
        if (/[*?]$/.test(searchPart)) return;

        // 提取搜索词末尾的字面量 (用于锚定补全位置)
        // 例如 `*_stora` -> `stora`
        const typedTextMatch = searchPart.match(/[^*?]+$/);
        const typedText = typedTextMatch ? typedTextMatch[0] : "";
        const typedLower = typedText.toLowerCase();

        // 5. 过滤出有效的文件项
        const validItems = this.current.items.filter(item =>
            item.fileType !== undefined && item.name
        );
        if (validItems.length === 0) return;

        const candidates: { text: string, isDir: boolean }[] = [];

        for (const item of validItems) {
            const basename = OSPath.basename(item.name);
            // 使用 indexOf 解决 "iiiiii" 匹配到末尾 "ii" 的问题
            const idx = typedLower === "" ? 0 : basename.toLowerCase().indexOf(typedLower);

            if (idx !== -1) {
                candidates.push({
                    // text 是从匹配点开始直到文件末尾的完整部分
                    text: basename.substring(idx),
                    isDir: !!(item.fileType !== undefined && item.fileType & FileType.Directory)
                });
            }
        }

        if (candidates.length === 0) return;

        // 6. 计算 LCP (最长公共前缀)，同时修复大小写
        let lcp = "";
        let j = 0;
        while (true) {
            if (j >= candidates[0].text.length) break;

            const charStrict = candidates[0].text[j]; // 实际文件的字符
            const charLower = charStrict.toLowerCase();
            let allMatchLower = true;
            let allMatchStrict = true;

            for (let i = 1; i < candidates.length; i++) {
                if (j >= candidates[i].text.length) {
                    allMatchLower = false;
                    break;
                }
                const compareChar = candidates[i].text[j];
                if (compareChar.toLowerCase() !== charLower) {
                    allMatchLower = false;
                    break;
                }
                if (compareChar !== charStrict) {
                    allMatchStrict = false;
                }
            }

            if (!allMatchLower) break;

            // 遵循实际文件的大小写：
            // 如果所有匹配项该位置字符相同，用该字符。
            // 如果大小写有分歧但字符相同，默认取第一个候选者的字符（遵循实际文件）
            lcp += allMatchStrict ? charStrict : charStrict;
            j++;
        }

        // 7. 补全文件夹的 / 逻辑
        let newSuffix = lcp;
        if (candidates.length === 1) {
            // 只有当 LCP 完全等于候选者的剩余全名时，才说明名字打完了，此时才加 /
            if (candidates[0].text === lcp && candidates[0].isDir) {
                newSuffix += '/';
            }
        }

        // 8. 替换文本
        // 将原本的 typedText 替换为补全后的 newSuffix
        // 这保证了 `*_stora` 前面的 `*_` 被保留
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

    // 覆盖旧的 Tab 命令：无论执行哪个都触发标准化的智能补全
    context.subscriptions.push(vscode.commands.registerCommand("file-browser.tabNext", () => active.ifSome(a => a.tabCompletion())));
    context.subscriptions.push(vscode.commands.registerCommand("file-browser.tabPrev", () => active.ifSome(a => a.tabCompletion())));
}

export function deactivate() { }