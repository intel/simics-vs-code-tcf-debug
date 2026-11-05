import * as fs from "fs";
import * as path from "path";
import { randomBytes } from "crypto";
import {
    ContinuedEvent,
    DebugSession,
    Event,
    InitializedEvent,
    OutputEvent,
    Scope,
    Source,
    StackFrame,
    StoppedEvent,
    TerminatedEvent,
    Thread,
    ThreadEvent,
    InvalidatedEvent,
} from "@vscode/debugadapter";
import { DebugProtocol } from "@vscode/debugprotocol";
import { TcfChannel, TcfError, TraceFn, formatTcfError } from "./tcf/channel";
import { TraceSilenceRule, isSilenced, parseTraceSilence } from "./tcf/traceSilence";
import { ResumeMode, RunControlContext, RunControlService } from "./tcf/services/runControl";
import { RegistersContext, RegistersService } from "./tcf/services/registers";
import { CodeArea, LineNumbersService } from "./tcf/services/lineNumbers";
import { SymbolClass, SymbolContext, SymbolsService } from "./tcf/services/symbols";
import { BreakpointsService } from "./tcf/services/breakpoints";
import { ExpressionsService, formatExpressionValue } from "./tcf/services/expressions";
import { StackFrameContext, StackTraceService } from "./tcf/services/stackTrace";
import { DisassemblyService } from "./tcf/services/disassembly";
import {
    disassembleInstructions,
    DisassemblyCache,
    instructionReference,
    KnownInstructionStarts,
    parseInstructionReference,
} from "./disassembly";
import { FunctionInfo, FunctionRanges } from "./functionHeaders";
import { MemoryAccessMode, MemoryService } from "./tcf/services/memory";
import { BreakpointHits, BreakpointManager } from "./breakpointManager";
import { VariableNode, VariablesProvider } from "./variables";
import { PathMapper, PathMapRule, parsePathMapConfig } from "./pathMapper";
import { PathMapService } from "./tcf/services/pathMap";
import { MemoryMapService } from "./tcf/services/memoryMap";
import {
    ForeignSymbolFile,
    SYMBOL_FILE_ID_PREFIX,
    SymbolFile,
    SymbolFileConfig,
    applySymbolFiles,
    collectForeignSymbolFiles,
    formatSymbolFileAddress,
    parseSymbolFilesConfig,
} from "./symbolFiles";
import { toBigInt } from "./tcf/json";
import { scanMemory } from "./shared/targetMemory/search";
import * as req from "./tcfRequests";
import { CONSOLE_AVAILABLE_EVENT, SimicsCliOptions, simicsCliOptions } from "./simicsConsole";
import { CommandLineService } from "./tcf/services/commandLine";

export interface TcfAttachArguments extends DebugProtocol.AttachRequestArguments {
    host?: string;
    port?: number;
    connectTimeout?: number;
    traceTcf?: boolean;
    /** TCF messages left out of the traceTcf log. */
    traceTcfSilence?: TraceSilenceRule[];
    /** The Simics CLI terminal, see SimicsCliOptions. */
    consoles?: { simicsCli?: Partial<SimicsCliOptions> };
    /** Show a header row at function entries in the Disassembly view. */
    disassemblyFunctionHeaders?: boolean;
    /** Maps path prefixes in the debug information to path prefixes on the host, in order. */
    pathMap?: PathMapRule[];
    /** Symbol files to add to the agent's memory map. */
    symbolFiles?: SymbolFileConfig[];
}

/** Where the TCF trace goes instead of the Debug Console, for example an Output channel. */
export interface TcfLog {
    /** Shown to the user, so they know where to look. */
    readonly name: string;
    info(line: string): void;
    error(line: string): void;
}

interface ThreadState {
    suspended: boolean;
    pc?: bigint;
    reason?: string;
}

/** What a DAP variables reference refers to. */
type VariablesRef =
    /** The children of a register parent: a run control context, a stack frame or a register (group). */
    | { kind: "registers"; tcfId: string }
    /** The local variables of a frame. */
    | { kind: "locals"; threadCtx: string; scopeId: string }
    /** The children of an expandable variable or expression. */
    | { kind: "node"; threadCtx: string; scopeId: string; node: VariableNode };

/** A source file of a frame that was not found on this host. */
interface MissingSource {
    /** Path in the debug information. */
    compiledPath: string;
    /** The path mapping gave, the same as compiledPath if no rule applies. */
    hostPath: string;
    line: number;
    contextId: string;
}

/** A frame resolved through the LineNumbers and Symbols services. */
interface FrameInfo {
    name: string;
    source?: Source;
    line: number;
}

/** What a DAP frame ID refers to. */
interface FrameRef {
    threadCtx: string;
    /** Parent ID for the frame's registers: the thread context for the top frame, else the TCF frame ID. */
    registersId: string;
    /** Context or frame ID that expressions are evaluated in. */
    scopeId: string;
    localsRef?: number;
}

type StepKind = "over" | "into" | "out";

/** A Memory context with the "physical" access type. */
interface PhysicalMemoryContext {
    id: string;
    /** Full name, like the threads in the call stack. */
    name: string;
}

/** Why a thread stopped, used to build the DAP stopped event. */
interface StopInfo {
    /** The TCF suspend reason. */
    reason?: string;
    stepped?: boolean;
    hits?: BreakpointHits;
}

/**
 * Debug adapter translating DAP requests into TCF commands.
 *
 * Mapping:
 *  - TCF run control contexts with HasState -> DAP threads
 *  - Stack frames -> StackTrace service frames, with function name and source
 *    location from the Symbols and LineNumbers services. Without the
 *    StackTrace service a single frame for the PC is shown.
 *  - Stepping -> RunControl.resume with a step mode on the thread's context.
 *  - Breakpoints -> Breakpoints service, see BreakpointManager. Logpoints are
 *    planted as breakpoints; the adapter prints the message and resumes.
 *  - Each frame has a "Registers" scope whose children follow the TCF
 *    Registers context hierarchy (groups -> registers -> fields).
 */
export class TcfDebugSession extends DebugSession {
    private channel: TcfChannel | undefined;
    private runControl: RunControlService | undefined;
    private registers: RegistersService | undefined;
    private lineNumbers: LineNumbersService | undefined;
    private symbols: SymbolsService | undefined;
    private expressions: ExpressionsService | undefined;
    private stackTrace: StackTraceService | undefined;
    private disassembly: DisassemblyService | undefined;
    private memory: MemoryService | undefined;
    private physicalMemoryContexts: Promise<PhysicalMemoryContext[]> | undefined;
    /** Running tcfFindMemory requests by find ID. */
    private readonly memoryScans = new Map<number, { cancelled: boolean }>();
    private breakpoints: BreakpointManager | undefined;
    private pathMapper: PathMapper | undefined;
    private symbolsChangedTimer: NodeJS.Timeout | undefined;
    private memoryMap: MemoryMapService | undefined;
    private symbolFiles: SymbolFile[] = [];
    /**
     * Unique per session, to tell this session's memory map regions from
     * those of other clients.
     */
    private readonly symbolFileIdPrefix = `${SYMBOL_FILE_ID_PREFIX}${randomBytes(4).toString("hex")}-`;
    private symbolFilesUpdate: Promise<void> = Promise.resolve();
    private configured = false;
    private disassemblyFunctionHeaders = true;
    private disconnecting = false;

    private readonly contexts = new Map<string, RunControlContext>();
    /** Order in which run control contexts were discovered, used for thread ordering. */
    private readonly contextOrder: string[] = [];
    private readonly threadIdByCtx = new Map<string, number>();
    private readonly ctxByThreadId = new Map<number, string>();
    private nextThreadId = 1;
    private readonly threadStates = new Map<string, ThreadState>();
    /** Contexts with a step in progress, used to report the stop reason. */
    private readonly pendingSteps = new Set<string>();
    private readonly frameCache = new Map<string, Promise<FrameInfo>>();
    /** Source files of frames not found on this host, by source reference. */
    private readonly missingSources = new Map<number, MissingSource>();
    private readonly sourceRefByPath = new Map<string, number>();
    private nextSourceRef = 1;
    /** PCs where contexts stopped, used to keep disassembly in step. */
    private readonly knownInstructionStarts = new KnownInstructionStarts();
    private readonly functionRanges = new FunctionRanges((ctxId, address) => this.outerFunctionAt(ctxId, address));
    private readonly disassemblyCache = new DisassemblyCache((ctxId, address, size) =>
        this.readCodeBytes(ctxId, address, size),
    );

    /** DAP frame IDs, valid while the thread is suspended. */
    private readonly frameRefs = new Map<number, FrameRef>();
    private readonly frameIdByKey = new Map<string, number>();
    private nextFrameId = 1;
    /** All TCF frame IDs of a suspended thread, top frame first. */
    private readonly stackCache = new Map<string, Promise<string[]>>();
    /** Whether the agent supports StackTrace.getChildrenRange, undefined until known. */
    private hasChildrenRange: boolean | undefined;

    private readonly varRefByTcfId = new Map<string, number>();
    private readonly varRefs = new Map<number, VariablesRef>();
    private nextVarRef = 1;
    private variables: VariablesProvider | undefined;
    private readonly regContextCache = new Map<string, Promise<RegistersContext>>();
    private readonly regChildrenCache = new Map<string, Promise<string[]>>();

    constructor(private readonly tcfLog?: TcfLog) {
        super();
        this.setDebuggerLinesStartAt1(true);
        this.setDebuggerColumnsStartAt1(true);
    }

    /** The connection to the agent, shared with the Simics console. */
    get tcfChannel(): TcfChannel | undefined {
        return this.channel;
    }

    protected override initializeRequest(response: DebugProtocol.InitializeResponse): void {
        response.body = {
            ...response.body,
            supportsConfigurationDoneRequest: true,
            supportsDelayedStackTraceLoading: true,
            supportsEvaluateForHovers: true,
            supportsSteppingGranularity: true,
            supportsDisassembleRequest: true,
            supportsConditionalBreakpoints: true,
            supportsHitConditionalBreakpoints: true,
            supportsLogPoints: true,
            supportsFunctionBreakpoints: true,
            supportsDataBreakpoints: true,
            supportsDataBreakpointBytes: true,
            supportsInstructionBreakpoints: true,
            exceptionBreakpointFilters: [],
            supportsTerminateRequest: false,
            supportsRestartRequest: false,
        };
        this.sendResponse(response);
    }

    protected override async attachRequest(
        response: DebugProtocol.AttachResponse,
        args: TcfAttachArguments,
    ): Promise<void> {
        this.disassemblyFunctionHeaders = args.disassemblyFunctionHeaders !== false;
        const host = args.host ?? "localhost";
        const port = args.port ?? 1534;
        const tcfLog = this.tcfLog;
        let trace: TraceFn | undefined;
        if (args.traceTcf) {
            const { rules, invalid } = parseTraceSilence(args.traceTcfSilence);
            for (const e of invalid) {
                this.log(
                    `traceTcfSilence: ignoring ${JSON.stringify(e)}. Entries need a "service" string, ` +
                        `"name" must be a string and "type" a list of message types, if given.\n`,
                    "stderr",
                );
            }
            const write = tcfLog
                ? (dir: string, text: string) => tcfLog.info(`${dir} ${text}`)
                : (dir: string, text: string) => this.log(`TCF ${dir} ${text}\n`);
            trace = (dir, text, message) => {
                if (!isSilenced(rules, message)) {
                    write(dir, text);
                }
            };
        }
        if (args.traceTcf && tcfLog) {
            this.log(`TCF traffic is logged in the Output view, "${tcfLog.name}".\n`);
            tcfLog.info(`Connecting to ${host}:${port}`);
        }
        const channel = new TcfChannel(trace);
        this.channel = channel;
        channel.on("error", (err: Error) => {
            this.log(`TCF error: ${err.message}\n`, "stderr");
            tcfLog?.error(err.message);
        });

        try {
            await channel.connect(host, port, args.connectTimeout ?? 10000);
            channel.on("close", () => {
                if (!this.disconnecting) {
                    this.log("Connection to TCF agent closed.\n", "stderr");
                    this.sendEvent(new TerminatedEvent());
                }
            });
            this.log(`Connected to TCF agent at ${host}:${port}\n`);
            this.log(`Agent services: ${channel.remoteServices.join(", ")}\n`);

            if (!channel.hasService(RunControlService.NAME)) {
                throw new Error("The TCF agent does not provide the RunControl service");
            }
            this.runControl = new RunControlService(channel);
            this.addRunControlListener(this.runControl);
            if (channel.hasService(RegistersService.NAME)) {
                this.registers = new RegistersService(channel);
                this.registers.addListener({
                    contextChanged: () => {
                        this.regContextCache.clear();
                        this.regChildrenCache.clear();
                        this.sendEvent(new InvalidatedEvent(["variables"]));
                    },
                    registerChanged: () => this.sendEvent(new InvalidatedEvent(["variables"])),
                });
            } else {
                this.log(
                    "The TCF agent does not provide the Registers service, registers will not be shown.\n",
                    "stderr",
                );
            }
            if (channel.hasService(LineNumbersService.NAME)) {
                this.lineNumbers = new LineNumbersService(channel);
            }
            if (channel.hasService(SymbolsService.NAME)) {
                this.symbols = new SymbolsService(channel);
            }
            if (channel.hasService(ExpressionsService.NAME)) {
                this.expressions = new ExpressionsService(channel);
                this.variables = new VariablesProvider(this.expressions, this.symbols);
            }
            if (channel.hasService(StackTraceService.NAME)) {
                this.stackTrace = new StackTraceService(channel);
            }
            if (channel.hasService(DisassemblyService.NAME)) {
                this.disassembly = new DisassemblyService(channel);
            } else {
                this.log(
                    "The TCF agent does not provide the Disassembly service, disassembly will not be shown.\n",
                    "stderr",
                );
            }
            if (channel.hasService(MemoryService.NAME)) {
                this.memory = new MemoryService(channel);
                this.addMemoryListener(this.memory);
            }
            if (!channel.hasService(BreakpointsService.NAME)) {
                this.log(
                    "The TCF agent does not provide the Breakpoints service, breakpoints will not be planted.\n",
                    "stderr",
                );
            }

            const pathMap = parsePathMapConfig(args.pathMap);
            pathMap.errors.forEach((e) => this.log(`${e}\n`, "stderr"));
            const pathMapService = channel.hasService(PathMapService.NAME) ? new PathMapService(channel) : undefined;
            this.pathMapper = new PathMapper(
                pathMap.rules,
                pathMapService,
                channel.hasService("ContextQuery")
                    ? async (query) => {
                          const [ids] = await channel.command("ContextQuery", "query", query);
                          if (!Array.isArray(ids) || !ids.every((id) => typeof id === "string")) {
                              throw new Error("Invalid ContextQuery response");
                          }
                          return ids;
                      }
                    : undefined,
            );
            pathMapService?.onChanged(() => this.pathMapContextsChanged());
            try {
                // Before any breakpoints are planted, so that the agent can
                // match breakpoints on host paths.
                await this.pathMapper.apply();
            } catch (err) {
                this.log(`Failed to send the path map to the TCF agent: ${errorMessage(err)}\n`, "stderr");
            }
            if (pathMap.rules.length > 0 && !this.pathMapper.agentMapsPaths) {
                this.log(
                    "The TCF agent does not provide the PathMap service, breakpoint paths are mapped by VS Code.\n",
                );
            }
            const pathMapper = this.pathMapper;

            await this.loadSymbolFiles(channel, args.symbolFiles);

            this.breakpoints = new BreakpointManager(
                channel.hasService(BreakpointsService.NAME) ? new BreakpointsService(channel) : undefined,
                {
                    sendEvent: (e) => this.sendEvent(e),
                    sourceLineAt: (ctxId, address) => this.sourceLineAt(ctxId, address),
                    capabilityContext: () => this.threadIdByCtx.keys().next().value,
                    toTargetPath: (hostPath, contextId) => pathMapper.toTargetLocation(hostPath, contextId),
                    processContexts: (ctxId) => this.processContexts(ctxId),
                    defaultContext: () => this.suspendedThreadContext(),
                },
            );

            await this.discoverContexts();
            this.sendResponse(response);
            this.sendEvent(new InitializedEvent());
            this.sendEvent(new Event("symbolFilesChanged"));
            this.sendEvent(new Event("pathMapChanged"));
            this.reportMissingSymbolFiles();
            if (channel.hasService(CommandLineService.NAME)) {
                this.sendEvent(new Event(CONSOLE_AVAILABLE_EVENT, { open: simicsCliOptions(args).open }));
            }
        } catch (err) {
            this.disconnecting = true;
            channel.close();
            this.sendErrorResponse(response, 1, `Failed to attach: ${errorMessage(err)}`);
        }
    }

    /**
     * Adds the configured symbol files to the agent's memory map, and keeps
     * the views up to date when the memory map (and so the symbols) changes.
     */
    private async loadSymbolFiles(channel: TcfChannel, config: unknown): Promise<void> {
        const { files, errors } = parseSymbolFilesConfig(config);
        errors.forEach((e) => this.log(`${e}\n`, "stderr"));
        if (!channel.hasService(MemoryMapService.NAME)) {
            if (files.length > 0) {
                this.log(
                    "The TCF agent does not provide the MemoryMap service, symbol files are not loaded.\n",
                    "stderr",
                );
            }
            return;
        }
        const service = new MemoryMapService(channel);
        this.memoryMap = service;
        service.onChanged(() => this.onSymbolsChanged());
        if (files.length === 0) {
            return;
        }
        this.symbolFiles = files;
        try {
            await this.applySymbolFiles(service, files);
            for (const f of files) {
                const scope =
                    [f.context && `context ${f.context}`, f.contextQuery && `contexts matching ${f.contextQuery}`]
                        .filter(Boolean)
                        .join(", ") || "all contexts";
                const at =
                    f.address === undefined
                        ? ""
                        : f.absolute
                          ? ` at ${formatSymbolFileAddress(f)}`
                          : ` relocated by ${formatSymbolFileAddress(f)}`;
                this.log(`Symbol file ${f.path}${at} for ${scope}\n`);
            }
        } catch (err) {
            this.log(`Failed to add symbol files: ${errorMessage(err)}\n`, "stderr");
        }
    }

    private reportMissingSymbolFiles(): void {
        const missing = this.symbolFiles.flatMap((file, index) =>
            fs.existsSync(file.path) ? [] : [{ index, path: file.path }],
        );
        if (missing.length > 0) {
            this.sendEvent(new Event("symbolFilesMissing", { files: missing }));
        }
    }

    protected override async customRequest(
        command: string,
        response: DebugProtocol.Response,
        args: unknown,
    ): Promise<void> {
        if (await this.memoryRequest(command, response, args)) {
            return;
        }
        if (command === "getSymbolContexts" || command === "getFunctionBreakpointContexts") {
            await this.handle(response, async () => {
                let ids: string[];
                const includeContainers =
                    command === "getFunctionBreakpointContexts" &&
                    typeof args === "object" &&
                    args !== null &&
                    "includeContainers" in args &&
                    args.includeContainers === true;
                if (includeContainers) {
                    ids = this.contextOrder;
                } else if (this.channel?.hasService("ContextQuery")) {
                    const [result] = await this.channel.command("ContextQuery", "query", "HasState=true");
                    if (!Array.isArray(result) || !result.every((id) => typeof id === "string")) {
                        throw new Error("Invalid ContextQuery.query response");
                    }
                    ids = result;
                } else {
                    ids = this.contextOrder.filter((id) => this.contexts.get(id)?.HasState === true);
                }
                response.body = ids.map((id) => {
                    const threadId =
                        command === "getFunctionBreakpointContexts" ? this.threadIdByCtx.get(id) : undefined;
                    return {
                        id,
                        name: this.contextDisplayName(id),
                        ...(threadId !== undefined && { threadId }),
                    };
                });
            });
            return;
        }
        if (command === "getMissingSources") {
            response.body = { sources: [...this.missingSources.values()] };
            this.sendResponse(response);
            return;
        }
        if (command === "getPathMapRules") {
            response.body = { rules: this.pathMapper?.getRules() ?? [] };
            this.sendResponse(response);
            return;
        }
        if (command === "setPathMapRules") {
            await this.handle(response, async () => {
                const input = args as
                    | {
                          rules?: unknown;
                          expectedRules?: unknown;
                      }
                    | undefined;
                const parsed = parsePathMapConfig(input?.rules);
                const expected = parsePathMapConfig(input?.expectedRules);
                if (
                    !Array.isArray(input?.rules) ||
                    !Array.isArray(input?.expectedRules) ||
                    parsed.errors.length > 0 ||
                    expected.errors.length > 0
                ) {
                    throw new Error("Invalid path map rules");
                }
                if (!this.pathMapper) {
                    throw new Error("Not attached to a TCF agent");
                }
                await this.pathMapper.replaceRules(parsed.rules, expected.rules);
                await this.pathMapChanged();
            });
            return;
        }
        if (command === "addPathMapRule") {
            await this.handle(response, async () => {
                const parsed = parsePathMapConfig([args]);
                if (parsed.rules.length !== 1) {
                    throw new Error(parsed.errors.join("; "));
                }
                await this.addPathMapRule(parsed.rules[0]);
            });
            return;
        }
        if (command === "getSymbolFiles") {
            response.body = {
                supported: this.memoryMap !== undefined,
                files: this.symbolFiles.map((file) => ({
                    path: file.path,
                    context: file.context,
                    ...(file.contextQuery !== undefined && { contextQuery: file.contextQuery }),
                    ...(file.address !== undefined && { address: file.address.toString() }),
                    ...(file.absolute && { absolute: true }),
                })),
            };
            this.sendResponse(response);
            return;
        }
        if (command === "getForeignSymbolFiles") {
            await this.handle(
                response,
                async () => {
                    const service = this.memoryMap;
                    response.body = {
                        supported: service !== undefined,
                        files: service && !this.disconnecting ? await this.foreignSymbolFiles(service) : [],
                    };
                },
                false,
            );
            return;
        }
        if (
            ![
                "addSymbolFile",
                "removeSymbolFile",
                "replaceSymbolFile",
                "reloadSymbolFile",
                "reloadSymbolFiles",
            ].includes(command)
        ) {
            super.customRequest(command, response, args);
            return;
        }
        await this.handle(response, async () =>
            this.updateSymbolFiles(async () => {
                if (!this.channel || this.disconnecting || !this.memoryMap) {
                    throw new Error("The active TCF session does not provide the MemoryMap service");
                }
                const service = this.memoryMap;
                if (command === "addSymbolFile") {
                    const { files, errors } = parseSymbolFilesConfig([args]);
                    if (errors.length > 0) {
                        throw new Error(errors.join("; "));
                    }
                    const nextFiles = [...this.symbolFiles, ...files];
                    await this.applySymbolFiles(service, nextFiles);
                    this.symbolFiles = nextFiles;
                    this.log(`Symbol file ${files[0].path} added\n`);
                } else if (command === "replaceSymbolFile") {
                    const selection = args as { file?: unknown } | undefined;
                    const index = this.symbolFileIndex(args);
                    const { files, errors } = parseSymbolFilesConfig([selection?.file]);
                    if (errors.length > 0) {
                        throw new Error(errors.join("; "));
                    }
                    const original = this.symbolFiles[index];
                    const replacement = files[0];
                    const nextFiles = this.symbolFiles.map((file, position) =>
                        position === index ? replacement : file,
                    );
                    await this.applySymbolFiles(service, nextFiles, this.symbolFiles);
                    this.symbolFiles = nextFiles;
                    this.log(`Symbol file ${original.path} updated\n`);
                } else if (command === "removeSymbolFile") {
                    const index = this.symbolFileIndex(args);
                    const nextFiles = this.symbolFiles.filter((_, position) => position !== index);
                    await this.applySymbolFiles(service, nextFiles, this.symbolFiles);
                    this.log(`Symbol file ${this.symbolFiles[index].path} removed\n`);
                    this.symbolFiles = nextFiles;
                } else {
                    const contexts =
                        command === "reloadSymbolFile"
                            ? [this.symbolFiles[this.symbolFileIndex(args)].context]
                            : [...new Set(this.symbolFiles.map((file) => file.context))];
                    for (const context of contexts) {
                        await service.set(context, []);
                    }
                    await this.applySymbolFiles(service, this.symbolFiles);
                    this.log(`Symbol files reloaded\n`);
                }
                this.onSymbolsChanged();
                this.sendEvent(new Event("symbolFilesChanged"));
            }),
        );
    }

    private symbolFileIndex(args: unknown): number {
        const selection = args as
            | {
                  index?: unknown;
                  path?: unknown;
                  context?: unknown;
                  contextQuery?: unknown;
                  address?: unknown;
                  absolute?: unknown;
              }
            | undefined;
        const index = selection?.index;
        if (
            typeof index !== "number" ||
            !Number.isInteger(index) ||
            index < 0 ||
            this.symbolFiles[index]?.path !== selection?.path ||
            this.symbolFiles[index].context !== selection?.context ||
            this.symbolFiles[index].contextQuery !== selection?.contextQuery ||
            this.symbolFiles[index].address?.toString() !== selection?.address ||
            (this.symbolFiles[index].absolute === true) !== (selection?.absolute === true)
        ) {
            throw new Error("The selected symbol file is no longer available; refresh the view");
        }
        return index;
    }

    private applySymbolFiles(
        service: MemoryMapService,
        files: SymbolFile[],
        previousFiles?: SymbolFile[],
    ): Promise<void> {
        return applySymbolFiles(
            service,
            files,
            (warning) => this.log(`${warning}\n`, "stderr"),
            previousFiles,
            this.symbolFileIdPrefix,
        );
    }

    /**
     * The files in the agent's memory maps that this session did not add,
     * from MemoryMap.get for the memory context (ProcessID) of each core or
     * thread.
     */
    private async foreignSymbolFiles(service: MemoryMapService): Promise<ForeignSymbolFile[]> {
        const memoryContexts = new Set<string>();
        for (const id of this.contextOrder) {
            const ctx = this.contexts.get(id);
            if (ctx?.HasState) {
                memoryContexts.add(ctx.ProcessID ?? id);
            }
        }
        const maps = await Promise.all(
            [...memoryContexts].map(async (id) => {
                try {
                    return {
                        context: this.contextDisplayName(id),
                        regions: await service.get(id),
                    };
                } catch {
                    // The context may have gone away.
                    return {
                        context: this.contextDisplayName(id),
                        regions: [],
                    };
                }
            }),
        );
        return collectForeignSymbolFiles(
            maps,
            (region) => typeof region.ID === "string" && region.ID.startsWith(this.symbolFileIdPrefix),
        );
    }

    private async updateSymbolFiles(update: () => Promise<void>): Promise<void> {
        const operation = this.symbolFilesUpdate.then(update);
        this.symbolFilesUpdate = operation.catch(() => {});
        await operation;
    }

    /** Symbols changed (memory map update), so cached frames and variables may be wrong. */
    private onSymbolsChanged(): void {
        this.pathMapper?.invalidateContexts();
        this.frameCache.clear();
        for (const id of [...this.stackCache.keys()]) {
            this.stackCache.delete(id);
        }
        this.variables?.clearCaches();
        // The memory map changed, so code at known addresses may have too.
        this.knownInstructionStarts.clear();
        this.disassemblyCache.clear();
        this.functionRanges.clear();
        // Agents send one event per affected context, refresh the views once.
        if (this.symbolsChangedTimer === undefined) {
            this.symbolsChangedTimer = setTimeout(() => {
                this.symbolsChangedTimer = undefined;
                // Files may have been added or removed by someone else.
                this.sendEvent(new Event("symbolFilesChanged"));
                if (this.configured && [...this.threadStates.values()].some((s) => s.suspended)) {
                    this.sendEvent(new InvalidatedEvent(["stacks", "variables"]));
                }
            }, 100);
        }
    }

    protected override async configurationDoneRequest(
        response: DebugProtocol.ConfigurationDoneResponse,
    ): Promise<void> {
        this.sendResponse(response);
        this.configured = true;
        await this.reportInitialState();
    }

    protected override disconnectRequest(response: DebugProtocol.DisconnectResponse): void {
        this.disconnecting = true;
        clearTimeout(this.symbolsChangedTimer);
        this.channel?.close();
        this.sendResponse(response);
    }

    protected override threadsRequest(response: DebugProtocol.ThreadsResponse): void {
        const threads: Thread[] = [];
        for (const id of this.contextOrder) {
            const threadId = this.threadIdByCtx.get(id);
            if (threadId !== undefined) {
                threads.push(new Thread(threadId, this.contextDisplayName(id)));
            }
        }
        response.body = { threads };
        this.sendResponse(response);
    }

    protected override async pauseRequest(
        response: DebugProtocol.PauseResponse,
        args: DebugProtocol.PauseArguments,
    ): Promise<void> {
        await this.handle(response, async () => {
            const ctxId = this.requireThreadCtx(args.threadId);
            const target = this.findAncestorOrSelf(ctxId, (c) => c.CanSuspend === true) ?? ctxId;
            await this.runControl!.suspend(target);
        });
    }

    protected override async continueRequest(
        response: DebugProtocol.ContinueResponse,
        args: DebugProtocol.ContinueArguments,
    ): Promise<void> {
        await this.handle(response, async () => {
            const ctxId = this.requireThreadCtx(args.threadId);
            const target = this.findAncestorOrSelf(ctxId, (c) => ((c.CanResume ?? 0) & 1) !== 0) ?? ctxId;
            await this.runControl!.resume(target);
            // The agent reports which contexts actually resumed through
            // contextResumed/containerResumed events.
            response.body = { allThreadsContinued: false };
        });
    }

    protected override async setBreakPointsRequest(
        response: DebugProtocol.SetBreakpointsResponse,
        args: DebugProtocol.SetBreakpointsArguments,
    ): Promise<void> {
        await this.handle(response, async () => {
            const requested = args.breakpoints ?? (args.lines ?? []).map((line) => ({ line }));
            response.body = {
                breakpoints: await this.requireBreakpoints().setSourceBreakpoints(args.source, requested),
            };
        });
    }

    protected override async setFunctionBreakPointsRequest(
        response: DebugProtocol.SetFunctionBreakpointsResponse,
        args: DebugProtocol.SetFunctionBreakpointsArguments,
    ): Promise<void> {
        await this.handle(response, async () => {
            response.body = { breakpoints: await this.requireBreakpoints().setFunctionBreakpoints(args.breakpoints) };
        });
    }

    protected override async dataBreakpointInfoRequest(
        response: DebugProtocol.DataBreakpointInfoResponse,
        args: DebugProtocol.DataBreakpointInfoArguments,
    ): Promise<void> {
        await this.handle(response, async () => {
            response.body = await this.requireBreakpoints().dataBreakpointInfo(args);
        });
    }

    protected override async setDataBreakpointsRequest(
        response: DebugProtocol.SetDataBreakpointsResponse,
        args: DebugProtocol.SetDataBreakpointsArguments,
    ): Promise<void> {
        await this.handle(response, async () => {
            response.body = { breakpoints: await this.requireBreakpoints().setDataBreakpoints(args.breakpoints) };
        });
    }

    protected override async setInstructionBreakpointsRequest(
        response: DebugProtocol.SetInstructionBreakpointsResponse,
        args: DebugProtocol.SetInstructionBreakpointsArguments,
    ): Promise<void> {
        await this.handle(response, async () => {
            response.body = {
                breakpoints: await this.requireBreakpoints().setInstructionBreakpoints(args.breakpoints),
            };
        });
    }

    protected override setExceptionBreakPointsRequest(response: DebugProtocol.SetExceptionBreakpointsResponse): void {
        response.body = { breakpoints: [] };
        this.sendResponse(response);
    }

    protected override async nextRequest(
        response: DebugProtocol.NextResponse,
        args: DebugProtocol.NextArguments,
    ): Promise<void> {
        await this.step(response, args.threadId, "over", args.granularity);
    }

    protected override async stepInRequest(
        response: DebugProtocol.StepInResponse,
        args: DebugProtocol.StepInArguments,
    ): Promise<void> {
        await this.step(response, args.threadId, "into", args.granularity);
    }

    protected override async stepOutRequest(
        response: DebugProtocol.StepOutResponse,
        args: DebugProtocol.StepOutArguments,
    ): Promise<void> {
        await this.step(response, args.threadId, "out", args.granularity);
    }

    protected override async stackTraceRequest(
        response: DebugProtocol.StackTraceResponse,
        args: DebugProtocol.StackTraceArguments,
    ): Promise<void> {
        await this.handle(response, async () => {
            const ctxId = this.requireThreadCtx(args.threadId);
            let state = this.threadStates.get(ctxId);
            if (!state?.suspended || state.pc === undefined) {
                const s = await this.runControl!.getState(ctxId);
                state = { suspended: s.suspended, pc: toBigInt(s.pc), reason: s.reason };
                this.threadStates.set(ctxId, state);
            }
            if (state.suspended && state.pc !== undefined) {
                this.knownInstructionStarts.add(ctxId, state.pc);
            }
            if (!state.suspended) {
                response.body = { stackFrames: [], totalFrames: 0 };
                return;
            }
            const start = args.startFrame ?? 0;
            const levels = args.levels && args.levels > 0 ? args.levels : undefined;
            const result = await this.stackFrames(ctxId, start, levels).catch((err) => {
                if (start === 0) {
                    this.log(
                        `Failed to get the stack trace of ${this.contextDisplayName(ctxId)}, showing the current PC only: ${errorMessage(err)}\n`,
                        "stderr",
                    );
                }
                return undefined;
            });
            if (result && (result.frames.length > 0 || start > 0)) {
                response.body = { stackFrames: result.frames, totalFrames: result.total };
                return;
            }
            if (start > 0) {
                response.body = { stackFrames: [] };
                return;
            }
            // No StackTrace service, or it failed: show the PC only.
            const info =
                state.pc !== undefined
                    ? await this.frameInfo(ctxId, ctxId, state.pc, true)
                    : { name: "<unknown PC>", line: 0 };
            const frame: DebugProtocol.StackFrame = new StackFrame(
                this.frameIdFor(ctxId, ctxId, ctxId, ctxId),
                info.name,
                info.source,
                info.line,
                0,
            );
            if (state.pc !== undefined) {
                frame.instructionPointerReference = instructionReference(ctxId, state.pc);
            }
            frame.presentationHint = "normal";
            response.body = { stackFrames: [frame], totalFrames: 1 };
        });
    }

    protected override async disassembleRequest(
        response: DebugProtocol.DisassembleResponse,
        args: DebugProtocol.DisassembleArguments,
    ): Promise<void> {
        await this.handle(response, async () => {
            if (!this.disassembly) {
                throw new Error("The TCF agent does not provide the Disassembly service");
            }
            const reference = parseInstructionReference(args.memoryReference);
            const contextId = reference.contextId ?? this.suspendedThreadContext();
            if (!contextId) {
                throw new Error("Disassembly requires a context or a suspended thread");
            }
            response.body = {
                instructions: await disassembleInstructions(this.disassembly, contextId, reference.address, args, {
                    knownStarts: (start, end) => this.instructionStarts(contextId, start, end),
                    cache: this.disassemblyCache,
                    functions:
                        args.resolveSymbols === false || !this.disassemblyFunctionHeaders
                            ? undefined
                            : (addresses) => this.functionRanges.find(contextId, addresses),
                }),
            };
        });
    }

    /** Reads code bytes to check cached disassembly, or undefined. */
    private async readCodeBytes(ctxId: string, address: bigint, size: number): Promise<Uint8Array | undefined> {
        if (!this.memory) {
            return undefined;
        }
        const result = await this.memory.get(
            ctxId,
            address,
            1,
            size,
            MemoryAccessMode.ContinueOnError | MemoryAccessMode.BlockMemoryMappedIO,
        );
        return result.unreadable.length === 0 ? result.bytes : undefined;
    }

    /**
     * Addresses in [start, end) where an instruction is known to start: PCs
     * where the context stopped and the start of each line number area.
     */
    private async instructionStarts(ctxId: string, start: bigint, end: bigint): Promise<bigint[]> {
        const starts = this.knownInstructionStarts.inRange(ctxId, start, end);
        const areas = this.lineNumbers
            ? await this.lineNumbers.mapToSource(ctxId, start, end).catch((): CodeArea[] => [])
            : [];
        for (const area of areas) {
            const address = toBigInt(area.SAddr);
            if (address !== undefined) {
                starts.push(address);
            }
        }
        return starts;
    }

    protected override scopesRequest(
        response: DebugProtocol.ScopesResponse,
        args: DebugProtocol.ScopesArguments,
    ): void {
        const frame = this.frameRefs.get(args.frameId);
        const scopes: DebugProtocol.Scope[] = [];
        if (frame && this.variables) {
            frame.localsRef ??= this.addVarRef({ kind: "locals", threadCtx: frame.threadCtx, scopeId: frame.scopeId });
            const scope: DebugProtocol.Scope = new Scope("Locals", frame.localsRef, false);
            scope.presentationHint = "locals";
            scopes.push(scope);
        }
        if (frame && this.registers) {
            const scope: DebugProtocol.Scope = new Scope("Registers", this.varRefFor(frame.registersId), false);
            scope.presentationHint = "registers";
            scopes.push(scope);
        }
        response.body = { scopes };
        this.sendResponse(response);
    }

    protected override async variablesRequest(
        response: DebugProtocol.VariablesResponse,
        args: DebugProtocol.VariablesArguments,
    ): Promise<void> {
        await this.handle(response, async () => {
            const ref = this.varRefs.get(args.variablesReference);
            if (!ref) {
                response.body = { variables: [] };
                return;
            }
            switch (ref.kind) {
                case "registers": {
                    if (!this.registers) {
                        response.body = { variables: [] };
                        return;
                    }
                    const childIds = await this.registerChildren(ref.tcfId);
                    response.body = { variables: await Promise.all(childIds.map((id) => this.registerVariable(id))) };
                    return;
                }
                case "locals": {
                    const nodes = await this.variables!.locals(ref.scopeId);
                    response.body = { variables: nodes.map((n) => this.toDapVariable(n, ref.threadCtx, ref.scopeId)) };
                    return;
                }
                case "node": {
                    const nodes = await this.variables!.children(ref.scopeId, ref.node, args.start, args.count);
                    response.body = { variables: nodes.map((n) => this.toDapVariable(n, ref.threadCtx, ref.scopeId)) };
                    return;
                }
            }
        });
    }

    protected override async evaluateRequest(
        response: DebugProtocol.EvaluateResponse,
        args: DebugProtocol.EvaluateArguments,
    ): Promise<void> {
        await this.handle(response, async () => {
            if (!this.variables) {
                throw new Error("The TCF agent does not provide the Expressions service");
            }
            const frame = args.frameId !== undefined ? this.frameRefs.get(args.frameId) : undefined;
            // Without a frame, evaluate in the first suspended thread.
            const threadCtx =
                frame?.threadCtx ?? [...this.threadIdByCtx.keys()].find((id) => this.threadStates.get(id)?.suspended);
            if (threadCtx === undefined) {
                throw new Error("Expressions can only be evaluated when a thread is suspended");
            }
            const scopeId = frame?.scopeId ?? threadCtx;
            const node = await this.variables.evaluate(scopeId, args.expression);
            const v = this.toDapVariable(node, threadCtx, scopeId);
            response.body = {
                result: v.value,
                type: v.type,
                variablesReference: v.variablesReference,
                indexedVariables: v.indexedVariables,
            };
        });
    }

    /** Handles the requests of the memory views (see tcfRequests.ts), returns false for others. */
    private async memoryRequest(command: string, response: DebugProtocol.Response, args: unknown): Promise<boolean> {
        // The memory views report errors themselves, VS Code should not show them as well.
        const handle = (fn: () => Promise<void>) => this.handle(response, fn, false);
        switch (command) {
            case req.TcfRequest.ThreadContext:
                await handle(async () => {
                    const { threadId } = args as req.ThreadContextArgs;
                    response.body = { contextId: this.requireThreadCtx(threadId) } satisfies req.ThreadContextResult;
                });
                return true;
            case req.TcfRequest.ContextSuspended:
                await handle(async () => {
                    const { contextId } = args as req.ContextSuspendedArgs;
                    const state = await this.runControl!.getState(requireString(contextId, "contextId"));
                    response.body = { suspended: state.suspended } satisfies req.ContextSuspendedResult;
                });
                return true;
            case req.TcfRequest.PhysicalMemoryContexts:
                await handle(async () => {
                    const found = this.memory ? await this.findPhysicalMemoryContexts() : [];
                    response.body = {
                        contexts: found.map((c) => c.id),
                        names: found.map((c) => c.name),
                    } satisfies req.PhysicalMemoryContextsResult;
                });
                return true;
            case req.TcfRequest.ReadMemory:
                await handle(async () => {
                    const a = args as req.ReadMemoryArgs;
                    const result = await this.requireMemory().get(
                        requireString(a.contextId, "contextId"),
                        parseAddress(a.address),
                        a.wordSize,
                        a.size,
                        a.mode,
                    );
                    response.body = {
                        data: result.bytes.toString("base64"),
                        unreadable: result.unreadable,
                    } satisfies req.ReadMemoryResult;
                });
                return true;
            case req.TcfRequest.WriteMemory:
                await handle(async () => {
                    const a = args as req.WriteMemoryArgs;
                    try {
                        await this.requireMemory().set(
                            requireString(a.contextId, "contextId"),
                            parseAddress(a.address),
                            a.wordSize,
                            Buffer.from(a.data, "base64"),
                            a.mode,
                        );
                    } finally {
                        this.disassemblyCache.invalidate();
                    }
                });
                return true;
            case req.TcfRequest.MemoryContextInfo:
                await handle(async () => {
                    const { contextId } = args as req.MemoryContextInfoArgs;
                    const ctx = await this.requireMemory()
                        .getContext(requireString(contextId, "contextId"))
                        .catch(() => undefined);
                    response.body = {
                        ...(typeof ctx?.Name === "string" && {
                            name: ctx.Name,
                        }),
                        ...(typeof ctx?.AddressSize === "number" && {
                            addressSize: ctx.AddressSize,
                        }),
                        ...(typeof ctx?.BigEndian === "boolean" && {
                            bigEndian: ctx.BigEndian,
                        }),
                    } satisfies req.MemoryContextInfoResult;
                });
                return true;
            case req.TcfRequest.FindMemory:
                await handle(async () => {
                    response.body = await this.findMemory(args as req.FindMemoryArgs);
                });
                return true;
            case req.TcfRequest.CancelFindMemory:
                await handle(async () => {
                    const { findId } = args as req.CancelFindMemoryArgs;
                    const scan = this.memoryScans.get(findId);
                    if (scan) {
                        scan.cancelled = true;
                    }
                });
                return true;
            default:
                return false;
        }
    }

    /** Searches memory for tcfFindMemory, sending progress events. */
    private async findMemory(a: req.FindMemoryArgs): Promise<req.FindMemoryResult> {
        const memory = this.requireMemory();
        const contextId = requireString(a.contextId, "contextId");
        const needle = Buffer.from(requireString(a.needle, "needle"), "base64");
        if (needle.length === 0) {
            throw new Error("Nothing to find");
        }
        if (!Number.isInteger(a.alignment) || a.alignment < 1) {
            throw new Error(`Invalid alignment: ${String(a.alignment)}`);
        }
        const scan = { cancelled: false };
        this.memoryScans.set(a.findId, scan);
        // MMIO reads can have side effects, and a scan would touch it all.
        const mode = MemoryAccessMode.ContinueOnError | MemoryAccessMode.BlockMemoryMappedIO;
        let lastProgress = Date.now();
        try {
            const result = await scanMemory({
                needle,
                alignment: a.alignment,
                start: parseAddress(a.start),
                end: parseAddress(a.end),
                direction: a.direction === "backward" ? "backward" : "forward",
                read: async (address, length) => {
                    const r = await memory.get(contextId, address, 1, length, mode);
                    if (r.unreadable.length === 0) {
                        return { bytes: r.bytes };
                    }
                    const valid = new Uint8Array(r.bytes.length).fill(1);
                    for (const u of r.unreadable) {
                        valid.fill(0, u.offset, u.offset + u.size);
                    }
                    return { bytes: r.bytes, valid };
                },
                isCancelled: () => scan.cancelled || this.disconnecting,
                onProgress: (address) => {
                    const now = Date.now();
                    if (now - lastProgress >= 250) {
                        lastProgress = now;
                        const body: req.FindMemoryProgressEventBody = {
                            findId: a.findId,
                            address: formatAddress(address),
                        };
                        this.sendEvent(new Event(req.FIND_MEMORY_PROGRESS_EVENT, body));
                    }
                },
            });
            switch (result.outcome) {
                case "found":
                    return {
                        outcome: "found",
                        address: formatAddress(result.address),
                    };
                case "notFound":
                    return {
                        outcome: "notFound",
                        failedReads: result.failedReads,
                        ...(result.firstError !== undefined && {
                            firstError: result.firstError,
                        }),
                    };
                case "cancelled":
                    return { outcome: "cancelled" };
            }
        } finally {
            this.memoryScans.delete(a.findId);
        }
    }

    private toDapVariable(node: VariableNode, threadCtx: string, scopeId: string): DebugProtocol.Variable {
        const v: DebugProtocol.Variable = {
            name: node.name,
            value: node.value,
            type: node.type,
            evaluateName: node.displayExpr,
            variablesReference: node.expand ? this.addVarRef({ kind: "node", threadCtx, scopeId, node }) : 0,
        };
        // VS Code splits large arrays in chunks and requests them with start/count.
        if (node.expand?.kind === "array" && node.expand.length > 100) {
            v.indexedVariables = node.expand.length;
        }
        return v;
    }

    private addVarRef(ref: VariablesRef): number {
        const id = this.nextVarRef++;
        this.varRefs.set(id, ref);
        return id;
    }

    // ---- Stepping and frames ---------------------------------------------

    private async step(
        response: DebugProtocol.Response,
        threadId: number,
        kind: StepKind,
        granularity: DebugProtocol.SteppingGranularity | undefined,
    ): Promise<void> {
        await this.handle(response, async () => {
            const ctxId = this.requireThreadCtx(threadId);
            const mode = selectStepMode(this.contexts.get(ctxId)?.CanResume, kind, granularity);
            if (mode === undefined) {
                throw new Error(
                    `Step ${kind}${granularity === "instruction" ? " instruction" : ""} is not supported for ${this.contextDisplayName(ctxId)}`,
                );
            }
            this.pendingSteps.add(ctxId);
            try {
                await this.runControl!.resume(ctxId, mode);
            } catch (err) {
                this.pendingSteps.delete(ctxId);
                throw err;
            }
        });
    }

    /**
     * Returns DAP frames start..start+levels-1 (all remaining if levels is
     * undefined) of a suspended thread from the StackTrace service, and the
     * total number of frames when known.
     */
    private async stackFrames(
        ctxId: string,
        start: number,
        levels: number | undefined,
    ): Promise<{ frames: DebugProtocol.StackFrame[]; total?: number } | undefined> {
        if (!this.stackTrace) {
            return undefined;
        }
        const { ids, total } = await this.stackFrameIds(ctxId, start, levels);
        if (ids.length === 0) {
            return { frames: [], total };
        }
        let contexts = await this.stackTrace.getContext(ids);
        // Agents can end the stack with a frame where unwinding found no return
        // address. It has no useful information, so leave it out.
        const last = contexts[ids.length - 1];
        if (ids.length > 1 || start > 0) {
            if (last && !(last.TopFrame ?? false) && toBigInt(last.IP) === 0n) {
                contexts = contexts.slice(0, -1);
            }
        }
        const top = (ctx: StackFrameContext, index: number) => ctx.TopFrame ?? index === 0;
        const frameIds = contexts.map((c, i) =>
            this.frameIdFor(ctxId, ids[i], top(c ?? { ID: ids[i] }, start + i) ? ctxId : ids[i], ids[i]),
        );
        const frames = await Promise.all(
            contexts.map(async (c, i) => {
                const ctx = c ?? { ID: ids[i] };
                const ip = toBigInt(ctx.IP);
                const info =
                    ip !== undefined
                        ? await this.frameInfo(ctxId, ids[i], ip, top(ctx, start + i), ctx)
                        : { name: "<unknown>", line: 0 };
                // Column 0 makes the Call Stack view show the line only.
                const frame: DebugProtocol.StackFrame = new StackFrame(
                    frameIds[i],
                    info.name,
                    info.source,
                    info.line,
                    0,
                );
                if (ip !== undefined) {
                    frame.instructionPointerReference = instructionReference(ctxId, ip);
                }
                frame.presentationHint = info.source ? "normal" : "subtle";
                return frame;
            }),
        );
        const dropped = ids.length - contexts.length;
        return { frames, total: total !== undefined ? total - dropped : undefined };
    }

    /** TCF frame IDs start..start+levels-1 of a thread, top frame first, and the total count when known. */
    private async stackFrameIds(
        ctxId: string,
        start: number,
        levels: number | undefined,
    ): Promise<{ ids: string[]; total?: number }> {
        const st = this.stackTrace!;
        if (levels !== undefined && this.hasChildrenRange !== false && !this.stackCache.has(ctxId)) {
            try {
                const ids = await st.getChildrenRange(ctxId, start, start + levels - 1);
                this.hasChildrenRange = true;
                return { ids };
            } catch (err) {
                if (!(err instanceof TcfError && err.unsupported)) {
                    throw err;
                }
                this.hasChildrenRange = false;
            }
        }
        let all = this.stackCache.get(ctxId);
        if (!all) {
            // getChildren returns the bottom frame first.
            all = st.getChildren(ctxId).then((ids) => ids.reverse());
            all.catch(() => this.stackCache.delete(ctxId));
            this.stackCache.set(ctxId, all);
        }
        const ids = await all;
        return { ids: ids.slice(start, levels !== undefined ? start + levels : undefined), total: ids.length };
    }

    /** Returns a DAP frame ID that is stable while the thread stays suspended. */
    private frameIdFor(threadCtx: string, frameKey: string, registersId: string, scopeId: string): number {
        const key = `${threadCtx}\0${frameKey}`;
        let id = this.frameIdByKey.get(key);
        if (id === undefined) {
            id = this.nextFrameId++;
            this.frameIdByKey.set(key, id);
            this.frameRefs.set(id, { threadCtx, registersId, scopeId });
        }
        return id;
    }

    /** Forgets frames and variables of resumed threads; their IDs and contents are no longer valid. */
    private clearFrames(ctxIds: string[]): void {
        const resumed = new Set(ctxIds);
        for (const [key, id] of this.frameIdByKey) {
            const ref = this.frameRefs.get(id);
            if (!ref || resumed.has(ref.threadCtx)) {
                this.frameIdByKey.delete(key);
                this.frameRefs.delete(id);
            }
        }
        for (const [id, ref] of this.varRefs) {
            if (ref.kind !== "registers" && resumed.has(ref.threadCtx)) {
                this.varRefs.delete(id);
            }
        }
        for (const id of ctxIds) {
            this.stackCache.delete(id);
        }
        this.frameCache.clear();
        this.variables?.clearCaches();
    }

    private frameInfo(
        ctxId: string,
        frameKey: string,
        pc: bigint,
        top: boolean,
        frame?: StackFrameContext,
    ): Promise<FrameInfo> {
        const key = `${ctxId}\0${frameKey}\0${pc}`;
        let p = this.frameCache.get(key);
        if (!p) {
            p = this.resolveFrame(ctxId, pc, top, frame);
            this.frameCache.set(key, p);
        }
        return p;
    }

    /**
     * Resolves the function and source location of a frame. For caller frames
     * `pc` is the return address, so the call instruction before it is used.
     * Code area and function reported by the StackTrace service (for inlined
     * frames) take precedence.
     */
    private async resolveFrame(ctxId: string, pc: bigint, top: boolean, frame?: StackFrameContext): Promise<FrameInfo> {
        const lookup = top || pc === 0n ? pc : pc - 1n;
        const [area, func] = await Promise.all([
            frame?.CodeArea ?? this.codeAreaAt(ctxId, lookup),
            frame?.FuncID ? this.symbolContext(frame.FuncID) : this.functionAt(ctxId, lookup),
        ]);
        const name = func?.Name ?? formatAddress(pc);
        const compiled = area && sourcePath(area);
        if (!compiled || !area?.SLine) {
            return { name, line: 0 };
        }
        const file = await this.toHostPath(compiled, ctxId);
        if (!fs.existsSync(file)) {
            return {
                name,
                source: this.missingSource(compiled, file, area.SLine, ctxId),
                line: area.SLine,
            };
        }
        const source: Source & DebugProtocol.Source = new Source(path.basename(file), file);
        source.adapterData = { contextId: ctxId };
        if (file !== compiled) {
            // Shown in the Call Stack view's tooltip.
            (source as DebugProtocol.Source).origin = `compiled as ${compiled}`;
        }
        return { name, source, line: area.SLine };
    }

    /**
     * A source for a file that is not on this host. It has a source
     * reference, so VS Code asks for its content with a source request
     * instead of offering to create the file.
     */
    private missingSource(compiledPath: string, hostPath: string, line: number, contextId: string): Source {
        const key = JSON.stringify([contextId, compiledPath]);
        let ref = this.sourceRefByPath.get(key);
        if (ref === undefined) {
            ref = this.nextSourceRef++;
            this.sourceRefByPath.set(key, ref);
        }
        this.missingSources.set(ref, {
            compiledPath,
            hostPath,
            line,
            contextId,
        });
        const source: DebugProtocol.Source = new Source(path.basename(compiledPath), compiledPath, ref);
        source.presentationHint = "deemphasize";
        source.origin = "not found on this host";
        source.adapterData = { contextId };
        return source as Source;
    }

    protected override sourceRequest(
        response: DebugProtocol.SourceResponse,
        args: DebugProtocol.SourceArguments,
    ): void {
        const ref = args.source?.sourceReference ?? args.sourceReference;
        const missing = this.missingSources.get(ref);
        if (!missing) {
            this.sendErrorResponse(response, 1, "Unknown source");
            return;
        }
        const lines = [`Source file not found on this host: ${missing.compiledPath}`];
        if (missing.hostPath !== missing.compiledPath) {
            lines.push(`It was mapped to ${missing.hostPath}, which does not exist.`);
        }
        lines.push(
            "",
            'Run "Simics Target Debug: Locate Source File..." and pick the file to add',
            "a path map rule.",
            "",
        );
        response.body = { content: lines.join("\n"), mimeType: "text/plain" };
        this.sendResponse(response);
        this.sendEvent(new Event("sourceNotFound", { ...missing }));
    }

    /** Adds a path map rule while debugging and shows the frames with it. */
    private async addPathMapRule(rule: PathMapRule): Promise<void> {
        if (!this.pathMapper) {
            throw new Error("Not attached to a TCF agent");
        }
        await this.pathMapper.addRule(rule);
        await this.pathMapChanged();
    }

    private async pathMapChanged(): Promise<void> {
        this.frameCache.clear();
        this.missingSources.clear();
        this.sendEvent(new Event("pathMapChanged"));
        const suspended = [...this.threadStates.values()].some((s) => s.suspended);
        if (this.configured && suspended) {
            this.sendEvent(new InvalidatedEvent(["stacks"]));
        }
        await this.breakpoints?.updateSourcePaths();
    }

    private pathMapContextsChanged(): void {
        this.pathMapper?.invalidateContexts();
        void this.pathMapChanged().catch((err) => {
            this.log(`Could not refresh path maps: ${errorMessage(err)}\n`, "stderr");
        });
    }

    private async sourceLineAt(ctxId: string, address: bigint): Promise<{ path: string; line: number } | undefined> {
        const area = await this.codeAreaAt(ctxId, address);
        const file = area && sourcePath(area);
        return file && area?.SLine ? { path: await this.toHostPath(file, ctxId), line: area.SLine } : undefined;
    }

    private toHostPath(compiledPath: string, contextId: string): Promise<string> {
        return this.pathMapper ? this.pathMapper.toHost(compiledPath, contextId) : Promise.resolve(compiledPath);
    }

    private async codeAreaAt(ctxId: string, pc: bigint): Promise<CodeArea | undefined> {
        if (!this.lineNumbers) {
            return undefined;
        }
        try {
            const areas = await this.lineNumbers.mapToSource(ctxId, pc, pc + 1n);
            return (
                areas.find((a) => {
                    const start = toBigInt(a.SAddr);
                    const end = toBigInt(a.EAddr);
                    return start !== undefined && end !== undefined && start <= pc && pc < end;
                }) ?? areas[0]
            );
        } catch {
            return undefined;
        }
    }

    private async symbolContext(id: string): Promise<SymbolContext | undefined> {
        try {
            return await this.symbols?.getContext(id);
        } catch {
            return undefined;
        }
    }

    /** Returns the function containing `pc`, following the containers of nested scopes. */
    private async functionAt(ctxId: string, pc: bigint): Promise<SymbolContext | undefined> {
        if (!this.symbols) {
            return undefined;
        }
        try {
            for (const id of await this.symbols.findByAddr(ctxId, pc)) {
                let sym: SymbolContext | undefined = await this.symbols.getContext(id);
                for (let depth = 0; sym && depth < 16; depth++) {
                    if (sym.Class === SymbolClass.Function) {
                        return sym;
                    }
                    if (sym.Class !== SymbolClass.Block || !sym.ContainerID) {
                        break;
                    }
                    sym = await this.symbols.getContext(sym.ContainerID);
                }
            }
        } catch {
            // No symbol information for this address.
        }
        return undefined;
    }

    /**
     * Returns the function containing `address` that is not inside another
     * function, so that inlined code gets no header of its own.
     */
    private async outerFunctionAt(ctxId: string, address: bigint): Promise<FunctionInfo | undefined> {
        if (!this.symbols) {
            return undefined;
        }
        for (const id of await this.symbols.findByAddr(ctxId, address)) {
            let sym: SymbolContext | undefined = await this.symbols.getContext(id);
            let outer: SymbolContext | undefined;
            for (let depth = 0; sym && depth < 16; depth++) {
                if (sym.Class === SymbolClass.Function) {
                    outer = sym;
                } else if (sym.Class !== SymbolClass.Block) {
                    break;
                }
                sym = sym.ContainerID
                    ? await this.symbols.getContext(sym.ContainerID).catch(() => undefined)
                    : undefined;
            }
            const start = toBigInt(outer?.Address);
            if (outer?.Name && start !== undefined) {
                const area = await this.codeAreaAt(ctxId, start);
                const file = area && sourcePath(area);
                return {
                    name: outer.Name,
                    address: start,
                    size: typeof outer.Size === "number" ? outer.Size : undefined,
                    file: file ? path.basename(file) : undefined,
                    line: area?.SLine,
                };
            }
        }
        return undefined;
    }

    // ---- Registers -------------------------------------------------------

    private registerContext(id: string): Promise<RegistersContext> {
        let p = this.regContextCache.get(id);
        if (!p) {
            p = this.registers!.getContext(id);
            p.catch(() => this.regContextCache.delete(id));
            this.regContextCache.set(id, p);
        }
        return p;
    }

    private registerChildren(id: string): Promise<string[]> {
        let p = this.regChildrenCache.get(id);
        if (!p) {
            p = this.registers!.getChildren(id);
            p.catch(() => this.regChildrenCache.delete(id));
            this.regChildrenCache.set(id, p);
        }
        return p;
    }

    private async registerVariable(id: string): Promise<DebugProtocol.Variable> {
        const [ctxResult, childrenResult] = await Promise.allSettled([
            this.registerContext(id),
            this.registerChildren(id),
        ]);
        if (ctxResult.status === "rejected") {
            return { name: id, value: `<${errorMessage(ctxResult.reason)}>`, variablesReference: 0 };
        }
        const ctx = ctxResult.value;
        const hasChildren = childrenResult.status === "fulfilled" && childrenResult.value.length > 0;
        const size = ctx.Size ?? 0;
        // Simics (and other agents) use contexts without a readable value
        // to group registers.
        const isGroup = size === 0 || ctx.Readable === false;

        let value = "";
        if (!isGroup) {
            try {
                value = formatRegisterValue(ctx, await this.registers!.get(id));
            } catch (err) {
                value = `<${errorMessage(err)}>`;
            }
        }
        const variable: DebugProtocol.Variable = {
            name: ctx.Name ?? id,
            value,
            variablesReference: hasChildren ? this.varRefFor(id) : 0,
        };
        if (isGroup) {
            variable.presentationHint = { kind: "virtual" };
        } else if (ctx.Writeable === false) {
            variable.presentationHint = { attributes: ["readOnly"] };
        }
        return variable;
    }

    private varRefFor(tcfId: string): number {
        let ref = this.varRefByTcfId.get(tcfId);
        if (ref === undefined) {
            ref = this.nextVarRef++;
            this.varRefByTcfId.set(tcfId, ref);
            this.varRefs.set(ref, { kind: "registers", tcfId });
        }
        return ref;
    }

    // ---- Memory ----------------------------------------------------------

    private addMemoryListener(memory: MemoryService): void {
        const contextsChanged = () => {
            this.physicalMemoryContexts = undefined;
        };
        memory.addListener({
            contextAdded: contextsChanged,
            contextChanged: contextsChanged,
            contextRemoved: contextsChanged,
            memoryChanged: (contextId, ranges) => {
                const body: req.MemoryChangedEventBody = {
                    contextId,
                    ranges: ranges.map((r) => ({ address: formatAddress(r.addr), size: r.size })),
                };
                this.sendEvent(new Event(req.MEMORY_CHANGED_EVENT, body));
            },
        });
    }

    /**
     * Memory contexts that access physical memory, such as Simics memory
     * spaces, with their full names.
     */
    private findPhysicalMemoryContexts(): Promise<PhysicalMemoryContext[]> {
        if (!this.physicalMemoryContexts) {
            const memory = this.requireMemory();
            const visit = async (parentId: string | null, parentName: string): Promise<PhysicalMemoryContext[]> => {
                const ids = await memory.getChildren(parentId);
                const found = await Promise.all(
                    ids.map(async (id) => {
                        // getChildren also lists containers without memory access, which have no Memory context.
                        const ctx = await memory.getContext(id).catch(() => undefined);
                        // Named like the threads in the call stack. Contexts that
                        // are not run control contexts get the Memory tree path.
                        const own = ctx?.Name ?? id;
                        const name = this.contexts.has(id)
                            ? this.contextDisplayName(id)
                            : parentName
                              ? `${parentName}.${own}`
                              : own;
                        const below = await visit(id, name);
                        return ctx?.AccessTypes?.includes("physical") ? [{ id, name }, ...below] : below;
                    }),
                );
                return found.flat();
            };
            const p = visit(null, "");
            p.catch(() => {
                if (this.physicalMemoryContexts === p) {
                    this.physicalMemoryContexts = undefined;
                }
            });
            this.physicalMemoryContexts = p;
        }
        return this.physicalMemoryContexts;
    }

    private requireMemory(): MemoryService {
        if (!this.memory) {
            throw new Error("The TCF agent does not provide the Memory service");
        }
        return this.memory;
    }

    // ---- Run control -----------------------------------------------------

    private async discoverContexts(): Promise<void> {
        const rc = this.runControl!;
        const visit = async (parentId: string | null): Promise<string[]> => {
            const ids = await rc.getChildren(parentId);
            const subtrees = await Promise.all(
                ids.map(async (id) => {
                    const [ctx, children] = await Promise.all([rc.getContext(id), visit(id)]);
                    this.contexts.set(id, ctx);
                    return [id, ...children];
                }),
            );
            return subtrees.flat();
        };
        const ordered = await visit(null);
        for (const id of ordered) {
            this.addContext(this.contexts.get(id)!, false);
        }
    }

    private addContext(ctx: RunControlContext, notify: boolean): void {
        const isNew = !this.contextOrder.includes(ctx.ID);
        this.contexts.set(ctx.ID, ctx);
        if (isNew) {
            this.contextOrder.push(ctx.ID);
        }
        if (ctx.HasState && !this.threadIdByCtx.has(ctx.ID)) {
            const threadId = this.nextThreadId++;
            this.threadIdByCtx.set(ctx.ID, threadId);
            this.ctxByThreadId.set(threadId, ctx.ID);
            if (notify) {
                this.sendEvent(new ThreadEvent("started", threadId));
            }
        }
    }

    /** The first suspended thread, or undefined. */
    private suspendedThreadContext(): string | undefined {
        return [...this.threadIdByCtx.keys()].find((id) => this.threadStates.get(id)?.suspended);
    }

    /**
     * The process of a context and the process's threads, for the ContextIds
     * of address breakpoints. The Simics agent plants breakpoints per thread
     * (with OS awareness a process has no breakpoint group), while other
     * agents plant them in the process. Both trigger in listed threads and in
     * threads of a listed process.
     */
    private processContexts(ctxId: string): string[] {
        const processId = this.contexts.get(ctxId)?.ProcessID ?? ctxId;
        const ids = [processId];
        for (const id of this.contextOrder) {
            const ctx = this.contexts.get(id);
            if (id !== processId && ctx?.HasState && ctx.ProcessID === processId) {
                ids.push(id);
            }
        }
        if (!ids.includes(ctxId)) {
            ids.push(ctxId);
        }
        return ids;
    }

    private removeContext(id: string): void {
        this.contexts.delete(id);
        const idx = this.contextOrder.indexOf(id);
        if (idx >= 0) {
            this.contextOrder.splice(idx, 1);
        }
        this.threadStates.delete(id);
        this.pendingSteps.delete(id);
        this.knownInstructionStarts.delete(id);
        this.disassemblyCache.delete(id);
        this.functionRanges.delete(id);
        this.clearFrames([id]);
        const threadId = this.threadIdByCtx.get(id);
        if (threadId !== undefined) {
            this.threadIdByCtx.delete(id);
            this.ctxByThreadId.delete(threadId);
            if (this.configured) {
                this.sendEvent(new ThreadEvent("exited", threadId));
            }
        }
    }

    private addRunControlListener(rc: RunControlService): void {
        rc.addListener({
            contextAdded: (ctxs) => {
                ctxs.forEach((c) => this.addContext(c, this.configured));
                this.pathMapContextsChanged();
                void this.breakpoints?.updateInstructionScopes();
            },
            contextChanged: (ctxs) => {
                ctxs.forEach((c) => this.addContext(c, this.configured));
                this.pathMapContextsChanged();
            },
            contextRemoved: (ids) => {
                ids.forEach((id) => this.removeContext(id));
                this.pathMapContextsChanged();
                void this.breakpoints?.updateInstructionScopes();
            },
            contextSuspended: (id, pc, reason, data) => this.onSuspended(id, [id], toBigInt(pc), reason, data),
            containerSuspended: (id, pc, reason, data, ids) => this.onSuspended(id, ids, toBigInt(pc), reason, data),
            contextResumed: (id) => this.onResumed([id]),
            containerResumed: (ids) => this.onResumed(ids),
            contextException: (id, msg) => this.log(`Exception in ${this.contextDisplayName(id)}: ${msg}\n`, "stderr"),
        });
    }

    /**
     * Handles contextSuspended and containerSuspended. `triggerId` is the
     * context that caused the suspension, `ids` all contexts that are now
     * suspended. `data` is the trigger context's state data, where "BPs"
     * lists the breakpoints that were hit.
     */
    private onSuspended(
        triggerId: string,
        ids: string[],
        pc: bigint | undefined,
        reason: string | undefined,
        data?: Record<string, unknown>,
    ): void {
        const stepped = this.pendingSteps.has(triggerId) || ids.some((id) => this.pendingSteps.has(id));
        this.pendingSteps.clear();
        if (pc !== undefined) {
            this.knownInstructionStarts.add(triggerId, pc);
        }
        for (const id of ids) {
            // Only the trigger context's PC is reported, fetch others lazily.
            this.threadStates.set(id, { suspended: true, pc: id === triggerId ? pc : undefined, reason });
        }
        if (!this.threadStates.has(triggerId)) {
            this.threadStates.set(triggerId, { suspended: true, pc, reason });
        }
        if (!this.configured) {
            return;
        }
        const bpIds = Array.isArray(data?.BPs)
            ? (data.BPs as unknown[]).filter((b): b is string => typeof b === "string")
            : [];
        const hits = bpIds.length > 0 ? this.breakpoints?.hits(bpIds) : undefined;
        if (hits && hits.logpoints.length > 0) {
            // A step that ends at a logpoint stops there as usual.
            const resume = !hits.hasStoppingBreakpoint && !stepped;
            void this.handleLogpoints(triggerId, ids, { reason, stepped, hits }, resume);
            return;
        }
        this.reportStopped(triggerId, ids, { reason, stepped, hits });
    }

    /** Prints the messages of hit logpoints, then resumes or reports the stop. */
    private async handleLogpoints(triggerId: string, ids: string[], stop: StopInfo, resume: boolean): Promise<void> {
        for (const lp of stop.hits!.logpoints) {
            const text = await this.interpolateLogMessage(triggerId, lp.message);
            this.log(text.endsWith("\n") ? text : `${text}\n`);
        }
        if (resume) {
            const target = this.findAncestorOrSelf(triggerId, (c) => ((c.CanResume ?? 0) & 1) !== 0) ?? triggerId;
            try {
                await this.runControl!.resume(target);
                return;
            } catch (err) {
                this.log(`Failed to resume after logpoint: ${errorMessage(err)}\n`, "stderr");
            }
        }
        this.reportStopped(triggerId, ids, stop);
    }

    /** Replaces {expression} in a logpoint message with its value. */
    private async interpolateLogMessage(ctxId: string, message: string): Promise<string> {
        const parts = message.split(/(\{[^{}]+\})/);
        const values = await Promise.all(
            parts.map(async (part, i) => {
                if (i % 2 === 0) {
                    return part;
                }
                const expr = part.slice(1, -1).trim();
                if (!this.expressions) {
                    return `<${expr}: the TCF agent does not provide the Expressions service>`;
                }
                try {
                    return formatExpressionValue(await this.expressions.evaluate(ctxId, expr));
                } catch (err) {
                    return `<${expr}: ${errorMessage(err)}>`;
                }
            }),
        );
        return values.join("");
    }

    private onResumed(ids: string[]): void {
        for (const id of ids) {
            this.threadStates.set(id, { suspended: false });
        }
        this.disassemblyCache.invalidate();
        this.clearFrames(ids);
        if (!this.configured) {
            return;
        }
        const threadIds = ids.map((id) => this.threadIdByCtx.get(id)).filter((t): t is number => t !== undefined);
        if (threadIds.length === 0) {
            return;
        }
        if (this.allThreads((s) => !s.suspended)) {
            this.sendEvent(new ContinuedEvent(threadIds[0], true));
        } else {
            for (const t of threadIds) {
                this.sendEvent(new ContinuedEvent(t, false));
            }
        }
    }

    private reportStopped(triggerId: string, ids: string[], stop: StopInfo): void {
        const triggerThread =
            this.threadIdByCtx.get(triggerId) ??
            ids.map((id) => this.threadIdByCtx.get(id)).find((t) => t !== undefined);
        if (triggerThread === undefined) {
            return;
        }
        if (this.allThreads((s) => s.suspended)) {
            this.sendEvent(stoppedEvent(stop, triggerThread, true));
            return;
        }
        this.sendEvent(stoppedEvent(stop, triggerThread, false));
        // Breakpoint hits only apply to the context that hit them.
        const others: StopInfo = { reason: stop.reason, stepped: stop.stepped };
        for (const id of ids) {
            const t = this.threadIdByCtx.get(id);
            if (t !== undefined && t !== triggerThread) {
                const e = stoppedEvent(others, t, false);
                e.body.preserveFocusHint = true;
                this.sendEvent(e);
            }
        }
    }

    private allThreads(pred: (s: ThreadState) => boolean): boolean {
        for (const id of this.threadIdByCtx.keys()) {
            const s = this.threadStates.get(id);
            if (!s || !pred(s)) {
                return false;
            }
        }
        return true;
    }

    /** Queries the state of all threads and reports the suspended ones. */
    private async reportInitialState(): Promise<void> {
        const ids = [...this.threadIdByCtx.keys()];
        const results = await Promise.allSettled(ids.map((id) => this.runControl!.getState(id)));
        const suspended: string[] = [];
        results.forEach((r, i) => {
            if (r.status === "fulfilled") {
                this.threadStates.set(ids[i], {
                    suspended: r.value.suspended,
                    pc: toBigInt(r.value.pc),
                    reason: r.value.reason,
                });
                if (r.value.suspended) {
                    suspended.push(ids[i]);
                }
            } else {
                this.log(
                    `Failed to get state of ${this.contextDisplayName(ids[i])}: ${errorMessage(r.reason)}\n`,
                    "stderr",
                );
            }
        });
        if (suspended.length > 0) {
            this.reportStopped(suspended[0], suspended, { reason: this.threadStates.get(suspended[0])?.reason });
        }
    }

    private requireBreakpoints(): BreakpointManager {
        if (!this.breakpoints) {
            throw new Error("Not attached to a TCF agent");
        }
        return this.breakpoints;
    }

    private requireThreadCtx(threadId: number): string {
        const ctxId = this.ctxByThreadId.get(threadId);
        if (ctxId === undefined) {
            throw new Error(`Unknown thread ${threadId}`);
        }
        return ctxId;
    }

    private findAncestorOrSelf(id: string, pred: (c: RunControlContext) => boolean): string | undefined {
        for (let c = this.contexts.get(id); c; c = c.ParentID ? this.contexts.get(c.ParentID) : undefined) {
            if (pred(c)) {
                return c.ID;
            }
        }
        return undefined;
    }

    /** Full name of a context, built from the names of its ancestors. */
    private contextDisplayName(id: string): string {
        const names: string[] = [];
        for (let c = this.contexts.get(id); c; c = c.ParentID ? this.contexts.get(c.ParentID) : undefined) {
            names.unshift(c.Name ?? c.ID);
        }
        return names.length > 0 ? names.join(".") : id;
    }

    // ---- Helpers ---------------------------------------------------------

    private async handle(response: DebugProtocol.Response, fn: () => Promise<void>, showUser = true): Promise<void> {
        try {
            await fn();
            this.sendResponse(response);
        } catch (err) {
            const message = errorMessage(err);
            if (showUser) {
                this.sendErrorResponse(response, 3, message);
            } else {
                this.sendErrorResponse(response, { id: 3, format: message });
            }
        }
    }

    private log(text: string, category: "console" | "stdout" | "stderr" = "console"): void {
        this.sendEvent(new OutputEvent(text, category));
    }
}

function stoppedEvent(stop: StopInfo, threadId: number, allThreadsStopped: boolean): DebugProtocol.StoppedEvent {
    const tcfReason = stop.reason;
    let reason = dapStopReason(tcfReason);
    if (stop.hits && stop.hits.dapIds.length > 0) {
        reason = stop.hits.reason;
    } else if (stop.stepped && reason === "pause" && tcfReason !== "Suspended") {
        // Agents do not always report "Step" when a step completes. An
        // explicit suspend while stepping is still reported as a pause.
        reason = "step";
    }
    const e = new StoppedEvent(reason, threadId) as DebugProtocol.StoppedEvent;
    e.body.allThreadsStopped = allThreadsStopped;
    if (stop.hits && stop.hits.dapIds.length > 0) {
        e.body.hitBreakpointIds = stop.hits.dapIds;
    }
    if (tcfReason) {
        e.body.description = tcfReason;
        e.body.text = tcfReason;
    }
    return e;
}

/**
 * Picks the TCF resume mode for a DAP step. Line stepping is used unless
 * instruction granularity is requested, falling back to instruction stepping
 * if the context cannot step by line. `canResume` is the context's CanResume
 * bit set; agents that do not report it get the preferred mode.
 */
export function selectStepMode(
    canResume: number | undefined,
    kind: StepKind,
    granularity: DebugProtocol.SteppingGranularity | undefined,
): ResumeMode | undefined {
    const instruction = granularity === "instruction";
    let candidates: ResumeMode[];
    switch (kind) {
        case "over":
            candidates = instruction ? [ResumeMode.StepOver] : [ResumeMode.StepOverLine, ResumeMode.StepOver];
            break;
        case "into":
            candidates = instruction ? [ResumeMode.StepInto] : [ResumeMode.StepIntoLine, ResumeMode.StepInto];
            break;
        case "out":
            candidates = [ResumeMode.StepOut];
            break;
    }
    if (canResume === undefined) {
        return candidates[0];
    }
    return candidates.find((m) => (canResume & (1 << m)) !== 0);
}

/** Maps TCF suspend reasons (see RunControl.REASON_*) to DAP stop reasons. */
function dapStopReason(reason: string | undefined): string {
    switch (reason) {
        case "Breakpoint":
            return "breakpoint";
        case "Step":
            return "step";
        case "Exception":
        case "Signal":
            return "exception";
        case "Watchpoint":
            return "data breakpoint";
        case "Suspended":
        case "Container":
        case undefined:
            return "pause";
        default:
            return reason.startsWith("Error") ? "exception" : "pause";
    }
}

function formatAddress(addr: bigint): string {
    return `0x${addr.toString(16)}`;
}

function parseAddress(text: unknown): bigint {
    if (typeof text === "string" && /^(0x[0-9a-f]+|\d+)$/i.test(text)) {
        return BigInt(text);
    }
    throw new Error(`Invalid address: ${String(text)}`);
}

function requireString(value: unknown, name: string): string {
    if (typeof value !== "string") {
        throw new Error(`Missing ${name}`);
    }
    return value;
}

/** The host path of a code area's source file. */
function sourcePath(area: CodeArea): string | undefined {
    if (!area.File) {
        return undefined;
    }
    return area.Dir && !path.isAbsolute(area.File) ? path.join(area.Dir, area.File) : area.File;
}

/** Formats a register value given as bytes in target byte order. */
export function formatRegisterValue(ctx: RegistersContext, bytes: Buffer): string {
    if (bytes.length === 0) {
        return "";
    }
    const be = ctx.BigEndian === true ? bytes : Buffer.from(bytes).reverse();
    let text = `0x${be.toString("hex")}`;
    if (ctx.Float) {
        const le = ctx.BigEndian === true ? Buffer.from(bytes).reverse() : bytes;
        if (le.length === 4) {
            text = `${le.readFloatLE(0)} (${text})`;
        } else if (le.length === 8) {
            text = `${le.readDoubleLE(0)} (${text})`;
        }
    }
    const named = ctx.Values?.find((v) => v.Value !== undefined && Buffer.from(v.Value, "base64").equals(bytes));
    if (named?.Name) {
        text += ` (${named.Name})`;
    }
    return text;
}

function errorMessage(err: unknown): string {
    if (err instanceof Error) {
        return err.message;
    }
    return formatTcfError(err);
}
