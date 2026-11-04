import React, { useEffect, useState } from "react"
import IconButton from "./IconButton"

// Sits next to a display's name in the panel
export default function BlackoutButton({ T, monitorKey }) {
    const [control, setControl] = useState(window.displayControl)

    useEffect(() => {
        const handleUpdate = e => setControl(e.detail)
        window.addEventListener("displayControlUpdated", handleUpdate)
        window.ipc.send("request-display-control")
        return () => window.removeEventListener("displayControlUpdated", handleUpdate)
    }, [])

    const display = control?.displays?.find(entry => entry.key === monitorKey)
    if (!display?.active) return null

    return (
        <div className="monitor-blackout">
            <IconButton
                icon="&#xE708;"
                label={display.blackedOut ? T.t("PANEL_BLACKOUT_OFF") : T.t("PANEL_BLACKOUT_ON")}
                active={display.blackedOut}
                onClick={() => window.sendDisplayControl("display.blackout", { key: monitorKey, on: !display.blackedOut })} />
        </div>
    )
}
