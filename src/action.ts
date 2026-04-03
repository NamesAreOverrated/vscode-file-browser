// --- START OF FILE action.ts ---
export enum Action {
    NewFile,
    NewFolder,
    OpenFile,
    OpenFileBeside,
    RenameFile,
    DeleteFile,
    OpenFolder,
    OpenFolderInNewWindow,

    // ======== 批量操作 Action ========
    GoToSymbol,
    GoToLine,
    OpenGlobalFile,
    OpenGlobalFolder,
    BulkCreate,
    BulkRename,
    BulkCopy,
    BulkMove,
    BulkDelete,

    // ======== 新增：单项预览的执行 Action ========
    SingleCreate,
    SingleRename,
    SingleCopy,
    SingleMove,
    SingleDelete
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