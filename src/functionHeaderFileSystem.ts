import * as vscode from "vscode";
import { FUNCTION_HEADER_SCHEME, functionHeaderText } from "./functionHeaders";

/**
 * Read-only file system with the function header documents shown in the
 * Disassembly view. A file system rather than a TextDocumentContentProvider:
 * VS Code re-renders a row by releasing and acquiring its document at once,
 * and for content providers that re-acquire fails with "Cannot add model
 * because it already exists", leaving the row with stale text. File system
 * documents are reused instead.
 */
class FunctionHeaderFileSystem implements vscode.FileSystemProvider {
    private readonly changes = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
    readonly onDidChangeFile = this.changes.event;

    watch(): vscode.Disposable {
        return new vscode.Disposable(() => undefined);
    }

    stat(uri: vscode.Uri): vscode.FileStat {
        const text = functionHeaderText(uri.path);
        return {
            type: text === undefined ? vscode.FileType.Directory : vscode.FileType.File,
            ctime: 0,
            mtime: 0,
            size: text === undefined ? 0 : Buffer.byteLength(text),
            permissions: vscode.FilePermission.Readonly,
        };
    }

    readFile(uri: vscode.Uri): Uint8Array {
        const text = functionHeaderText(uri.path);
        if (text === undefined) {
            throw vscode.FileSystemError.FileIsADirectory(uri);
        }
        return Buffer.from(text);
    }

    readDirectory(): [string, vscode.FileType][] {
        return [];
    }

    createDirectory(uri: vscode.Uri): void {
        throw vscode.FileSystemError.NoPermissions(uri);
    }

    writeFile(uri: vscode.Uri): void {
        throw vscode.FileSystemError.NoPermissions(uri);
    }

    delete(uri: vscode.Uri): void {
        throw vscode.FileSystemError.NoPermissions(uri);
    }

    rename(uri: vscode.Uri): void {
        throw vscode.FileSystemError.NoPermissions(uri);
    }
}

export function registerFunctionHeaderFileSystem(): vscode.Disposable {
    return vscode.workspace.registerFileSystemProvider(FUNCTION_HEADER_SCHEME, new FunctionHeaderFileSystem(), {
        isReadonly: true,
        isCaseSensitive: true,
    });
}
