import type { FromWebview, ToWebview } from "../../shared/targetMemory/protocol";

interface VsCodeApi {
    postMessage(message: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

const api = acquireVsCodeApi();

export function post(message: FromWebview): void {
    api.postMessage(message);
}

export function onMessage(handler: (message: ToWebview) => void): () => void {
    const listener = (e: MessageEvent<ToWebview>) => handler(e.data);
    window.addEventListener("message", listener);
    return () => window.removeEventListener("message", listener);
}
