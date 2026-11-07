import React, { useEffect, useState } from "react"
import IconButton from "./IconButton"
import PanelStatus from "./PanelStatus"

function useDisplayControl() {
    const [control, setControl] = useState(window.displayControl)
    useEffect(() => {
        const handleUpdate = e => setControl(e.detail)
        window.addEventListener("displayControlUpdated", handleUpdate)
        window.ipc.send("request-display-control")
        return () => window.removeEventListener("displayControlUpdated", handleUpdate)
    }, [])
    return control
}

function useCommand() {
    const [error, setError] = useState(false)
    const run = async (command, args) => {
        setError(false)
        const response = await window.sendDisplayControl(command, args)
        if (!response.ok) setError(response.error)
    }
    return [run, error, setError]
}

// Sits next to a display's name in the panel. Off takes the display off the desktop,
// so it works the same for every screen, whatever it supports.
export function DisplayPowerButton({ T, monitorKey }) {
    const control = useDisplayControl()
    const [run, error] = useCommand()
    const display = control?.displays?.find(entry => entry.key === monitorKey)
    if (!display?.active) return null
    const onlyScreen = !control.displays.some(entry => entry !== display && entry.active)

    return (
        <div className="monitor-blackout">
            <IconButton
                icon="&#xE7E8;"
                label={error || T.t("PANEL_LABEL_TURN_OFF")}
                disabledReason={onlyScreen ? T.t("PANEL_DISPLAY_ONLY_SCREEN") : false}
                onClick={() => run("display.power", { key: monitorKey, on: false })} />
        </div>
    )
}

// Turned-off displays aren't monitors Windows knows about any more, so they're
// listed here to be turned back on. The TV has its own card.
export function OffDisplays({ T }) {
    const control = useDisplayControl()
    const [run, error, setError] = useCommand()
    const tvPath = (control?.tv?.paired ? control.tv.displayPath : null)
    const off = (control?.displays ?? []).filter(entry => !entry.active && entry.devicePath !== tvPath)
    if (!off.length) return null

    return (
        <div className="panel-card off-displays">
            {off.map(display => (
                <div className="monitor-item" key={display.key}>
                    <div className="name-row">
                        <div className="icon"><span>&#xE7F4;</span></div>
                        <div className="title">{display.name || T.t("GENERIC_DISPLAY_SINGLE")}</div>
                        <div className="panel-card-state">{T.t("PANEL_DISPLAY_OFF")}</div>
                        <div className="monitor-blackout">
                            <IconButton icon="&#xE7E8;" label={T.t("PANEL_LABEL_TURN_ON")} onClick={() => run("display.power", { key: display.key, on: true })} />
                        </div>
                    </div>
                </div>
            ))}
            {error ? <PanelStatus severity="error" text={error} onDismiss={() => setError(false)} dismissLabel={T.t("GENERIC_DISMISS")} /> : null}
        </div>
    )
}
