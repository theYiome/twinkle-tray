import React, { useEffect, useState } from "react"
import Slider from "./Slider"
import PanelStatus from "./PanelStatus"
import IconButton from "./IconButton"
import BlackoutButton from "./BlackoutButton"

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

const REMOTE_BUTTONS = [
    { button: "back", icon: "&#xE72B;", label: "PANEL_TV_REMOTE_BACK" },
    { button: "up", icon: "&#xE70E;", label: "PANEL_TV_REMOTE_UP" },
    { button: "home", icon: "&#xE80F;", label: "PANEL_TV_REMOTE_HOME" },
    { button: "left", icon: "&#xE76B;", label: "PANEL_TV_REMOTE_LEFT" },
    { button: "ok", icon: "&#xE73E;", label: "PANEL_TV_REMOTE_OK" },
    { button: "right", icon: "&#xE76C;", label: "PANEL_TV_REMOTE_RIGHT" },
    { button: "volumeDown", icon: "&#xE738;", label: "PANEL_TV_REMOTE_VOLUME_DOWN" },
    { button: "down", icon: "&#xE70D;", label: "PANEL_TV_REMOTE_DOWN" },
    { button: "volumeUp", icon: "&#xE710;", label: "PANEL_TV_REMOTE_VOLUME_UP" }
]

const AMBILIGHT_GROUPS = [
    { group: "video", label: "PANEL_TV_AMBILIGHT_VIDEO" },
    { group: "audio", label: "PANEL_TV_AMBILIGHT_AUDIO" },
    { group: "color", label: "PANEL_TV_AMBILIGHT_COLOR" }
]

export default function NetworkTVCard({ T }) {
    const [control, setControl] = useState(window.displayControl)
    const [error, setError] = useState(false)
    const [showRemote, setShowRemote] = useState(false)

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
    const unavailableReason = (controlsUnavailable ? T.t("PANEL_TV_UNAVAILABLE") : false)
    const offReason = (isOn ? unavailableReason : T.t("PANEL_TV_STATUS_STANDBY"))
    // Keys can still go over the backup link, but reading and setting things can't
    const usingBackup = (controlsUnavailable && tv.backupPaired)
    const keysReason = (usingBackup ? false : unavailableReason)
    const keysOffReason = (isOn ? keysReason : T.t("PANEL_TV_STATUS_STANDBY"))
    const failedAt = tv.standbyFailure && new Date(tv.standbyFailure.at).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" })
    const statusText = {
        on: T.t("PANEL_TV_STATUS_ON"),
        standby: T.t("PANEL_TV_STATUS_STANDBY"),
        unreachable: T.t("PANEL_TV_STATUS_OFFLINE"),
        unknown: T.t("PANEL_TV_STATUS_CHECKING")
    }[tv.power]

    return (
        <div className="panel-card network-tv-card">
            <div className="monitor-item">
                <div className="name-row">
                    <div className="icon"><span>&#xE7F4;</span></div>
                    <div className="title">{tv.name || T.t("PANEL_TV_NAME")}</div>
                    <div className="panel-card-state">{statusText}</div>
                    {display ? <BlackoutButton T={T} monitorKey={display.key} /> : null}
                </div>
            </div>
            <div className="tv-buttons" role="toolbar" aria-label={tv.name || T.t("PANEL_TV_NAME")}>
                <IconButton
                    icon="&#xE7E8;"
                    label={isOn ? T.t("PANEL_LABEL_TURN_OFF") : T.t("PANEL_LABEL_TURN_ON")}
                    active={isOn && !keysReason}
                    disabledReason={isOn ? keysReason : !tv.canWake}
                    onClick={() => run("tv.togglePower")} />
                {display ? <IconButton icon="&#xE7F4;" label={display.active ? T.t("PANEL_TV_DISCONNECT") : T.t("PANEL_TV_CONNECT")} active={display.active} onClick={() => run("display.setActive", { key: display.key, active: !display.active })} /> : null}
                {display?.mirroredWith?.length ? <IconButton icon="&#xE9A6;" label={T.t("PANEL_TV_EXTEND")} onClick={() => run("display.setActive", { key: display.key, active: true, extend: true })} /> : null}
                {display?.active && !display.mirroredWith?.length ? <IconButton icon="&#xE8A7;" label={T.t("PANEL_TV_MOVE_WINDOWS")} onClick={() => run("display.moveWindows", { key: display.key })} /> : null}
                {display?.active && display.hdr !== "unsupported" ? <IconButton icon="&#xE790;" label={T.t("PANEL_TV_HDR")} active={display.hdr === "on"} onClick={() => run("display.setHDR", { key: display.key, on: display.hdr !== "on" })} /> : null}
                <IconButton icon={tv.muted ? "&#xE74F;" : "&#xE767;"} label={T.t("PANEL_TV_MUTE")} active={!!tv.muted} disabledReason={keysOffReason} onClick={() => run("tv.toggleMute")} />
                <IconButton icon="&#xE793;" label={T.t("PANEL_TV_AMBILIGHT")} active={!!tv.ambilight} disabledReason={offReason} onClick={() => run("tv.ambilight", { on: !tv.ambilight })} />
                <IconButton icon="&#xE7C2;" label={T.t("PANEL_TV_REMOTE")} active={showRemote && !keysOffReason} disabledReason={keysOffReason} onClick={() => setShowRemote(!showRemote)} />
            </div>
            {showRemote && !keysOffReason ? (
                <div className="tv-remote" role="group" aria-label={T.t("PANEL_TV_REMOTE")}>
                    {REMOTE_BUTTONS.map(({ button, icon, label }) => <div key={button} className={`tv-remote-${button}`}><IconButton icon={icon} label={T.t(label)} onClick={() => run("tv.remote", { button })} /></div>)}
                </div>
            ) : null}
            {isOn && tv.ambilight && tv.ambilightStyles?.length ? (
                <div className="feature-row" title={T.t("PANEL_TV_AMBILIGHT_STYLE")}>
                    <div className="feature-icon"><span className="icon vfix">&#xE793;</span></div>
                    <select className="tv-select" aria-label={T.t("PANEL_TV_AMBILIGHT_STYLE")} value={tv.ambilightStyle ?? ""} onChange={e => run("tv.ambilightStyle", { id: e.target.value })}>
                        {tv.ambilightStyle ? null : <option value="" disabled>{T.t("PANEL_TV_AMBILIGHT_CUSTOM")}</option>}
                        {AMBILIGHT_GROUPS.map(({ group, label }) => (
                            <optgroup key={group} label={T.t(label)}>
                                {tv.ambilightStyles.filter(style => style.group === group).map(style => <option key={style.id} value={style.id}>{style.name}</option>)}
                            </optgroup>
                        ))}
                    </select>
                </div>
            ) : null}
            {isOn && tv.volume !== null ? (
                <div className="feature-row" title={T.t("PANEL_TV_VOLUME")}>
                    <div className="feature-icon"><span className="icon vfix">&#xE767;</span></div>
                    <Slider label={T.t("PANEL_TV_VOLUME")} level={tv.volume} min={tv.volumeMin} max={tv.volumeMax} onChange={sendVolume} scrollAmount={1} syncLevel={true} />
                </div>
            ) : null}
            {display?.active ? (
                <div className="feature-row" title={T.t("PANEL_TV_DIM")}>
                    <div className="feature-icon"><span className="icon vfix">&#xE706;</span></div>
                    <Slider label={T.t("PANEL_TV_DIM")} level={display.dim} min={5} max={100} onChange={sendDim} scrollAmount={window.settings?.scrollFlyoutAmount} syncLevel={true} />
                </div>
            ) : null}
            {display?.mirroredWith?.length ? <PanelStatus text={T.t("SETTINGS_DISPLAYS_MIRRORED", display.mirroredWith.join(", "))} details={T.t("PANEL_TV_MIRROR_NOTE", display.mirroredWith.join(", "))} /> : null}
            {tv.disconnectedAutomatically ? <PanelStatus text={T.t("PANEL_TV_AUTO_SHORT")} details={T.t("PANEL_TV_AUTO_NOTE")} /> : null}
            {tv.api === "unauthorized" ? <PanelStatus severity="warning" text={T.t("PANEL_TV_UNAUTHORIZED_SHORT")} details={T.t("PANEL_TV_UNAUTHORIZED")} /> : null}
            {isOn && tv.api === "down" ? <PanelStatus severity="warning" text={tv.backupPaired ? T.t("PANEL_TV_USING_BACKUP") : T.t("PANEL_TV_UNAVAILABLE")} details={tv.backupPaired ? T.t("PANEL_TV_USING_BACKUP_NOTE") : T.t("PANEL_TV_API_DOWN")} /> : null}
            {tv.standbyFailure ? (
                <PanelStatus
                    severity="error"
                    text={T.t("PANEL_TV_OFF_FAILED_SHORT", failedAt)}
                    details={T.t(tv.standbyFailure.reason === "sleep" ? "PANEL_TV_SLEEP_FAILED" : "PANEL_TV_SHUTDOWN_FAILED", failedAt)}
                    dismissLabel={T.t("PANEL_TV_DISMISS")}
                    onDismiss={() => run("tv.dismissStandbyFailure")} />
            ) : null}
            {error ? <PanelStatus severity="error" text={error} dismissLabel={T.t("PANEL_TV_DISMISS")} onDismiss={() => setError(false)} /> : null}
        </div>
    )
}
