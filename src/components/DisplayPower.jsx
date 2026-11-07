import React, { useEffect, useState } from "react"
import IconButton from "./IconButton"
import PanelStatus from "./PanelStatus"

export function useDisplayControl() {
    const [control, setControl] = useState(window.displayControl)
    useEffect(() => {
        const handleUpdate = e => setControl(e.detail)
        window.addEventListener("displayControlUpdated", handleUpdate)
        window.ipc.send("request-display-control")
        return () => window.removeEventListener("displayControlUpdated", handleUpdate)
    }, [])
    return control
}

function useCommand(onError) {
    const [error, setError] = useState(false)
    const run = async (command, args) => {
        setError(false)
        onError?.(false)
        const response = await window.sendDisplayControl(command, args)
        if (!response.ok) {
            setError(response.error)
            onError?.(response.error)
        }
    }
    return [run, error, setError]
}

// Whether the TV is on, going by what was last asked of it, since it takes a while
// to look any different
export function tvIsOn(tv) {
    return (tv?.changing ? tv.changing === "on" : tv?.power === "on")
}

// The same buttons at the end of every display's name: blackout, then power. Power
// off takes the display off the desktop, so windows and the mouse can't go there,
// whatever the display supports. The TV also goes to standby.
export function DisplayActions({ T, monitorKey, forTV = false, onError }) {
    const control = useDisplayControl()
    const [run, error] = useCommand(onError)
    const display = control?.displays?.find(entry => entry.key === monitorKey)
    const tv = control?.tv
    const isTV = forTV || !!(tv?.paired && display && display.devicePath === tv.displayPath)
    if (!isTV && !display) return null

    let on, disabledReason = false, toggle
    if (isTV) {
        on = tvIsOn(tv)
        const unavailable = (tv.api === "down" || tv.api === "unauthorized") && !tv.backupPaired
        disabledReason = (on ? (unavailable && T.t("PANEL_TV_UNAVAILABLE")) : !tv.canWake)
        toggle = () => run("tv.power", { on: !on })
    } else {
        on = display.active
        const onlyScreen = on && !control.displays.some(entry => entry !== display && entry.active)
        disabledReason = (onlyScreen ? T.t("PANEL_DISPLAY_ONLY_SCREEN") : false)
        toggle = () => run("display.power", { key: monitorKey, on: !on })
    }
    const powerLabel = (on ? T.t("PANEL_LABEL_TURN_OFF") : T.t("PANEL_LABEL_TURN_ON"))

    return (
        <div className="display-actions">
            {display?.active ? (
                <IconButton
                    icon="&#xE708;"
                    label={display.blackedOut ? T.t("PANEL_BLACKOUT_OFF") : T.t("PANEL_BLACKOUT_ON")}
                    active={display.blackedOut}
                    onClick={() => run("display.blackout", { key: monitorKey, on: !display.blackedOut })} />
            ) : null}
            <IconButton
                icon="&#xE7E8;"
                label={(!onError && error) || powerLabel}
                disabledReason={disabledReason}
                onClick={toggle} />
        </div>
    )
}

// Turned-off monitors aren't monitors Windows knows about any more, so they're
// listed here to be turned back on. The TV has its own card.
export function OffDisplays({ T }) {
    const control = useDisplayControl()
    const [error, setError] = useState(false)
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
                        <DisplayActions T={T} monitorKey={display.key} onError={setError} />
                    </div>
                </div>
            ))}
            {error ? <PanelStatus severity="error" text={error} onDismiss={() => setError(false)} dismissLabel={T.t("GENERIC_DISMISS")} /> : null}
        </div>
    )
}
