import { DebugSession, InitializedEvent, Response, TerminatedEvent } from "@vscode/debugadapter";
import { DebugProtocol } from "@vscode/debugprotocol";
import { ContextSessionLink, ContextSessionSink, TCF_CAPABILITIES } from "./tcfDebugSession";

/** Connects a child session to its group in the root adapter, undefined if the group is gone. */
export type ContextSessionConnector = (sink: ContextSessionSink) => ContextSessionLink | undefined;

/**
 * Debug adapter of a child session that shows the threads of one container
 * context (see ContextSessionHost). The root adapter does the work: thread,
 * frame and variable IDs are the root's, so requests are passed on as they
 * are. Breakpoints are only planted by the root session.
 */
export class TcfContextSession extends DebugSession implements ContextSessionSink {
    private link: ContextSessionLink | undefined;
    private terminated = false;

    constructor(private readonly connect: ContextSessionConnector) {
        super();
    }

    terminate(): void {
        this.link = undefined;
        if (!this.terminated) {
            this.terminated = true;
            this.sendEvent(new TerminatedEvent());
        }
    }

    override sendEvent(event: DebugProtocol.Event): void {
        if (event.event === "stopped") {
            // The IDs are the root session's. Without them VS Code finds the
            // hit breakpoints by the location of the top frame.
            const body = { ...(event as DebugProtocol.StoppedEvent).body };
            delete body.hitBreakpointIds;
            event = { ...event, body };
        }
        super.sendEvent(event);
    }

    protected override dispatchRequest(request: DebugProtocol.Request): void {
        const response: DebugProtocol.Response = new Response(request);
        switch (request.command) {
            case "initialize":
                response.body = { ...TCF_CAPABILITIES };
                this.sendResponse(response);
                return;
            case "attach":
            case "launch":
                this.link = this.connect(this);
                this.sendResponse(response);
                if (this.link) {
                    this.sendEvent(new InitializedEvent());
                } else {
                    this.terminate();
                }
                return;
            case "configurationDone":
                this.sendResponse(response);
                this.link?.configured();
                return;
            case "threads":
                response.body = { threads: this.link?.threads() ?? [] };
                this.sendResponse(response);
                return;
            case "setBreakpoints":
            case "setFunctionBreakpoints":
            case "setInstructionBreakpoints":
            case "setDataBreakpoints":
                // No entries, so VS Code keeps the root session's state for
                // each breakpoint.
                response.body = { breakpoints: [] };
                this.sendResponse(response);
                return;
            case "setExceptionBreakpoints":
                this.sendResponse(response);
                return;
            case "disconnect":
            case "terminate":
                this.link?.disconnect();
                this.link = undefined;
                this.terminated = true;
                this.sendResponse(response);
                return;
        }
        const link = this.link;
        if (!link) {
            this.sendErrorResponse(response, 4, "The debug session has ended");
            return;
        }
        void link.forward(request).then((r) => this.sendResponse({ ...r, seq: 0, request_seq: request.seq }));
    }
}
