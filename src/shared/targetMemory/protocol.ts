/*
 * Messages between the Target Memory webview and the extension. Addresses
 * are hex strings, since JSON numbers cannot hold all 64-bit values.
 */

import type { BytesPerRow, Endianness, GroupSize } from "./format";
import type { FindFormat, IntSize } from "./needle";
import type { SearchDirection } from "./search";

export const TARGET_MEMORY_VIEW_TYPE = "simics-target-debug.targetMemory";

/** The memory shown: of the focused thread, or a physical memory context. */
export type MemoryTarget = { kind: "thread" } | { kind: "physical"; contextId: string };

export interface FindSettings {
    format: FindFormat;
    intSize: IntSize;
    endianness: Endianness;
    /** Only addresses that are a multiple of this are searched. */
    alignment: number;
    rangeStart: string;
    rangeEnd: string;
}

export interface PanelSettings {
    groupSize: GroupSize;
    endianness: Endianness;
    bytesPerRow: BytesPerRow;
    inspector: boolean;
    find: FindSettings;
}

export const DEFAULT_SETTINGS: PanelSettings = {
    groupSize: 1,
    endianness: "little",
    bytesPerRow: 16,
    inspector: false,
    find: {
        format: "hex",
        intSize: 4,
        endianness: "little",
        alignment: 1,
        rangeStart: "0x0",
        // The low 1 TiB. A miss over the whole 64-bit space would never end.
        rangeEnd: "0xffffffffff",
    },
};

export interface PhysicalContext {
    id: string;
    label: string;
}

export interface TargetState {
    /** Name of the debug session, undefined if there is none. */
    session?: string;
    target: MemoryTarget;
    /** The TCF memory context that is read, if known. */
    contextId?: string;
    contextLabel?: string;
    physicalContexts: PhysicalContext[];
    /** Bytes per address, for the width of the address column. */
    addressSize: number;
    /** Whether the context shown is running. */
    running: boolean;
    canRead: boolean;
    canWrite: boolean;
    /** Why no memory can be shown, if so. */
    notice?: string;
    /** Incremented when another context is shown: cached bytes are stale. */
    epoch: number;
}

export type FindOutcome = "found" | "notFound" | "cancelled" | "error";

export type ContextMenuCommand = "copy" | "copyText" | "copyAddress" | "goto" | "find" | "refresh";

/** The entry that was right-clicked, from the webview's menu context. */
export interface MenuTarget {
    address: string;
    pane: "hex" | "text";
}

export type ToWebview =
    | { type: "init"; settings: PanelSettings; address?: string }
    | { type: "state"; state: TargetState }
    /** Memory may have changed: read it again and highlight the changes. */
    | { type: "refresh"; epoch: number }
    | {
          type: "data";
          epoch: number;
          seq: number;
          address: string;
          bytes: number[];
          unreadable: { offset: number; size: number }[];
      }
    | {
          type: "readError";
          epoch: number;
          seq: number;
          address: string;
          error: string;
      }
    | { type: "reveal"; address: string; length?: number }
    | { type: "gotoError"; message: string }
    /** `id` is that of the find request, replies to older ones are stale. */
    | { type: "findProgress"; id: number; address: string }
    | {
          type: "findResult";
          id: number;
          outcome: FindOutcome;
          address?: string;
          length?: number;
          message?: string;
      }
    | { type: "writeResult"; ok: boolean; message?: string }
    | { type: "command"; command: ContextMenuCommand; target?: MenuTarget };

export type FromWebview =
    | { type: "ready" }
    | {
          type: "read";
          epoch: number;
          seq: number;
          address: string;
          length: number;
      }
    | {
          type: "write";
          epoch: number;
          writes: { address: string; bytes: number[] }[];
      }
    | { type: "setTarget"; target: MemoryTarget }
    | { type: "goto"; expression: string }
    | { type: "refresh" }
    | {
          type: "find";
          /** Chosen by the webview, echoed in the replies. */
          id: number;
          epoch: number;
          needle: number[];
          alignment: number;
          start: string;
          end: string;
          direction: SearchDirection;
      }
    | { type: "cancelFind" }
    | { type: "settings"; settings: PanelSettings }
    /** The address at the top of the view, restored when reopened. */
    | { type: "position"; address: string }
    | { type: "copy"; text: string };
