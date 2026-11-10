import * as React from "react";
import type { BytesPerRow, Endianness, GroupSize } from "@/shared/targetMemory/format";
import { BYTES_PER_ROW_OPTIONS, GROUP_SIZES } from "@/shared/targetMemory/format";
import type { MemoryTarget, PanelSettings, TargetState } from "@/shared/targetMemory/protocol";
import { IconButton, Segmented } from "./controls";

interface ToolbarProps {
    state: TargetState | undefined;
    settings: PanelSettings;
    onSettings(change: Partial<PanelSettings>): void;
    onTarget(target: MemoryTarget): void;
    onGoto(expression: string): void;
    gotoError?: string;
    onGotoEdit(): void;
    /** Incremented to focus the address input. */
    focusToken: number;
    findOpen: boolean;
    onToggleFind(): void;
    onRefresh(): void;
}

export function Toolbar(props: ToolbarProps) {
    const { state, settings } = props;
    const [expression, setExpression] = React.useState("");
    const inputRef = React.useRef<HTMLInputElement>(null);
    React.useEffect(() => {
        if (props.focusToken > 0) {
            inputRef.current?.focus();
            inputRef.current?.select();
        }
    }, [props.focusToken]);

    const target = state?.target ?? { kind: "thread" };
    const targetValue = target.kind === "thread" ? "" : target.contextId;
    const physical = state?.physicalContexts ?? [];
    const go = () => {
        if (expression.trim()) {
            props.onGoto(expression.trim());
        }
    };

    return (
        <div className="toolbar">
            <select
                className="target-select"
                value={targetValue}
                title="Memory to show"
                onChange={(e) =>
                    props.onTarget(
                        e.target.value ? { kind: "physical", contextId: e.target.value } : { kind: "thread" },
                    )
                }
            >
                <option value="">Focused thread</option>
                {physical.length > 0 && (
                    <optgroup label="Physical memory">
                        {physical.map((c) => (
                            <option key={c.id} value={c.id} title={c.id}>
                                {c.label}
                            </option>
                        ))}
                    </optgroup>
                )}
            </select>
            <span className="address-box">
                <input
                    ref={inputRef}
                    className={`address-input${props.gotoError ? " invalid" : ""}`}
                    value={expression}
                    placeholder="Address or expression (Ctrl+G)"
                    title={
                        props.gotoError ??
                        "An address such as 0x1000, or an expression such as &buffer or $sp, evaluated in the selected frame"
                    }
                    spellCheck={false}
                    onChange={(e) => {
                        setExpression(e.target.value);
                        props.onGotoEdit();
                    }}
                    onKeyDown={(e) => {
                        if (e.key === "Enter") {
                            e.preventDefault();
                            go();
                        }
                    }}
                />
                <IconButton icon="arrow-right" title="Go to address" onClick={go} />
            </span>
            <span className="toolbar-group" title="Bytes per group">
                <span className="toolbar-label">Group</span>
                <Segmented<GroupSize>
                    value={settings.groupSize}
                    options={GROUP_SIZES.map((n) => ({
                        value: n,
                        label: String(n),
                        title: `${n} byte${n > 1 ? "s" : ""} per group`,
                    }))}
                    onChange={(groupSize) => props.onSettings({ groupSize })}
                />
            </span>
            <Segmented<Endianness>
                value={settings.endianness}
                title="Byte order of the groups and the data inspector"
                options={[
                    { value: "little", label: "LE", title: "Little endian" },
                    { value: "big", label: "BE", title: "Big endian" },
                ]}
                onChange={(endianness) => props.onSettings({ endianness })}
            />
            <select
                value={settings.bytesPerRow}
                title="Bytes per row"
                onChange={(e) =>
                    props.onSettings({
                        bytesPerRow: Number(e.target.value) as BytesPerRow,
                    })
                }
            >
                {BYTES_PER_ROW_OPTIONS.map((n) => (
                    <option key={n} value={n}>
                        {n === 0 ? "Fit width" : `${n} per row`}
                    </option>
                ))}
            </select>
            <span className="toolbar-spacer" />
            <IconButton icon="refresh" title="Read memory again" onClick={props.onRefresh} />
            <IconButton icon="search" title="Find (Ctrl+F)" checked={props.findOpen} onClick={props.onToggleFind} />
            <IconButton
                icon="inspect"
                title="Data inspector"
                checked={settings.inspector}
                onClick={() => props.onSettings({ inspector: !settings.inspector })}
            />
        </div>
    );
}
