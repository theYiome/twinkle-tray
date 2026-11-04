// The parts of display detection that can be tested without any displays.

const NULL_HANDLE_RETRY_MS = [200, 500, 1000]

// Splits a path like "\\?\DISPLAY#ABC1234#5&123&0&UID1_0#{GUID}". Returns null for
// one that doesn't have those parts, so it can be skipped without losing the others.
function parseDisplayHwid(devicePath) {
    if (typeof devicePath !== "string") return null
    const hwid = devicePath.split("#")
    if (hwid.length < 3 || !hwid[0] || !hwid[1] || !hwid[2]) return null
    hwid[2] = hwid[2].split("_")[0]
    return (hwid[2] ? hwid : null)
}

// Windows sometimes returns a null handle for a display that's still settling, so
// reading again usually fixes it. Some displays never get one, though, and shouldn't
// slow down every scan after the first, so those are remembered until they recover.
class NullHandleRetry {
    constructor({ wait, log = console.log }) {
        this.wait = wait
        this.log = log
        this.knownNull = new Set()
    }

    async scan(readMonitors) {
        const read = () => (readMonitors() || []).filter(monitor => monitor)
        const nullKeys = monitors => monitors.filter(monitor => monitor.handleIsValid === false).map(monitor => monitor.deviceKey)
        const isNew = key => !this.knownNull.has(key)

        let monitors = read()
        for (const delay of NULL_HANDLE_RETRY_MS) {
            const waitingFor = nullKeys(monitors).filter(isNew)
            if (!waitingFor.length) break
            this.log(`DDC/CI results contain a null handle (${waitingFor.join(", ")}). Trying again in ${delay}ms.`)
            await this.wait(delay)
            const next = read()
            if (next.length) monitors = next
        }

        const stillNull = nullKeys(monitors)
        const givenUp = stillNull.filter(isNew)
        if (givenUp.length) this.log(`DDC/CI results still contain a null handle (${givenUp.join(", ")}). Continuing anyway.`)
        this.knownNull = new Set(stillNull)
        return monitors
    }
}

const DDC_RECHECK_DELAYS_MS = [3000, 10000, 30000]

// Monitors can be slow to answer right after starting up or waking, and a scan then
// loses their features or shows a made-up brightness. That can't be told apart from a
// display that really can't do better, so this only tries a few times after each wake.
class DDCRecheck {
    constructor() {
        this.everSupported = new Set()
        this.attempts = 0
    }

    // Keys of the displays that look like they were read wrong
    suspects(monitors) {
        const found = []
        for (const monitor of Object.values(monitors)) {
            if (monitor.ddcciSupported) this.everSupported.add(monitor.key)
            const lostDDC = (!monitor.ddcciSupported && (monitor.type === "ddcci" || this.everSupported.has(monitor.key)))
            if (lostDDC || (monitor.brightnessUnread && monitor.type === "ddcci")) found.push(monitor.key)
        }
        return found
    }

    // Returns how long to wait before looking again, or null if there's no need to
    review(monitors) {
        const found = this.suspects(monitors)
        if (!found.length) {
            // A first look that's still missing its features doesn't prove anything yet
            if (!Object.values(monitors).some(monitor => monitor.featuresPending)) this.attempts = 0
            return null
        }
        const delay = DDC_RECHECK_DELAYS_MS[this.attempts]
        return (delay === undefined ? null : { delay, keys: found })
    }

    attempted() {
        this.attempts++
    }

    restart() {
        this.attempts = 0
    }
}

module.exports = { parseDisplayHwid, NullHandleRetry, NULL_HANDLE_RETRY_MS, DDCRecheck, DDC_RECHECK_DELAYS_MS }
