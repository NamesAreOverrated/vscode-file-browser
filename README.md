# File Browser Plus

File Browser Plus is a keyboard-driven file management extension for Visual Studio Code. It is designed to facilitate rapid navigation and manipulation of the file system through a unified command-line interface, reducing reliance on the mouse and the standard sidebar.

## Core Navigation and Path Shortcuts

Navigation is primarily conducted using the arrow keys and the Enter key.
- **Step Into/Accept**: Pressing the Right Arrow or Enter on a folder moves the browser into that directory. On a file, it opens the action menu or the file itself.
- **Step Out**: Pressing the Left Arrow moves the browser to the parent directory.
- **Root Shortcut (~~)**: Typing `~~` into the input field instantly resets the browser path to the first workspace root directory.
- **Home/Workspace Path (~)**: Starting a path with `~` allows for navigation relative to the workspace root, regardless of the current directory location.

## Advanced Search and Navigation Modes

The extension utilizes specific character prefixes to switch between different functional modes:

- **Symbol Search (@ / @@)**: 
  - `@`: Searches for symbols (functions, classes, variables) within the currently active document.
  - `@@`: Performs a workspace-wide symbol search.
- **Global Search (! / #)**:
  - `!`: Searches for files across the entire workspace by name.
  - `#`: Searches for directories across the entire workspace.
- **Text Search ($ / $$)**:
  - `$`: Searches for text strings within currently open documents.
  - `$$`: Performs a global text search across workspace files.
- **Line Navigation (:)**: Typing a colon followed by a number (e.g., `:45`) targets a specific line in the active file.
- **Diagnostics (% / %%)**:
  - `%`: Lists errors and warnings in the current file.
  - `%%`: Lists all diagnostics across the workspace.

## Bulk Operations and Wildcard Transformation

Bulk operations allow for the simultaneous manipulation of multiple file system entries. These commands follow the syntax `prefix:source_pattern [target_pattern]`.

### Wildcard Replacement (*)
The asterisk (`*`) is used for pattern matching and string transformation. During a bulk rename or copy operation, the `*` in the target pattern is replaced by the string matched by the `*` in the source pattern. 
- **Example**: `r:old_*.js new_*.js`
  This command will rename `old_data.js` to `new_data.js` and `old_test.js` to `new_test.js`.

### Command Prefixes
- **r:** (Rename): Renames files matching the source pattern. If only one argument is provided, it renames the currently active file.
- **d:** (Delete): Deletes all files and folders matching the specified pattern.
- **c:** (Copy): Copies matched files to the destination. If the destination ends with a `/`, it is treated as a directory.
- **m:** (Move): Moves matched files to the destination.

## Pattern Expansion and Creation

The extension supports glob patterns and brace expansion for both searching and creating files.

- **Brace Expansion**: Typing `src/{app,utils}.ts` identifies or creates both `src/app.ts` and `src/utils.ts`. 
- **Deep Creation**: If a path is entered that does not exist (e.g., `new_folder/sub/file.txt`), the extension will recursively create all necessary parent directories upon execution.
- **Numeric Ranges**: Supports sequences such as `data{01..05}.json`, which expands to five numbered files.

## Command Reference Table

| Prefix | Function | Example |
| :--- | :--- | :--- |
| `~` | Workspace Root Path | `~/src/main.ts` |
| `~~` | Jump to Root | `~~` |
| `r:` | Bulk/Quick Rename | `r:*.txt *.log` |
| `d:` | Bulk Delete | `d:*.tmp` |
| `c:` | Bulk Copy | `c:config.json ./backup/` |
| `m:` | Bulk Move | `m:*.js ./scripts/` |
| `@` | Document Symbols | `@init` |
| `@@` | Workspace Symbols | `@@UserService` |
| `!` | Workspace File Search | `!index.html` |
| `#` | Workspace Folder Search | `#assets` |
| `$` | Open Files Text Search | `$TODO` |
| `$$` | Global Text Search | `$$functionName` |
| `:` | Go to Line | `:120` |
| `>t` | Terminal at Path | `>t folder_name` |
| `>d` | Reveal in OS | `>d` |

## System Constraints and Safety

- **Path Safety**: Operations are restricted to the current workspace boundaries to prevent accidental modification of system files.
- **Gitignore Respect**: The extension optionally filters results based on `.gitignore` and `.ignore` files located within the workspace.
- **Confirmation**: Destructive actions, such as bulk deletions or overwriting existing files, require explicit user confirmation via a modal dialog.

---

## Licence & Credits

**File Browser Plus** is a fork of the original [vscode-file-browser](https://github.com/bodil/vscode-file-browser) created by **Bodil Stokke**.

Copyright 2020 [Bodil Stokke]

Copyright 2026 [NamesAreOverrated]

This program is free software: you can redistribute it and/or modify it under the terms of the **GNU Lesser General Public License** as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version.

This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the [LGPL-3.0 License](https://www.gnu.org/licenses/lgpl-3.0.en.html) for more details.

## Code of Conduct

Please note that this project is released with a [Contributor Code of Conduct][coc]. By participating in this project you agree to abide by its terms.

[coc]: https://github.com/bodil/vscode-file-browser/blob/master/CODE_OF_CONDUCT.md
