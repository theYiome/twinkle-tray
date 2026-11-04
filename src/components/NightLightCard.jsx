import React, { useEffect, useRef, useState } from "react"
import Slider from "./Slider"

const SEND_INTERVAL_MS = 150

export default function NightLightCard({ T }) {
    const [control, setControl] = useState(window.displayControl)
    const [pending, setPending] = useState(null)
    const [error, setError] = useState(false)
    const sender = useRef({ timeout: false, level: null })

    useEffect(() => {
        const handleUpdate = e => setControl(e.detail)
        window.addEventListener("displayControlUpdated", handleUpdate)
        window.ipc.send("request-display-control")
        return () => window.removeEventListener("displayControlUpdated", handleUpdate)
    }, [])

    const nightLight = control?.nightLight
    const adjusting = nightLight?.adjusting

    // What was dragged to stays on screen until the app has saved it
    useEffect(() => {
        if (!adjusting && !sender.current.timeout) setPending(null)
    }, [adjusting, nightLight?.level])

    if (!nightLight?.show || !nightLight.supported) return null

    const send = async level => {
        const response = await window.sendDisplayControl("nightLight.adjust", { level })
        setError(response.ok ? false : response.error)
        // Nothing's coming to replace it, so go back to the real value
        if (!response.ok) setPending(null)
    }

    // Throttled since each one is a registry write. The last value always gets sent.
    const flush = () => {
        sender.current.timeout = false
        if (sender.current.level === null) return
        send(sender.current.level)
        sender.current.level = null
        sender.current.timeout = setTimeout(flush, SEND_INTERVAL_MS)
    }
    const handleChange = level => {
        setPending(level)
        sender.current.level = level
        if (!sender.current.timeout) flush()
    }

    const level = pending ?? nightLight.level
    const status = (level > 0 ? T.t("GENERIC_ON") : (nightLight.scheduleEnabled ? T.t("PANEL_NIGHT_LIGHT_AUTO") : T.t("GENERIC_OFF")))
    const message = error || nightLight.error

    return (
        <div className="monitor-sliders extended network-tv-card night-light-card">
            <div className="monitor-item" style={{ height: "auto", paddingBottom: "4px" }}>
                <div className="name-row">
                    <div className="icon"><span>&#xE708;</span></div>
                    <div className="title">{T.t("PANEL_NIGHT_LIGHT")}</div>
                    <div className="tv-status">{status}</div>
                </div>
            </div>
            <div className="feature-row">
                <div className="feature-icon"><span className="icon vfix">&#xE706;</span></div>
                <Slider level={level} min={0} max={100} onChange={handleChange} scrollAmount={window.settings?.scrollFlyoutAmount} syncLevel={true} />
            </div>
            {message ? <div className="tv-note tv-error">{message}</div> : null}
        </div>
    )
}
