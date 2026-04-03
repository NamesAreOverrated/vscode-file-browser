export enum Action {
    NewFile,
    NewFolder,
    OpenFile,
    OpenFileBeside,
    RenameFile,
    DeleteFile,
    OpenFolder,
    OpenFolderInNewWindow,

    // ======== 新增的 Action ========
    GoToSymbol,
    GoToLine,
    OpenGlobalFile,
    OpenGlobalFolder,
    BulkCreate,
    BulkRename,
    BulkCopy,
    BulkMove,
    BulkDelete,

    Preview // 新增：哑操作，用于模式匹配下的文件预览项
}

export function action(label: string, action: Action, payload?: any) {
    return {
        label,
        name: "",
        action,
        alwaysShow: true,
        payload
    };
}