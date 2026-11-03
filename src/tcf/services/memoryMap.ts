import { TcfChannel } from "../channel";

/** Memory map region properties, see TCF Services -> Memory Map. */
export interface MemoryRegionProperties {
    ID?: string;
    /** Restricts the region to contexts matching this context query. */
    ContextQuery?: string;
    /** Memory address. With only FileName and Addr, the file is relocated so its first loadable segment is at Addr. */
    Addr?: bigint | number;
    /**
     * Offset between the addresses in the file and in memory ("base
     * address" in the System V ABI). With only FileName and BaseAddress, all
     * addresses in the file are shifted by this value.
     */
    BaseAddress?: bigint | number;
    Size?: bigint | number;
    /** Offset in the file. */
    Offs?: bigint | number;
    BSS?: boolean;
    Flags?: number;
    FileName?: string;
    SectionName?: string;
    [key: string]: unknown;
}

export class MemoryMapService {
    static readonly NAME = "MemoryMap";

    constructor(private readonly channel: TcfChannel) {}

    async get(contextId: string): Promise<MemoryRegionProperties[]> {
        const [regions] = await this.channel.command(MemoryMapService.NAME, "get", contextId);
        return Array.isArray(regions) ? (regions as MemoryRegionProperties[]) : [];
    }

    /**
     * Sets this client's memory map for a context. The context is a context
     * ID or name, or "" for all contexts. An empty list removes the map.
     */
    async set(contextId: string, regions: MemoryRegionProperties[]): Promise<void> {
        await this.channel.command(MemoryMapService.NAME, "set", contextId, regions);
    }

    onChanged(listener: (contextId: string) => void): void {
        this.channel.onEvent(MemoryMapService.NAME, "changed", (a) => listener(String(a[0] ?? "")));
    }
}
