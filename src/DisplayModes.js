// Changing a display's resolution or refresh rate can leave it without a picture, so
// like Windows itself, a new mode only stays if it's kept within a few seconds. It isn't
// saved until then, so a restart also brings back the old one. Pure, so this can be
// tested without touching a display.

const REVERT_AFTER_MS = 15000
// A display with no picture can disappear for a while, so going back has to wait for it
const REVERT_RETRY_MS = 5000
const REVERT_RETRIES = 24

class DisplayModeChanges {
    // setMode(key, mode, { save }) changes the mode, and only saves it if asked to
    constructor({ setMode, onChange = () => { }, revertAfterMs = REVERT_AFTER_MS, log = console.log }) {
        this.setMode = setMode
        this.onChange = onChange
        this.revertAfterMs = revertAfterMs
        this.log = log
        this.pending = new Map()
        this.queues = new Map()
    }

    // Mode changes on one display take turns, so none can land after one made later
    inTurn(key, step) {
        const turn = (this.queues.get(key) ?? Promise.resolve()).then(step)
        this.queues.set(key, turn.catch(() => { }))
        return turn
    }

    // Changing again before keeping still goes back to the original mode in the end
    change(key, current, mode) {
        return this.inTurn(key, async () => {
            const pending = this.pending.get(key)
            clearTimeout(pending?.timer)
            try {
                await this.setMode(key, mode, { save: false })
            } catch (e) {
                // Nothing changed, so the wait for what was already there carries on
                if (pending) this.startTimer(key, pending, pending.until - Date.now())
                throw e
            }
            const next = { previous: pending?.previous ?? current, mode, until: Date.now() + this.revertAfterMs }
            this.pending.set(key, next)
            this.startTimer(key, next, this.revertAfterMs)
            this.onChange()
        })
    }

    startTimer(key, pending, delay, retriesLeft = REVERT_RETRIES) {
        pending.timer = setTimeout(() => this.revertOnTimer(key, pending, retriesLeft), Math.max(0, delay))
    }

    async revertOnTimer(key, pending, retriesLeft) {
        try {
            await this.inTurn(key, async () => {
                if (this.pending.get(key) !== pending) return
                await this.setMode(key, pending.previous, { save: false })
                this.pending.delete(key)
                this.onChange()
            })
        } catch (e) {
            if (this.pending.get(key) !== pending) return
            if (retriesLeft > 0) {
                this.startTimer(key, pending, REVERT_RETRY_MS, retriesLeft - 1)
            } else {
                this.pending.delete(key)
                this.log("Giving up on putting the display mode back:", e.message)
                this.onChange()
            }
        }
    }

    keep(key) {
        return this.inTurn(key, async () => {
            const pending = this.pending.get(key)
            if (!pending) return false
            clearTimeout(pending.timer)
            this.pending.delete(key)
            try {
                await this.setMode(key, pending.mode, { save: true })
            } finally {
                this.onChange()
            }
            return true
        })
    }

    revert(key) {
        return this.inTurn(key, async () => {
            const pending = this.pending.get(key)
            if (!pending) return false
            clearTimeout(pending.timer)
            try {
                await this.setMode(key, pending.previous, { save: false })
            } catch (e) {
                this.startTimer(key, pending, REVERT_RETRY_MS)
                throw e
            }
            this.pending.delete(key)
            this.onChange()
            return true
        })
    }

    // When the mode goes back on its own, or null if nothing's waiting
    revertsAt(key) {
        return this.pending.get(key)?.until ?? null
    }
}

// Resolutions from largest to smallest, each with its refresh rates from fastest to slowest
function groupModes(modes) {
    const groups = new Map()
    for (const { width, height, refreshRate } of modes) {
        const id = `${width}x${height}`
        if (!groups.has(id)) groups.set(id, { id, width, height, refreshRates: new Set() })
        groups.get(id).refreshRates.add(refreshRate)
    }
    return Array.from(groups.values())
        .sort((a, b) => (b.width * b.height - a.width * a.height) || (b.width - a.width))
        .map(group => ({ ...group, refreshRates: Array.from(group.refreshRates).sort((a, b) => b - a) }))
}

// The same rate if the new resolution has it, otherwise its fastest
function refreshRateForResolution(group, currentRate) {
    return (group.refreshRates.includes(currentRate) ? currentRate : group.refreshRates[0])
}

module.exports = { DisplayModeChanges, groupModes, refreshRateForResolution, REVERT_AFTER_MS, REVERT_RETRY_MS, REVERT_RETRIES }
