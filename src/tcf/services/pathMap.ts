import { TcfChannel } from "@/tcf/channel";

/** Path map rule properties, see TCF Services -> Path Map. */
export interface PathMapRuleProperties {
    ID?: string;
    /** File path prefix as seen by the target, for example the compilation directory. */
    Source?: string;
    /** Replacement prefix on the client (host). */
    Destination?: string;
    /** Restricts the rule to clients on this host. */
    Host?: string;
    Protocol?: string;
    /** Restricts the rule to matching contexts, e.g. "ID=cpu0". */
    ContextQuery?: string;
    [key: string]: unknown;
}

export class PathMapService {
    static readonly NAME = "PathMap";

    constructor(private readonly channel: TcfChannel) {}

    /** Returns all path map rules known by the agent, including rules from other clients. */
    async get(): Promise<PathMapRuleProperties[]> {
        const [rules] = await this.channel.command(PathMapService.NAME, "get");
        return Array.isArray(rules) ? (rules as PathMapRuleProperties[]) : [];
    }

    /** Replaces the path map rules of this client (channel). */
    async set(rules: PathMapRuleProperties[]): Promise<void> {
        await this.channel.command(PathMapService.NAME, "set", rules);
    }

    onChanged(listener: () => void): void {
        this.channel.onEvent(PathMapService.NAME, "changed", () => listener());
    }
}
