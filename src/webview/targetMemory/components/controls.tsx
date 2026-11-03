import { formatAddress, inspectBytes, type Endianness } from "../../../shared/targetMemory/format";

export function Segmented<T extends string | number>(props: {
    value: T;
    options: { value: T; label: string; title?: string }[];
    onChange(value: T): void;
    title?: string;
}) {
    return (
        <span className="segmented" role="radiogroup" title={props.title}>
            {props.options.map((o) => (
                <button
                    key={String(o.value)}
                    role="radio"
                    aria-checked={o.value === props.value}
                    className={o.value === props.value ? "checked" : ""}
                    title={o.title}
                    onClick={() => props.onChange(o.value)}
                >
                    {o.label}
                </button>
            ))}
        </span>
    );
}

/** Values of the bytes at the cursor, like the hex editor's data inspector. */
export function Inspector(props: {
    address: bigint | undefined;
    addressSize: number;
    bytes: number[];
    endianness: Endianness;
}) {
    return (
        <aside className="inspector">
            <div className="inspector-title">
                Data Inspector
                <span className="inspector-endian">
                    {props.endianness === "little" ? "little endian" : "big endian"}
                </span>
            </div>
            {props.address === undefined ? (
                <div className="inspector-empty">Select a byte.</div>
            ) : (
                <table>
                    <tbody>
                        <tr>
                            <th>address</th>
                            <td>
                                0x
                                {formatAddress(props.address, props.addressSize)}
                            </td>
                        </tr>
                        {inspectBytes(props.bytes, props.endianness).map((e) => (
                            <tr key={e.label}>
                                <th>{e.label}</th>
                                <td title={e.value}>{e.value}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            )}
        </aside>
    );
}

export function IconButton(props: {
    icon: string;
    title: string;
    onClick(): void;
    disabled?: boolean;
    checked?: boolean;
}) {
    return (
        <button
            className={`icon-button${props.checked ? " checked" : ""}`}
            title={props.title}
            aria-label={props.title}
            aria-pressed={props.checked}
            disabled={props.disabled}
            onClick={props.onClick}
        >
            <i className={`codicon codicon-${props.icon}`} />
        </button>
    );
}
