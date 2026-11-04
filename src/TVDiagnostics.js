// A log of what happens between this app and the TV, one JSON object per line. Session
// logs only go back a few runs, and API outages are rare and don't say when they'll come,
// so this keeps enough history to see what led up to one. Size-limited, and safe to share:
// anything that looks like a secret or an address on the hardware is left out.

const fs = require("fs")

const MAX_BYTES = 5 * 1024 * 1024
const HIDDEN_FIELDS = /pass|auth|token|secret|pin$|challenge|credential|^mac|macs$/i
const MAC_ADDRESS = /\b([0-9a-f]{2}[:-]){5}[0-9a-f]{2}\b/gi

// Local time, to line up with the session logs
function localTime(now = new Date()) {
    return new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, -1)
}

function clean(value) {
    if (typeof value === "string") return value.replace(MAC_ADDRESS, "<mac>")
    if (Array.isArray(value)) return value.map(clean)
    if (value && typeof value === "object") {
        const out = {}
        for (const key in value) {
            if (!HIDDEN_FIELDS.test(key)) out[key] = clean(value[key])
        }
        return out
    }
    return value
}

class TVDiagnostics {
    // basePath has no extension. Writes to basePath.log, and the one before to basePath.old.log.
    constructor(basePath, { maxBytes = MAX_BYTES } = {}) {
        this.path = `${basePath}.log`
        this.oldPath = `${basePath}.old.log`
        this.maxBytes = maxBytes
    }

    write(event, fields = {}) {
        try {
            if (fs.existsSync(this.path) && fs.statSync(this.path).size > this.maxBytes) {
                fs.renameSync(this.path, this.oldPath)
            }
            // Written right away, since it's most useful around crashes and shutdowns
            fs.appendFileSync(this.path, JSON.stringify({ t: localTime(), e: event, ...clean(fields) }) + "\n")
        } catch (e) {
            // Nothing here is worth breaking TV control over
        }
    }
}

module.exports = { TVDiagnostics, clean, MAX_BYTES }
