/*
 * Custom DAP requests and events through which the Target Memory view
 * accesses TCF memory in a "simics-target-debug" debug session. Addresses are
 * strings, since JSON numbers cannot hold all 64-bit values.
 */

import type { ByteRange } from "./tcf/services/memory";

export const enum TcfRequest {
    ThreadContext = "tcfThreadContext",
    ContextSuspended = "tcfContextSuspended",
    PhysicalMemoryContexts = "tcfPhysicalMemoryContexts",
    ReadMemory = "tcfReadMemory",
    WriteMemory = "tcfWriteMemory",
    MemoryContextInfo = "tcfMemoryContextInfo",
    FindMemory = "tcfFindMemory",
    CancelFindMemory = "tcfCancelFindMemory",
}

export const MEMORY_CHANGED_EVENT = "tcfMemoryChanged";
/** Sent while a tcfFindMemory request runs, see FindMemoryProgressEventBody. */
export const FIND_MEMORY_PROGRESS_EVENT = "tcfFindMemoryProgress";

export interface ThreadContextArgs {
    threadId: number;
}

export interface ThreadContextResult {
    contextId: string;
}

export interface ContextSuspendedArgs {
    contextId: string;
}

export interface ContextSuspendedResult {
    suspended: boolean;
}

export interface PhysicalMemoryContextsResult {
    contexts: string[];
    /**
     * Full names of the contexts, in the same order: the names of the
     * contexts from the top down joined with ".", like the threads in the
     * call stack, for example "board.mb.phys_mem".
     */
    names?: string[];
}

export interface ReadMemoryArgs {
    contextId: string;
    address: string;
    wordSize: number;
    size: number;
    /** Bit set of MemoryAccessMode values. */
    mode: number;
}

export interface ReadMemoryResult {
    /** Base64 encoded bytes. */
    data: string;
    unreadable: ByteRange[];
}

export interface WriteMemoryArgs {
    contextId: string;
    address: string;
    wordSize: number;
    /** Base64 encoded bytes. */
    data: string;
    mode: number;
}

export interface MemoryChangedEventBody {
    contextId: string;
    ranges: { address: string; size: number }[];
}

export interface MemoryContextInfoArgs {
    contextId: string;
}

/** Properties of the Memory context, empty if it is not one. */
export interface MemoryContextInfoResult {
    name?: string;
    addressSize?: number;
    bigEndian?: boolean;
}

export interface FindMemoryArgs {
    /** Chosen by the client, used to cancel and in progress events. */
    findId: number;
    contextId: string;
    /** Base64 encoded bytes to find. */
    needle: string;
    /** Only addresses that are a multiple of this are tried. */
    alignment: number;
    /** The range to search, `end` inclusive. */
    start: string;
    end: string;
    direction: "forward" | "backward";
}

export interface FindMemoryResult {
    outcome: "found" | "notFound" | "cancelled";
    address?: string;
    /** Number of reads that failed completely. */
    failedReads?: number;
    firstError?: string;
}

export interface CancelFindMemoryArgs {
    findId: number;
}

export interface FindMemoryProgressEventBody {
    findId: number;
    /** Address the search has reached. */
    address: string;
}
