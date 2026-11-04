import React from "react"

export default function IconButton({ icon, label, onClick, active = false, disabledReason = false }) {
    const disabled = !!disabledReason
    return (
        <button
            type="button"
            className="tv-button"
            aria-label={label}
            aria-pressed={active}
            aria-disabled={disabled}
            title={disabled && disabledReason !== true ? `${label}: ${disabledReason}` : label}
            onClick={disabled ? undefined : onClick}>
            <span className="icon" dangerouslySetInnerHTML={{ __html: icon }}></span>
        </button>
    )
}
