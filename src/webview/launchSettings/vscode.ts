import type { StateMessage, WebviewMessage } from "@/launchSettings/protocol";

interface VsCodeApi {
    postMessage(message: WebviewMessage): void;
    getState(): unknown;
    setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

const api = acquireVsCodeApi();

export function post(message: WebviewMessage): void {
    api.postMessage(message);
}

export function onMessage(handler: (message: StateMessage) => void): () => void {
    const listener = (e: MessageEvent<StateMessage>) => handler(e.data);
    window.addEventListener("message", listener);
    return () => window.removeEventListener("message", listener);
}

/** The state VS Code keeps while the webview is hidden or reloaded. */
export function loadState<T>(): Partial<T> {
    return (api.getState() as Partial<T> | undefined) ?? {};
}

export function saveState(state: unknown): void {
    api.setState(state);
}
