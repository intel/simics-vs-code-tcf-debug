/** A frame selected in the Call Stack view. */
export interface CallStackFrame {
    /** DAP thread ID. */
    threadId: number;
    /** Index of the frame in the thread's stack, 0 for the top frame. */
    frameIndex: number;
}

/**
 * Parses the context that VS Code passes to commands in the Call Stack view's
 * context menu. Its `frameId` has the form
 * `stackframe:thread:<sessionId>:<threadId>:<frameIndex>:<sourceName>`.
 */
export function parseCallStackContext(context: unknown): (CallStackFrame & { sessionId: string }) | undefined {
    if (typeof context !== "object" || context === null) {
        return undefined;
    }
    const { sessionId, frameId } = context as Record<string, unknown>;
    if (typeof sessionId !== "string" || typeof frameId !== "string") {
        return undefined;
    }
    const m = /^stackframe:thread:([^:]*):(\d+):(\d+):/.exec(frameId);
    if (!m || m[1] !== sessionId) {
        return undefined;
    }
    return {
        sessionId,
        threadId: Number(m[2]),
        frameIndex: Number(m[3]),
    };
}
