import * as fs from "fs";
import { toBigInt } from "./tcf/json";
import { MemoryMapService, MemoryRegionProperties } from "./tcf/services/memoryMap";

/** Default prefix of the IDs of the memory map regions of symbol files. */
export const SYMBOL_FILE_ID_PREFIX = "vscode-symbol-file-";

/** A symbol file from the debug configuration. */
export interface SymbolFileConfig {
    /** Path of the symbol file (ELF with debug information) as seen by the agent. */
    path: string;
    /** Context ID or name the symbol file applies to. All contexts if not set. */
    context?: string;
    /** TCF context query selecting the contexts the symbol file applies to. */
    contextQuery?: string;
    /**
     * Relocation offset added to all addresses in the file, like the Simics
     * command add-symbol-file -relative. May be negative. With `absolute`,
     * this is instead the load address of the file's loadable segment with
     * the lowest file offset (normally the first one). If not set, the
     * addresses in the file are used.
     */
    address?: number | string;
    /** Treat `address` as an absolute load address instead of an offset. Requires `address`. */
    absolute?: boolean;
}

export interface SymbolFile {
    path: string;
    context: string;
    contextQuery?: string;
    /** Relocation offset (may be negative), or the load address when `absolute` is set. */
    address?: bigint;
    /** Only present when true. */
    absolute?: true;
}

export function symbolFileBreakpointContext(
    file: Pick<SymbolFileConfig, "context">,
    contexts: readonly { id: string; name: string }[],
): string {
    const scope = file.context;
    if (!scope) {
        throw new Error("The symbol file has no context");
    }
    const exact = contexts.find((context) => context.id === scope);
    if (exact) {
        return exact.id;
    }
    const matches = contexts.filter((context) => context.name === scope);
    if (matches.length !== 1) {
        throw new Error(
            matches.length === 0
                ? `Symbol file context '${scope}' is not available in this session`
                : `Symbol file context '${scope}' is ambiguous; use its exact TCF context ID`,
        );
    }
    return matches[0].id;
}

/**
 * Validates the "symbolFiles" attribute of a debug configuration. Returns the
 * valid entries and a message for each invalid one.
 */
export function parseSymbolFilesConfig(value: unknown): { files: SymbolFile[]; errors: string[] } {
    const files: SymbolFile[] = [];
    const errors: string[] = [];
    if (value === undefined || value === null) {
        return { files, errors };
    }
    if (!Array.isArray(value)) {
        return { files, errors: ['"symbolFiles" must be a list of { "path": ... } entries'] };
    }
    value.forEach((entry, i) => {
        const e = entry as Partial<SymbolFileConfig> | null;
        if (typeof e?.path !== "string" || e.path.length === 0) {
            errors.push(`symbolFiles[${i}] is ignored, it needs a non-empty "path" string`);
            return;
        }
        if (e.context !== undefined && typeof e.context !== "string") {
            errors.push(`symbolFiles[${i}] is ignored, "context" must be a string`);
            return;
        }
        if (e.contextQuery !== undefined && (typeof e.contextQuery !== "string" || e.contextQuery.length === 0)) {
            errors.push(`symbolFiles[${i}] is ignored, "contextQuery" must be a non-empty string`);
            return;
        }
        if (e.absolute !== undefined && typeof e.absolute !== "boolean") {
            errors.push(`symbolFiles[${i}] is ignored, "absolute" must be true or false`);
            return;
        }
        const absolute = e.absolute === true;
        if (absolute && e.address === undefined) {
            errors.push(`symbolFiles[${i}] is ignored, "absolute" requires an "address" to load the file at`);
            return;
        }
        let address: bigint | undefined;
        if (e.address !== undefined) {
            address = parseAddress(e.address, !absolute);
            if (address === undefined) {
                errors.push(
                    absolute
                        ? `symbolFiles[${i}] is ignored, an absolute "address" must be a non-negative integer or a string like "0x1000"`
                        : `symbolFiles[${i}] is ignored, "address" must be an integer or a string like "0x1000" or "-0x1000"`,
                );
                return;
            }
        }
        files.push({
            path: e.path,
            context: e.context ?? "",
            contextQuery: e.contextQuery,
            address,
            ...(absolute && { absolute: true as const }),
        });
    });
    return { files, errors };
}

/**
 * Adds symbol files to the agent's memory map, like "Load symbols" in the
 * Eclipse TCF client: each file becomes a memory region with FileName, set
 * with MemoryMap.set for its context, or for all contexts ("") with a
 * ContextQuery filter. A relocation offset is sent as BaseAddress (added to
 * all file addresses, which is what Simics add-symbol-file -relative uses);
 * an absolute load address as Addr (the address of the file's first
 * loadable segment). The agent removes the regions when the debug session
 * ends. The region IDs start with `idPrefix`, so that the regions can be
 * recognized in MemoryMap.get results.
 */
export async function applySymbolFiles(
    service: MemoryMapService,
    files: SymbolFile[],
    warn: (message: string) => void,
    previousFiles: SymbolFile[] = [],
    idPrefix = SYMBOL_FILE_ID_PREFIX,
): Promise<void> {
    const maps = new Map<string, MemoryRegionProperties[]>();
    files.forEach((f, i) => {
        if (!fs.existsSync(f.path)) {
            // The agent may run on another host, so this is only a hint.
            warn(`Symbol file ${f.path} does not exist on this host`);
        }
        const region: MemoryRegionProperties = { ID: `${idPrefix}${i + 1}`, FileName: f.path };
        if (f.address !== undefined) {
            if (f.absolute) {
                region.Addr = f.address;
            } else {
                region.BaseAddress = f.address;
            }
        }
        if (f.contextQuery !== undefined) {
            region.ContextQuery = f.contextQuery;
        }
        const regions = maps.get(f.context) ?? [];
        regions.push(region);
        maps.set(f.context, regions);
    });
    for (const file of previousFiles) {
        if (!maps.has(file.context)) {
            maps.set(file.context, []);
        }
    }
    await Promise.all([...maps].map(([ctx, regions]) => service.set(ctx, regions)));
}

/**
 * A memory map region of a file that is mapped by someone else. Numbers are
 * hex strings.
 */
export interface ForeignSymbolFileRegion {
    addr?: string;
    size?: string;
    /**
     * Relocation offset ("+0x1000" or "-0x1000"), from BaseAddress or the
     * Simics "relocation" attribute.
     */
    offset?: string;
    section?: string;
}

/**
 * A file in the agent's memory maps that this session did not add, for
 * example with add-symbol-file in Simics, by OS awareness, or by another
 * client.
 */
export interface ForeignSymbolFile {
    path: string;
    /** The memory contexts the file is mapped in. */
    contexts: string[];
    /** IDs of the regions, set by the client that added them. */
    ids: string[];
    regions: ForeignSymbolFileRegion[];
}

/**
 * Collects the files in MemoryMap.get results, grouped by file name, leaving
 * out regions without a file and those for which `isOwn` is true. Files are
 * listed in the order they are first seen.
 */
export function collectForeignSymbolFiles(
    maps: { context: string; regions: MemoryRegionProperties[] }[],
    isOwn: (region: MemoryRegionProperties) => boolean,
): ForeignSymbolFile[] {
    const files = new Map<string, ForeignSymbolFile>();
    const regionKeys = new Map<string, Set<string>>();
    for (const { context, regions } of maps) {
        for (const region of regions) {
            if (typeof region.FileName !== "string" || region.FileName.length === 0 || isOwn(region)) {
                continue;
            }
            let file = files.get(region.FileName);
            if (!file) {
                file = {
                    path: region.FileName,
                    contexts: [],
                    ids: [],
                    regions: [],
                };
                files.set(region.FileName, file);
                regionKeys.set(region.FileName, new Set());
            }
            if (!file.contexts.includes(context)) {
                file.contexts.push(context);
            }
            if (typeof region.ID === "string" && !file.ids.includes(region.ID)) {
                file.ids.push(region.ID);
            }
            const summary = summarizeRegion(region);
            const key = JSON.stringify(summary);
            const keys = regionKeys.get(region.FileName)!;
            if (!keys.has(key)) {
                keys.add(key);
                file.regions.push(summary);
            }
        }
    }
    return [...files.values()];
}

function summarizeRegion(region: MemoryRegionProperties): ForeignSymbolFileRegion {
    const hex = (value: unknown) => {
        const v = toBigInt(value);
        return v === undefined ? undefined : `0x${v.toString(16)}`;
    };
    const offset = toBigInt(region.BaseAddress ?? region.relocation);
    const summary: ForeignSymbolFileRegion = {};
    const addr = hex(region.Addr);
    const size = hex(region.Size);
    if (addr !== undefined) {
        summary.addr = addr;
    }
    if (size !== undefined) {
        summary.size = size;
    }
    if (offset !== undefined && offset !== 0n) {
        summary.offset = formatSymbolFileAddress({ address: offset })!;
    }
    if (typeof region.SectionName === "string") {
        summary.section = region.SectionName;
    }
    return summary;
}

/**
 * The description and tooltip in the Symbol Files view of a file from
 * someone else's memory map.
 */
export function describeForeignSymbolFile(
    file: ForeignSymbolFile,
    maxRegions = 10,
): { description: string; tooltip: string } {
    const scope = file.contexts.length === 1 ? file.contexts[0] : `${file.contexts.length} contexts`;
    let where = "";
    if (file.regions.length === 1 && file.regions[0].offset !== undefined && file.regions[0].addr === undefined) {
        where = ` ${file.regions[0].offset}`;
    } else {
        const addrs = file.regions.flatMap((r) => (r.addr === undefined ? [] : [BigInt(r.addr)]));
        if (addrs.length > 0) {
            const lowest = addrs.reduce((a, b) => (a < b ? a : b));
            where = ` @ 0x${lowest.toString(16)}`;
        }
    }
    const lines = [file.path, `Mapped in: ${file.contexts.join(", ")}`];
    if (file.ids.length > 0) {
        lines.push(`Region ID: ${file.ids.join(", ")}`);
    }
    for (const r of file.regions.slice(0, maxRegions)) {
        const parts = [
            r.addr !== undefined && (r.size !== undefined ? `${r.addr}+${r.size}` : r.addr),
            r.offset !== undefined && `relocated by ${r.offset}`,
            r.section !== undefined && r.section,
        ].filter(Boolean);
        if (parts.length > 0) {
            lines.push(`  ${parts.join(" ")}`);
        }
    }
    if (file.regions.length > maxRegions) {
        lines.push(`  ... ${file.regions.length - maxRegions} more regions`);
    }
    return { description: `${scope}${where}`, tooltip: lines.join("\n") };
}

/** Parses an address; negative values are only accepted when `signed`. */
function parseAddress(value: unknown, signed = false): bigint | undefined {
    try {
        if (typeof value === "number" && Number.isSafeInteger(value) && (signed || value >= 0)) {
            return BigInt(value);
        }
        if (typeof value === "string") {
            const m = /^\s*(-?)\s*(0x[0-9a-f]+|\d+)\s*$/i.exec(value);
            if (m && (signed || !m[1])) {
                const v = BigInt(m[2]);
                return m[1] ? -v : v;
            }
        }
    } catch {
        // Fall through.
    }
    return undefined;
}

/** Formats a symbol file address for display: "+0x1000"/"-0x1000" for an offset, "0x1000" when absolute. */
export function formatSymbolFileAddress(file: Pick<SymbolFile, "address" | "absolute">): string | undefined {
    if (file.address === undefined) {
        return undefined;
    }
    const magnitude = `0x${(file.address < 0n ? -file.address : file.address).toString(16)}`;
    if (file.absolute) {
        return magnitude;
    }
    return `${file.address < 0n ? "-" : "+"}${magnitude}`;
}
