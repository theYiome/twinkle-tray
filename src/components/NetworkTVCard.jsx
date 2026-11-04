import React, { useEffect, useState } from "react"
import Slider from "./Slider"

// Throttled so dragging a slider doesn't queue up a request per pixel. The
// last value always gets sent, so the slider never stops short of where it ended.
function useLatestSender(send, delay = 150) {
    const [state] = useState({ timeout: false, pending: undefined, hasPending: false, send })
    state.send = send
    const flush = () => {
        state.timeout = false
        if (!state.hasPending) return
        state.hasPending = false
        state.send(state.pending)
        state.timeout = setTimeout(flush, delay)
    }
    return value => {
        state.pending = value
        state.hasPending = true
        if (!state.timeout) flush()
    }
}

export default function NetworkTVCard({ T }) {
    const [control, setControl] = useState(window.displayControl)
    const [error, setError] = useState(false)

    useEffect(() => {
        const handleUpdate = e => setControl(e.detail)
        window.addEventListener("displayControlUpdated", handleUpdate)
        window.ipc.send("request-display-control")
        return () => window.removeEventListener("displayControlUpdated", handleUpdate)
    }, [])

    const run = async (command, args) => {
        setError(false)
        const response = await window.sendDisplayControl(command, args)
        if (!response.ok) setError(response.error)
    }

    const sendVolume = useLatestSender(level => run("tv.volume", { level }))
    const sendDim = useLatestSender(level => run("display.dim", { key: display?.key, level }))

    const tv = control?.tv
    if (!tv?.paired) return null

    const display = control.displays?.find(entry => entry.devicePath === tv.displayPath)
    const isOn = tv.power === "on"
    const controlsUnavailable = tv.api === "down" || tv.api === "unauthorized"
    const failedAt = tv.standbyFailure && new Date(tv.standbyFailure.at).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" })
    const statusText = {
        on: T.t("PANEL_TV_STATUS_ON"),
        standby: T.t("PANEL_TV_STATUS_STANDBY"),
        unreachable: T.t("PANEL_TV_STATUS_OFFLINE"),
        unknown: T.t("PANEL_TV_STATUS_CHECKING")
    }[tv.power]

    const button = (icon, label, onClick, { active = false, disabled = false } = {}) => (
        <div className="tv-button" data-active={active} data-disabled={disabled} title={label} onClick={disabled ? undefined : onClick}>
            <span className="icon vfix" dangerouslySetInnerHTML={{ __html: icon }}></span>
            <span>{label}</span>
        </div>
    )

    return (
        <div className="monitor-sliders extended network-tv-card">
            <div className="monitor-item" style={{ height: "auto", paddingBottom: "12px" }}>
                <div className="name-row">
                    <div className="icon"><span>&#xE7F4;</span></div>
                    <div className="title">{tv.name || T.t("PANEL_TV_NAME")}</div>
                    <div className="tv-status">{statusText}</div>
                </div>
            </div>
            <div className="tv-buttons">
                {button("&#xE7E8;", isOn ? T.t("PANEL_LABEL_TURN_OFF") : T.t("PANEL_LABEL_TURN_ON"), () => run("tv.togglePower"), { disabled: isOn ? controlsUnavailable : !tv.canWake })}
                {display ? button("&#xE7F4;", display.active ? T.t("PANEL_TV_DISCONNECT") : T.t("PANEL_TV_CONNECT"), () => run("display.setActive", { key: display.key, active: !display.active }), { active: display.active }) : null}
                {display?.mirroredWith?.length ? button("&#xE9A6;", T.t("PANEL_TV_EXTEND"), () => run("display.setActive", { key: display.key, active: true, extend: true })) : null}
                {display?.active && !display.mirroredWith?.length ? button("&#xE8A7;", T.t("PANEL_TV_MOVE_WINDOWS"), () => run("display.moveWindows", { key: display.key })) : null}
                {button(tv.muted ? "&#xE74F;" : "&#xE767;", T.t("PANEL_TV_MUTE"), () => run("tv.toggleMute"), { active: tv.muted, disabled: !isOn || controlsUnavailable })}
                {button("&#xE793;", T.t("PANEL_TV_AMBILIGHT"), () => run("tv.ambilight", { on: !tv.ambilight }), { active: tv.ambilight, disabled: !isOn || controlsUnavailable })}
            </div>
            {isOn && tv.volume !== null ? (
                <div className="feature-row">
                    <div className="feature-icon"><span className="icon vfix">&#xE767;</span></div>
                    <Slider level={tv.volume} min={tv.volumeMin} max={tv.volumeMax} onChange={sendVolume} scrollAmount={1} />
                </div>
            ) : null}
            {display?.active ? (
                <div className="feature-row">
                    <div className="feature-icon"><span className="icon vfix">&#xE706;</span></div>
                    <Slider level={display.dim} min={5} max={100} onChange={sendDim} scrollAmount={window.settings?.scrollFlyoutAmount} />
                </div>
            ) : null}
            {display?.mirroredWith?.length ? <div className="tv-note">{T.t("PANEL_TV_MIRROR_NOTE", display.mirroredWith.join(", "))}</div> : null}
            {tv.autoDisconnect && tv.disconnectedAutomatically ? <div className="tv-note">{T.t("PANEL_TV_AUTO_NOTE")}</div> : null}
            {tv.api === "unauthorized" ? <div className="tv-note">{T.t("PANEL_TV_UNAUTHORIZED")}</div> : null}
            {isOn && tv.api === "down" ? <div className="tv-note">{T.t("PANEL_TV_API_DOWN")}</div> : null}
            {tv.standbyFailure ? (
                <div className="tv-note tv-error">
                    {T.t(tv.standbyFailure.reason === "sleep" ? "PANEL_TV_SLEEP_FAILED" : "PANEL_TV_SHUTDOWN_FAILED", failedAt)}
                    {" "}<a className="tv-dismiss" onClick={() => run("tv.dismissStandbyFailure")}>{T.t("PANEL_TV_DISMISS")}</a>
                </div>
            ) : null}
            {error ? <div className="tv-note tv-error">{error}</div> : null}
        </div>
    )
}
