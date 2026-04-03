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

/** 支持双引号/单引号的参数分割器，防止带空格的文件名被截断 */
function splitArgs(str: string): string[] {
    const regex = /[^\s"']+|"([^"]*)"|'([^']*)'/g;
    const result: string[] = [];
    let match;
    while ((match = regex.exec(str)) !== null) {
        result.push(match[1] || match[2] || match[0]);
    }
    return result;
}

/** 简单的 Wildcard 到 Regex 转换 */
function wildcardToRegExp(pattern: string): RegExp {
    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp('^' + escaped.replace(/\*/g, '.*') + '$');
}

/** 
 * 增强版通配符重命名替换逻辑（支持多通配符映射）
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

    editorUri?: Uri; // 用于保存呼出搜索时的当前文件 URI
    private searchToken = 0;

    // 用于记忆 # 搜索时的状态
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
            this.current.placeholder = "Type a file name here to search or open a new file";
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
        // 清理上一次的防抖定时器
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
        if (value.startsWith("!")) return this.handleGlobalFileSearch(value.substring(1));
        if (value.startsWith("#")) return this.handleGlobalFolderSearch(value.substring(1));

        if (value.startsWith("r:")) return this.handleBulkOp(value.substring(2), Action.BulkRename);
        if (value.startsWith("d:")) return this.handleBulkOp(value.substring(2), Action.BulkDelete);
        if (value.startsWith("c:")) return this.handleBulkOp(value.substring(2), Action.BulkCopy);
        if (value.startsWith("m:")) return this.handleBulkOp(value.substring(2), Action.BulkMove);

        // 需要防抖的全局重量级搜索 (延迟 250ms)
        if (value.startsWith("!")) {
            this.searchTimeout = setTimeout(() => this.handleGlobalFileSearch(value.substring(1)), 250);
            return;
        }
        if (value.startsWith("#")) {
            this.searchTimeout = setTimeout(() => this.handleGlobalFolderSearch(value.substring(1)), 250);
            return;
        }


        const query = value.toLowerCase();

        let displayItems = this.items.filter((item) => {
            if (item.action !== undefined && item.action !== Action.OpenFile) return true;
            return item.name.toLowerCase().includes(query);
        });

        if (value.includes("{")) {
            const newItem = {
                label: `$(new-file) Create Pattern: ${value}`,
                name: value,
                description: "Supports brace expansion",
                alwaysShow: true,
                action: Action.BulkCreate,
                payload: value
            } as FileItem;
            displayItems = [newItem, ...displayItems];
        } else {
            const existingItem = this.items.find((item) => item.name === value);
            if (!existingItem) {
                const newItem = {
                    label: `$(new-file) ${value}`,
                    name: value,
                    description: "Open as new file",
                    alwaysShow: true,
                    action: Action.NewFile,
                } as FileItem;
                displayItems = [newItem, ...displayItems];
            }
        }

        this.current.items = displayItems;
        if (displayItems.length > 0) {
            this.current.activeItems = [displayItems[0]];
        }
    }

    // --- 高级搜索处理器 ---
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
                label: `$(symbol-method) ${s.name}`,
                name: s.name,
                description: `Line ${s.range.start.line + 1}`,
                alwaysShow: true,
                action: Action.GoToSymbol,
                payload: { uri: this.editorUri, range: s.range }
            } as FileItem));
        } catch (e) {
            console.error(e);
        } finally {
            if (this.searchToken === token) this.current.busy = false;
        }
    }

    handleLineSearch(query: string) {
        query = query.trim();
        const line = parseInt(query, 10);
        if (isNaN(line)) {
            this.current.items = [{ label: "Type a line number...", name: "", alwaysShow: true } as FileItem];
            return;
        }
        this.current.items = [{
            label: `$(go-to-file) Go to line ${line}`,
            name: query,
            alwaysShow: true,
            action: Action.GoToLine,
            payload: line
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
                label: `$(file) ${OSPath.basename(uri.fsPath)}`,
                description: vscode.workspace.asRelativePath(uri),
                name: OSPath.basename(uri.fsPath),
                alwaysShow: true,
                action: Action.OpenGlobalFile,
                payload: uri
            } as FileItem));
        } catch (e) {
            console.error(e);
        } finally {
            if (this.searchToken === token) this.current.busy = false;
        }
    }

    async handleGlobalFolderSearch(query: string) {
        query = query.trim().toLowerCase();
        if (query.length < 1) {
            this.current.items = [{ label: "Type to search folders globally...", name: "", alwaysShow: true } as FileItem];
            return;
        }

        const token = ++this.searchToken;
        this.current.busy = true;

        try {
            // 通过查找匹配文件夹内的文件，间接定位文件夹
            const files = await vscode.workspace.findFiles(`**/*${query}*/**`, '**/node_modules/**', 300);
            if (this.searchToken !== token) return;

            const dirSet = new Set<string>();
            const dirs: Uri[] = [];

            for (const f of files) {
                // 将完整路径分割
                const pathParts = f.path.split('/');
                let matchedIndex = -1;

                // 倒序遍历（跳过最后一个元素，因为最后一个是文件名）
                // 找出真正匹配到 query 的那一层目录的索引
                for (let i = pathParts.length - 2; i >= 0; i--) {
                    if (pathParts[i].toLowerCase().includes(query)) {
                        matchedIndex = i;
                        break;
                    }
                }

                // 如果找到了匹配层，截断重建正确的父目录 URI
                if (matchedIndex !== -1) {
                    const matchedPath = pathParts.slice(0, matchedIndex + 1).join('/');
                    const dirUri = f.with({ path: matchedPath });

                    // 使用 fsPath 判重（解决跨平台路径斜杠不一的问题）
                    if (!dirSet.has(dirUri.fsPath)) {
                        dirSet.add(dirUri.fsPath);
                        dirs.push(dirUri);
                    }
                }
            }

            this.current.items = dirs.map(uri => ({
                label: `$(folder) ${OSPath.basename(uri.fsPath)}`,
                description: vscode.workspace.asRelativePath(uri),
                name: OSPath.basename(uri.fsPath),
                alwaysShow: true,
                fileType: FileType.Directory,
                action: Action.OpenGlobalFolder,
                payload: uri
            } as FileItem));
        } catch (e) {
            console.error(e);
        } finally {
            if (this.searchToken === token) this.current.busy = false;
        }
    }

    handleBulkOp(query: string, action: Action) {
        const parts = splitArgs(query.trim());
        let label = "";
        let payload: any = {};
        let matchedFiles: FileItem[] = [];

        // --- 提取预览涉及到的文件 ---
        if (parts.length > 0) {
            const matchPattern = parts[0];
            try {
                const regex = wildcardToRegExp(matchPattern);
                matchedFiles = this.items.filter(i =>
                    (i.action === undefined || i.action === Action.OpenFile) &&
                    regex.test(i.name)
                );
            } catch (e) { }
        }

        if (action === Action.BulkRename && parts.length >= 2) {
            const from = parts[0], to = parts[1];
            label = `Rename matching '${from}' to '${to}'`;
            payload = { from, to };
            matchedFiles = matchedFiles.map(i => {
                const newName = applyWildcard(i.name, from, to) || i.name;
                return {
                    label: `$(arrow-right) ${i.name} -> ${newName}`,
                    name: i.name,
                    alwaysShow: true,
                    description: "Will be renamed",
                    action: Action.Preview
                } as FileItem;
            });
        } else if (action === Action.BulkDelete && parts.length === 1 && parts[0] !== "") {
            label = `Delete matching '${parts[0]}'`;
            payload = { match: parts[0] };
            matchedFiles = matchedFiles.map(i => ({
                label: `$(trash) ${i.name}`,
                name: i.name,
                alwaysShow: true,
                description: "Will be deleted",
                action: Action.Preview
            } as FileItem));
        } else if (action === Action.BulkCopy && parts.length >= 2) {
            label = `Copy '${parts[0]}' to '${parts[1]}'`;
            payload = { match: parts[0], dest: parts[1] };
            matchedFiles = matchedFiles.map(i => ({
                label: `$(files) ${i.name} -> ${parts[1]}/${i.name}`,
                name: i.name,
                alwaysShow: true,
                description: "Will be copied",
                action: Action.Preview
            } as FileItem));
        } else if (action === Action.BulkMove && parts.length >= 2) {
            label = `Move '${parts[0]}' to '${parts[1]}'`;
            payload = { match: parts[0], dest: parts[1] };
            matchedFiles = matchedFiles.map(i => ({
                label: `$(arrow-right) ${i.name} -> ${parts[1]}/${i.name}`,
                name: i.name,
                alwaysShow: true,
                description: "Will be moved",
                action: Action.Preview
            } as FileItem));
        } else {
            // 参数不完整仅显示已匹配预览
            matchedFiles = matchedFiles.map(i => ({
                label: `$(record) ${i.name}`,
                name: i.name,
                alwaysShow: true,
                description: "Matched",
                action: Action.Preview
            } as FileItem));
        }

        const items: FileItem[] = [];
        if (label) {
            items.push({ label: `$(zap) ${label}`, name: query, alwaysShow: true, action, payload } as FileItem);
        } else {
            items.push({ label: "Keep typing pattern...", name: "", alwaysShow: true } as FileItem);
        }

        items.push(...matchedFiles);
        this.current.items = items;
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

        // 修复：恢复搜索状态时，只要赋值 current.value，VS Code 底层就会自动触发 onDidChangeValue。
        // 去掉了之前多余的 this.onDidChangeValue(val); 防止执行两次导致白屏。
        if (this.searchModeState && this.path.equals(this.searchModeState.path)) {
            const val = this.searchModeState.mode;
            this.searchModeState = undefined;
            this.current.value = val;
            return;
        }

        // --- 防越狱逻辑改进 ---
        // 修复：比较 fsPath 而不是 toString()，确保在 Windows 上斜杠差异不会导致越狱失效
        const folders = vscode.workspace.workspaceFolders;
        if (folders) {
            const isRoot = folders.some(f => f.uri.fsPath === this.path.uri.fsPath);
            if (isRoot) {
                vscode.window.showInformationMessage("You are at the root of the workspace.");
                return;
            }
        }
        // ----------------------------------------

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

    async rename() {
        const uri = this.path.uri;
        const stat = await vscode.workspace.fs.stat(uri);
        const isDir = (stat.type & FileType.Directory) === FileType.Directory;
        const fileName = this.path.pop().getOrElse(() => { throw new Error("Can't rename an empty file name!"); });
        const fileType = isDir ? "folder" : "file";
        const workspaceFolder = this.path.getWorkspaceFolder().map((wsf) => wsf.uri);
        const relPath = workspaceFolder.chain((wsf) => new Path(uri).relativeTo(wsf)).getOr(fileName);
        const extension = OSPath.extname(relPath);
        const startSelection = relPath.length - fileName.length;
        const endSelection = startSelection + (fileName.length - extension.length);
        const result = await vscode.window.showInputBox({
            prompt: `Enter the new ${fileType} name`,
            value: relPath,
            valueSelection: [startSelection, endSelection],
        });
        this.file = Some(fileName);
        if (result !== undefined) {
            const newUri = workspaceFolder.match(
                (wsf) => Uri.joinPath(wsf, result),
                () => Uri.joinPath(this.path.uri, result)
            );
            if ((await Result.await(vscode.workspace.fs.rename(uri, newUri))).isOk()) {
                this.file = Some(OSPath.basename(result));
            } else {
                vscode.window.showErrorMessage(`Failed to rename ${fileType} "${fileName}"`);
            }
        }
    }

    async runAction(item: FileItem) {
        switch (item.action) {
            case Action.Preview: {
                // Do nothing
                break;
            }
            // ======== 新增的 Action 处理器 ========
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
            case Action.OpenGlobalFile: {
                this.openFile(item.payload as Uri);
                break;
            }
            case Action.OpenGlobalFolder: {
                this.searchModeState = { mode: this.current.value, path: new Path(item.payload) };
                this.current.value = "";
                await this.stepIntoFolder(new Path(item.payload));
                break;
            }
            case Action.BulkCreate: {
                const paths = expandBraces(item.payload);
                for (const p of paths) {
                    const fullUri = this.path.append(...p.split('/')).uri;
                    if (p.endsWith('/')) {
                        await vscode.workspace.fs.createDirectory(fullUri);
                    } else {
                        await vscode.workspace.fs.createDirectory(Uri.joinPath(fullUri, '..'));
                        await vscode.workspace.fs.writeFile(fullUri, new Uint8Array(0));
                    }
                }
                this.current.value = "";
                await this.update();
                break;
            }
            case Action.BulkRename: {
                const { from, to } = item.payload;
                const regex = wildcardToRegExp(from);
                const filesToRename = this.items.filter(i => regex.test(i.name));
                for (const f of filesToRename) {
                    const newName = applyWildcard(f.name, from, to);
                    if (newName && newName !== f.name) {
                        const oldUri = this.path.append(f.name).uri;
                        const newUri = this.path.append(newName).uri;
                        await vscode.workspace.fs.rename(oldUri, newUri);
                    }
                }
                this.current.value = "";
                await this.update();
                break;
            }
            case Action.BulkDelete: {
                const { match } = item.payload;
                const regex = wildcardToRegExp(match);
                const toDelete = this.items.filter(i => regex.test(i.name));
                for (const f of toDelete) {
                    const uri = this.path.append(f.name).uri;
                    await vscode.workspace.fs.delete(uri, { recursive: true, useTrash: true });
                }
                this.current.value = "";
                await this.update();
                break;
            }
            case Action.BulkMove:
            case Action.BulkCopy: {
                const { match, dest } = item.payload;
                const regex = wildcardToRegExp(match);
                const toOperate = this.items.filter(i => regex.test(i.name));
                const destBaseUri = this.path.append(dest).uri;
                await vscode.workspace.fs.createDirectory(destBaseUri);

                for (const f of toOperate) {
                    const oldUri = this.path.append(f.name).uri;
                    const newUri = Uri.joinPath(destBaseUri, f.name);
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
            // ======================================

            // 原有处理器
            case Action.NewFolder: {
                await vscode.workspace.fs.createDirectory(this.path.uri);
                await this.update();
                break;
            }
            case Action.NewFile: {
                const uri = this.path.append(item.name).uri;
                this.openFile(uri.with({ scheme: "untitled" }));
                break;
            }
            case Action.OpenFile: {
                const path = this.path.clone();
                if (item.name && item.name.length > 0) path.push(item.name);
                this.openFile(path.uri);
                break;
            }
            case Action.OpenFileBeside: {
                const path = this.path.clone();
                if (item.name && item.name.length > 0) path.push(item.name);
                this.openFile(path.uri, ViewColumn.Beside);
                break;
            }
            case Action.RenameFile: {
                this.keepAlive = true;
                this.hide();
                await this.rename();
                this.show();
                this.keepAlive = false;
                this.inActions = false;
                this.update();
                break;
            }
            case Action.DeleteFile: {
                this.keepAlive = true;
                this.hide();
                const uri = this.path.uri;
                const stat = await vscode.workspace.fs.stat(uri);
                const isDir = (stat.type & FileType.Directory) === FileType.Directory;
                const fileName = this.path.pop().getOrElse(() => { throw new Error("Can't delete an empty file name!"); });
                const fileType = isDir ? "folder" : "file";
                const goAhead = `$(trash) Delete the ${fileType} "${fileName}"`;
                const result = await vscode.window.showQuickPick(["$(close) Cancel", goAhead], {});
                if (result === goAhead) {
                    const delOp = await Result.await(vscode.workspace.fs.delete(uri, { recursive: isDir, useTrash: true }));
                    if (delOp.isErr()) vscode.window.showErrorMessage(`Failed to delete ${fileType} "${fileName}"`);
                }
                this.show();
                this.keepAlive = false;
                this.inActions = false;
                this.update();
                break;
            }
            case Action.OpenFolder: {
                vscode.commands.executeCommand("vscode.openFolder", this.path.uri);
                break;
            }
            case Action.OpenFolderInNewWindow: {
                vscode.commands.executeCommand("vscode.openFolder", this.path.uri, true);
                break;
            }
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