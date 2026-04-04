# File Browser Plus

**The ultimate keyboard-driven file manager for VS Code.**

Inspired by Emacs's [Helm](https://emacs-helm.github.io/helm/), this is a heavily enhanced fork of the original File Browser. It transforms the file selection process into a high-speed productivity tool with bulk operations, glob patterns, and advanced search modes.


## Key Enhancements (Power User Features)

While keeping the classic keyboard-first navigation, this version adds:

-   **Bulk Operations**: Execute file system actions on multiple files at once using a command prefix:
    -   `r:from to`: **Rename** multiple files (supports wildcards, e.g., `r:*.js *.ts`).
    -   `d:pattern`: **Delete** all files matching a pattern.
    -   `c:pattern dest`: **Copy** matched files to a destination.
    -   `m:pattern dest`: **Move** matched files to a destination.
-   **Glob & Brace Expansion**: Create or search multiple files instantly.
    -   Type `src/{index,utils,types}.ts` to create three files at once.
    -   Type `**/*.test.js` to find all test files in subdirectories.
-   **Contextual Search Modes**:
    -   `@`: Search **Symbols** in the active document.
    -   `:`: Go to **Line number**.
    -   `!`: Global **File** search (workspace-wide).
    -   `#`: Global **Folder** search.
-   **Deep Path Creation**: Type a non-existent path like `api/v1/user/service.ts` and hit enter; the extension will automatically perform a `mkdir -p` and create the file for you.
-   **Smarter Tab Completion**: Context-aware autocompletion that works across all search modes and command prefixes.

## Basic Usage

-   **Open Browser**: Bind `file-browser.open` to `Ctrl+O` or `Alt+O`.
-   **Navigation**: 
    -   `Right Arrow`: Step into a folder or view file actions.
    -   `Left Arrow`: Step out to the parent folder.
    -   `Tab`: Cycle through suggestions/autocompletion.
-   **Quick Rename**: Type `r:newname.js` while the browser is open to immediately rename the currently active file.

## Command Cheat Sheet

| Prefix | Action | Example |
| :--- | :--- | :--- |
| `r:` | Bulk Rename / Quick Rename | `r:*.old *.new` or `r:style.css` |
| `d:` | Bulk Delete | `d:temp_*` |
| `c:` | Bulk Copy | `c:*.json ./backup` |
| `m:` | Bulk Move | `m:*.log ./logs` |
| `@` | Symbol Search | `@handleSubmit` |
| `:` | Go to Line | `:42` |
| `!` | Workspace File Search | `!app.config` |
| `#` | Workspace Folder Search | `#controllers` |

---

## Licence & Credits

**File Browser Plus** is a fork of the original `vscode-file-browser` created by **Bodil Stokke**.

Copyright 2020 Bodil Stokke  
Copyright 2026 [NamesAreOverrated]

This program is free software: you can redistribute it and/or modify it under the terms of the **GNU Lesser General Public License** as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version.

This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the [LGPL-3.0 License](https://www.gnu.org/licenses/lgpl-3.0.en.html) for more details.

## Code of Conduct

Please note that this project is released with a [Contributor Code of Conduct][coc]. By participating in this project you agree to abide by its terms.

[coc]: https://github.com/bodil/vscode-file-browser/blob/master/CODE_OF_CONDUCT.md
