// Keeps track of a paired network TV and takes its commands. Windows can't tell
// when a TV goes to standby, since the HDMI link stays up, so this also turns
// the TV's display off and back on along with it.

const { EventEmitter } = require("events")
const path = require("path")
const { Worker } = require("worker_threads")
const { PhilipsTV, wakeOnLan, discover, AMBILIGHT_STYLES, ambilightStyleId } = require("./PhilipsTV")

const POLL_MS = 4000
// While the TV is changing because of something sent from here, it's checked more
// often, so the panel and the display follow it as soon as it's done. These are
// bare connection attempts, not API requests.
const POLL_CHANGING_MS = 1500
// How long a change sent from here is waited on before going back to what's seen.
// The Cast port stays open for about 15 seconds after standby.
const TURN_OFF_WAIT_MS = 45000
// Volume and Ambilight cost an HTTPS connection each per read, since the TV closes
// every one. Only an open panel needs them to be current.
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
// The TV starts its screen saver after about 5 minutes of a still picture, and only
// a key press gets rid of it. An arrow key does, and doesn't show anything otherwise.
const SCREEN_SAVER_KEY = "CursorUp"
// Counted from the last key the TV got from here, of any kind, rather than from when
// the app started, so restarting the app or waking the PC can't leave a gap.
const SCREEN_SAVER_KEY_INTERVAL_MS = 3 * 60 * 1000
// A key doesn't stop the logo coming back after a few minutes of a still picture, it
// only clears it, and nothing the TV reports shows when it's up. So with the backup
// link, which doesn't load the API, a key goes every 5 seconds and the logo can only
// flash. Just under the check interval, so a key that took a moment still counts as due.
const SCREEN_SAVER_KEY_BACKUP_INTERVAL_MS = 4500
const SCREEN_SAVER_CHECK_MS = 5000
// Sent more than once when the screens return, since the TV may still be settling
const SCREEN_SAVER_WAKE_KEYS_MS = [0, 5000, 15000]
const SCREENS_OFF_DEFAULT_MINUTES = 5
// How often what the TV is showing is checked, while it's on and the screens are on
const INPUT_CHECK_MS = 1000
// After being told to go to standby, the TV still looks like it's on for a while
const STANDBY_SETTLE_MS = 20000
// How often the log gets a look at everything the TV is answering on
const DIAGNOSTICS_EVERY_MS = 5 * 60 * 1000

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

    // Returns the new state if it changed, otherwise null. A reading that matches what
    // was just asked of the TV doesn't need confirming.
    update({ apiReachable, castOpen, expected = null }) {
        const reading = (castOpen ? "on" : (apiReachable ? "standby" : "unreachable"))
        if (reading === this.state) {
            this.pending = null
            this.pendingCount = 0
            return null
        }
        if (reading === expected) {
            this.state = reading
            this.pending = null
            this.pendingCount = 0
            return reading
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
    // Whatever took it off the desktop, it comes back with the TV
    if (power === "on" && disconnectedAutomatically && !displayActive) return "connect"
    return null
}

class NetworkTV extends EventEmitter {
    constructor({ getConfig, setConfig, loadCredentials, saveCredentials, displays, note = () => { }, diagnosticsPath = null }) {
        super()
        this.note = note
        this.diagnosticsPath = diagnosticsPath
        this.diagnosticsTimer = null
        this.inputTimer = null
        this.checkingInput = false
        this.screensOn = true
        this.screenSaverTimer = null
        this.screenSaverWakeTimers = []
        this.screensOffTimer = null
        this.wakeRetryTimer = null
        this.standbySentAt = 0
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
            ambilightStyle: null,
            displayActive: null,
            mirrored: false,
            // "pc" on an HDMI input (the PC, as there's nothing else), "tv" on the TV's
            // own home screen and apps, or null while it isn't known
            showing: null,
            // "on" or "off" while a change sent from here is under way
            changing: null,
            api: "unknown"
        }
    }

    get config() {
        return this.getConfig() || {}
    }

    get isPaired() {
        return !!(this.config.host && this.tv?.deviceId)
    }

    // On unless turned off: the TV's display leaves the desktop while the TV shows its
    // own screens, and comes back when it returns to the PC
    get followInput() {
        return this.config.followInput !== false
    }

    // On unless turned off, so a TV in standby doesn't leave windows stuck on it
    get autoDisconnect() {
        return this.config.autoDisconnect !== false
    }

    // 0 turns it off
    get screensOffMinutes() {
        return this.config.screensOffStandbyMinutes ?? SCREENS_OFF_DEFAULT_MINUTES
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
        clearInterval(this.screenSaverTimer)
        this.screenSaverTimer = setInterval(() => this.sendScreenSaverKeyIfDue(), SCREEN_SAVER_CHECK_MS)
        clearInterval(this.diagnosticsTimer)
        this.diagnosticsTimer = setInterval(() => this.logSnapshot("timer"), DIAGNOSTICS_EVERY_MS)
        clearInterval(this.inputTimer)
        this.inputTimer = setInterval(() => this.checkInput(), INPUT_CHECK_MS)
        if (this.isPaired) this.poll()
    }

    stop() {
        clearTimeout(this.pollTimer)
        this.pollTimer = null
        clearInterval(this.screenSaverTimer)
        this.screenSaverTimer = null
        this.cancelScreenSaverWakeKeys()
        clearTimeout(this.screensOffTimer)
        this.screensOffTimer = null
        clearTimeout(this.wakeRetryTimer)
        this.wakeRetryTimer = null
        clearInterval(this.diagnosticsTimer)
        this.diagnosticsTimer = null
        clearInterval(this.inputTimer)
        this.inputTimer = null
        this.tv?.closeBackup?.()
    }

    // A connection is only opened on the backup link if it's paired or the API is in
    // trouble, so the log can show whether it's still alive in a real outage.
    async logSnapshot(reason) {
        if (!this.isPaired) return
        const apiDown = this.apiDown
        try {
            const snapshot = await this.tv.diagnosticsSnapshot?.({ apiDown, includeBackup: apiDown || !!this.tv.hasBackup })
            if (snapshot) this.note("snapshot", { reason, power: this.tracker.state, api: this.health.state, screensOn: this.screensOn, ...snapshot })
        } catch (e) {
            this.note("snapshot.failed", { reason, error: e.message })
        }
    }

    get apiDown() {
        return this.health.state === "down" || this.health.state === "unauthorized"
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
            autoDisconnect: this.autoDisconnect,
            wakeOnStartup: !!this.config.wakeOnStartup,
            standbyOnShutdown: !!this.config.standbyOnShutdown,
            followSleep: this.config.followSleep !== false,
            keepScreenSaverAway: this.config.keepScreenSaverAway !== false,
            followInput: this.followInput,
            screensOffStandbyMinutes: this.screensOffMinutes,
            ambilightStyles: AMBILIGHT_STYLES.map(({ id, group, name }) => ({ id, group, name })),
            backupPaired: !!this.tv?.hasBackup,
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
        if (this.isPaired) this.pollTimer = setTimeout(() => this.poll(), (this.status.changing ? POLL_CHANGING_MS : POLL_MS))
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

        this.expireChange()
        const expected = { on: "on", off: "standby" }[this.status.changing] ?? null
        const power = this.tracker.update({ apiReachable, castOpen, expected })
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

    // Windows reports one state for all of its displays, which is all there is to go by
    setScreensOn(on) {
        const returned = (on && !this.screensOn)
        const left = (!on && this.screensOn)
        this.screensOn = on
        if (returned || left) this.note("screens", { on, power: this.tracker.state })
        if (returned) {
            this.sendScreenSaverWakeKeys()
        } else if (!on) {
            this.cancelScreenSaverWakeKeys()
        }
        if (on) {
            clearTimeout(this.screensOffTimer)
            this.screensOffTimer = null
        } else if (left) {
            this.startScreensOffTimer()
        }
    }

    startScreensOffTimer() {
        clearTimeout(this.screensOffTimer)
        this.screensOffTimer = null
        const minutes = this.screensOffMinutes
        if (minutes > 0 && !this.screensOn) {
            this.screensOffTimer = setTimeout(() => this.checkScreensOffStandby(), minutes * 60 * 1000)
        }
    }

    // A TV that's already off, or was turned on again by hand, is left alone. So is one
    // showing its own apps, though that's looked at again later in case they get closed.
    async checkScreensOffStandby() {
        this.screensOffTimer = null
        if (!this.isPaired || this.screensOn || this.tracker.state !== "on" || this.wakeAfterSleep) return
        // There'd be no way to bring it back when the screens return
        if (!this.config.wakeMacs?.length) return
        if (this.status.displayActive === false) return

        let showingPC = false
        try {
            showingPC = await this.tv.isShowingExternalInput()
        } catch (e) {
            this.logOnChange("screensOff", `couldn't check what the TV is showing: ${e.message}`)
        }
        this.note("screensOff.check", { showingPC })
        if (this.screensOn) return
        if (!showingPC || Date.now() < this.wakingUntil) return this.startScreensOffTimer()
        if (!(await this.tv.isOn()) || this.screensOn) return

        this.wakeAfterSleep = true
        try {
            await this.apiCommand((tv, options) => tv.standby(options))
            this.standbySentAt = Date.now()
            this.clearStandbyFailure()
            console.log("NetworkTV: TV sent to standby since the screens are off")
        } catch (e) {
            console.log("NetworkTV: couldn't send the TV to standby:", e.message)
            this.note("screensOff.failed", { error: e.message, mayHaveLanded: !!e.mayHaveLanded })
            // Sending it again could wake it, and it still has to come back with the screens
            if (e.mayHaveLanded) {
                this.standbySentAt = Date.now()
                return
            }
            this.wakeAfterSleep = false
            this.startScreensOffTimer()
        }
    }

    // Why the screen saver key isn't being sent, or null when it should be
    screenSaverSkipReason() {
        if (!this.isPaired) return "not paired"
        if (this.config.keepScreenSaverAway === false) return "turned off"
        if (!this.screensOn) return "screens off"
        if (this.tracker.state !== "on") return `tv ${this.tracker.state}`
        // It shouldn't get keys while it's still coming up
        if (this.wakeAfterSleep) return "waiting for the screens to wake it"
        if (Date.now() < this.wakingUntil) return "tv waking"
        if (this.apiDown && !this.tv.hasBackup) return "api down"
        // Nothing from this PC is on it, so it's being used for something else
        if (this.status.displayActive === false) return "display disconnected"
        // An arrow key would move around the TV's own home screen and apps
        if (this.status.showing === "tv") return "tv showing its own screens"
        // Not known yet, so wait a little for the first check rather than risk it
        if (this.status.showing === null && this.onSince && Date.now() - this.onSince < 10000) return "checking what the tv shows"
        if (this.tv?.backupChannelState === "launcher") return "tv home screen"
        return null
    }

    // Asked every second. Only while the TV is on, the screens are on and the API is
    // answering, since it's one request each time and the API has locked up before.
    async checkInput() {
        if (this.checkingInput) return
        if (!this.isPaired || this.tracker.state !== "on" || !this.screensOn || this.apiDown || this.wakeAfterSleep) {
            if (this.tracker.state !== "on" && this.status.showing !== null) this.setShowing(null)
            return
        }
        this.checkingInput = true
        try {
            this.tv.keepBackupConnected?.()
            // The API keeps saying HDMI while the home screen is opened over it, and only
            // the backup link notices that. The backup link says nothing about apps, which
            // the API does notice. So it's the TV's own screens if either says so.
            const showing = await this.tv.getShowing()
            const homeScreen = (this.tv.backupChannelState === "launcher")
            if (showing === "own" || homeScreen) {
                await this.setShowing("tv")
            } else if (showing === "external") {
                await this.setShowing("pc")
            }
        } catch (e) {
            // The regular poll looks after the API's health
            this.logOnChange("input", `couldn't check what the TV is showing: ${e.message}`)
        } finally {
            this.checkingInput = false
        }
    }

    async setShowing(showing) {
        const previous = this.status.showing
        if (showing === previous) return
        this.setStatus({ showing })
        this.logOnChange("input", null)
        this.note("showing", { showing, previous })
        if (showing === null || !this.followInput) return
        if (showing === "tv") {
            await this.detachForOwnScreens()
        } else if (this.config.disconnectedForInput) {
            // Also after a restart or standby in between
            await this.reattachForPC()
        }
    }

    // Leaving the PC for the TV's own screens takes its display off the desktop, so
    // windows move to the other screens. Marked, so only this brings it back.
    async detachForOwnScreens() {
        const devicePath = this.config.displayPath
        if (!devicePath) return
        try {
            const targets = await this.displays.list()
            const target = targets.find(entry => entry.devicePath === devicePath)
            if (!target?.active || !targets.some(entry => entry !== target && entry.active)) return
            await this.setDisplayConnected(false, { automatic: true })
            this.setConfig({ disconnectedForInput: true })
            this.note("display", { connected: false, reason: "tv showing its own screens" })
        } catch (e) {
            this.note("display.failed", { connected: false, error: e.message })
        }
    }

    async reattachForPC() {
        this.setConfig({ disconnectedForInput: false })
        if (!this.config.disconnectedAutomatically || this.status.displayActive !== false) return
        try {
            await this.setDisplayConnected(true, { automatic: true })
            this.note("display", { connected: true, reason: "tv back on the pc" })
        } catch (e) {
            this.note("display.failed", { connected: true, error: e.message })
        }
    }

    shouldSendScreenSaverKey() {
        return !this.screenSaverSkipReason()
    }

    async sendScreenSaverKey() {
        // Logged when it changes, so the log shows any stretch without keys and why
        const skipped = this.screenSaverSkipReason()
        if (skipped !== (this.lastScreenSaverSkip ?? null)) {
            this.note("saver", skipped ? { skipped } : { sending: true })
            this.lastScreenSaverSkip = skipped
        }
        if (skipped) return
        try {
            const { via } = await this.sendKey(SCREEN_SAVER_KEY, { preferBackup: true }) ?? {}
            if (via !== this.lastScreenSaverVia) {
                this.note("saver.via", { via })
                this.lastScreenSaverVia = via
            }
            // Every minute over the backup would bury everything else in the session log
            if (via !== "backup") console.log("NetworkTV: sent the screen saver key")
        } catch (e) {
            console.log("NetworkTV: couldn't send the screen saver key:", e.message)
            this.note("saver.failed", { error: e.message })
        }
    }

    // Nothing is known about keys from before the app started, so the first one goes
    // out as soon as the TV is seen on
    async sendScreenSaverKeyIfDue() {
        // One that's still on its way counts too
        const interval = (this.tv?.hasBackup ? SCREEN_SAVER_KEY_BACKUP_INTERVAL_MS : SCREEN_SAVER_KEY_INTERVAL_MS)
        if (this.sendingScreenSaverKey || Date.now() - (this.lastKeyAt ?? 0) < interval) return
        this.sendingScreenSaverKey = true
        try {
            await this.sendScreenSaverKey()
        } finally {
            this.sendingScreenSaverKey = false
        }
    }

    sendScreenSaverWakeKeys() {
        this.cancelScreenSaverWakeKeys()
        this.screenSaverWakeTimers = SCREEN_SAVER_WAKE_KEYS_MS.map(delay => setTimeout(() => this.sendScreenSaverKey(), delay))
    }

    cancelScreenSaverWakeKeys() {
        this.screenSaverWakeTimers.forEach(timer => clearTimeout(timer))
        this.screenSaverWakeTimers = []
    }

    isStateReadDue(now = Date.now()) {
        if (!this.health.canCheck(now)) return false
        if (this.health.failures) return true
        const interval = (this.watched ? WATCHED_READ_MS : STATE_READ_MS)
        return now >= this.lastStateRead + interval
    }

    // Shown in the panel right away, since the TV takes a while to look any different
    startChange(change) {
        this.changeUntil = Date.now() + (change === "on" ? WAKE_GRACE_MS : TURN_OFF_WAIT_MS)
        this.changeStartedAt = Date.now()
        this.setStatus({ changing: change })
        // Checked sooner than the next regular poll
        if (this.isPaired && !this.polling) {
            clearTimeout(this.pollTimer)
            this.pollTimer = setTimeout(() => this.poll(), POLL_CHANGING_MS)
        }
    }

    expireChange() {
        if (this.status.changing && Date.now() > this.changeUntil) {
            this.note("power.change.timeout", { changing: this.status.changing, power: this.tracker.state })
            this.wakeWhenOff = false
            this.setStatus({ changing: null })
        }
    }

    async handlePowerChange(power) {
        console.log(`NetworkTV: TV is now ${power}`)
        const finished = { on: "on", off: "standby" }[this.status.changing] === power
        this.note("power", { power, ...(finished ? { afterMs: Date.now() - this.changeStartedAt } : {}) })
        this.setStatus({ power, ...(finished ? { changing: null } : {}) })
        // Turned on again while it was still going off
        if (power === "standby" && this.wakeWhenOff) {
            this.wakeWhenOff = false
            this.setPower(true).catch(e => console.log("NetworkTV: couldn't wake the TV:", e.message))
        }
        if (power === "on") {
            this.onSince = Date.now()
            this.wakingUntil = 0
            this.readStateSoon()
        }

        let action = displayActionFor({
            power,
            autoDisconnect: this.autoDisconnect,
            castSeen: !!this.config.castSeen,
            displayActive: this.status.displayActive === true,
            disconnectedAutomatically: !!this.config.disconnectedAutomatically,
            waking: this.wakeAfterSleep || Date.now() < this.wakingUntil
        })
        // Detached for the TV's own screens: following the input brings it back, once
        // it's known the TV is on the PC again
        if (action === "connect" && this.config.disconnectedForInput && this.followInput) action = null
        if (action) this.note("display", { connected: action === "connect", reason: `tv ${power}` })
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
            changes.ambilightStyle = ambilightStyleId(ambilight)
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
        const wasDown = this.apiDown
        if (this.health.recordSuccess()) {
            console.log("NetworkTV: control API is responding")
            this.note("api.state", { state: "ok" })
            this.setStatus({ api: "ok" })
            if (wasDown) this.logSnapshot("api recovered")
        }
    }

    noteApiFailure(e) {
        const state = this.health.recordFailure({ unauthorized: e.status === 401 })
        if (!state) return
        console.log(`NetworkTV: control API is now ${state}: ${e.message}`)
        this.note("api.state", { state, error: e.message, failures: this.health.failures })
        this.logSnapshot("api down")
        // Don't keep showing values that can no longer be read or changed
        this.setStatus({ api: state, volume: null, muted: null, ambilight: null, ambilightStyle: null })
    }

    // Runs a command against the API. Commands are always attempted, even during an
    // outage, since one that gets through is the quickest sign that it's over.
    async apiCommand(send) {
        const tv = this.requireTV()
        try {
            const result = await send(tv, { apiDown: this.apiDown })
            // It tells nothing about the API, unless it's the API that just refused it
            if (result?.via === "backup") {
                // Screen saver keys go this way by choice every minute, which isn't news
                if (result.apiError || this.apiDown) console.log("NetworkTV: sent over the backup link")
                if (result.apiError) this.noteApiFailure(result.apiError)
                return result
            }
            const wasOk = this.health.state === "ok"
            this.noteApiSuccess()
            if (!wasOk) this.readStateSoon()
            return result
        } catch (e) {
            if (e.status === "unsupported") throw e
            this.note("command.failed", { error: e.message, api: this.health.state, mayHaveLanded: !!e.mayHaveLanded })
            // The backup link failing says nothing about the API
            if (e.name !== "TitanMqttError") this.noteApiFailure(e)
            throw Object.assign(
                new Error(e.status === 401 ? "The TV no longer accepts this app. Pair it again in Display Control settings." : `TV not responding (${e.message})`),
                { mayHaveLanded: e.mayHaveLanded }
            )
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
        // Pairing with the API again has nothing to do with the backup link
        const backup = (this.tv?.host === tv.host ? this.tv?.backupCredentials : null)
        this.tv?.closeBackup?.()
        tv.setBackupCredentials(backup)
        this.saveCredentials({ ...credentials, ...(backup ? { backup } : {}) })
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

    // Makes the TV show a PIN. Resolves with how many seconds it stays valid.
    async startBackupPairing() {
        this.note("backup.pairingStart")
        return this.requireTV().startBackupPairing()
    }

    async finishBackupPairing(pin) {
        const tv = this.requireTV()
        await tv.finishBackupPairing(pin)
        this.saveCredentials({ deviceId: tv.deviceId, authKey: tv.authKey, backup: tv.backupCredentials })
        this.note("backup.paired")
        this.emit("changed")
        // Records the TV's model and firmware, and what it says it can do
        this.testBackup().catch(e => this.note("backup.testFailed", { error: e.message }))
    }

    testBackup() {
        const tv = this.requireTV()
        if (!tv.hasBackup) throw new Error("The backup link isn't paired.")
        return tv.testBackup()
    }

    removeBackup() {
        const tv = this.requireTV()
        tv.setBackupCredentials(null)
        this.saveCredentials({ deviceId: tv.deviceId, authKey: tv.authKey })
        this.note("backup.removed")
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
            if (!this.status.changing) this.startChange("on")
            this.note("power.send", { on: true })
            await wakeOnLan(macs, tv.host)
        } else {
            this.startChange("off")
            this.note("power.send", { on: false })
            try {
                await this.apiCommand((tv, options) => tv.standby(options))
            } catch (e) {
                if (!e.mayHaveLanded) this.setStatus({ changing: null })
                throw e
            }
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
        this.note("pc.suspend", { power: this.tracker.state, api: this.health.state })
        // It may still look like it's on after being sent to standby for the screens
        if (this.config.followSleep !== false && this.tracker.state === "on" && !this.wakeAfterSleep) {
            this.wakeAfterSleep = true
            const sent = this.sendStandbyAndWait()
            console.log("NetworkTV: TV sent to standby for sleep:", sent)
            this.recordStandbyResult(sent, "sleep")
        }
        // Counts as the screens going off, in case Windows doesn't report that first
        this.screensOn = false
        this.pause()
    }

    // PCs also wake on their own for maintenance with the screens off, which is why
    // this waits for a screen to come on rather than following the resume event.
    handleDisplayOn() {
        if (!this.wakeAfterSleep) return
        // A TV on its way to standby still looks on, so a wake now would do nothing
        const settling = this.standbySentAt + STANDBY_SETTLE_MS - Date.now()
        if (settling > 0) {
            clearTimeout(this.wakeRetryTimer)
            this.wakeRetryTimer = setTimeout(() => {
                if (this.screensOn) this.handleDisplayOn()
            }, settling)
            return
        }
        this.wakeAfterSleep = false
        console.log("NetworkTV: waking the TV after sleep")
        this.note("tv.wake", { reason: "screens returned" })
        return this.wakeUntilOn()
    }

    standbyBeforeExit() {
        // It may still look like it's on after being sent to standby for the screens
        if (!this.config.standbyOnShutdown || this.wakeAfterSleep) return false
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
            workerData: { host: this.tv.host, deviceId: this.tv.deviceId, authKey: this.tv.authKey, backup: this.tv.backupCredentials, apiDown: this.apiDown, diagnosticsPath: this.diagnosticsPath, done }
        })
        worker.on("error", e => console.log("NetworkTV: standby worker failed", e.message))
        Atomics.wait(done, 0, 0, SHUTDOWN_WAIT_MS)
        return Atomics.load(done, 0) === 1
    }

    // Goes by what was last asked for, since the TV takes a while to show it. Sending
    // standby twice would turn it back on, as it's the same key.
    get isOnOrTurningOn() {
        if (this.status.changing) return this.status.changing === "on"
        return this.tracker.state === "on"
    }

    togglePower() {
        return this.setPowerWithDisplay(!this.isOnOrTurningOn)
    }

    // Turning the TV off from here also takes it off the desktop, so windows and the
    // mouse can't end up on a dark screen. It comes back once the TV is seen on.
    async setPowerWithDisplay(on) {
        if (on) {
            if (this.status.changing === "on") return
            // A wake doesn't do anything until it's finished going off
            if (this.status.changing === "off") {
                this.wakeWhenOff = true
                this.startChange("on")
                return
            }
            return this.setPower(true)
        }
        this.wakeWhenOff = false
        if (this.status.changing === "off") return
        let standbyError = null
        try {
            await this.setPower(false)
        } catch (e) {
            // A key that may have landed most likely turned it off
            if (!e.mayHaveLanded) throw e
            standbyError = e
        }
        await this.detachForStandby()
        if (standbyError) console.log("NetworkTV: standby may not have reached the TV:", standbyError.message)
    }

    async detachForStandby() {
        const devicePath = this.config.displayPath
        if (!devicePath) return
        try {
            const targets = await this.displays.list()
            const target = targets.find(entry => entry.devicePath === devicePath)
            if (!target?.active) return
            // Never take away the last screen
            if (!targets.some(entry => entry !== target && entry.active)) return
            await this.setDisplayConnected(false, { automatic: true })
            this.note("display", { connected: false, reason: "turned off" })
        } catch (e) {
            console.log("NetworkTV: couldn't disconnect the TV's display:", e.message)
            this.note("display.failed", { connected: false, error: e.message })
        }
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
        await this.apiCommand((tv, options) => tv.sendKey("Mute", options))
        this.lastKeyAt = Date.now()
        // During an outage it can't be read, so it isn't guessed at
        if (this.status.muted !== null) this.setStatus({ muted: !this.status.muted })
    }

    async setAmbilight(on) {
        await this.apiCommand(tv => (on
            ? tv.setAmbilightConfig(this.config.ambilightStyle ?? { styleName: "FOLLOW_VIDEO", isExpert: false, menuSetting: "STANDARD" })
            : tv.turnOffAmbilight()))
        this.setStatus({ ambilight: on })
        // Reading it back also saves the style, for the next time it's turned on
        this.readStateSoon()
    }

    async setAmbilightStyle(id) {
        await this.apiCommand(tv => tv.setAmbilightStyle(id))
        this.setStatus({ ambilight: true, ambilightStyle: id })
        this.readStateSoon()
    }

    async pressButton(button) {
        await this.apiCommand((tv, options) => tv.pressButton(button, options))
        this.lastKeyAt = Date.now()
    }

    async sendKey(key, { preferBackup = false } = {}) {
        const result = await this.apiCommand((tv, options) => tv.sendKey(key, { ...options, preferBackup }))
        // Any key keeps the screen saver away, so the next screen saver key can wait
        this.lastKeyAt = Date.now()
        return result
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
