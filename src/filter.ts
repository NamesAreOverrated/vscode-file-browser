// 修改 filter.ts
import * as vscode from "vscode";
import { Uri } from "vscode";
import { lookUpwards, Path } from "./path";
import ignore from "ignore";
import { Ignore } from "ignore";
import { FileItem, itemIsDir } from "./fileitem";
import * as OSPath from "path";

export class Rules {
    private path: Path;
    private name: string;
    private rules: Ignore;

    private constructor(path: Path) {
        this.path = path;
        this.rules = ignore();
        this.name = "empty";
    }

    static async forPath(path: Path): Promise<Rules> {
        const ruleFileNames = [".gitignore", ".ignore"];
        const ruleFilePath = await lookUpwards(path.uri, ruleFileNames);
        return ruleFilePath.match(
            async (ruleFilePath) => await Rules.read(ruleFilePath),
            async () => new Rules(path)
        );
    }

    static async read(ruleFilePath: Uri): Promise<Rules> {
        const ruleString = (await vscode.workspace.fs.readFile(ruleFilePath)).toString();
        const ruleList = ruleString.trim().split(/\r?\n/);
        const rules = new Rules(new Path(ruleFilePath).parent());
        rules.name = OSPath.basename(ruleFilePath.fsPath);
        rules.add(ruleList);
        return rules;
    }

    private add(rules: string[]) {
        this.rules.add(rules);
    }

    // ==== 新增方法：直接判断某个 Uri 是否被 ignore 规则命中 ====
    public ignoresUri(uri: Uri): boolean {
        if (this.name === "empty") return false;
        // 计算目标文件相对于 .gitignore 文件所在目录的相对路径
        let relPath = OSPath.relative(this.path.fsPath, uri.fsPath).replace(/\\/g, '/');

        // 如果文件在 ignore 工作区之外（比如上级目录），则不忽略
        if (relPath.startsWith('..') || relPath === '') return false;

        return this.rules.test(relPath).ignored;
    }

    filter(base: Path, items: FileItem[]): FileItem[] {
        return items.filter((item) => {
            let relativePathStr = base.append(item.name).relativeTo(this.path.uri).getOr(item.name);
            if (itemIsDir(item)) {
                relativePathStr += "/";
            }
            return !this.rules.test(relativePathStr).ignored;
        });
    }
}