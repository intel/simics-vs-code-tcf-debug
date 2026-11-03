import * as fs from "fs/promises";
import * as path from "path";

export interface SymbolPathSuggestion {
    path: string;
    directory: boolean;
}

export async function suggestSymbolPaths(value: string, workspaceFolder?: string): Promise<SymbolPathSuggestion[]> {
    const directory = value.endsWith(path.sep) ? value : path.dirname(value);
    const prefix = value.endsWith(path.sep) ? "" : path.basename(value);
    const localDirectory = path.isAbsolute(directory)
        ? directory
        : workspaceFolder
          ? path.resolve(workspaceFolder, directory)
          : undefined;
    if (!localDirectory) {
        return [];
    }
    try {
        const entries = await fs.readdir(localDirectory, { withFileTypes: true });
        return entries
            .filter((entry) => entry.name.toLowerCase().startsWith(prefix.toLowerCase()))
            .sort(
                (left, right) =>
                    Number(right.isDirectory()) - Number(left.isDirectory()) || left.name.localeCompare(right.name),
            )
            .slice(0, 100)
            .map((entry) => ({ path: path.join(directory, entry.name), directory: entry.isDirectory() }));
    } catch {
        return [];
    }
}
