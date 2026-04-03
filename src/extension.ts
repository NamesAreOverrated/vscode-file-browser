import * as vscode from "vscode";
import { Uri, FileType, QuickInputButton, ThemeIcon, ViewColumn, DocumentSymbol } from "vscode";
import * as OS from "os";
import * as OSPath from "path";

import { Result, None, Option, Some } from "@bodil/opt";
import { Path, endsWithPathSeparator } from "./path";
import { Rules } from "./filter";
import { FileItem, fileRecordCompare } from "./fileitem";
import { action, Action } from "./action";

// ================= 新增与改进：工具函数 =================

/** 展开大括号 (例如: /tmp/{a,b}/c -> /tmp/a/c, /tmp/b/c) */
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

/** 支持双引号/单引号的参数分割器 */
function splitArgs(str: string): string[] {
    const regex = /[^\s"']+|"([^"]*)"|'([^']*)'/g;
    const result: string[] = [];
    let match;
    while ((match = regex.exec(str)) !== null) {
        result.push(match[1] || match[2] || match[0]);
    }
    return result;
}

/** 
 * 增强版通配符重命名替换逻辑 (仅针对文件名 BaseName)
 */
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
            if (groupIndex < match.length) {
                result += match[groupIndex++];
            }
        } else {
            result += to[i];
        }
    }
    return result;
}

async function expandPathWildcards(
    baseUri: Uri,
    pattern: string,
    mustExist: boolean,
    onlyDirs: boolean = false
): Promise<{ name: string, uri: Uri }[]> {
    // 预处理：如果是 ** 结尾且要求目录，统一处理
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
                    if (!nextPathsMap.has(key)) {
                        // 如果是最后一段且要求目录，或者不是最后一段，都收集
                        nextPathsMap.set(key, { name: rel, uri: u });
                    }
                    try {
                        const entries = await vscode.workspace.fs.readDirectory(u);
                        for (const [n, t] of entries) {
                            if (t & FileType.Directory) {
                                await collectDirs(Uri.joinPath(u, n), rel ? `${rel}/${n}` : n, depth + 1);
                            }
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
                            // 如果不是最后一段，必须是目录；如果是最后一段且要求 onlyDirs，也必须是目录
                            if (!isLastSegment && !isDir) continue;
                            if (isLastSegment && onlyDirs && !isDir) continue;

                            const nextUri = Uri.joinPath(cur.uri, name);
                            nextPathsMap.set(nextUri.toString(), {
                                name: cur.name ? `${cur.name}/${name}` : name,
                                uri: nextUri
                            });
                        }
                    }
                } catch (e) { }
            } else {
                const nextUri = Uri.joinPath(cur.uri, seg);
                const nextName = cur.name ? `${cur.name}/${seg}` : seg;
                try {
                    const stat = await vscode.workspace.fs.stat(nextUri);
                    const isDir = !!(stat.type & FileType.Directory);
                    if (isLastSegment && onlyDirs && !isDir) { /* 过滤非目录 */ }
                    else {
                        nextPathsMap.set(nextUri.toString(), { name: nextName, uri: nextUri });
                    }
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

// ==================================================

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

interface AutoCompletion {
    index: number;
    items: FileItem[];
}

class FileBrowser {
    current: vscode.QuickPick<FileItem>;
    path: Path;
    file: Option<string>;
    items: FileItem[] = [];
    pathHistory: { [path: string]: Option<string> };
    inActions: boolean = false;
    keepAlive: boolean = false;
    autoCompletion?: AutoCompletion;

    editorUri?: Uri;
    private searchToken = 0;
    searchModeState?: { mode: string; path: Path };
    private searchTimeout?: NodeJS.Timeout;

    actionsButton: QuickInputButton = {
        iconPath: new ThemeIcon("ellipsis"),
        tooltip: "Actions on selected file",
    };
    stepOutButton: QuickInputButton = {
        iconPath: new ThemeIcon("arrow-left"),
        tooltip: "Step out of folder",
    };
    stepInButton: QuickInputButton = {
        iconPath: new ThemeIcon("arrow-right"),
        tooltip: "Step into folder",
    };

    constructor(path: Path, file: Option<string>) {
        this.path = path;
        this.file = file;
        this.pathHistory = { [this.path.id]: this.file };

        const editor = vscode.window.activeTextEditor;
        if (editor) {
            this.editorUri = editor.document.uri;
        }

        this.current = vscode.window.createQuickPick();
        this.current.buttons = [this.actionsButton, this.stepOutButton, this.stepInButton];
        this.current.placeholder = "Preparing the file list...";
        this.current.onDidHide(() => {
            if (!this.keepAlive) {
                this.dispose();
            }
        });
        this.current.onDidAccept(this.onDidAccept.bind(this));
        this.current.onDidChangeValue(this.onDidChangeValue.bind(this));
        this.current.onDidTriggerButton(this.onDidTriggerButton.bind(this));
        this.update().then(() => {
            this.current.placeholder = "Type a file name, paths (e.g. a/b.js), or commands (*, d:, r:)";
            this.current.busy = false;
        });
    }

    dispose() {
        setContext(false);
        this.current.dispose();
        active = None;
    }

    hide() {
        this.current.hide();
        setContext(false);
    }

    show() {
        setContext(true);
        this.current.show();
    }

    async update() {
        this.current.show();
        this.current.busy = true;
        this.current.title = this.path.fsPath;
        this.current.value = "";

        const stat = (await Result.await(vscode.workspace.fs.stat(this.path.uri))).unwrap();
        if (stat && this.inActions && (stat.type & FileType.File) === FileType.File) {
            this.items = [
                action("$(file) Open this file", Action.OpenFile),
                action("$(split-horizontal) Open this file to the side", Action.OpenFileBeside),
                action("$(edit) Rename this file", Action.RenameFile),
                action("$(trash) Delete this file", Action.DeleteFile),
            ];
            this.current.items = this.items;
        } else if (stat && this.inActions && (stat.type & FileType.Directory) === FileType.Directory) {
            this.items = [
                action("$(folder-opened) Open this folder", Action.OpenFolder),
                action("$(folder-opened) Open this folder in a new window", Action.OpenFolderInNewWindow),
                action("$(edit) Rename this folder", Action.RenameFile),
                action("$(trash) Delete this folder", Action.DeleteFile),
            ];
            this.current.items = this.items;
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
            this.current.items = items;
            this.current.activeItems = items.filter((item) => this.file.value === item.name);
        } else {
            this.items = [action("$(new-folder) Create this folder", Action.NewFolder)];
            this.current.items = this.items;
        }
        this.current.enabled = true;
    }

    async onDidChangeValue(value: string, isAutoComplete = false) {
        if (this.inActions) return;
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

        if (value.startsWith("@")) return this.handleSymbolSearch(value.substring(1));
        if (value.startsWith(":")) return this.handleLineSearch(value.substring(1));

        // 重量级命令防抖处理 (250ms)
        if (value.startsWith("!")) {
            this.searchTimeout = setTimeout(() => this.handleGlobalFileSearch(value.substring(1)), 250);
            return;
        }
        if (value.startsWith("#")) {
            this.searchTimeout = setTimeout(() => this.handleGlobalFolderSearch(value.substring(1)), 250);
            return;
        }

        if (value.match(/^[rdcm]:/)) {
            const actionMap: { [k: string]: Action } = { 'r': Action.BulkRename, 'd': Action.BulkDelete, 'c': Action.BulkCopy, 'm': Action.BulkMove };
            this.searchTimeout = setTimeout(() => this.handleBulkOp(value.substring(2), actionMap[value[0]]), 250);
            return;
        }

        if (value.includes("{") || value.includes("*")) {
            this.searchTimeout = setTimeout(() => this.handleBulkCreateSearch(value), 250);
            return;
        }

        if (value.includes("/")) {
            this.searchTimeout = setTimeout(() => this.handlePathSearch(value), 100);
            return;
        }

        // 普通字符过滤
        const query = value.toLowerCase();
        let displayItems = this.items.filter((item) => {
            if (item.action !== undefined && item.action !== Action.OpenFile) return true;
            return item.name.toLowerCase().includes(query);
        });

        const existingItem = this.items.find((item) => item.name === value);
        if (!existingItem) {
            const newItem = {
                label: `$(new-file) Create: ${value}`,
                name: value,
                description: "Open as new file",
                alwaysShow: true,
                action: Action.OpenFile, // Action.OpenFile 现在兼顾创建
            } as FileItem;
            displayItems = [newItem, ...displayItems];
        }

        this.current.items = displayItems;
        if (displayItems.length > 0) {
            this.current.activeItems = [displayItems[0]];
        }
    }

    // --- 高级路径搜索与隐式钻取 ---
    async handlePathSearch(value: string) {
        const token = ++this.searchToken;
        this.current.busy = true;

        const parts = value.split('/');
        const searchName = parts.pop()!.toLowerCase(); // 要搜索的文件名片段
        const dirPath = parts.join('/'); // 目标路径 (支持包含 ../)

        let displayItems: FileItem[] = [];

        try {
            const targetDirUri = this.path.append(...dirPath.split('/')).uri;
            const stat = await vscode.workspace.fs.stat(targetDirUri);

            if ((stat.type & FileType.Directory) === FileType.Directory) {
                const entries = await vscode.workspace.fs.readDirectory(targetDirUri);
                const matched = entries
                    .filter(([name]) => name.toLowerCase().includes(searchName))
                    .map(([name, type]) => {
                        const relativeName = dirPath === "" ? name : `${dirPath}/${name}`;
                        const item = new FileItem([relativeName, type]);
                        item.action = Action.OpenFile;
                        return item;
                    });
                displayItems.push(...matched);
            }
        } catch (e) { }

        if (this.searchToken !== token) return;

        // 始终提供直接执行/创建该全路径的选项
        const exactItem = {
            label: `$(go-to-file) Open / Create Path: ${value}`,
            name: value,
            description: "Will create missing directories automatically",
            alwaysShow: true,
            action: Action.OpenFile,
        } as FileItem;

        this.current.items = [exactItem, ...displayItems];
        if (this.current.items.length > 0) this.current.activeItems = [this.current.items[0]];
        this.current.busy = false;
    }

    // --- 全局文件/文件夹搜索 --- (略, 保持之前版本不变)
    async handleGlobalFileSearch(query: string) { /* ...原代码... */ }
    async handleGlobalFolderSearch(query: string) { /* ...原代码... */ }
    handleLineSearch(query: string) { /* ...原代码... */ }
    async handleSymbolSearch(query: string) { /* ...原代码... */ }

    async handleBulkCreateSearch(value: string) {
        const token = ++this.searchToken;
        this.current.busy = true;

        try {
            const finalPaths: string[] = [];
            const braced = expandBraces(value);

            for (const pattern of braced) {
                // 1. 识别末尾是否为目录创建请求
                const isDirCreate = pattern.endsWith('/');
                const cleanPattern = isDirCreate ? pattern.slice(0, -1) : pattern;

                // 2. 找到最后一个斜杠，分割“路径通配符”与“文件名字面量”
                const lastSlashIdx = cleanPattern.lastIndexOf('/');

                if (lastSlashIdx === -1) {
                    // 没有斜杠，整段都是文件名（字面量，即使含*也当字符）
                    finalPaths.push(pattern);
                } else {
                    const dirPart = cleanPattern.substring(0, lastSlashIdx);
                    const leafPart = cleanPattern.substring(lastSlashIdx + 1);

                    // 3. 展开父目录路径 (必须存在，或是根据逻辑生成的)
                    const resolvedDirs = await expandPathWildcards(this.path.uri, dirPart, false, true);

                    for (const r of resolvedDirs) {
                        // 在每个匹配到的线下，拼接字面量 leafPart
                        const finalName = leafPart ? `${r.name}/${leafPart}` : r.name;
                        finalPaths.push(isDirCreate && leafPart ? `${finalName}/` : finalName);
                    }
                }
            }

            if (this.searchToken !== token) return;

            const newItem = {
                label: `$(new-file) Create Pattern: ${value}`,
                name: value,
                description: "Directories expand, last part is literal",
                alwaysShow: true,
                action: Action.BulkCreate,
                payload: value
            } as FileItem;

            const previews = finalPaths.map(p => ({
                label: p.endsWith('/') ? `$(add) [Folder] ${p}` : `$(add) ${p}`,
                name: p,
                alwaysShow: true,
                action: Action.Preview
            } as FileItem));

            this.current.items = [newItem, ...previews];
        } catch (e) { }
        this.current.busy = false;
    }

    async handleBulkOp(query: string, action: Action) {
        const token = ++this.searchToken;
        this.current.busy = true;

        const parts = splitArgs(query.trim());
        let label = "";
        let payload: any = {};
        let matchedFiles: FileItem[] = [];

        if (parts.length > 0) {
            const matchPattern = parts[0];
            const onlyDirs = matchPattern.endsWith('/'); // 核心修复：d: */ 只匹配目录

            try {
                // 读取真实存在的 Glob 匹配文件/文件夹
                const resolvedPaths = await expandPathWildcards(this.path.uri, matchPattern, true, onlyDirs);
                if (this.searchToken !== token) return;

                if (action === Action.BulkRename && parts.length >= 2) {
                    const from = parts[0], to = parts[1];
                    label = `Rename matching '${from}' to '${to}'`;
                    payload = { from, to };
                    matchedFiles = resolvedPaths.map(p => {
                        const oldBase = OSPath.basename(p.name);
                        const newBase = applyWildcard(oldBase, OSPath.basename(from), OSPath.basename(to)) || oldBase;
                        const dir = OSPath.dirname(p.name);
                        const displayNew = dir === "." ? newBase : `${dir}/${newBase}`;
                        return {
                            label: `$(arrow-right) ${p.name} -> ${displayNew}`,
                            name: p.name,
                            alwaysShow: true,
                            description: "Will be renamed",
                            action: Action.Preview
                        } as FileItem;
                    });
                } else if (action === Action.BulkDelete) {
                    label = `Delete matching '${matchPattern}' (${resolvedPaths.length} items)`;
                    payload = { match: matchPattern, onlyDirs };
                    matchedFiles = resolvedPaths.map(p => ({
                        label: `$(trash) ${p.name}`,
                        name: p.name,
                        alwaysShow: true,
                        action: Action.Preview
                    } as FileItem));
                } else if (action === Action.BulkCopy && parts.length >= 2) {
                    label = `Copy '${parts[0]}' to '${parts[1]}'`;
                    payload = { match: parts[0], dest: parts[1] };
                    matchedFiles = resolvedPaths.map(p => ({
                        label: `$(files) ${p.name} -> ${parts[1]}/${OSPath.basename(p.name)}`,
                        name: p.name,
                        alwaysShow: true,
                        description: "Will be copied",
                        action: Action.Preview
                    } as FileItem));
                } else if (action === Action.BulkMove && parts.length >= 2) {
                    label = `Move '${parts[0]}' to '${parts[1]}'`;
                    payload = { match: parts[0], dest: parts[1] };
                    matchedFiles = resolvedPaths.map(p => ({
                        label: `$(arrow-right) ${p.name} -> ${parts[1]}/${OSPath.basename(p.name)}`,
                        name: p.name,
                        alwaysShow: true,
                        description: "Will be moved",
                        action: Action.Preview
                    } as FileItem));
                } else {
                    matchedFiles = resolvedPaths.map(p => ({
                        label: `$(record) ${p.name}`,
                        name: p.name,
                        alwaysShow: true,
                        description: "Matched path",
                        action: Action.Preview
                    } as FileItem));
                }
            } catch (e) { }
        }

        const items: FileItem[] = [];
        if (label) {
            items.push({ label: `$(zap) ${label}`, name: query, alwaysShow: true, action, payload } as FileItem);
        } else {
            items.push({ label: "Keep typing pattern...", name: "", alwaysShow: true } as FileItem);
        }

        items.push(...matchedFiles);
        this.current.items = items;
        this.current.busy = false;
    }
    // ----------------------------

    onDidTriggerButton(button: QuickInputButton) {
        if (button === this.stepInButton) this.stepIn();
        else if (button === this.stepOutButton) this.stepOut();
        else if (button === this.actionsButton) this.actions();
    }

    activeItem(): Option<FileItem> {
        return Option.from(this.current.activeItems[0]);
    }

    async stepIntoFolder(folder: Path) {
        if (!this.path.equals(folder)) {
            this.path = folder;
            this.file = this.pathHistory[this.path.id] || None;
            await this.update();
        }
    }

    async stepIn() {
        this.activeItem().ifSome(async (item) => {
            if (item.action !== undefined) {
                this.runAction(item);
            } else if (item.fileType !== undefined) {
                if ((item.fileType & FileType.Directory) === FileType.Directory) {
                    await this.stepIntoFolder(this.path.append(item.name));
                } else if ((item.fileType & FileType.File) === FileType.File) {
                    this.path.push(item.name);
                    this.file = None;
                    this.inActions = true;
                    await this.update();
                }
            }
        });
    }

    async stepOut() {
        this.inActions = false;

        if (this.searchModeState && this.path.equals(this.searchModeState.path)) {
            const val = this.searchModeState.mode;
            this.searchModeState = undefined;
            this.current.value = val;
            return;
        }

        const folders = vscode.workspace.workspaceFolders;
        if (folders) {
            const isRoot = folders.some(f => f.uri.fsPath === this.path.uri.fsPath);
            if (isRoot) {
                vscode.window.showInformationMessage("You are at the root of the workspace.");
                return;
            }
        }

        if (!this.path.atTop()) {
            this.pathHistory[this.path.id] = this.activeItem().map((item) => item.name);
            this.file = this.path.pop();
            await this.update();
        }
    }

    async actions() {
        if (this.inActions) return;
        await this.activeItem().match(
            async (item) => {
                this.inActions = true;
                this.path.push(item.name);
                this.file = None;
                await this.update();
            },
            async () => {
                this.inActions = true;
                this.file = None;
                await this.update();
            }
        );
    }

    tabCompletion(tabNext: boolean) {
        if (this.inActions) return;
        if (this.autoCompletion) {
            const length = this.autoCompletion.items.length;
            const step = tabNext ? 1 : -1;
            this.autoCompletion.index = (this.autoCompletion.index + length + step) % length;
        } else {
            const items = this.items.filter((i) => i.name.toLowerCase().startsWith(this.current.value.toLowerCase()));
            this.autoCompletion = { index: tabNext ? 0 : items.length - 1, items };
        }
        const newIndex = this.autoCompletion.index;
        const length = this.autoCompletion.items.length;
        if (newIndex < length) {
            const item = this.autoCompletion.items[newIndex];
            this.current.value = item.name;
            if (length === 1 && item.fileType === FileType.Directory) this.current.value += "/";
            this.onDidChangeValue(this.current.value, true);
        }
    }

    onDidAccept() {
        this.autoCompletion = undefined;
        this.activeItem().ifSome((item) => {
            if (item.action !== undefined) {
                this.runAction(item);
            } else if (item.fileType !== undefined && (item.fileType & FileType.Directory) === FileType.Directory) {
                this.stepIn();
            } else {
                this.openFile(this.path.append(item.name).uri);
            }
        });
    }

    openFile(uri: Uri, column: ViewColumn = ViewColumn.Active) {
        this.dispose();
        vscode.workspace.openTextDocument(uri).then((doc) => vscode.window.showTextDocument(doc, column));
    }

    async rename() { /* 保持原代码 */ }

    async runAction(item: FileItem) {
        switch (item.action) {
            case Action.Preview: break;
            case Action.GoToLine: { /* 保持原代码 */ break; }
            case Action.GoToSymbol: { /* 保持原代码 */ break; }
            case Action.OpenGlobalFile: { /* 保持原代码 */ break; }
            case Action.OpenGlobalFolder: { /* 保持原代码 */ break; }
            case Action.BulkCreate: {
                const braced = expandBraces(item.payload);
                for (const pattern of braced) {
                    const isDirCreate = pattern.endsWith('/');
                    const clean = isDirCreate ? pattern.slice(0, -1) : pattern;
                    const lastSlash = clean.lastIndexOf('/');

                    if (lastSlash === -1) {
                        // 根目录下创建
                        const uri = Uri.joinPath(this.path.uri, clean);
                        if (isDirCreate) await vscode.workspace.fs.createDirectory(uri);
                        else await vscode.workspace.fs.writeFile(uri, new Uint8Array(0));
                    } else {
                        const dirPart = clean.substring(0, lastSlash);
                        const leafPart = clean.substring(lastSlash + 1);
                        const resolved = await expandPathWildcards(this.path.uri, dirPart, false, true);
                        for (const r of resolved) {
                            const uri = leafPart ? Uri.joinPath(r.uri, leafPart) : r.uri;
                            if (isDirCreate) {
                                await vscode.workspace.fs.createDirectory(uri);
                            } else {
                                await vscode.workspace.fs.createDirectory(Uri.joinPath(uri, '..'));
                                await vscode.workspace.fs.writeFile(uri, new Uint8Array(0));
                            }
                        }
                    }
                }
                this.current.value = "";
                await this.update();
                break;
            }
            case Action.BulkRename: {
                const { from, to } = item.payload;
                const resolved = await expandPathWildcards(this.path.uri, from, true);
                for (const r of resolved) {
                    const oldBase = OSPath.basename(r.name);
                    const newBase = applyWildcard(oldBase, OSPath.basename(from), OSPath.basename(to)) || oldBase;
                    if (newBase !== oldBase) {
                        const oldUri = r.uri;
                        const newUri = Uri.joinPath(Uri.joinPath(oldUri, '..'), newBase);
                        await vscode.workspace.fs.rename(oldUri, newUri);
                    }
                }
                this.current.value = "";
                await this.update();
                break;
            }
            case Action.BulkDelete: {
                const { match } = item.payload;
                const resolved = await expandPathWildcards(this.path.uri, match, true);
                for (const r of resolved) {
                    await vscode.workspace.fs.delete(r.uri, { recursive: true, useTrash: true });
                }
                this.current.value = "";
                await this.update();
                break;
            }
            case Action.BulkMove:
            case Action.BulkCopy: {
                const { match, dest } = item.payload;
                const resolved = await expandPathWildcards(this.path.uri, match, true);
                const destBaseUri = this.path.append(...dest.split('/')).uri;
                await vscode.workspace.fs.createDirectory(destBaseUri);

                for (const r of resolved) {
                    const oldUri = r.uri;
                    const newUri = Uri.joinPath(destBaseUri, OSPath.basename(r.name));
                    if (item.action === Action.BulkMove) {
                        await vscode.workspace.fs.rename(oldUri, newUri);
                    } else {
                        await vscode.workspace.fs.copy(oldUri, newUri);
                    }
                }
                this.current.value = "";
                await this.update();
                break;
            }

            case Action.NewFolder: {
                await vscode.workspace.fs.createDirectory(this.path.uri);
                await this.update();
                break;
            }
            case Action.NewFile: {
                // 已被 OpenFile 吸收，这里可以留空或复用
                break;
            }
            case Action.OpenFile:
            case Action.OpenFileBeside: {
                // 【核心增强】完美支持全路径的递归创建与跳转
                const path = this.path.clone();
                if (item.name && item.name.length > 0) {
                    path.push(...item.name.split('/'));
                }
                const uri = path.uri;

                try {
                    const stat = await vscode.workspace.fs.stat(uri);
                    if ((stat.type & FileType.Directory) === FileType.Directory) {
                        // 如果用户敲入了 a/b/ 的目录并回车，隐式钻取进去
                        await this.stepIntoFolder(path);
                        return;
                    }
                    this.openFile(uri, item.action === Action.OpenFileBeside ? ViewColumn.Beside : ViewColumn.Active);
                } catch (e) {
                    // 如果路径不存在，自动递归创建所有的父级目录，并建立新文件
                    const parts = item.name.split('/');
                    if (parts.length > 1) {
                        await vscode.workspace.fs.createDirectory(Uri.joinPath(uri, '..'));
                    }
                    // 文件以untitled形式开出 (如果是末尾带斜线的输入，上面就已经捕获并只创建文件夹了)
                    if (!item.name.endsWith('/')) {
                        this.openFile(uri.with({ scheme: "untitled" }), item.action === Action.OpenFileBeside ? ViewColumn.Beside : ViewColumn.Active);
                    } else {
                        await vscode.workspace.fs.createDirectory(uri);
                        this.current.value = "";
                        await this.update();
                    }
                }
                break;
            }
            case Action.RenameFile: { /* 保持原代码 */ break; }
            case Action.DeleteFile: { /* 保持原代码 */ break; }
            case Action.OpenFolder: { /* 保持原代码 */ break; }
            case Action.OpenFolderInNewWindow: { /* 保持原代码 */ break; }
            default:
                throw new Error(`Unhandled action ${item.action}`);
        }
    }
}


export function activate(context: vscode.ExtensionContext) {
    setContext(false);

    context.subscriptions.push(
        vscode.commands.registerCommand("file-browser.open", () => {
            const document = vscode.window.activeTextEditor?.document;
            const workspaceFolder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
            let path = new Path(workspaceFolder?.uri || Uri.file(OS.homedir()));
            let file: Option<string> = None;
            if (document && !document.isUntitled) {
                path = new Path(document.uri);
                file = path.pop();
            }
            active = Some(new FileBrowser(path, file));
            setContext(true);
        })
    );
    context.subscriptions.push(
        vscode.commands.registerCommand("file-browser.rename", () =>
            active
                .chainNone(() => {
                    const document = vscode.window.activeTextEditor?.document;
                    const workspaceFolder =
                        vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
                    const path = new Path(
                        document?.uri || workspaceFolder?.uri || Uri.file(OS.homedir())
                    );
                    active = Some(new FileBrowser(path, None));
                    setContext(true);
                    return active;
                })
                .ifSome((active) => active.rename())
        )
    );

    context.subscriptions.push(
        vscode.commands.registerCommand("file-browser.stepIn", () =>
            active.ifSome((active) => active.stepIn())
        )
    );
    context.subscriptions.push(
        vscode.commands.registerCommand("file-browser.stepOut", () =>
            active.ifSome((active) => active.stepOut())
        )
    );
    context.subscriptions.push(
        vscode.commands.registerCommand("file-browser.actions", () =>
            active.ifSome((active) => active.actions())
        )
    );
    context.subscriptions.push(
        vscode.commands.registerCommand("file-browser.tabNext", () =>
            active.ifSome((active) => active.tabCompletion(true))
        )
    );
    context.subscriptions.push(
        vscode.commands.registerCommand("file-browser.tabPrev", () =>
            active.ifSome((active) => active.tabCompletion(false))
        )
    );
}

export function deactivate() { }