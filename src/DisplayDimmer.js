// Dims displays without putting anything on screen. An SDR display gets its gamma
// ramp scaled, on top of whatever the ramp already is (calibration, Night light). An
// HDR display, where Windows ignores gamma ramps, gets its SDR content brightness
// lowered instead, which only goes down to Windows' minimum of 80 nits.
//
// Windows replaces gamma ramps on display events and when Night light changes, so
// dimmed ramps are checked every couple of seconds and put back.

const CHECK_MS = 2000
// Windows' SDR content brightness slider runs from 80 to 480 nits
const SDR_MIN_NITS = 80
const SDR_NITS_PER_LEVEL = 4

const sdrLevelToNits = level => SDR_MIN_NITS + level * SDR_NITS_PER_LEVEL
const nitsToSdrLevel = nits => Math.max(0, Math.min(100, Math.round((nits - SDR_MIN_NITS) / SDR_NITS_PER_LEVEL)))

// The SDR level that dims a display to the given percentage of its own level
function dimmedSdrLevel(baseLevel, percent) {
    return nitsToSdrLevel(Math.max(SDR_MIN_NITS, sdrLevelToNits(baseLevel) * percent / 100))
}

class DisplayDimmer {
    // native: { setDim(path, percent) -> mode, dimIntact(path) -> bool }
    // setSDRLevel(monitorId, level), getSdrBase(key), setSdrBase(key, level | undefined)
    constructor({ native, setSDRLevel, getSdrBase, setSdrBase, log = console.log }) {
        this.native = native
        this.setSDRLevel = setSDRLevel
        this.getSdrBase = getSdrBase
        this.setSdrBase = setSdrBase
        this.log = log
        // path -> { percent, mode } for ramps dimmed here
        this.ramps = new Map()
        // key -> { monitorId, level } for SDR levels set here
        this.sdr = new Map()
        this.timer = null
    }

    // entries: [{ key, path, monitorId, level, hdr, sdrLevel }]. Displays left out are
    // put back to normal.
    apply(entries) {
        const wantedRamps = new Map()
        const wantedSdr = new Map()
        for (const entry of entries) {
            const level = Math.max(1, Math.min(100, Math.round(entry.level ?? 100)))
            if (entry.hdr) {
                if (entry.monitorId) wantedSdr.set(entry.key, { ...entry, level })
            } else if (typeof entry.path === "string" && entry.path.length) {
                // Displays can share a ramp, so the dimmest one counts
                const existing = wantedRamps.get(entry.path)
                wantedRamps.set(entry.path, Math.min(level, existing ?? 100))
            }
        }

        for (const [path] of this.ramps) {
            if (!wantedRamps.has(path)) this.setRamp(path, 100)
        }
        for (const [path, percent] of wantedRamps) {
            // A ramp that was never dimmed here isn't touched
            const current = this.ramps.get(path)?.percent ?? 100
            if (current !== percent) this.setRamp(path, percent)
        }

        for (const [key, current] of this.sdr) {
            if (!wantedSdr.has(key) || wantedSdr.get(key).level >= 100) this.restoreSdr(key, current.monitorId)
        }
        for (const [key, entry] of wantedSdr) {
            if (entry.level < 100) this.setSdr(key, entry)
        }

        const dimming = [...this.ramps.values()].some(ramp => ramp.percent < 100)
        if (dimming && !this.timer) {
            this.timer = setInterval(() => this.check(), CHECK_MS)
        } else if (!dimming && this.timer) {
            clearInterval(this.timer)
            this.timer = null
        }
    }

    setRamp(path, percent) {
        let mode = ""
        try {
            mode = this.native.setDim(path, percent)
        } catch (e) {
            this.log(`DisplayDimmer: couldn't dim ${path}: ${e.message}`)
        }
        if (!mode) this.log(`DisplayDimmer: Windows refused dimming ${path} to ${percent}%`)
        if (percent >= 100) {
            this.ramps.delete(path)
        } else {
            this.ramps.set(path, { percent, mode })
        }
        return mode
    }

    setSdr(key, { monitorId, level, sdrLevel }) {
        // What the display was at before dimming, kept so it survives restarts
        let base = this.getSdrBase(key)
        if (base === undefined) {
            if (!(sdrLevel >= 0)) return
            base = sdrLevel
            this.setSdrBase(key, base)
        }
        const target = dimmedSdrLevel(base, level)
        if (this.sdr.get(key)?.level === target) return
        this.setSDRLevel(monitorId, target)
        this.sdr.set(key, { monitorId, level: target })
    }

    restoreSdr(key, monitorId) {
        const base = this.getSdrBase(key)
        if (base !== undefined && monitorId) this.setSDRLevel(monitorId, base)
        this.setSdrBase(key, undefined)
        this.sdr.delete(key)
    }

    // Puts dimming back on ramps that something else replaced
    check() {
        for (const [path, { percent }] of this.ramps) {
            let intact = true
            try {
                intact = this.native.dimIntact(path)
            } catch (e) { }
            if (!intact) {
                const mode = this.setRamp(path, percent)
                this.log(`DisplayDimmer: ${path} was reset, dimmed again (${mode || "refused"})`)
            }
        }
    }

    // Ramps can't be undone without the app, so they're handed back on quit. SDR
    // brightness is a Windows setting the app sets again when it starts.
    restoreRamps() {
        clearInterval(this.timer)
        this.timer = null
        for (const [path] of this.ramps) this.setRamp(path, 100)
    }

    get state() {
        return { ramps: Object.fromEntries(this.ramps), sdr: Object.fromEntries(this.sdr) }
    }
}

module.exports = { DisplayDimmer, dimmedSdrLevel, sdrLevelToNits, nitsToSdrLevel }
