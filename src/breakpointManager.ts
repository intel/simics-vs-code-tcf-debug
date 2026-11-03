import { randomUUID } from "crypto";
import * as path from "path";
import { BreakpointEvent } from "@vscode/debugadapter";
import { DebugProtocol } from "@vscode/debugprotocol";
import {
    AccessMode,
    BreakpointCapabilities,
    BreakpointProperties,
    BreakpointStatus,
    BreakpointsService,
} from "./tcf/services/breakpoints";
import { toBigInt } from "./tcf/json";
import { instructionReference, parseInstructionReference } from "./disassembly";
import type { TargetPath } from "./pathMapper";

type BreakpointKind = "source" | "function" | "data" | "instruction";

function sourceContextId(source?: DebugProtocol.Source): string | undefined {
    const data: unknown = source?.adapterData;
    if (data && typeof data === "object" && "contextId" in data) {
        return typeof data.contextId === "string" ? data.contextId : undefined;
    }
    return undefined;
}

/** What VS Code asked for, converted to TCF properties (without ID). */
interface BreakpointSpec {
    kind: BreakpointKind;
    /** Identifies "the same" breakpoint between two set*Breakpoints requests. */
    key: string;
    props?: Omit<BreakpointProperties, "ID">;
    /** Reason the breakpoint cannot be planted, when props is undefined. */
    error?: string;
    logMessage?: string;
    source?: DebugProtocol.Source;
    line?: number;
    column?: number;
    /**
     * For instruction breakpoints: the context whose process the breakpoint
     * is limited to, when the agent supports ContextIds.
     */
    scopeContext?: string;
}

interface ManagedBreakpoint extends BreakpointSpec {
    dapId: number;
    /** TCF breakpoint ID, set while the breakpoint is planted in the agent. */
    tcfId?: string;
    status?: BreakpointStatus;
    /** Set once VS Code knows the DAP ID, after which changes are sent as events. */
    reported: boolean;
    /** The last DAP breakpoint sent to VS Code, to avoid sending unchanged ones. */
    lastReported?: string;
}

export interface BreakpointHost {
    sendEvent(event: DebugProtocol.Event): void;
    /** Maps an address in a context to a source location on the host, if known. */
    sourceLineAt(contextId: string, address: bigint): Promise<{ path: string; line: number } | undefined>;
    /** Maps a host path to the file name the agent should use in breakpoint File properties. */
    toTargetPath(hostPath: string, contextId?: string): Promise<string | TargetPath>;
    /** A context to query context specific capabilities (access modes) for. */
    capabilityContext(): string | undefined;
    /**
     * The ContextIds of an address breakpoint set in a context: the context's
     * process first, then the process's threads.
     */
    processContexts(contextId: string): string[];
    /** The context of instruction references without one. */
    defaultContext(): string | undefined;
}

export interface BreakpointHits {
    /** DAP IDs of all hit breakpoints that this adapter created. */
    dapIds: number[];
    logpoints: { dapId: number; message: string }[];
    /** True if a hit breakpoint is not a logpoint (including breakpoints from other clients). */
    hasStoppingBreakpoint: boolean;
    /** DAP stop reason for the hit breakpoints. */
    reason: "breakpoint" | "function breakpoint" | "data breakpoint" | "instruction breakpoint";
}

const ACCESS_TYPES: Record<DebugProtocol.DataBreakpointAccessType, number> = {
    read: AccessMode.Read,
    write: AccessMode.Write,
    readWrite: AccessMode.Read | AccessMode.Write,
};

/**
 * Keeps the TCF agent's breakpoint table in sync with the breakpoints in VS
 * Code. VS Code always sends the full list of breakpoints of one kind (or one
 * source file), which is diffed against what is planted to send Breakpoints
 * add/change/remove commands.
 */
export class BreakpointManager {
    private readonly idPrefix = `vscode-tcf-${randomUUID()}`;
    private nextTcfId = 1;
    private nextDapId = 1;
    private readonly sourceBreakpoints = new Map<string, ManagedBreakpoint[]>();
    private functionBreakpoints: ManagedBreakpoint[] = [];
    private dataBreakpoints: ManagedBreakpoint[] = [];
    private instructionBreakpoints: ManagedBreakpoint[] = [];
    private readonly byTcfId = new Map<string, ManagedBreakpoint>();
    private globalCaps: Promise<BreakpointCapabilities> | undefined;
    private contextCaps: Promise<BreakpointCapabilities> | undefined;
    private sourcePathUpdates: Promise<void> = Promise.resolve();

    constructor(
        private readonly service: BreakpointsService | undefined,
        private readonly host: BreakpointHost,
    ) {
        service?.addListener({
            status: (id, status) => this.onStatus(id, status),
            contextRemoved: (ids) => this.onRemoved(ids),
        });
    }

    async setSourceBreakpoints(
        source: DebugProtocol.Source,
        requested: DebugProtocol.SourceBreakpoint[],
    ): Promise<DebugProtocol.Breakpoint[]> {
        const file = source.path ?? source.name ?? "";
        const caps = await this.capabilities();
        const contextId = sourceContextId(source);
        const target = requested.length === 0 ? file : await this.host.toTargetPath(file, contextId);
        const targetFile = typeof target === "string" ? target : target.path;
        const scope = typeof target === "string" ? undefined : target.contextId;
        const specs = requested.map((r): BreakpointSpec => {
            const spec: BreakpointSpec = {
                kind: "source",
                key: `${r.line}:${r.column ?? ""}`,
                source,
                line: r.line,
                column: r.column,
                logMessage: r.logMessage,
            };
            if (caps.FileLine === false) {
                return {
                    ...spec,
                    error: "The TCF agent does not support source line breakpoints",
                };
            }
            if (scope && caps.ContextIds === false) {
                return {
                    ...spec,
                    error: "Context-scoped path mapping requires " + "breakpoint ContextIds support",
                };
            }
            return this.withCommonProps(
                spec,
                {
                    File: targetFile,
                    Line: r.line,
                    Column: r.column,
                    ...(scope && {
                        ContextIds: [scope],
                    }),
                },
                r,
                caps,
            );
        });
        const result = await this.update(this.sourceBreakpoints.get(file) ?? [], specs);
        if (result.length > 0) {
            this.sourceBreakpoints.set(file, result);
        } else {
            this.sourceBreakpoints.delete(file);
        }
        return this.report(result);
    }

    /** Remaps planted file breakpoints after the session's path map changes. */
    updateSourcePaths(): Promise<void> {
        const result = this.sourcePathUpdates.then(() => this.remapSourcePaths());
        this.sourcePathUpdates = result.catch(() => {});
        return result;
    }

    private async remapSourcePaths(): Promise<void> {
        for (const [file, breakpoints] of this.sourceBreakpoints) {
            for (const bp of breakpoints) {
                const contextId = sourceContextId(bp.source);
                let target: TargetPath;
                try {
                    const result = await this.host.toTargetPath(file, contextId);
                    target = typeof result === "string" ? { path: result } : result;
                    if (target.contextId && (await this.capabilities()).ContextIds === false) {
                        throw new Error("Context-scoped path mapping requires " + "breakpoint ContextIds support");
                    }
                } catch (err) {
                    // Never leave a previously global breakpoint planted
                    // after its mapping becomes scoped but cannot be applied.
                    if (bp.tcfId) {
                        await this.service!.remove([bp.tcfId]);
                        this.forget(bp);
                    }
                    bp.error = err instanceof Error ? err.message : String(err);
                    await this.sendChanged(bp);
                    continue;
                }
                const previousScope = bp.props?.ContextIds;
                const scopeChanged =
                    JSON.stringify(previousScope) !== JSON.stringify(target.contextId ? [target.contextId] : undefined);
                if (bp.props && (!bp.tcfId || bp.props.File !== target.path || scopeChanged)) {
                    bp.props = {
                        ...bp.props,
                        File: target.path,
                        ContextIds: target.contextId ? [target.contextId] : undefined,
                    };
                    await this.plant(bp, bp.tcfId !== undefined);
                }
                await this.sendChanged(bp);
            }
        }
    }

    async setFunctionBreakpoints(requested: DebugProtocol.FunctionBreakpoint[]): Promise<DebugProtocol.Breakpoint[]> {
        const caps = await this.capabilities();
        const specs = requested.map((r): BreakpointSpec => {
            const spec: BreakpointSpec = { kind: "function", key: r.name };
            if (caps.Location === false) {
                return { ...spec, error: "The TCF agent does not support breakpoints on expressions" };
            }
            return this.withCommonProps(spec, { Location: r.name }, r, caps);
        });
        this.functionBreakpoints = await this.update(this.functionBreakpoints, specs);
        return this.report(this.functionBreakpoints);
    }

    async setDataBreakpoints(requested: DebugProtocol.DataBreakpoint[]): Promise<DebugProtocol.Breakpoint[]> {
        const caps = await this.capabilities();
        const specs = requested.map((r): BreakpointSpec => {
            const accessType = r.accessType ?? "write";
            const spec: BreakpointSpec = { kind: "data", key: `${r.dataId}|${accessType}` };
            const target = parseDataId(r.dataId);
            if (!target) {
                return { ...spec, error: `Invalid data breakpoint '${r.dataId}'` };
            }
            const mode = ACCESS_TYPES[accessType];
            if (caps.AccessMode !== undefined && (caps.AccessMode & mode) !== mode) {
                return { ...spec, error: `The TCF agent does not support ${accessType} breakpoints` };
            }
            return this.withCommonProps(
                spec,
                { Location: formatAddress(target.address), Size: target.size, AccessMode: mode },
                r,
                caps,
            );
        });
        this.dataBreakpoints = await this.update(this.dataBreakpoints, specs);
        return this.report(this.dataBreakpoints);
    }

    /**
     * Plants breakpoints at instruction addresses, for example from the
     * Disassembly view. An address only means something in one address
     * space, so each breakpoint is limited to the process of the context in
     * its instruction reference.
     */
    async setInstructionBreakpoints(
        requested: DebugProtocol.InstructionBreakpoint[],
    ): Promise<DebugProtocol.Breakpoint[]> {
        const caps = await this.capabilities();
        const specs = requested.map((r): BreakpointSpec => {
            const spec: BreakpointSpec = {
                kind: "instruction",
                key: `${r.instructionReference}|${r.offset ?? 0}`,
            };
            let contextId: string | undefined;
            let address: bigint;
            try {
                const ref = parseInstructionReference(r.instructionReference);
                contextId = ref.contextId ?? this.host.defaultContext();
                address = ref.address + BigInt(r.offset ?? 0);
            } catch {
                return {
                    ...spec,
                    error: `Invalid instruction reference '${r.instructionReference}'`,
                };
            }
            if (address < 0n) {
                return { ...spec, error: "Invalid instruction address" };
            }
            if (caps.Location === false) {
                return {
                    ...spec,
                    error: "The TCF agent does not support address breakpoints",
                };
            }
            const location: Omit<BreakpointProperties, "ID"> = {
                Location: formatAddress(address),
            };
            if (contextId !== undefined && caps.ContextIds !== false) {
                const ids = this.host.processContexts(contextId);
                location.ContextIds = ids;
                // The process, which outlives the thread in the reference.
                spec.scopeContext = ids[0];
            }
            return this.withCommonProps(spec, location, r, caps);
        });
        this.instructionBreakpoints = await this.update(this.instructionBreakpoints, specs);
        return this.report(this.instructionBreakpoints);
    }

    /**
     * Updates the ContextIds of planted instruction breakpoints after
     * contexts were added or removed, so that new threads of the process
     * also hit them.
     */
    async updateInstructionScopes(): Promise<void> {
        const changed = this.instructionBreakpoints.filter((bp) => {
            const old = bp.props?.ContextIds as string[] | undefined;
            if (!bp.tcfId || !old || !bp.scopeContext) {
                return false;
            }
            const ids = this.host.processContexts(bp.scopeContext);
            if (sameIds(ids, old)) {
                return false;
            }
            bp.props = { ...bp.props, ContextIds: ids };
            return true;
        });
        await Promise.all(changed.map((bp) => this.plant(bp, true)));
        await Promise.all(changed.map((bp) => this.sendChanged(bp)));
    }

    /** Describes data breakpoint support for an address, see DAP dataBreakpointInfo. */
    async dataBreakpointInfo(
        args: DebugProtocol.DataBreakpointInfoArguments,
    ): Promise<DebugProtocol.DataBreakpointInfoResponse["body"]> {
        if (!this.service) {
            return { dataId: null, description: "The TCF agent does not provide the Breakpoints service" };
        }
        if (args.variablesReference !== undefined && !args.asAddress) {
            return { dataId: null, description: "Data breakpoints are only supported on memory addresses" };
        }
        let address: bigint;
        try {
            address = BigInt(args.name.trim());
        } catch {
            return { dataId: null, description: `'${args.name}' is not an address` };
        }
        const size = args.bytes && args.bytes > 0 ? args.bytes : 1;
        const caps = await this.capabilities();
        const modes = caps.AccessMode ?? AccessMode.Read | AccessMode.Write;
        const accessTypes = (Object.keys(ACCESS_TYPES) as DebugProtocol.DataBreakpointAccessType[]).filter(
            (t) => (modes & ACCESS_TYPES[t]) === ACCESS_TYPES[t],
        );
        if (accessTypes.length === 0) {
            return { dataId: null, description: "The TCF agent does not support data breakpoints" };
        }
        return {
            dataId: `${formatAddress(address)}:${size}`,
            description: `${size} byte${size === 1 ? "" : "s"} at ${formatAddress(address)}`,
            accessTypes,
            canPersist: true,
        };
    }

    /** Classifies the TCF breakpoints reported in a suspended context's state ("BPs"). */
    hits(tcfIds: readonly string[]): BreakpointHits {
        const result: BreakpointHits = {
            dapIds: [],
            logpoints: [],
            hasStoppingBreakpoint: false,
            reason: "breakpoint",
        };
        const kinds = new Set<BreakpointKind>();
        for (const id of tcfIds) {
            const bp = this.byTcfId.get(id);
            if (!bp) {
                result.hasStoppingBreakpoint = true;
                continue;
            }
            result.dapIds.push(bp.dapId);
            kinds.add(bp.kind);
            if (bp.logMessage !== undefined) {
                result.logpoints.push({ dapId: bp.dapId, message: bp.logMessage });
            } else {
                result.hasStoppingBreakpoint = true;
            }
        }
        if (kinds.size === 1 && kinds.has("function")) {
            result.reason = "function breakpoint";
        } else if (kinds.size === 1 && kinds.has("data")) {
            result.reason = "data breakpoint";
        } else if (kinds.size === 1 && kinds.has("instruction")) {
            result.reason = "instruction breakpoint";
        }
        return result;
    }

    private withCommonProps(
        spec: BreakpointSpec,
        location: Omit<BreakpointProperties, "ID">,
        r: { condition?: string; hitCondition?: string },
        caps: BreakpointCapabilities,
    ): BreakpointSpec {
        const props: Omit<BreakpointProperties, "ID"> = { Enabled: true, ...location };
        const condition = r.condition?.trim();
        if (condition) {
            if (caps.Condition === false) {
                return { ...spec, error: "The TCF agent does not support breakpoint conditions" };
            }
            props.Condition = condition;
        }
        if (r.hitCondition?.trim()) {
            const ignoreCount = parseHitCondition(r.hitCondition);
            if (ignoreCount === undefined) {
                return {
                    ...spec,
                    error: `Unsupported hit count '${r.hitCondition}', use a number N or '>= N' to break from the N:th hit`,
                };
            }
            if (caps.IgnoreCount === false) {
                return { ...spec, error: "The TCF agent does not support hit counts" };
            }
            if (ignoreCount > 0) {
                props.IgnoreCount = ignoreCount;
            }
        }
        for (const k of Object.keys(props) as (keyof typeof props)[]) {
            if (props[k] === undefined) {
                delete props[k];
            }
        }
        return { ...spec, props };
    }

    /**
     * Applies the requested breakpoints, reusing existing breakpoints with the
     * same key, and returns the new list in request order.
     */
    private async update(existing: ManagedBreakpoint[], specs: BreakpointSpec[]): Promise<ManagedBreakpoint[]> {
        const unused = new Map<string, ManagedBreakpoint>();
        for (const bp of existing) {
            unused.set(bp.key, bp);
        }
        const result: ManagedBreakpoint[] = [];
        const toAdd: ManagedBreakpoint[] = [];
        const toChange: ManagedBreakpoint[] = [];
        const toRemove: string[] = [];

        for (const spec of specs) {
            const old = unused.get(spec.key);
            if (old) {
                unused.delete(spec.key);
                const propsChanged = JSON.stringify(old.props) !== JSON.stringify(spec.props);
                Object.assign(old, spec);
                old.error = spec.error;
                old.logMessage = spec.logMessage;
                old.scopeContext = spec.scopeContext;
                if (propsChanged) {
                    if (old.tcfId && spec.props) {
                        toChange.push(old);
                    } else if (old.tcfId) {
                        toRemove.push(this.forget(old));
                    } else if (spec.props) {
                        toAdd.push(old);
                    }
                }
                result.push(old);
            } else {
                const bp: ManagedBreakpoint = { ...spec, dapId: this.nextDapId++, reported: false };
                if (spec.props) {
                    toAdd.push(bp);
                }
                result.push(bp);
            }
        }
        for (const bp of unused.values()) {
            if (bp.tcfId) {
                toRemove.push(this.forget(bp));
            }
        }

        if (!this.service) {
            for (const bp of result) {
                bp.error ??= "The TCF agent does not provide the Breakpoints service";
                bp.props = undefined;
            }
            return result;
        }
        if (toRemove.length > 0) {
            await this.service.remove(toRemove).catch(() => undefined);
        }
        await Promise.all([...toAdd.map((bp) => this.plant(bp, false)), ...toChange.map((bp) => this.plant(bp, true))]);
        return result;
    }

    private async plant(bp: ManagedBreakpoint, change: boolean): Promise<void> {
        const service = this.service!;
        if (!change) {
            bp.tcfId = `${this.idPrefix}-${this.nextTcfId++}`;
            this.byTcfId.set(bp.tcfId, bp);
        }
        const id = bp.tcfId!;
        bp.status = undefined;
        try {
            if (change) {
                await service.change({ ...bp.props, ID: id });
            } else {
                await service.add({ ...bp.props, ID: id });
            }
        } catch (err) {
            this.forget(bp);
            bp.error = err instanceof Error ? err.message : String(err);
            bp.props = undefined;
            return;
        }
        try {
            bp.status = await service.getStatus(id);
        } catch {
            // The status is also reported through status events.
        }
    }

    /** Stops tracking a planted breakpoint and returns its TCF ID. */
    private forget(bp: ManagedBreakpoint): string {
        const id = bp.tcfId!;
        this.byTcfId.delete(id);
        bp.tcfId = undefined;
        bp.status = undefined;
        return id;
    }

    private async report(bps: ManagedBreakpoint[]): Promise<DebugProtocol.Breakpoint[]> {
        const result = await Promise.all(bps.map((bp) => this.toDap(bp)));
        bps.forEach((bp, i) => {
            bp.reported = true;
            bp.lastReported = JSON.stringify(result[i]);
        });
        return result;
    }

    /** Sends a breakpoint event if VS Code's view of the breakpoint changed. */
    private async sendChanged(bp: ManagedBreakpoint): Promise<void> {
        const dap = await this.toDap(bp);
        const json = JSON.stringify(dap);
        if (bp.reported && json !== bp.lastReported) {
            bp.lastReported = json;
            this.host.sendEvent(new BreakpointEvent("changed", dap));
        }
    }

    private onStatus(id: string, status: BreakpointStatus): void {
        const bp = this.byTcfId.get(id);
        if (!bp) {
            return;
        }
        bp.status = status;
        if (bp.reported) {
            void this.sendChanged(bp);
        }
    }

    /** Breakpoints removed by the agent or another client, for example temporary ones. */
    private onRemoved(ids: string[]): void {
        for (const id of ids) {
            const bp = this.byTcfId.get(id);
            if (bp) {
                this.forget(bp);
                bp.error = "The breakpoint was removed from the TCF agent";
                if (bp.reported) {
                    void this.sendChanged(bp);
                }
            }
        }
    }

    private async toDap(bp: ManagedBreakpoint): Promise<DebugProtocol.Breakpoint> {
        const dap: DebugProtocol.Breakpoint = { id: bp.dapId, verified: false };
        if (bp.kind === "source") {
            dap.source = bp.source;
            dap.line = bp.line;
            dap.column = bp.column;
        }
        if (!bp.tcfId || !bp.props) {
            dap.message = bp.error ?? "The breakpoint is not planted";
            return dap;
        }
        const status = bp.status;
        const instances = status?.Instances ?? [];
        const planted = instances.filter((i) => !i.Error);
        dap.verified = planted.length > 0;
        dap.message =
            status?.Error ??
            instances.find((i) => i.Error)?.Error ??
            planted.find((i) => i.ConditionError)?.ConditionError ??
            (dap.verified ? undefined : "The breakpoint could not be resolved to any address");
        const first = planted[0];
        const address = toBigInt(first?.Address);
        if (address !== undefined) {
            dap.instructionReference = first?.LocationContext
                ? instructionReference(first.LocationContext, address)
                : formatAddress(address);
            if (bp.kind === "source" && first.LocationContext && bp.source?.path) {
                // Show where the breakpoint actually ended up, for example
                // when it is set on a line without code.
                const loc = await this.host.sourceLineAt(first.LocationContext, address).catch(() => undefined);
                if (loc && samePath(loc.path, bp.source.path)) {
                    dap.line = loc.line;
                }
            }
        }
        return dap;
    }

    private async capabilities(): Promise<BreakpointCapabilities> {
        if (!this.service) {
            return {};
        }
        this.globalCaps ??= this.service.getCapabilities("").catch(() => ({}));
        const ctx = this.host.capabilityContext();
        if (ctx && !this.contextCaps) {
            this.contextCaps = this.service.getCapabilities(ctx).catch(() => ({}));
        }
        const [global, context] = await Promise.all([this.globalCaps, this.contextCaps ?? Promise.resolve({})]);
        return { ...global, ...context };
    }
}

/**
 * Converts a DAP hit condition to a TCF IgnoreCount. TCF ignores the first
 * IgnoreCount hits and then triggers on every hit, so "N" and ">= N" (break
 * from the N:th hit) are supported.
 */
export function parseHitCondition(hitCondition: string): number | undefined {
    const m = /^\s*(?:>=\s*)?(\d+)\s*$/.exec(hitCondition);
    if (!m) {
        return undefined;
    }
    return Math.max(Number(m[1]) - 1, 0);
}

function parseDataId(dataId: string): { address: bigint; size: number } | undefined {
    const m = /^(0x[0-9a-f]+):(\d+)$/i.exec(dataId);
    return m ? { address: BigInt(m[1]), size: Number(m[2]) } : undefined;
}

function formatAddress(addr: bigint): string {
    return `0x${addr.toString(16)}`;
}

function samePath(a: string, b: string): boolean {
    return path.normalize(a) === path.normalize(b);
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
    return a.length === b.length && a.every((id, i) => id === b[i]);
}
