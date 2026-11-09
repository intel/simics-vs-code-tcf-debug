import { randomUUID } from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { PathMapRuleProperties, PathMapService } from "./tcf/services/pathMap";

/** A path map rule from the debug configuration. */
export interface PathMapRule {
    /** Path prefix as compiled into the debug information. */
    source: string;
    /** Corresponding path prefix on the host running VS Code. */
    destination: string;
    /** Exact context ID. Use this or contextQuery, not both. */
    context?: string;
    /** TCF query selecting contexts. Omitted means all contexts. */
    contextQuery?: string;
}

export interface TargetPath {
    path: string;
    /** Only set when local reverse mapping must be limited to this context. */
    contextId?: string;
}

/** The wire representation always uses ContextQuery, including exact IDs. */
export function pathMapContextQuery(rule: Pick<PathMapRule, "context" | "contextQuery">): string | undefined {
    if (rule.context) {
        const id = /^[A-Za-z_][A-Za-z0-9_]*$/.test(rule.context) ? rule.context : JSON.stringify(rule.context);
        return `ID=${id}`;
    }
    return rule.contextQuery;
}

/**
 * Maps between file paths in the debug information ("compiled" or target
 * paths) and paths on the host, the same way as the Eclipse TCF client:
 *
 * - The rules from the debug configuration are sent to the agent with
 *   PathMap.set. The agent then uses them when it matches breakpoint file
 *   names, so breakpoints can be set on host paths.
 * - Source paths reported by the agent are mapped to host paths here, using
 *   the configured rules first and then the agent's other rules (for example
 *   ones added with the Simics command add-pathmap-entry). The first mapped
 *   file that exists on the host is used.
 */
export class PathMapper {
    private readonly idPrefix = `vscode-tcf-${randomUUID()}`;
    private agentRules: Promise<PathMapRuleProperties[]> | undefined;
    private readonly hostPathCache = new Map<string, string>();
    private readonly queryCache = new Map<string, Promise<readonly string[]>>();
    private generation = 0;

    private readonly rules: PathMapRule[];
    private updates: Promise<void> = Promise.resolve();

    constructor(
        rules: readonly PathMapRule[],
        private readonly service: PathMapService | undefined,
        private readonly queryContexts?: (query: string) => Promise<readonly string[]>,
    ) {
        this.rules = [...rules];
        service?.onChanged(() => this.reset());
    }

    /** True if the agent applies the rules itself, for example to breakpoint file names. */
    get agentMapsPaths(): boolean {
        return this.service !== undefined;
    }

    /** Sends the configured rules to the agent. */
    async apply(): Promise<void> {
        if (!this.service || this.rules.length === 0) {
            return;
        }
        await this.commitRules(this.getRules());
    }

    getRules(): PathMapRule[] {
        return this.rules.map((rule) => ({ ...rule }));
    }

    /** Replaces only this client's rules, including clearing the last rule. */
    replaceRules(rules: readonly PathMapRule[], expected?: readonly PathMapRule[]): Promise<void> {
        const replacement = rules.map((rule) => ({ ...rule }));
        return this.update(async () => {
            if (expected && JSON.stringify(expected) !== JSON.stringify(this.rules)) {
                throw new Error("Path map rules changed. Refresh and retry.");
            }
            await this.commitRules(replacement);
        });
    }

    private update(operation: () => Promise<void>): Promise<void> {
        const result = this.updates.then(operation);
        this.updates = result.catch(() => {});
        return result;
    }

    private async commitRules(rules: PathMapRule[]): Promise<void> {
        await this.service?.set(
            rules.map((rule, i) => ({
                ID: `${this.idPrefix}-${i + 1}`,
                Source: rule.source,
                Destination: rule.destination,
                ...(pathMapContextQuery(rule) && {
                    ContextQuery: pathMapContextQuery(rule),
                }),
            })),
        );
        this.rules.splice(0, this.rules.length, ...rules);
        this.reset();
    }

    /**
     * Adds a rule after the configured ones, for example one the user made
     * by locating a missing source file, and sends all rules to the agent.
     */
    addRule(rule: PathMapRule): Promise<void> {
        return this.update(async () => {
            const rules = this.getRules();
            const known = rules.some(
                (r) =>
                    r.source === rule.source &&
                    r.destination === rule.destination &&
                    pathMapContextQuery(r) === pathMapContextQuery(rule),
            );
            if (!known) {
                rules.push({ ...rule });
            }
            await this.commitRules(rules);
        });
    }

    /** Maps a path from the debug information to a path on the host. */
    async toHost(compiledPath: string, contextId?: string): Promise<string> {
        const key = JSON.stringify([contextId, compiledPath]);
        const generation = this.generation;
        const cached = this.hostPathCache.get(key);
        if (cached !== undefined) {
            return cached;
        }
        const candidates: string[] = [];
        for (const r of this.rules) {
            const p = mapPrefix(compiledPath, r.source, r.destination);
            if (p !== undefined && (await this.matches(pathMapContextQuery(r), contextId))) {
                candidates.push(p);
            }
        }
        for (const r of await this.otherAgentRules()) {
            const p = mapPrefix(compiledPath, r.Source!, r.Destination!);
            if (p !== undefined && (await this.matches(r.ContextQuery, contextId))) {
                candidates.push(p);
            }
        }
        // Prefer a file that exists, else the first configured mapping, so
        // that a missing file is reported with the expected host path.
        const result =
            candidates.find(fileExists) ?? (fileExists(compiledPath) ? compiledPath : (candidates[0] ?? compiledPath));
        if (generation === this.generation) {
            this.hostPathCache.set(key, result);
        }
        return result;
    }

    /**
     * Maps a host path to the file name to use in breakpoints. Paths covered
     * by the configured rules are mapped by the agent itself (PathMap
     * service), or here in reverse if the agent has no PathMap service.
     * Rules the agent got elsewhere, for example from the Simics command
     * add-pathmap-entry, are not used by the agent for breakpoints, so those
     * are applied in reverse here.
     *
     * Rules with a "target=" source are skipped. The Simics agent uses that
     * prefix for files in the target's file system, such as binaries found
     * by the OS awareness tracker, never for paths in the debug information.
     */
    async toTarget(hostPath: string, contextId?: string): Promise<string> {
        return (await this.toTargetLocation(hostPath, contextId)).path;
    }

    async toTargetLocation(hostPath: string, contextId?: string): Promise<TargetPath> {
        for (const r of this.rules) {
            if (isTargetFileSystemPath(r.source)) {
                continue;
            }
            const p = mapPrefix(hostPath, r.destination, r.source);
            const query = pathMapContextQuery(r);
            if (p !== undefined && query && query !== "*" && query !== "**" && !contextId && !this.service) {
                throw new Error(
                    "Scoped breakpoint path mapping needs a context ID " + "or an agent with the PathMap service",
                );
            }
            // With no DAP context, let the agent apply scoped rules for
            // each breakpoint instance rather than choosing one globally.
            if (p !== undefined && this.service && !contextId) {
                return { path: hostPath };
            }
            if (p !== undefined && (await this.matches(query, contextId))) {
                return this.agentMapsPaths
                    ? { path: hostPath }
                    : {
                          path: p,
                          ...(query &&
                              query !== "*" &&
                              query !== "**" && {
                                  contextId,
                              }),
                      };
            }
        }
        for (const r of await this.otherAgentRules()) {
            if (isTargetFileSystemPath(r.Source!)) {
                continue;
            }
            const p = mapPrefix(hostPath, r.Destination!, r.Source!);
            if (p !== undefined && (await this.matches(r.ContextQuery, contextId))) {
                return {
                    path: p,
                    ...(r.ContextQuery && r.ContextQuery !== "*" && r.ContextQuery !== "**" && { contextId }),
                };
            }
        }
        return { path: hostPath };
    }

    private reset(): void {
        this.agentRules = undefined;
        this.invalidateContexts();
    }

    /** Context properties and hierarchy changes can change query results. */
    invalidateContexts(): void {
        this.generation++;
        this.hostPathCache.clear();
        this.queryCache.clear();
    }

    private async matches(query: string | undefined, contextId: string | undefined): Promise<boolean> {
        if (!query || query === "*" || query === "**") {
            return true;
        }
        if (!contextId) {
            return false;
        }
        const id = /^ID=("(?:[^"\\]|\\.)*"|[^",/=\s]+)$/.exec(query);
        if (id) {
            return contextId === (id[1].startsWith('"') ? JSON.parse(id[1]) : id[1]);
        }
        if (!this.queryContexts) {
            throw new Error(`Cannot evaluate path map query "${query}": ` + "the agent does not provide ContextQuery");
        }
        let result = this.queryCache.get(query);
        if (!result) {
            result = this.queryContexts(query);
            this.queryCache.set(query, result);
        }
        try {
            return (await result).includes(contextId);
        } catch (err) {
            if (this.queryCache.get(query) === result) {
                this.queryCache.delete(query);
            }
            throw err;
        }
    }

    /** Rules the agent knows from elsewhere that apply to this host. */
    private otherAgentRules(): Promise<PathMapRuleProperties[]> {
        if (!this.service) {
            return Promise.resolve([]);
        }
        this.agentRules ??= this.service
            .get()
            .then((rules) =>
                rules.filter(
                    (r) =>
                        typeof r.Source === "string" &&
                        r.Source.length > 0 &&
                        typeof r.Destination === "string" &&
                        r.Destination.length > 0 &&
                        !(typeof r.ID === "string" && r.ID.startsWith(this.idPrefix)) &&
                        (!r.Host || isLocalHost(r.Host)),
                ),
            )
            .catch(() => []);
        return this.agentRules;
    }
}

/**
 * Validates the "pathMap" attribute of a debug configuration. Returns the
 * valid rules and a message for each invalid entry.
 */
export function parsePathMapConfig(value: unknown): { rules: PathMapRule[]; errors: string[] } {
    const rules: PathMapRule[] = [];
    const errors: string[] = [];
    if (value === undefined || value === null) {
        return { rules, errors };
    }
    if (!Array.isArray(value)) {
        return { rules, errors: ['"pathMap" must be a list of { "source": ..., "destination": ... } rules'] };
    }
    value.forEach((entry, i) => {
        const e = entry as Partial<PathMapRule> | null;
        for (const key of ["context", "contextQuery"] as const) {
            if (e?.[key] !== undefined && (typeof e[key] !== "string" || e[key].trim().length === 0)) {
                errors.push(`pathMap[${i}] is ignored, "${key}" must be a ` + "non-empty string");
                return;
            }
        }
        if (e?.context !== undefined && e.contextQuery !== undefined) {
            errors.push(`pathMap[${i}] is ignored, use "context" or ` + '"contextQuery", not both');
            return;
        }
        if (
            typeof e?.source === "string" &&
            e.source.length > 0 &&
            typeof e.destination === "string" &&
            e.destination.length > 0
        ) {
            rules.push({
                source: e.source,
                destination: e.destination,
                ...(e.context !== undefined && { context: e.context }),
                ...(e.contextQuery !== undefined && {
                    contextQuery: e.contextQuery,
                }),
            });
        } else {
            errors.push(`pathMap[${i}] is ignored, it needs non-empty "source" and "destination" strings`);
        }
    });
    return { rules, errors };
}

/**
 * Problems to show the user before a session starts: rules without source or
 * destination, and destinations that do not exist on this host. Relative
 * destinations are checked relative to `folder`.
 */
export function pathMapProblems(value: unknown, exists: (p: string) => boolean, folder?: string): string[] {
    if (!Array.isArray(value)) {
        return [];
    }
    const isEmpty = (v: unknown) => typeof v !== "string" || v.length === 0;
    return value.flatMap((entry, i) => {
        const e = entry as { source?: unknown; destination?: unknown } | null;
        const empty = [isEmpty(e?.source) ? "source" : "", isEmpty(e?.destination) ? "destination" : ""].filter(
            (s) => s !== "",
        );
        if (empty.length > 0) {
            return [`Rule ${i + 1} has no ${empty.join(" and ")} and is ignored.`];
        }
        const scopeErrors = parsePathMapConfig([entry]).errors;
        if (scopeErrors.length > 0) {
            return scopeErrors.map((error) => error.replace("pathMap[0]", `Rule ${i + 1}`));
        }
        const destination = e?.destination as string;
        const resolved =
            folder !== undefined && !path.isAbsolute(destination) ? path.join(folder, destination) : destination;
        return exists(resolved) ? [] : [`Rule ${i + 1}: the destination ${destination} does not exist on this host.`];
    });
}

/**
 * Makes the rule that maps `compiledPath` to `hostPath`, the file the user
 * located on the host. The trailing path components the two paths have in
 * common are dropped, so the rule also maps the other files of the same
 * source tree. If even the file names differ, the rule maps only this file.
 */
export function deriveRule(compiledPath: string, hostPath: string): PathMapRule {
    const compiled = compiledPath.split(/[\\/]/);
    const host = hostPath.split(/[\\/]/);
    let common = 0;
    while (
        common < compiled.length - 1 &&
        common < host.length - 1 &&
        compiled[compiled.length - 1 - common] === host[host.length - 1 - common]
    ) {
        common++;
    }
    const prefix = (parts: string[]) => parts.slice(0, parts.length - common).join("/");
    // Keep at least one directory besides the root, "/" or "C:/", in both
    // prefixes.
    const isRoot = (p: string) => p === "" || /^[A-Za-z]:$/.test(p);
    while (common > 0 && (isRoot(prefix(compiled)) || isRoot(prefix(host)))) {
        common--;
    }
    if (common === 0) {
        return { source: compiledPath, destination: hostPath };
    }
    return { source: prefix(compiled), destination: prefix(host) };
}

/**
 * Replaces the prefix `from` of `file` with `to`. The prefix must end at a
 * path separator, so "/src" maps "/src/a.c" but not "/src2/a.c". Both / and
 * \ separators are accepted, so Windows compiled paths can be mapped.
 */
export function mapPrefix(file: string, from: string, to: string): string | undefined {
    const f = file.replace(/\\/g, "/");
    const prefix = from.replace(/\\/g, "/").replace(/\/+$/, "");
    if (prefix.length === 0) {
        return undefined;
    }
    if (f !== prefix && !f.startsWith(`${prefix}/`)) {
        return undefined;
    }
    const rest = f.slice(prefix.length);
    return `${to.replace(/[\\/]+$/, "")}${rest}`;
}

function isTargetFileSystemPath(file: string): boolean {
    return file.startsWith("target=");
}

function fileExists(file: string): boolean {
    try {
        return fs.statSync(file).isFile();
    } catch {
        return false;
    }
}

function isLocalHost(host: string): boolean {
    const h = host.toLowerCase();
    return h === "localhost" || h === "127.0.0.1" || h === "::1" || h === os.hostname().toLowerCase();
}
