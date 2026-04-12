export enum Action {
    NewFile,
    NewFolder,
    OpenFile,
    OpenFileBeside,
    RenameFile,
    DeleteFile,
    OpenFolder,
    OpenFolderInNewWindow,
    OpenTerminal,

    // ======== 批量/搜索 Action ========
    GoToLine,
    BulkCreate,
    BulkRename,
    BulkCopy,
    BulkMove,
    BulkDelete,

    // ======== 单项执行 Action ========
    SingleCreate,
    SingleRename,
    SingleCopy,
    SingleMove,
    SingleDelete,

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