// Keeps track of a paired network TV and takes its commands. Windows can't tell
// when a TV goes to standby, since the HDMI link stays up, so this also turns
// the TV's display off and back on along with it.

const { EventEmitter } = require("events")
const path = require("path")
const { Worker } = require("worker_threads")
const { PhilipsTV, wakeOnLan, discover } = require("./PhilipsTV")

const POLL_MS = 4000
// Volume and Ambilight cost several HTTPS connections per read, since the TV closes
// each one and every request needs a digest challenge first. Only an open panel
// needs them to be current.
const STATE_READ_MS = 45000
const WATCHED_READ_MS = 8000
// A TV takes a while to come up after being woken, and looks like it's in
// standby until then. Its display shouldn't be disconnected in the meantime.
const WAKE_GRACE_MS = 60000
const WAKE_RETRY_MS = 8000
const SHUTDOWN_WAIT_MS = 3000
// One extra reading is enough to ride out a dropped connection
const SAMPLES_TO_CONFIRM = 2
const API_FAILURES_BEFORE_DOWN = 2
const API_RETRY_MS = [15000, 30000, 60000, 120000, 300000]
const UNREACHABLE_POLLS_BEFORE_SEARCH = 8
const SEARCH_INTERVAL_MS = 5 * 60 * 1000
const VOLUME_HOLD_MS = 2000

// Turns raw readings into a settled power state. Pure, so the rules that decide
// when a display gets turned off can be tested without a TV.
class PowerTracker {
    constructor() {
        this.reset()
    }

    reset() {
        this.state = "unknown"
        this.pending = null
        this.pendingCount = 0
    }

    // Returns the new state if it changed, otherwise null
    update({ apiReachable, castOpen }) {
        const reading = (castOpen ? "on" : (apiReachable ? "standby" : "unreachable"))
        if (reading === this.state) {
            this.pending = null
            this.pendingCount = 0
            return null
        }
        if (reading !== this.pending) {
            this.pending = reading
            this.pendingCount = 0
        }
        this.pendingCount++
        if (this.pendingCount < SAMPLES_TO_CONFIRM) return null
        this.state = reading
        this.pending = null
        this.pendingCount = 0
        return reading
    }
}

// Tracks whether the TV's control API is answering, separately from whether the TV
// is on: the API can stop responding while the TV and its network stay up. Pure, so
// the backoff can be tested without a TV.
class ApiHealth {
    constructor() {
        this.reset()
    }

    reset() {
        this.state = "unknown"
        this.failures = 0
        this.retryAt = 0
    }

    canCheck(now = Date.now()) {
        return now >= this.retryAt
    }

    checkSoon() {
        this.retryAt = 0
    }

    // These return the new state if it changed, otherwise null
    recordSuccess() {
        this.failures = 0
        this.retryAt = 0
        return this.setState("ok")
    }

    recordFailure({ unauthorized = false, now = Date.now() } = {}) {
        this.failures++
        this.retryAt = now + API_RETRY_MS[Math.min(this.failures, API_RETRY_MS.length) - 1]
        if (unauthorized) return this.setState("unauthorized")
        return (this.failures >= API_FAILURES_BEFORE_DOWN ? this.setState("down") : null)
    }

    setState(state) {
        if (state === this.state) return null
        this.state = state
        return state
    }
}

// What to do with the TV's display after a settled power change. "Unreachable"
// is never acted on, since it's just as likely to be this PC losing its network.
function displayActionFor({ power, autoDisconnect, castSeen, displayActive, disconnectedAutomatically, waking = false }) {
    if (power === "standby" && !waking && autoDisconnect && castSeen && displayActive) return "disconnect"
    if (power === "on" && autoDisconnect && disconnectedAutomatically && !displayActive) return "connect"
    return null
}

class NetworkTV extends EventEmitter {
    constructor({ getConfig, setConfig, loadCredentials, saveCredentials, displays }) {
        super()
        this.getConfig = getConfig
        this.setConfig = setConfig
        this.loadCredentials = loadCredentials
        this.saveCredentials = saveCredentials
        this.displays = displays

        this.tracker = new PowerTracker()
        this.health = new ApiHealth()
        this.watched = false
        this.lastStateRead = 0
        this.lastLogged = {}
        this.pollTimer = null
        this.polling = false
        this.pairing = null
        this.unreachablePolls = 0
        this.lastSearch = 0
        this.volumeHoldUntil = 0
        this.pendingVolume = null
        this.sendingVolume = false
        this.wokeByApp = false
        this.wakingUntil = 0
        this.wakeAfterSleep = false
        this.tv = null

        this.status = {
            power: "unknown",
            volume: null,
            volumeMin: 0,
            volumeMax: 60,
            muted: null,
            ambilight: null,
            displayActive: null,
            mirrored: false,
            api: "unknown"
        }
    }

    get config() {
        return this.getConfig() || {}
    }

    get isPaired() {
        return !!(this.config.host && this.tv?.deviceId)
    }

    start() {
        const credentials = this.loadCredentials()
        if (this.config.host && credentials) {
            this.tv = new PhilipsTV(this.config.host, credentials)
        }
        this.restartPolling()
    }

    restartPolling() {
        clearTimeout(this.pollTimer)
        this.pollTimer = null
        if (this.isPaired) this.poll()
    }

    stop() {
        clearTimeout(this.pollTimer)
        this.pollTimer = null
    }

    // After the PC sleeps nothing is known about the TV, so don't act on old readings
    pause() {
        this.stop()
        this.tracker.reset()
        this.readStateSoon()
    }

    readStateSoon() {
        this.lastStateRead = 0
        this.health.checkSoon()
    }

    // Whether something on screen is showing the TV's volume and Ambilight
    setWatched(watched) {
        this.watched = watched
        if (watched && Date.now() >= this.lastStateRead + WATCHED_READ_MS) this.readStateSoon()
    }

    getState() {
        return {
            paired: this.isPaired,
            host: this.config.host ?? "",
            name: this.config.name ?? "",
            displayPath: this.config.displayPath ?? "",
            autoDisconnect: !!this.config.autoDisconnect,
            wakeOnStartup: !!this.config.wakeOnStartup,
            standbyOnShutdown: !!this.config.standbyOnShutdown,
            followSleep: this.config.followSleep !== false,
            disconnectedAutomatically: !!this.config.disconnectedAutomatically,
            canWake: !!this.config.wakeMacs?.length,
            standbyFailure: this.config.standbyFailure ?? null,
            ...this.status
        }
    }

    setStatus(changes) {
        let changed = false
        for (const key in changes) {
            if (this.status[key] !== changes[key]) {
                this.status[key] = changes[key]
                changed = true
            }
        }
        if (changed) this.emit("changed")
    }

    async poll() {
        if (this.polling) return
        this.polling = true
        try {
            await this.pollOnce()
            this.logOnChange("poll", null)
        } catch (e) {
            this.logOnChange("poll", `poll failed: ${e.message}`)
        }
        this.polling = false
        if (this.isPaired) this.pollTimer = setTimeout(() => this.poll(), POLL_MS)
    }

    // For failures that repeat on every poll. Pass null once it's working again.
    logOnChange(kind, message) {
        if (this.lastLogged[kind] === message) return
        if (message) console.log(`NetworkTV: ${message}`)
        this.lastLogged[kind] = message
    }

    async pollOnce() {
        // An open Cast port already says the TV is on. The API's port only matters
        // for telling standby from offline, so it isn't touched otherwise.
        const castOpen = await this.tv.isOn()
        const apiReachable = castOpen || await this.tv.isReachable()
        await this.readDisplay()

        if (castOpen && !this.config.castSeen) this.setConfig({ castSeen: true })

        const power = this.tracker.update({ apiReachable, castOpen })
        if (power) await this.handlePowerChange(power)

        // The TV never came up, so treat it as the standby that it is
        if (this.wakingUntil && Date.now() > this.wakingUntil) {
            this.wakingUntil = 0
            if (this.tracker.state === "standby") await this.handlePowerChange("standby")
        }

        if (apiReachable) {
            this.unreachablePolls = 0
        } else if (++this.unreachablePolls >= UNREACHABLE_POLLS_BEFORE_SEARCH) {
            this.searchForMovedTV()
        }

        if (this.tracker.state === "on" && this.isStateReadDue()) await this.readTVState()
    }

    isStateReadDue(now = Date.now()) {
        if (!this.health.canCheck(now)) return false
        if (this.health.failures) return true
        const interval = (this.watched ? WATCHED_READ_MS : STATE_READ_MS)
        return now >= this.lastStateRead + interval
    }

    async handlePowerChange(power) {
        console.log(`NetworkTV: TV is now ${power}`)
        this.setStatus({ power })
        if (power === "on") {
            this.wakingUntil = 0
            this.readStateSoon()
        }

        const action = displayActionFor({
            power,
            autoDisconnect: !!this.config.autoDisconnect,
            castSeen: !!this.config.castSeen,
            displayActive: this.status.displayActive === true,
            disconnectedAutomatically: !!this.config.disconnectedAutomatically,
            waking: this.wakeAfterSleep || Date.now() < this.wakingUntil
        })
        if (action === "disconnect") {
            await this.setDisplayConnected(false, { automatic: true })
        } else if (action === "connect") {
            await this.setDisplayConnected(true, { automatic: true })
        }

        // Waking over the network leaves Ambilight off, whatever the TV's menu says
        if (power === "on" && this.wokeByApp) {
            this.wokeByApp = false
            setTimeout(() => this.restoreAmbilight(), 3000)
        }
    }

    async readDisplay() {
        const displayPath = this.config.displayPath
        if (!displayPath) return
        try {
            const targets = await this.displays.list()
            const target = targets.find(entry => entry.devicePath === displayPath)
            this.setStatus({
                displayActive: (target ? target.active : null),
                mirrored: !!(target?.active && targets.some(entry => entry !== target && entry.active && entry.sourceId === target.sourceId))
            })
            this.logOnChange("display", null)
        } catch (e) {
            this.logOnChange("display", `couldn't read displays: ${e.message}`)
        }
    }

    // Each value is read on its own, so one failing doesn't lose the other
    async readTVState() {
        this.lastStateRead = Date.now()
        const changes = {}
        const failures = []
        let answered = false
        const read = async readValue => {
            try {
                await readValue()
                answered = true
            } catch (e) {
                failures.push(e)
            }
        }

        if (Date.now() > this.volumeHoldUntil) {
            await read(async () => {
                const volume = await this.tv.getVolume()
                if (volume) {
                    changes.volume = volume.current
                    changes.volumeMin = volume.min
                    changes.volumeMax = volume.max
                    changes.muted = volume.muted
                }
            })
        }
        await read(async () => {
            const ambilight = await this.tv.getAmbilightConfig()
            changes.ambilight = !!ambilight
            if (ambilight) this.rememberAmbilight(ambilight)
        })

        if (answered) {
            this.noteApiSuccess()
            this.logOnChange("read", failures[0] ? `couldn't read part of the TV's state: ${failures[0].message}` : null)
        } else if (failures.length) {
            this.noteApiFailure(failures.find(e => e.status === 401) ?? failures[0])
        }
        this.setStatus(changes)
    }

    noteApiSuccess() {
        if (this.health.recordSuccess()) {
            console.log("NetworkTV: control API is responding")
            this.setStatus({ api: "ok" })
        }
    }

    noteApiFailure(e) {
        const state = this.health.recordFailure({ unauthorized: e.status === 401 })
        if (!state) return
        console.log(`NetworkTV: control API is now ${state}: ${e.message}`)
        // Don't keep showing values that can no longer be read or changed
        this.setStatus({ api: state, volume: null, muted: null, ambilight: null })
    }

    // Runs a command against the API. Commands are always attempted, even during an
    // outage, since one that gets through is the quickest sign that it's over.
    async apiCommand(send) {
        const tv = this.requireTV()
        try {
            const result = await send(tv)
            const wasOk = this.health.state === "ok"
            this.noteApiSuccess()
            if (!wasOk) this.readStateSoon()
            return result
        } catch (e) {
            if (e.status === "unsupported") throw e
            this.noteApiFailure(e)
            throw new Error(e.status === 401 ? "The TV no longer accepts this app. Pair it again in Display Control settings." : `TV not responding (${e.message})`)
        }
    }

    rememberAmbilight({ styleName, isExpert, menuSetting, algorithm, colorSettings }) {
        const saved = this.config.ambilightStyle
        const style = { styleName, isExpert, menuSetting, algorithm, colorSettings }
        if (JSON.stringify(saved) !== JSON.stringify(style)) this.setConfig({ ambilightStyle: style })
    }

    async restoreAmbilight() {
        try {
            const style = this.config.ambilightStyle
            if (style && !(await this.tv.getAmbilightConfig())) await this.tv.setAmbilightConfig(style)
            await this.readTVState()
        } catch (e) {
            console.log("NetworkTV: couldn't restore Ambilight", e.message)
        }
    }

    // The TV's address can change, so look for it again by name
    async searchForMovedTV() {
        if (Date.now() < this.lastSearch + SEARCH_INTERVAL_MS) return
        this.lastSearch = Date.now()
        const found = (await discover()).find(tv => tv.name && tv.name === this.config.name)
        if (found && found.host !== this.tv?.host) {
            console.log("NetworkTV: TV moved to a new address")
            this.tv.host = found.host
            this.setConfig({ host: found.host })
            this.unreachablePolls = 0
            this.emit("changed")
        }
    }

    //
    // Pairing
    //

    discover() {
        return discover()
    }

    // Makes the TV show a PIN. Resolves with how many seconds it stays valid.
    async startPairing(host) {
        const tv = new PhilipsTV(host)
        let system
        try {
            system = await tv.getSystem()
        } catch (e) {
            if (e.status === 404) throw new Error("the TV's control API isn't responding right now.")
            throw e
        }
        const pairing = await tv.pairRequest()
        this.pairing = { tv, pairing, name: system?.name ?? "" }
        return pairing.timeout
    }

    async finishPairing(pin) {
        if (!this.pairing) throw new Error("Pairing wasn't started.")
        const { tv, pairing, name } = this.pairing
        const credentials = await tv.pairGrant(pairing, pin)
        this.pairing = null
        this.saveCredentials(credentials)
        this.tv = tv
        this.health.reset()
        this.setStatus({ api: "unknown" })

        const wakeMacs = await tv.getWakeMacs().catch(() => [])
        this.setConfig({
            host: tv.host,
            name,
            wakeMacs,
            displayPath: this.config.displayPath || await this.guessDisplay(),
            wakeOnStartup: true,
            standbyOnShutdown: true
        })
        this.tracker.reset()
        this.restartPolling()
        this.emit("changed")
    }

    // TVs connect over HDMI, and Philips' EDID manufacturer code is PHL
    async guessDisplay() {
        const targets = await this.displays.list().catch(() => [])
        const display = targets.find(entry => /#PHL/i.test(entry.devicePath)) ?? targets.find(entry => entry.outputTechnology === "hdmi")
        return display?.devicePath ?? ""
    }

    forget() {
        this.stop()
        this.tv = null
        this.pairing = null
        this.saveCredentials(null)
        this.setConfig({ host: "", name: "", wakeMacs: [], displayPath: "", disconnectedAutomatically: false, castSeen: false, ambilightStyle: null, standbyFailure: null })
        this.tracker.reset()
        this.health.reset()
        this.status.power = "unknown"
        this.status.displayActive = null
        this.status.api = "unknown"
        this.emit("changed")
    }

    //
    // Commands
    //

    requireTV() {
        if (!this.isPaired) throw new Error("No TV is paired.")
        return this.tv
    }

    async setPower(on) {
        const tv = this.requireTV()
        if (on) {
            const macs = this.config.wakeMacs ?? []
            if (!macs.length) throw new Error("The TV didn't report a network adapter with Wake-on-LAN turned on.")
            this.wokeByApp = true
            this.wakingUntil = Date.now() + WAKE_GRACE_MS
            await wakeOnLan(macs, tv.host)
        } else {
            await this.apiCommand(tv => tv.sendKey("Standby"))
            this.clearStandbyFailure()
        }
    }

    // The network may not be up yet this early after logging in or waking, so keep
    // trying until the TV answers or the grace period runs out.
    async wakeUntilOn() {
        if (!this.isPaired || !this.config.wakeMacs?.length) return
        if (await this.tv.isOn()) return
        const giveUpAt = Date.now() + WAKE_GRACE_MS
        while (Date.now() < giveUpAt && !(await this.tv.isOn())) {
            await this.setPower(true)
            await new Promise(resolve => setTimeout(resolve, WAKE_RETRY_MS))
        }
    }

    wakeAtLogin() {
        if (!this.config.wakeOnStartup) return
        console.log("NetworkTV: waking the TV for login")
        return this.wakeUntilOn()
    }

    // A TV that was already off when the PC went to sleep stays off when it wakes
    handleSuspend() {
        if (this.config.followSleep !== false && this.tracker.state === "on") {
            this.wakeAfterSleep = true
            const sent = this.sendStandbyAndWait()
            console.log("NetworkTV: TV sent to standby for sleep:", sent)
            this.recordStandbyResult(sent, "sleep")
        }
        this.pause()
    }

    // PCs also wake on their own for maintenance with the screens off, which is why
    // this waits for a screen to come on rather than following the resume event.
    handleDisplayOn() {
        if (!this.wakeAfterSleep) return
        this.wakeAfterSleep = false
        console.log("NetworkTV: waking the TV after sleep")
        return this.wakeUntilOn()
    }

    standbyBeforeExit() {
        if (!this.config.standbyOnShutdown) return false
        const wasOn = this.tracker.state === "on"
        const sent = this.sendStandbyAndWait()
        if (wasOn) this.recordStandbyResult(sent, "shutdown")
        return sent
    }

    // Kept across restarts, since a failure at shutdown can only be shown after the
    // next login. Saved right away, as the app may not get to run again before then.
    recordStandbyResult(sent, reason) {
        if (sent) return this.clearStandbyFailure()
        this.setConfig({ standbyFailure: { reason, at: Date.now() } }, { saveNow: true })
        this.emit("changed")
    }

    clearStandbyFailure() {
        if (!this.config.standbyFailure) return
        this.setConfig({ standbyFailure: null })
        this.emit("changed")
    }

    // Windows moves on shortly after announcing a shutdown or sleep, and nothing on
    // the main thread gets to run once the handler returns. So a worker sends the
    // command while the main thread waits for it here. Only a TV that's on gets the
    // key, since it's a toggle that could wake one in standby.
    sendStandbyAndWait() {
        if (!this.isPaired || this.tracker.state !== "on") return false
        const done = new Int32Array(new SharedArrayBuffer(4))
        const worker = new Worker(path.join(__dirname, "TVStandbyWorker.js"), {
            workerData: { host: this.tv.host, deviceId: this.tv.deviceId, authKey: this.tv.authKey, done }
        })
        worker.on("error", e => console.log("NetworkTV: standby worker failed", e.message))
        Atomics.wait(done, 0, 0, SHUTDOWN_WAIT_MS)
        return Atomics.load(done, 0) === 1
    }

    togglePower() {
        return this.setPower(this.tracker.state !== "on")
    }

    // Slider moves arrive faster than the TV can take them, so only the latest counts
    async setVolume(level) {
        this.requireTV()
        const volume = Math.max(this.status.volumeMin, Math.min(this.status.volumeMax, Math.round(level)))
        this.pendingVolume = volume
        this.volumeHoldUntil = Date.now() + VOLUME_HOLD_MS
        this.setStatus({ volume })
        if (this.sendingVolume) return
        this.sendingVolume = true
        try {
            while (this.pendingVolume !== null) {
                const next = this.pendingVolume
                this.pendingVolume = null
                await this.apiCommand(tv => tv.setVolume(next, false))
            }
        } finally {
            this.sendingVolume = false
            this.volumeHoldUntil = Date.now() + VOLUME_HOLD_MS
        }
    }

    async toggleMute() {
        await this.apiCommand(tv => tv.sendKey("Mute"))
        const muted = !this.status.muted
        this.setStatus({ muted })
    }

    async setAmbilight(on) {
        await this.apiCommand(tv => (on
            ? tv.setAmbilightConfig(this.config.ambilightStyle ?? { styleName: "FOLLOW_VIDEO", isExpert: false, menuSetting: "STANDARD" })
            : tv.turnOffAmbilight()))
        this.setStatus({ ambilight: on })
    }

    async sendKey(key) {
        await this.apiCommand(tv => tv.sendKey(key))
    }

    //
    // TV's display
    //

    // mode: "previous" puts it back as it was, "extend" gives it its own desktop
    async setDisplayConnected(connected, { automatic = false, mode = "previous" } = {}) {
        const devicePath = this.config.displayPath
        if (!devicePath) throw new Error("No display is selected for this TV.")

        if (!connected) {
            const targets = await this.displays.list()
            const target = targets.find(entry => entry.devicePath === devicePath)
            const mirrored = targets.find(entry => entry !== target && entry.active && entry.sourceId === target?.sourceId)
            this.setConfig({
                mirrorDevicePath: mirrored?.devicePath ?? "",
                disconnectedAutomatically: automatic
            })
        }

        const mirrorDevicePath = (mode === "previous" ? this.config.mirrorDevicePath || undefined : undefined)
        await this.displays.setActive({ devicePath, active: connected, mirrorDevicePath })

        if (connected) this.setConfig({ disconnectedAutomatically: false })
        await this.readDisplay()
        this.emit("display-changed", { connected, automatic })
    }

    // Reconnects a mirrored TV as its own screen
    async extendDisplay() {
        if (this.status.displayActive) await this.setDisplayConnected(false)
        await this.setDisplayConnected(true, { mode: "extend" })
    }
}

module.exports = { NetworkTV, PowerTracker, ApiHealth, displayActionFor }
