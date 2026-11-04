import React from "react"

const ICONS = { info: "", warning: "", error: "" }

// One line of status for the panel's cards. Anything longer than fits gets cut off
// and goes in the tooltip, so a message can't push the rest of the panel around.
export default function PanelStatus({ severity = "info", text, details, onDismiss, dismissLabel }) {
    return (
        <div className="panel-status" data-severity={severity} role={severity === "info" ? "status" : "alert"} title={details ?? text}>
            <span className="panel-status-icon icon">{ICONS[severity]}</span>
            <span className="panel-status-text">{text}</span>
            {onDismiss ? <button type="button" className="panel-status-dismiss icon" aria-label={dismissLabel} title={dismissLabel} onClick={onDismiss}>{""}</button> : null}
        </div>
    )
}
