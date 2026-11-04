// Keeps track of a paired network TV and takes its commands. Windows can't tell
// when a TV goes to standby, since the HDMI link stays up, so this also turns
// the TV's display off and back on along with it.

const { EventEmitter } = require("events")
const path = require("path")
const { Worker } = require("worker_threads")
const { PhilipsTV, wakeOnLan, discover } = require("./PhilipsTV")

const POLL_MS = 4000
// A TV takes a while to come up after being woken, and looks like it's in
// standby until then. Its display shouldn't be disconnected in the meantime.
const WAKE_GRACE_MS = 60000
const WAKE_RETRY_MS = 8000
const SHUTDOWN_WAIT_MS = 3000
// One extra reading is enough to ride out a dropped connection
const SAMPLES_TO_CONFIRM = 2
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
            error: null
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
            disconnectedAutomatically: !!this.config.disconnectedAutomatically,
            canWake: !!this.config.wakeMacs?.length,
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
        } catch (e) {
            console.log("NetworkTV: poll failed", e.message)
        }
        this.polling = false
        if (this.isPaired) this.pollTimer = setTimeout(() => this.poll(), POLL_MS)
    }

    async pollOnce() {
        const [apiReachable, castOpen] = await Promise.all([this.tv.isReachable(), this.tv.isOn()])
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

        if (this.tracker.state === "on") await this.readTVState()
    }

    async handlePowerChange(power) {
        console.log(`NetworkTV: TV is now ${power}`)
        this.setStatus({ power })
        if (power === "on") this.wakingUntil = 0

        const action = displayActionFor({
            power,
            autoDisconnect: !!this.config.autoDisconnect,
            castSeen: !!this.config.castSeen,
            displayActive: this.status.displayActive === true,
            disconnectedAutomatically: !!this.config.disconnectedAutomatically,
            waking: Date.now() < this.wakingUntil
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
        } catch (e) {
            console.log("NetworkTV: couldn't read displays", e.message)
        }
    }

    async readTVState() {
        try {
            const changes = {}
            if (Date.now() > this.volumeHoldUntil) {
                const volume = await this.tv.getVolume()
                if (volume) {
                    changes.volume = volume.current
                    changes.volumeMin = volume.min
                    changes.volumeMax = volume.max
                    changes.muted = volume.muted
                }
            }
            const ambilight = await this.tv.getAmbilightConfig()
            changes.ambilight = !!ambilight
            if (ambilight) this.rememberAmbilight(ambilight)
            changes.error = null
            this.setStatus(changes)
        } catch (e) {
            if (e.status === 401) this.setStatus({ error: "unauthorized" })
            console.log("NetworkTV: couldn't read TV state", e.message)
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
        const found = (await discover()).find(tv => tv.name === this.config.name)
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
        const system = await tv.getSystem()
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
        this.setConfig({ host: "", name: "", wakeMacs: [], displayPath: "", disconnectedAutomatically: false, castSeen: false, ambilightStyle: null })
        this.tracker.reset()
        this.status.power = "unknown"
        this.status.displayActive = null
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
            await tv.sendKey("Standby")
        }
    }

    // The network may not be up yet this early after logging in, so keep trying
    // until the TV answers or the grace period runs out.
    async wakeAtLogin() {
        if (!this.isPaired || !this.config.wakeOnStartup || !this.config.wakeMacs?.length) return
        if (await this.tv.isOn()) return
        console.log("NetworkTV: waking the TV for login")
        const giveUpAt = Date.now() + WAKE_GRACE_MS
        while (Date.now() < giveUpAt && !(await this.tv.isOn())) {
            await this.setPower(true)
            await new Promise(resolve => setTimeout(resolve, WAKE_RETRY_MS))
        }
    }

    // Windows ends the app shortly after telling it about a shutdown, and nothing
    // on the main thread gets to run once this handler returns. So a worker sends
    // the command while the main thread waits for it here. Only a TV that's on gets
    // the key, since it's a toggle that could wake one in standby.
    standbyBeforeExit() {
        if (!this.isPaired || !this.config.standbyOnShutdown || this.tracker.state !== "on") return false
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
        const tv = this.requireTV()
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
                await tv.setVolume(next, false)
            }
        } finally {
            this.sendingVolume = false
            this.volumeHoldUntil = Date.now() + VOLUME_HOLD_MS
        }
    }

    async toggleMute() {
        await this.requireTV().sendKey("Mute")
        const muted = !this.status.muted
        this.setStatus({ muted })
    }

    async setAmbilight(on) {
        const tv = this.requireTV()
        if (on) {
            await tv.setAmbilightConfig(this.config.ambilightStyle ?? { styleName: "FOLLOW_VIDEO", isExpert: false, menuSetting: "STANDARD" })
        } else {
            await tv.turnOffAmbilight()
        }
        this.setStatus({ ambilight: on })
    }

    async sendKey(key) {
        await this.requireTV().sendKey(key)
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

module.exports = { NetworkTV, PowerTracker, displayActionFor }
