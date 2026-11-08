import React, { useEffect, useState } from "react"
import Slider from "./Slider"
import PanelStatus from "./PanelStatus"
import IconButton from "./IconButton"
import { DisplayActions, tvIsOn } from "./DisplayPower"

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
    // "remote", "ambilight" or null: one at a time keeps the card short
    const [sheet, setSheet] = useState(null)
    const toggleSheet = name => setSheet(sheet === name ? null : name)

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
    const isOn = tvIsOn(tv)
    const controlsUnavailable = tv.api === "down" || tv.api === "unauthorized"
    const unavailableReason = (controlsUnavailable ? T.t("PANEL_TV_UNAVAILABLE") : false)
    // Keys can still go over the backup link, but reading and setting things can't
    const usingBackup = (controlsUnavailable && tv.backupPaired)
    const keysReason = (usingBackup ? false : unavailableReason)
    const keysOffReason = (isOn ? keysReason : T.t("PANEL_TV_STATUS_STANDBY"))
    const failedAt = tv.standbyFailure && new Date(tv.standbyFailure.at).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" })
    // Only shown when it's something other than plainly on
    const statusText = (tv.changing ? T.t(tv.changing === "on" ? "PANEL_TV_STATUS_TURNING_ON" : "PANEL_TV_STATUS_TURNING_OFF") : {
        on: null,
        standby: T.t("PANEL_TV_STATUS_STANDBY"),
        unreachable: T.t("PANEL_TV_STATUS_OFFLINE"),
        unknown: T.t("PANEL_TV_STATUS_CHECKING")
    }[tv.power])
    const ready = (isOn && tv.power === "on")
    const showRemote = (sheet === "remote" && ready && !keysReason)
    const showAmbilight = (sheet === "ambilight" && ready && !unavailableReason)

    return (
        <div className="panel-card network-tv-card">
            <div className="monitor-item">
                <div className="name-row">
                    <div className="icon"><span>&#xE7F4;</span></div>
                    <div className="title">{tv.name || T.t("PANEL_TV_NAME")}</div>
                    {statusText ? <div className="panel-card-state">{statusText}</div> : null}
                    <DisplayActions T={T} monitorKey={display?.key} forTV={true} onError={setError} />
                </div>
            </div>
            {ready ? (
                <div className="tv-buttons" role="toolbar" aria-label={tv.name || T.t("PANEL_TV_NAME")}>
                    {display ? <IconButton icon="&#xE7F4;" label={display.active ? T.t("PANEL_TV_DISCONNECT") : T.t("PANEL_TV_CONNECT")} active={display.active} onClick={() => run("display.setActive", { key: display.key, active: !display.active })} /> : null}
                    {display?.mirroredWith?.length ? <IconButton icon="&#xE9A6;" label={T.t("PANEL_TV_EXTEND")} onClick={() => run("display.setActive", { key: display.key, active: true, extend: true })} /> : null}
                    {display?.active && display.hdr !== "unsupported" ? <IconButton icon="&#xE790;" label={T.t("PANEL_TV_HDR")} active={display.hdr === "on"} onClick={() => run("display.setHDR", { key: display.key, on: display.hdr !== "on" })} /> : null}
                    <IconButton icon="&#xE793;" label={T.t("PANEL_TV_AMBILIGHT")} active={!!tv.ambilight} expanded={showAmbilight} disabledReason={unavailableReason} onClick={() => toggleSheet("ambilight")} />
                    <IconButton icon="&#xE7C2;" label={T.t("PANEL_TV_REMOTE")} expanded={showRemote} disabledReason={keysReason} onClick={() => toggleSheet("remote")} />
                </div>
            ) : null}
            {showRemote ? (
                <div className="tv-remote" role="group" aria-label={T.t("PANEL_TV_REMOTE")}>
                    {REMOTE_BUTTONS.map(({ button, icon, label }) => <div key={button} className={`tv-remote-${button}`}><IconButton icon={icon} label={T.t(label)} onClick={() => run("tv.remote", { button })} /></div>)}
                </div>
            ) : null}
            {showAmbilight ? (
                <div className="tv-sheet ambilight-sheet" role="group" aria-label={T.t("PANEL_TV_AMBILIGHT")}>
                    <div className="tv-sheet-header">
                        <span>{T.t("PANEL_TV_AMBILIGHT")}</span>
                        <button type="button" role="switch" aria-checked={!!tv.ambilight} className="tv-switch" onClick={() => run("tv.ambilight", { on: !tv.ambilight })}>
                            <span className="tv-switch-label">{tv.ambilight ? T.t("PANEL_TV_AMBILIGHT_ON") : T.t("PANEL_TV_AMBILIGHT_OFF")}</span>
                            <span className="tv-switch-track"><span className="tv-switch-thumb"></span></span>
                        </button>
                    </div>
                    {tv.ambilightStyles?.length ? AMBILIGHT_GROUPS.map(({ group, label }) => {
                        const styles = tv.ambilightStyles.filter(style => style.group === group)
                        if (!styles.length) return null
                        return (
                            <div className="ambilight-group" key={group}>
                                <div className="ambilight-group-label">{T.t(label)}</div>
                                <div className="ambilight-chips">
                                    {styles.map(style => {
                                        const current = (tv.ambilight && tv.ambilightStyle === style.id)
                                        return <button type="button" key={style.id} className="ambilight-chip" aria-pressed={current} onClick={() => run("tv.ambilightStyle", { id: style.id })}>{style.name}</button>
                                    })}
                                </div>
                            </div>
                        )
                    }) : null}
                </div>
            ) : null}
            {isOn && tv.volume !== null ? (
                <div className="feature-row" title={T.t("PANEL_TV_VOLUME")}>
                    <div className="feature-icon">
                        <IconButton icon={tv.muted ? "&#xE74F;" : "&#xE767;"} label={tv.muted ? T.t("PANEL_TV_UNMUTE") : T.t("PANEL_TV_MUTE")} active={!!tv.muted} disabledReason={keysOffReason} onClick={() => run("tv.toggleMute")} />
                    </div>
                    <Slider label={T.t("PANEL_TV_VOLUME")} level={tv.volume} min={tv.volumeMin} max={tv.volumeMax} onChange={sendVolume} scrollAmount={1} syncLevel={true} />
                </div>
            ) : null}
            {display?.active ? (
                <div className="feature-row" title={T.t("PANEL_TV_DIM")}>
                    <div className="feature-icon"><span className="icon vfix">&#xE706;</span></div>
                    <Slider label={T.t("PANEL_TV_DIM")} level={display.dim} min={5} max={100} onChange={sendDim} scrollAmount={window.settings?.scrollFlyoutAmount} syncLevel={true} />
                </div>
            ) : null}
            {display?.active && display.dimLimitedTo ? <PanelStatus text={T.t("PANEL_DIM_LIMITED", display.dimLimitedTo)} details={T.t("PANEL_DIM_LIMITED_NOTE")} /> : null}
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
