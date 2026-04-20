import * as vscode from "vscode";
import { Uri, FileType, QuickInputButton, ThemeIcon, ViewColumn, DocumentSymbol } from "vscode";
import * as OS from "os";
import * as OSPath from "path";

import { Result, None, Option, Some } from "@bodil/opt";
import { lookUpwards, Path } from "./path";
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

    let escapedFrom = from.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
    escapedFrom = escapedFrom.replace(/\*\*/g, '\0');
    escapedFrom = escapedFrom.replace(/\*/g, '([^/]*)');
    escapedFrom = escapedFrom.replace(/\0/g, '(.*)');

    const regexStr = '^' + escapedFrom + '$';
    const regex = new RegExp(regexStr);
    const match = name.match(regex);
    if (!match) return null;

    let result = '';
    let groupIndex = 1;

    for (let i = 0; i < to.length; i++) {
        if (to[i] === '*') {
            if (i + 1 < to.length && to[i + 1] === '*') {
                if (groupIndex < match.length) result += match[groupIndex++];
                i++;
            } else {
                if (groupIndex < match.length) result += match[groupIndex++];
            }
        } else {
            result += to[i];
        }
    }
    return result;
}
// ================= 路径解析逻辑 =================

function expandBraces(str: string): string[] {
    const rangeMatch = str.match(/^(.*?)\{([0-9a-zA-Z]+)\.\.([0-9a-zA-Z]+)\}(.*)$/);
    if (rangeMatch) {
        const [_, pre, startStr, endStr, post] = rangeMatch;
        const results: string[] = [];

        const isNumber = /^\d+$/.test(startStr) && /^\d+$/.test(endStr);
        if (isNumber) {
            const start = parseInt(startStr, 10);
            const end = parseInt(endStr, 10);
            const step = start < end ? 1 : -1;
            const padLen = Math.max(startStr.length, endStr.length);

            for (let i = start; start < end ? i <= end : i >= end; i += step) {
                const numStr = i.toString().padStart(startStr.startsWith('0') ? padLen : 0, '0');
                results.push(...expandBraces(pre + numStr + post));
            }
        } else if (startStr.length === 1 && endStr.length === 1) {
            const start = startStr.charCodeAt(0);
            const end = endStr.charCodeAt(0);
            const step = start < end ? 1 : -1;
            for (let i = start; start < end ? i <= end : i >= end; i += step) {
                results.push(...expandBraces(pre + String.fromCharCode(i) + post));
            }
        }
        return results;
    }

    const listMatch = str.match(/^(.*?)\{([^{}]+)\}(.*)$/);
    if (listMatch) {
        const results: string[] = [];
        const parts = listMatch[2].split(',');
        for (const p of parts) {
            results.push(...expandBraces(listMatch[1] + p.trim() + listMatch[3]));
        }
        return results;
    }

    return [str];
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

    const patterns = expandBraces(pattern);
    const results: ExpandedPath[] = [];
    const seen = new Set<string>();

    for (const pat of patterns) {
        const clean = pat.endsWith('/') ? pat.slice(0, -1) : pat;
        const segments = clean.split('/').filter(Boolean);

        let current: { name: string, uri: Uri, isDir: boolean }[] = [{ name: "", uri: baseUri, isDir: true }];

        for (let i = 0; i < segments.length; i++) {
            const seg = segments[i];
            const next: typeof current = [];

            for (const cur of current) {
                if (!cur.isDir) continue;

                if (seg === '..') {
                    const parentUri = Uri.joinPath(cur.uri, '..');
                    next.push({
                        name: cur.name ? `${cur.name}/..` : '..',
                        uri: parentUri,
                        isDir: true
                    });
                    continue;
                }

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

                if (seg.includes('*') || seg.includes('?') || fuzzy) {
                    try {
                        const entries = await vscode.workspace.fs.readDirectory(cur.uri);
                        for (const [n, t] of entries) {
                            let isDir = !!(t & FileType.Directory);
                            if (t === FileType.SymbolicLink) {
                                try {
                                    const linkStat = await vscode.workspace.fs.stat(Uri.joinPath(cur.uri, n));
                                    isDir = !!(linkStat.type & FileType.Directory);
                                } catch { }
                            }
                            const patternStr = seg.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
                            const regex = fuzzy ? new RegExp(`.*${patternStr}.*`, 'i') : new RegExp(`^${patternStr}$`);

                            if (regex.test(n)) {
                                next.push({
                                    name: cur.name ? `${cur.name}/${n}` : n,
                                    uri: Uri.joinPath(cur.uri, n),
                                    isDir: isDir
                                });
                            }


                        }
                    } catch { }
                    continue;
                }

                const nextUri = Uri.joinPath(cur.uri, seg);
                let nextIsDir = false;
                try {
                    const s = await vscode.workspace.fs.stat(nextUri);
                    nextIsDir = !!(s.type & FileType.Directory);
                } catch {
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
                continue;
            }

            if (onlyDirs && !isDir) continue;
            results.push({ name: p.name || ".", uri: p.uri, exists, type, isDir });
        }
    }

    return results;
}

export async function resolveExistingPaths(baseUri: Uri, pattern: string, onlyDirs: boolean = false): Promise<{ name: string, uri: Uri, type: FileType }[]> {
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

async function findDirectoriesSmart(baseUri: Uri, query: string, token: number, searchTokenRef: { value: number }): Promise<ExpandedPath[]> {
    const results: ExpandedPath[] = [];
    const seen = new Set<string>();

    if (!query) {
        try {
            const entries = await vscode.workspace.fs.readDirectory(baseUri);
            for (const [name, type] of entries) {
                if (type & FileType.Directory) {
                    const uri = Uri.joinPath(baseUri, name);
                    results.push({
                        name: name,
                        uri: uri,
                        exists: true,
                        isDir: true,
                        type: FileType.Directory
                    });
                    seen.add(uri.toString());
                }
            }
        } catch (e) { }
        return results;
    }

    const localResults = await expandPaths(baseUri, query, {
        onlyExisting: true,
        onlyDirs: true,
        fuzzy: true,
        maxDepth: 3
    });

    if (searchTokenRef.value !== token) return [];

    for (const r of localResults) {
        results.push(r);
        seen.add(r.uri.toString());
    }

    if (results.length < 5 && !query.includes('/') && !query.includes('.')) {
        try {
            const globPattern = toCaseInsensitiveGlob(query);
            const globalFiles = await vscode.workspace.findFiles(`**/*${globPattern}*/**`, '**/node_modules/**', 50);

            for (const f of globalFiles) {
                if (searchTokenRef.value !== token) break;
                let currentUri = f;
                while (currentUri.fsPath.length > (vscode.workspace.getWorkspaceFolder(f)?.uri.fsPath.length || 0)) {
                    const dirUri = Uri.joinPath(currentUri, '..');
                    const dirName = OSPath.basename(dirUri.fsPath);
                    if (dirName.toLowerCase().includes(query.toLowerCase())) {
                        const dirStr = dirUri.toString();
                        if (!seen.has(dirStr)) {
                            seen.add(dirStr);
                            results.push({
                                name: vscode.workspace.asRelativePath(dirUri),
                                uri: dirUri,
                                exists: true,
                                isDir: true,
                                type: FileType.Directory
                            });
                        }
                    }
                    currentUri = dirUri;
                    if (results.length > 50) break;
                }
            }
        } catch (e) { }
    }

    return results;
}
// ================= 配置与上下文 =================

export enum ConfigItem {
    ExplorerExcludeHidden = "explorer.excludeHidden",
    ExplorerExcludeGitIgnore = "explorer.excludeGitIgnore",
    ExplorerExcludeVSCodeFiles = "explorer.excludeVSCodeFiles",

    SearchRespectExcludes = "search.respectVSCodeExcludes",
    SearchRespectGitIgnore = "search.respectGitIgnore",
    SearchExcludePatterns = "search.excludePatterns",

    PreviewIgnoreExtensions = "previewIgnoreExtensions",
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

    private originalSelection?: vscode.Selection;
    private originalVisibleRanges?: readonly vscode.Range[];
    private originalViewColumn?: vscode.ViewColumn;
    private accepted: boolean = false;
    private touchedEditors = new Map<string, { selection: vscode.Selection, visibleRanges: readonly vscode.Range[], viewColumn: vscode.ViewColumn, uri: Uri }>();
    private exemptTarget?: { uri: string, column: vscode.ViewColumn };

    actionsButton: QuickInputButton = { iconPath: new ThemeIcon("ellipsis"), tooltip: "Actions on selected file" };
    terminalButton: QuickInputButton = { iconPath: new ThemeIcon("terminal"), tooltip: "Open terminal in current folder" };
    stepOutButton: QuickInputButton = { iconPath: new ThemeIcon("arrow-left"), tooltip: "Step out of folder" };
    stepInButton: QuickInputButton = { iconPath: new ThemeIcon("arrow-right"), tooltip: "Step into folder" };

    constructor(path: Path, file: Option<string>) {
        this.path = path;
        this.file = file;
        this.pathHistory = { [this.path.id]: this.file };

        const editor = vscode.window.activeTextEditor;
        if (editor) {
            this.editorUri = editor.document.uri;
            this.originalSelection = editor.selection;
            this.originalVisibleRanges = editor.visibleRanges;
            this.originalViewColumn = editor.viewColumn;
        }

        this.current = vscode.window.createQuickPick();
        this.current.buttons = [this.actionsButton, this.terminalButton, this.stepOutButton, this.stepInButton];
        this.current.placeholder = "Preparing the file list...";
        this.current.onDidHide(() => { if (!this.keepAlive) this.dispose(); });
        this.current.onDidAccept(this.onDidAccept.bind(this));
        this.current.onDidChangeValue(this.onDidChangeValue.bind(this));
        this.current.onDidTriggerButton(this.onDidTriggerButton.bind(this));
        this.update().then(() => {
            this.current.placeholder = "Type a file name, paths, or commands (@@, @, $$, $, ^, etc.)";
            this.current.busy = false;
        });
        this.current.onDidChangeActive(items => { this.preview(items[0]); });
    }

    private previewToken = 0;
    private previewTimeout?: NodeJS.Timeout;
    private currentPreviewTab?: vscode.Tab;

    private async preview(item?: FileItem) {
        if (this.inActions) return;
        if (this.previewTimeout) { clearTimeout(this.previewTimeout); this.previewTimeout = undefined; }

        if (!item || item.name === "") {
            this.closePreviewTab();
            this.clearDecorations();
            return;
        }

        const canPreview = item.action === undefined || item.action === Action.GoToLine || item.action === Action.OpenFile;
        if (!canPreview || (item.fileType !== undefined && (item.fileType & FileType.Directory))) {
            this.closePreviewTab();
            this.clearDecorations();
            return;
        }

        const currentToken = ++this.previewToken;

        this.previewTimeout = setTimeout(async () => {
            if (this.previewToken !== currentToken) return;

            let uri: Uri | undefined;
            let range: vscode.Range | undefined;
            let selectionRange: vscode.Range | undefined;

            if (item.payload?.uri) { uri = item.payload.uri; range = item.payload.range; selectionRange = item.payload.selectionRange; }
            else if (item.payload instanceof Uri) { uri = item.payload; }
            else if (item.name && !item.action) { uri = this.path.append(item.name).uri; }

            if (!uri) { this.clearDecorations(); return; }

            try {
                const stat = await vscode.workspace.fs.stat(uri);

                if (stat.type & FileType.Directory) return;

                // 智能拦截：文件大小限制 (例如 > 2MB 则不预览，防止卡死)
                if (stat.size > 2 * 1024 * 1024) {
                    this.clearDecorations();
                    return;
                }

                const ignoreConfig = config<string[]>(ConfigItem.PreviewIgnoreExtensions) || [];
                const ignorePreviewExts = new Set(ignoreConfig.map(ext => ext.startsWith('.') ? ext.toLowerCase() : `.${ext.toLowerCase()}`));

                const ext = OSPath.extname(uri.fsPath).toLowerCase();
                if (ignorePreviewExts.has(ext)) {
                    this.clearDecorations();
                    return;
                }

            } catch (e) { return; }

            const oldTab = this.currentPreviewTab;
            this.clearDecorations();

            let targetColumn: ViewColumn | undefined;
            const uriStr = uri.toString();

            if (range) {
                const visibleEditors = vscode.window.visibleTextEditors;
                const editorInOriginal = visibleEditors.find(e => e.document.uri.toString() === uriStr && e.viewColumn === this.originalViewColumn);

                if (editorInOriginal) {
                    targetColumn = editorInOriginal.viewColumn;
                } else {
                    const anyVisibleEditor = visibleEditors.find(e => e.document.uri.toString() === uriStr);
                    if (anyVisibleEditor) {
                        targetColumn = anyVisibleEditor.viewColumn;
                    }
                }
            }

            if (!targetColumn) {
                const activeGroup = vscode.window.tabGroups.activeTabGroup;
                const tabInActive = activeGroup.tabs.find(t => t.input instanceof vscode.TabInputText && t.input.uri.toString() === uriStr);

                if (tabInActive) {
                    targetColumn = activeGroup.viewColumn;
                } else {
                    targetColumn = this.originalViewColumn || vscode.ViewColumn.Active;
                }
            }

            try {
                const editor = await vscode.window.showTextDocument(uri, { preview: true, preserveFocus: true, viewColumn: targetColumn });

                if (this.previewToken !== currentToken) return;

                const targetGroup = vscode.window.tabGroups.all.find(g => g.viewColumn === editor.viewColumn);
                const activeTab = targetGroup?.activeTab;
                const isMatch = activeTab?.input instanceof vscode.TabInputText && activeTab.input.uri.toString() === uriStr;

                if (isMatch && activeTab.isPreview) {
                    this.currentPreviewTab = activeTab;
                } else {
                    this.currentPreviewTab = undefined;
                }

                if (oldTab && oldTab.input instanceof vscode.TabInputText) {
                    const oldUriStr = oldTab.input.uri.toString();
                    if (oldUriStr !== uriStr) {
                        this.safeCloseTab(oldTab).catch(e => console.error(e));
                    }
                }

                if (!activeTab?.isPreview && isMatch) {
                    const stateKey = `${uriStr}::${editor.viewColumn}`;
                    if (!this.touchedEditors.has(stateKey)) {
                        this.touchedEditors.set(stateKey, {
                            uri: uri, viewColumn: editor.viewColumn!,
                            selection: editor.selection, visibleRanges: editor.visibleRanges
                        });
                    }
                }

                if (range) {
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

    private async safeCloseTab(tab: vscode.Tab) {
        if (!tab || tab.isPinned) {
            return;
        }
        try {
            if (tab.input instanceof vscode.TabInputText) {
                const tabURL = tab.input.uri.toString();
                for (const group of vscode.window.tabGroups.all) {
                    if (group.viewColumn === tab.group.viewColumn) {
                        for (const checkTab of group.tabs) {
                            if (checkTab.input instanceof vscode.TabInputText) {
                                const uriStr = checkTab.input.uri.toString();
                                if (tabURL === uriStr) {
                                    if (checkTab.isPreview) {
                                        await vscode.window.tabGroups.close(checkTab, true);
                                        return;
                                    }
                                }
                            }
                        }
                    }
                }
            }
        } catch (err) {
            console.error("Failed to safely close tab:", err);
        }
    }

    private closePreviewTab() {
        if (this.currentPreviewTab) {
            this.safeCloseTab(this.currentPreviewTab);
            this.currentPreviewTab = undefined;
        }
    }

    private clearDecorations() {
        vscode.window.visibleTextEditors.forEach(editor => {
            editor.setDecorations(searchDecorationType, []);
            editor.setDecorations(rangeDecorationType, []);
        });
    }

    private restoreEditorState(state: { uri: Uri, viewColumn: vscode.ViewColumn, selection: vscode.Selection, visibleRanges: readonly vscode.Range[] }, preserveFocus: boolean) {
        const editor = vscode.window.visibleTextEditors.find(e =>
            e.document.uri.toString() === state.uri.toString() &&
            e.viewColumn === state.viewColumn
        );
        if (editor) {
            editor.selection = state.selection;
            if (state.visibleRanges && state.visibleRanges.length > 0) {
                editor.revealRange(state.visibleRanges[0], vscode.TextEditorRevealType.InCenterIfOutsideViewport);
            }
            if (!preserveFocus) {
                vscode.window.showTextDocument(editor.document, {
                    viewColumn: state.viewColumn,
                    preserveFocus: false,
                    preview: false
                });
            }
        } else {
            vscode.workspace.openTextDocument(state.uri).then(doc => {
                vscode.window.showTextDocument(doc, {
                    viewColumn: state.viewColumn,
                    preserveFocus: preserveFocus,
                    preview: false
                }).then(e => {
                    e.selection = state.selection;
                    if (state.visibleRanges && state.visibleRanges.length > 0) {
                        e.revealRange(state.visibleRanges[0], vscode.TextEditorRevealType.InCenterIfOutsideViewport);
                    }
                });
            });
        }
    }

    private getRelativeDisplayPath(uri: Uri): string {
        let rel = OSPath.relative(this.path.uri.fsPath, uri.fsPath);
        if (!rel) return ".";
        rel = rel.replace(/\\/g, '/');
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

    dispose() {
        this.closePreviewTab();
        this.clearDecorations();

        // 还原所有被扰乱过的非目标编辑器光标位置
        for (const state of this.touchedEditors.values()) {
            if (this.exemptTarget && state.uri.toString() === this.exemptTarget.uri && state.viewColumn === this.exemptTarget.column) {
                continue;
            }
            if (this.editorUri && state.uri.toString() === this.editorUri.toString() && state.viewColumn === this.originalViewColumn) {
                continue;
            }
            this.restoreEditorState(state, true);
        }

        // 原始主窗口的处理
        if (this.editorUri && this.originalSelection) {
            const isExempt = this.exemptTarget && (this.editorUri.toString() === this.exemptTarget.uri && this.originalViewColumn === this.exemptTarget.column);
            if (!isExempt) {
                this.restoreEditorState({
                    uri: this.editorUri,
                    viewColumn: this.originalViewColumn || vscode.ViewColumn.Active,
                    selection: this.originalSelection,
                    visibleRanges: this.originalVisibleRanges || []
                }, this.accepted); // 如果用户主动确认跳转至某处，保持还原但不强夺焦点；如果是退出取消，强行夺回焦点
            }
        }

        this.touchedEditors.clear();
        setContext(false);
        this.current.dispose();
        active = None;
    }
    hide() { this.current.hide(); setContext(false); }
    show() { setContext(true); this.current.show(); }
    activeItem(): Option<FileItem> { return Option.from(this.current.activeItems[0]); }

    onDidTriggerButton(button: QuickInputButton) {
        if (button === this.stepInButton) this.stepIn();
        else if (button === this.stepOutButton) this.stepOut();
        else if (button === this.actionsButton) this.actions();
        else if (button === this.terminalButton) this.openTerminal();
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
                action("$(terminal) Open terminal here", Action.OpenTerminal),
                action("$(edit) Rename this folder", Action.RenameFile),
                action("$(trash) Delete this folder", Action.DeleteFile),
            ];
        } else if (stat && (stat.type & FileType.Directory) === FileType.Directory) {
            const records = await vscode.workspace.fs.readDirectory(this.path.uri);
            records.sort(fileRecordCompare);
            let items = records.map((entry) => new FileItem(entry));

            const excludeHidden = config<boolean>(ConfigItem.ExplorerExcludeHidden) ?? false;
            if (excludeHidden) {
                items = items.filter(item => !item.name.startsWith('.'));
            }

            const excludeVSCode = config<boolean>(ConfigItem.ExplorerExcludeVSCodeFiles) ?? false;
            if (excludeVSCode) {
                const excludeSettings = vscode.workspace.getConfiguration('files').get<Record<string, boolean>>('exclude') || {};
                const excludePatterns = Object.keys(excludeSettings).filter(k => excludeSettings[k]);
                if (excludePatterns.length > 0) {
                    const ig = require('ignore')().add(excludePatterns);
                    items = items.filter(item => !ig.ignores(item.name));
                }
            }

            const excludeGit = config<boolean>(ConfigItem.ExplorerExcludeGitIgnore) ?? false;
            if (excludeGit) {
                const rules = await Rules.forPath(this.path);
                items = rules.filter(this.path, items);
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

        if (!this.path.atTop()) {
            const parentPath = this.path.clone();
            parentPath.pop();
            if (!isPathSafe(parentPath.uri)) {
                vscode.window.showInformationMessage("Cannot step out: Outside of workspace bounds.");
                return;
            }

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
        if (value.startsWith(">t")) return this.debounce(() => this.handleTerminalCommand(value.substring(2)));
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
    async getSearchExcludeGlob(): Promise<string> {
        const respect = config<boolean>(ConfigItem.SearchRespectExcludes) ?? true;
        const respectGit = config<boolean>(ConfigItem.SearchRespectGitIgnore) ?? true;
        const customPatterns = config<string[]>(ConfigItem.SearchExcludePatterns) || [];

        const patterns: Set<string> = new Set(customPatterns);

        // 1. 获取 VS Code 原生设置的排除
        if (respect) {
            const filesExclude = vscode.workspace.getConfiguration('files').get<Record<string, boolean>>('exclude') || {};
            const searchExclude = vscode.workspace.getConfiguration('search').get<Record<string, boolean>>('exclude') || {};
            Object.keys(filesExclude).filter(k => filesExclude[k]).forEach(p => patterns.add(p));
            Object.keys(searchExclude).filter(k => searchExclude[k]).forEach(p => patterns.add(p));
        }

        // 2. 获取 .gitignore 中的排除内容
        if (respectGit) {
            try {
                // 寻找当前目录或上层目录的 .gitignore
                const ruleFileNames = [".gitignore", ".ignore"];
                const ruleFilePath = await lookUpwards(this.path.uri, ruleFileNames);

                await ruleFilePath.match(
                    async (uri) => {
                        const content = (await vscode.workspace.fs.readFile(uri)).toString();
                        const lines = content.split(/\r?\n/);
                        for (let line of lines) {
                            line = line.trim();
                            // 过滤注释和空行
                            if (!line || line.startsWith('#')) continue;

                            // 简单的 gitignore 到 glob 的转换
                            // 如果是目录 (以/结尾)，转为 **/name/**
                            // 如果包含通配符，尝试保持原样或包裹
                            if (line.endsWith('/')) {
                                patterns.add(`**/${line}**`);
                            } else if (line.startsWith('/')) {
                                patterns.add(line.substring(1));
                            } else {
                                patterns.add(`**/${line}/**`);
                                patterns.add(`**/${line}`);
                            }
                        }
                    },
                    async () => { } // 没找到 ignore 文件则忽略
                );
            } catch (e) {
                // 容错处理
            }
        }

        const uniquePatterns = Array.from(patterns).filter(p => !!p);
        if (uniquePatterns.length === 0) return '**/node_modules/**';
        if (uniquePatterns.length === 1) return uniquePatterns[0];
        return `{${uniquePatterns.join(',')}}`;
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
                const excludes = await this.getSearchExcludeGlob();
                const files = await vscode.workspace.findFiles('**/*', excludes, 250);
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
            const globPattern = toCaseInsensitiveGlob(query);
            const excludes = await this.getSearchExcludeGlob();
            const files = await vscode.workspace.findFiles(`**/*${globPattern}*`, excludes, 50);
            if (this.searchToken !== token) return;
            this.current.items = files.map(uri => {
                const relToCurrent = this.getRelativeDisplayPath(uri);
                return {
                    label: `$(file) ${OSPath.basename(uri.fsPath)}`,
                    description: `rel: ${relToCurrent}`,
                    name: OSPath.basename(uri.fsPath),
                    alwaysShow: true,
                    payload: uri,
                    fileType: FileType.File,
                } as FileItem;
            });
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
                    label: (m.type & FileType.Directory) ? `$(folder) ${m.name}` : `$(file) ${m.name}`,
                    name: m.name,
                    description: "Existing Match",
                    alwaysShow: true,
                    fileType: m.type,
                    payload: m.uri
                } as FileItem);
            }
            for (const p of finalCreatePaths) { items.push({ label: p.isDir ? `$(add) [Folder] ${p.name}` : `$(add) ${p.name}`, name: p.name, description: "Preview (Click to create single item)", alwaysShow: true, action: Action.SingleCreate, payload: p } as FileItem); }
            this.current.items = items; if (items.length > 0) this.current.activeItems = [items[0]];
        } catch (e) { } this.current.busy = false;
    }

    async handleGlobalFolderSearch(query: string) {
        const token = ++this.searchToken;
        const queryTrim = query.trim();
        this.current.busy = true;

        try {
            const results = await findDirectoriesSmart(this.path.uri, queryTrim, token, { value: this.searchToken });
            if (this.searchToken !== token) return;

            this.current.items = results.map(r => ({
                label: `$(folder) ${r.name}`,
                description: vscode.workspace.asRelativePath(r.uri),
                name: r.name,
                alwaysShow: true,
                fileType: FileType.Directory,
                payload: r.uri
            } as FileItem));

            if (this.current.items.length === 0 && queryTrim) {
                this.current.items = [{ label: `$(info) No folders found matching "${queryTrim}"`, name: "", alwaysShow: true } as FileItem];
            }
        } finally {
            if (this.searchToken === token) this.current.busy = false;
        }

    }
    async handleTerminalCommand(query: string) {
        const token = ++this.searchToken;
        const queryTrim = query.trim();
        this.current.busy = true;

        const items: FileItem[] = [];

        items.push({
            label: `$(terminal) Open Terminal in Current Folder`,
            description: `./ (${this.path.fsPath})`,
            name: ">t",
            alwaysShow: true,
            action: Action.OpenTerminal as any,
            payload: { uri: this.path.uri }
        } as FileItem);

        try {
            const dirs = await findDirectoriesSmart(this.path.uri, queryTrim, token, { value: this.searchToken });
            if (this.searchToken !== token) return;

            const searchItems = dirs.map(d => ({
                label: `$(terminal) Open Terminal in: ${d.name}`,
                description: vscode.workspace.asRelativePath(d.uri),
                name: d.name,
                alwaysShow: true,
                action: Action.OpenTerminal as any,
                payload: { uri: d.uri }
            } as FileItem));

            items.push(...searchItems);
        } catch (e) { }

        if (this.searchToken === token) {
            this.current.items = items;
            if (items.length > 0) this.current.activeItems = [queryTrim ? (items[1] || items[0]) : items[0]];
            this.current.busy = false;
        }
    }

    // ================= 核心重构：Bulk 操作逻辑 =================

    async handleBulkOp(fullQuery: string, action: Action) {
        const token = ++this.searchToken;
        this.current.busy = true;

        const queryValue = fullQuery.substring(2);
        const parts = splitArgs(queryValue.trim());
        const matchPattern = parts.length > 0 ? parts[0] : "";
        const toPatternRaw = parts.length >= 2 ? parts[1] : "";
        const isSingleArg = parts.length === 1;

        let finalItems: FileItem[] = [];
        let mappings: { src: { name: string, uri: Uri }, target: Uri }[] = [];

        const isEditorInCurrentDir = !!(this.editorUri &&
            (OSPath.dirname(this.editorUri.fsPath) === OSPath.normalize(this.path.uri.fsPath)));

        if (isSingleArg && isEditorInCurrentDir && this.editorUri && matchPattern && action !== Action.BulkDelete) {
            const oldUri = this.editorUri;
            const newUri = Uri.joinPath(oldUri, '..', matchPattern);

            if (action === Action.BulkCopy || action === Action.BulkMove) {
                const isMove = action === Action.BulkMove;
                finalItems.push({
                    label: `$(files) ${isMove ? 'Move' : 'Copy'} current file -> ${this.getRelativeDisplayPath(newUri)}`,
                    name: matchPattern,
                    alwaysShow: true, action: isMove ? Action.SingleMove : Action.SingleCopy,
                    payload: { oldUri, newUri }
                } as FileItem);
            } else if (action === Action.BulkRename) {
                finalItems.push({
                    label: `$(edit) Rename current file -> ${this.getRelativeDisplayPath(newUri)}`,
                    name: matchPattern,
                    alwaysShow: true, action: Action.SingleRename,
                    payload: { oldUri, newUri }
                } as FileItem);
            }
        }

        else if (matchPattern && (action === Action.BulkCopy || action === Action.BulkMove || action === Action.BulkRename)) {
            const fromPatterns = expandBraces(matchPattern);
            const toPatterns = toPatternRaw ? expandBraces(toPatternRaw) : [""];
            const isCopy = action === Action.BulkCopy;

            if (fromPatterns.length > 1 && toPatterns.length > 1 && fromPatterns.length === toPatterns.length) {
                for (let i = 0; i < fromPatterns.length; i++) {
                    const fromPat = fromPatterns[i];
                    const toPat = toPatterns[i];
                    try {
                        const res = await resolveExistingPaths(this.path.uri, fromPat, fromPat.endsWith('/'));
                        for (const r of res) {
                            mappings.push({ src: r, target: this.resolveTargetUri(r.name, toPat, fromPat) });
                        }
                    } catch (e) { }
                }
            }
            else if (toPatterns.length === 1) {
                const toPat = toPatterns[0];
                const isExplicitDir = toPat.endsWith('/') || toPat.endsWith('\\') || toPat === '.' || toPat === '..';

                let allSrc: { name: string, uri: Uri, type: FileType, fromPattern: string }[] = [];
                for (const p of fromPatterns) {
                    try {
                        const res = await resolveExistingPaths(this.path.uri, p, p.endsWith('/'));
                        for (const r of res) {
                            if (!allSrc.some(s => s.uri.toString() === r.uri.toString())) {
                                allSrc.push({ ...r, fromPattern: p });
                            }
                        }
                    } catch (e) { }
                }

                if (!isExplicitDir && allSrc.length > 1 && !toPat.includes('*')) {
                    let isPhysDir = false;
                    try { const s = await vscode.workspace.fs.stat(Uri.joinPath(this.path.uri, toPat)); isPhysDir = !!(s.type & FileType.Directory); } catch { }

                    if (!isPhysDir) {
                        finalItems.push({
                            label: `$(error) Collision Risk`,
                            description: `Multiple files cannot be mapped to a single file. Add '/' to target a folder.`,
                            name: "", alwaysShow: true
                        } as FileItem);
                    } else {
                        for (const src of allSrc) {
                            mappings.push({ src, target: Uri.joinPath(this.path.uri, toPat, OSPath.basename(src.name)) });
                        }
                    }
                } else {
                    for (const src of allSrc) {
                        mappings.push({ src, target: this.resolveTargetUri(src.name, toPat, src.fromPattern) });
                    }
                }
            }
            else if (fromPatterns.length === 1 && toPatterns.length > 1) {
                if (!isCopy) {
                    finalItems.push({
                        label: `$(error) Illegal Operation`,
                        description: `Cannot ${action === Action.BulkMove ? 'move' : 'rename'} to multiple target patterns.`,
                        name: "", alwaysShow: true
                    } as FileItem);
                } else {
                    const fromPat = fromPatterns[0];
                    try {
                        const res = await resolveExistingPaths(this.path.uri, fromPat, fromPat.endsWith('/'));
                        for (const r of res) {
                            for (const toPat of toPatterns) {
                                mappings.push({ src: r, target: this.resolveTargetUri(r.name, toPat, fromPat) });
                            }
                        }
                    } catch (e) { }
                }
            }
            else {
                finalItems.push({
                    label: `$(error) Ambiguous Mapping`,
                    description: `Source patterns (${fromPatterns.length}) and target patterns (${toPatterns.length}) mismatch.`,
                    name: "", alwaysShow: true
                } as FileItem);
            }

            if (this.searchToken !== token) return;

            if (mappings.length > 0 && finalItems.length === 0) {
                const opName = isCopy ? "Copy" : (action === Action.BulkMove ? "Move" : "Rename");
                finalItems.push({
                    label: `$(zap) Execute Bulk ${opName} (${mappings.length} steps)`,
                    description: `from ${fromPatterns.length} patterns to ${toPatterns.length} patterns`,
                    name: fullQuery,
                    alwaysShow: true,
                    action: action,
                    payload: { mappings }
                } as FileItem);

                mappings.slice(0, 10).forEach(m => {
                    finalItems.push({
                        label: `  $(arrow-right) ${m.src.name} → ${this.getRelativeDisplayPath(m.target)}`,
                        name: m.src.name,
                        alwaysShow: true,
                        action: isCopy ? Action.SingleCopy : (action === Action.BulkMove ? Action.SingleMove : Action.SingleRename),
                        payload: { oldUri: m.src.uri, newUri: m.target }
                    } as FileItem);
                });
                if (mappings.length > 10) {
                    finalItems.push({ label: `  ... and ${mappings.length - 10} more`, name: "", alwaysShow: true } as FileItem);
                }
            }
        }
        else if (action === Action.BulkDelete && matchPattern) {
            let allSrc: { name: string, uri: Uri, type: FileType }[] = [];
            const fromPatterns = expandBraces(matchPattern);
            for (const p of fromPatterns) {
                try {
                    const res = await resolveExistingPaths(this.path.uri, p, p.endsWith('/'));
                    for (const r of res) {
                        if (!allSrc.some(s => s.uri.toString() === r.uri.toString())) {
                            allSrc.push(r);
                        }
                    }
                } catch (e) { }
            }

            if (this.searchToken !== token) return;

            if (allSrc.length > 0) {
                finalItems.push({
                    label: `$(trash) Delete ${allSrc.length} items matching '${matchPattern}'`,
                    name: fullQuery,
                    alwaysShow: true, action,
                    payload: { uris: allSrc.map(r => r.uri) }
                } as FileItem);
                allSrc.slice(0, 10).forEach(p => {
                    finalItems.push({ label: `  $(remove) ${p.name}`, name: p.name, alwaysShow: true, action: Action.SingleDelete, payload: { uri: p.uri } } as FileItem);
                });
            }
        }

        if (this.searchToken !== token) return;

        const contextQuery = parts.length > 1 ? parts[parts.length - 1] : matchPattern;
        try {
            const suggestions = await searchExistingPaths(this.path.uri, contextQuery || "./");
            const existingSrcUris = new Set<string>();
            if (action === Action.BulkDelete && finalItems[0]?.payload?.uris) {
                (finalItems[0].payload.uris as Uri[]).forEach((u: Uri) => existingSrcUris.add(u.toString()));
            } else {
                mappings.forEach(m => existingSrcUris.add(m.src.uri.toString()));
            }

            const filteredSug = suggestions
                .filter(s => !existingSrcUris.has(s.uri.toString()))
                .slice(0, 10);

            if (filteredSug.length > 0 && finalItems.length < 15) {
                finalItems.push({ label: `--- Suggestions for '${contextQuery || './'}' ---`, name: "", alwaysShow: true } as FileItem);
                filteredSug.forEach(s => {
                    finalItems.push({
                        label: (s.type & FileType.Directory) ? `$(folder) ${s.name}` : `$(file) ${s.name}`,
                        name: s.name, description: parts.length > 1 ? "Target suggestion" : "Source suggestion",
                        alwaysShow: true, fileType: s.type, payload: s.uri
                    } as FileItem);
                });
            }
        } catch (e) { }

        if (this.searchToken === token) {
            this.current.items = finalItems;
            if (finalItems.length > 0) this.current.activeItems = [finalItems[0]];
            this.current.busy = false;
        }
    }

    private resolveTargetUri(srcRelPath: string, targetInput: string, fromPattern: string): Uri {
        const isDestExplicitDir = targetInput.endsWith('/') || targetInput.endsWith('\\') || targetInput === '.' || targetInput === '..';

        if (isDestExplicitDir) {
            return Uri.joinPath(this.path.uri, targetInput, OSPath.basename(srcRelPath));
        }

        if (targetInput.includes('*')) {
            const transformedName = applyWildcard(srcRelPath, fromPattern, targetInput);
            if (transformedName) {
                return Uri.joinPath(this.path.uri, transformedName);
            }
        }

        return Uri.joinPath(this.path.uri, targetInput);
    }

    // ================= 文件操作执行 =================

    openFile(uri: Uri, column?: ViewColumn, range?: vscode.Range, selectionRange?: vscode.Range) {
        this.accepted = true;
        this.previewToken++;
        if (this.previewTimeout) { clearTimeout(this.previewTimeout); this.previewTimeout = undefined; }
        this.clearDecorations();

        let targetColumn = column;
        const uriStr = uri.toString();

        if (!targetColumn && range) {
            const visibleEditors = vscode.window.visibleTextEditors;
            const editorInOriginal = visibleEditors.find(e =>
                e.document.uri.toString() === uriStr && e.viewColumn === this.originalViewColumn
            );
            if (editorInOriginal) { targetColumn = editorInOriginal.viewColumn; }
            else {
                const anyVisibleEditor = visibleEditors.find(e => e.document.uri.toString() === uriStr);
                if (anyVisibleEditor) { targetColumn = anyVisibleEditor.viewColumn; }
            }
        }
        if (!targetColumn) {
            const activeGroup = vscode.window.tabGroups.activeTabGroup;
            const tabInActive = activeGroup.tabs.find(t =>
                t.input instanceof vscode.TabInputText && t.input.uri.toString() === uriStr
            );
            if (tabInActive) { targetColumn = activeGroup.viewColumn; }
            else { targetColumn = this.originalViewColumn || vscode.ViewColumn.Active; }
        }

        if (this.currentPreviewTab && this.currentPreviewTab.input instanceof vscode.TabInputText && this.currentPreviewTab.input.uri.toString() === uriStr) {
            if (targetColumn === ViewColumn.Beside || (column !== undefined && targetColumn !== this.currentPreviewTab.group.viewColumn)) {
                this.closePreviewTab();
            } else {
                this.currentPreviewTab = undefined;
            }
        } else {
            this.closePreviewTab();
        }

        // 我们设置一个目标例外：当 dispose() 执行清扫时，不要重置这组目标的状态
        this.exemptTarget = { uri: uriStr, column: targetColumn };

        // 因为不再依赖阻断，交给 dispose 去执行非常安全的所有其它编辑器的复原工作
        this.dispose();

        vscode.workspace.openTextDocument(uri).then((doc) => {
            vscode.window.showTextDocument(doc, { viewColumn: targetColumn || ViewColumn.Active, preview: false }).then(editor => {
                if (range) {
                    const ts = selectionRange || range;
                    editor.selection = new vscode.Selection(ts.start, ts.end);
                    editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
                }
            });
        });
    }

    openTerminal(targetUri?: Uri) {
        const uri = targetUri || this.path.uri;
        const terminal = vscode.window.createTerminal({
            cwd: uri,
            name: `Terminal: ${OSPath.basename(uri.fsPath)}`
        });
        terminal.show();
        this.accepted = true;
        this.dispose();
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
                        if (p.isDir) {
                            try {
                                await vscode.workspace.fs.createDirectory(p.uri);
                            } catch (err: any) {
                                vscode.window.showWarningMessage(`Cannot create directory ${p.uri}: File already exists.`);
                            }
                        }
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
                case Action.OpenTerminal: {
                    const uri = item.payload?.uri;
                    this.openTerminal(uri);
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
        if (!val) return;

        const cmdMatch = val.match(/^([rdcm]:|#|>t|!|@@|@|\$\$?|%%?|:)\s*/);
        const cmdPrefix = cmdMatch ? cmdMatch[0] : "";
        const argsStr = val.substring(cmdPrefix.length);

        if (cmdPrefix.match(/^(\$\$?|%%?|:)\s*$/)) return;

        let textBeforeToken = "";
        let tokenToComplete = argsStr;

        if (cmdPrefix.match(/^[rdcm]:\s*$/)) {
            const lastSpaceIdx = argsStr.lastIndexOf(' ');
            if (lastSpaceIdx !== -1) {
                textBeforeToken = argsStr.substring(0, lastSpaceIdx + 1);
                tokenToComplete = argsStr.substring(lastSpaceIdx + 1);
            }
        }

        if (!tokenToComplete) return;

        const wildcardIdx = Math.max(tokenToComplete.lastIndexOf('*'), tokenToComplete.lastIndexOf('?'));
        const wildPrefix = wildcardIdx !== -1 ? tokenToComplete.substring(0, wildcardIdx + 1) : "";
        const literalSuffix = wildcardIdx !== -1 ? tokenToComplete.substring(wildcardIdx + 1) : tokenToComplete;

        const escapeForRegex = (str: string) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

        const escapedWild = escapeForRegex(wildPrefix)
            .replace(/\\\*/g, '.*')
            .replace(/\\\?/g, '.');
        const escapedLiteral = escapeForRegex(literalSuffix);

        let regex: RegExp;
        try {
            regex = new RegExp(`^(${escapedWild})(${escapedLiteral}.*)$`, "i");
        } catch (e) {
            return;
        }

        const validItems = this.current.items.filter(item =>
            item.name &&
            item.name !== ">t" &&
            !item.label.includes("Create Pattern:") &&
            !item.label.includes("Open / Create Path:")
        );

        if (validItems.length === 0) return;

        const matchedSuffixes: { full: string, suffix: string, isDir: boolean }[] = [];

        for (const item of validItems) {
            const match = item.name.match(regex);
            if (match) {
                matchedSuffixes.push({
                    full: item.name,
                    suffix: match[2],
                    isDir: !!(item.fileType !== undefined && (item.fileType & vscode.FileType.Directory))
                });
            }
        }

        if (matchedSuffixes.length === 0) return;

        let lcp = matchedSuffixes[0].suffix;
        for (let i = 1; i < matchedSuffixes.length; i++) {
            const curr = matchedSuffixes[i].suffix;
            let j = 0;
            while (j < lcp.length && j < curr.length && lcp[j] === curr[j]) {
                j++;
            }
            lcp = lcp.substring(0, j);
            if (lcp === "") break;
        }

        let newSuffix = lcp;
        if (matchedSuffixes.length === 1 && matchedSuffixes[0].isDir && !newSuffix.endsWith('/')) {
            newSuffix += '/';
        }

        const newToken = wildPrefix + newSuffix;
        const newValue = cmdPrefix + textBeforeToken + newToken;

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