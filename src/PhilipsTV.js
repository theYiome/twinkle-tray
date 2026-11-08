// Client for the JointSpace API on Philips TVs (v6, as used by Titan OS).
//
// The API is undocumented, so what's here was measured on a 48OLED770 (API 6.1.0),
// with the protocol details coming from ha-philips-titanos (Apache-2.0):
// https://github.com/ksooo/ha-philips-titanos
//
// - It stays reachable in standby, and "powerstate" and "screenstate" don't reflect
//   reality. The Cast receiver only runs while the TV is on, so its port is what
//   tells on from standby.
// - The TV picks up "audio/volume" on HDMI, but inputs and apps can't be selected.

const crypto = require("crypto")
const dgram = require("dgram")
const http = require("http")
const https = require("https")
const net = require("net")
const os = require("os")
const { TitanMqttClient, KEY_CODES, PAIRING_LINGER_MS } = require("./TitanMqtt")

const API_PORT = 1926
const CAST_PORT = 8009
const CAST_INFO_PORT = 8008
const REQUEST_TIMEOUT = 8000
// The TV's API server is reported to lock up under bursts of requests, until it's
// unplugged. It closes every connection, so spacing requests out is what's left.
// That's for the app's own reads. Commands someone is waiting on, like a remote button,
// only get a short gap, since 700 ms per press made the remote feel slow.
const MIN_REQUEST_GAP_MS = 700
const COMMAND_GAP_MS = 100
const BACKUP_LINGER_MS = 150 * 1000

// Philips' app secret for signing pairing grants. It's the same for every client.
const PAIRING_KEY = Buffer.from("ZmVay1EQVFOaZhwQ4Kv81ypLAZNczV9sG4KkseXWn1NEk6cXmPKO/MCa9sryslvLCFMnNe4Z4CPXzToowvhHvA==", "base64")

const REMOTE_KEYS = {
    up: "CursorUp",
    down: "CursorDown",
    left: "CursorLeft",
    right: "CursorRight",
    ok: "Confirm",
    back: "Back",
    home: "Home",
    volumeUp: "VolumeUp",
    volumeDown: "VolumeDown"
}

// Pressing these twice undoes them, so they're never sent again if the first may have landed
const TOGGLE_KEYS = new Set(["Standby", "Mute"])

// Whether a key sent over the API could have reached the TV despite this error. An answer
// of any kind means it was refused, but one that never came says nothing.
function couldHaveLanded(error) {
    if (typeof error?.status === "number" || typeof error?.code === "number") return false
    return !["ECONNREFUSED", "connectTimeout", "certificate"].includes(error?.code)
}

function canResendKey(key, error) {
    return !TOGGLE_KEYS.has(key) || !couldHaveLanded(error)
}

// Records what's sent to the TV, for working out what happened around an outage later
let diagnostics = () => { }
function setTVDiagnostics(write) {
    diagnostics = write
}

// Each of these was set on a 48OLED770 and read back. The names are the TV's own.
const AMBILIGHT_STYLES = [
    ...[["STANDARD", "Standard"], ["NATURAL", "Natural"], ["VIVID", "Vivid"], ["GAME", "Game"], ["COMFORT", "Comfort"], ["RELAX", "Relax"], ["SPORTS", "Sports"]]
        .map(([setting, name]) => ({ id: `FOLLOW_VIDEO:${setting}`, group: "video", name, styleName: "FOLLOW_VIDEO", setting })),
    ...[["ENERGY_ADAPTIVE_BRIGHTNESS", "Lumina"], ["ENERGY_ADAPTIVE_COLORS", "Colora"], ["VU_METER", "Retro"], ["SPECTRUM_ANALYZER", "Spectrum"], ["PARTY", "Party"]]
        .map(([setting, name]) => ({ id: `FOLLOW_AUDIO:${setting}`, group: "audio", name, styleName: "FOLLOW_AUDIO", setting })),
    ...[["HOT_LAVA", "Hot Lava"], ["DEEP_WATER", "Deep Water"], ["FRESH_NATURE", "Fresh Nature"], ["ISF", "Warm White"], ["PTA_LOUNGE", "Cool White"]]
        .map(([setting, name]) => ({ id: `FOLLOW_COLOR:${setting}`, group: "color", name, styleName: "FOLLOW_COLOR", setting }))
]

// The TV reports the current style as a menu setting whichever way it was set, but
// only takes most of the audio ones as an algorithm.
function ambilightStyleConfig({ styleName, setting }) {
    return { styleName, isExpert: false, ...(styleName === "FOLLOW_AUDIO" ? { algorithm: setting } : { menuSetting: setting }) }
}

function ambilightStyleId(config) {
    const id = `${config?.styleName}:${config?.menuSetting ?? config?.algorithm}`
    return (AMBILIGHT_STYLES.some(style => style.id === id) ? id : null)
}

// The TV uses a self-signed certificate that doesn't name it
const agent = new https.Agent({ rejectUnauthorized: false })

const md5 = value => crypto.createHash("md5").update(value).digest("hex")

class TVError extends Error {
    constructor(message, status) {
        super(message)
        this.name = "TVError"
        this.status = status
    }
}

function rawRequest(host, method, path, body, headers = {}, timeout = REQUEST_TIMEOUT) {
    return new Promise((resolve, reject) => {
        const data = (body === undefined ? undefined : JSON.stringify(body))
        const startedAt = Date.now()
        const signed = !!headers.Authorization
        const req = https.request({
            host,
            port: API_PORT,
            method,
            path,
            agent,
            timeout,
            headers: {
                ...headers,
                ...(data === undefined ? {} : { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) })
            }
        }, res => {
            let text = ""
            res.setEncoding("utf8")
            res.on("data", chunk => text += chunk)
            res.on("end", () => {
                // What the TV is showing is asked every second, which would push everything
                // else out of the log. Its changes are logged where they're noticed.
                if (!(path === "/6/context" && res.statusCode === 200)) {
                    diagnostics("api", { method, path, status: res.statusCode, ms: Date.now() - startedAt, signed })
                }
                resolve({ status: res.statusCode, headers: res.headers, text })
            })
        })
        req.on("timeout", () => req.destroy(new TVError(`${method} ${path} timed out`)))
        req.on("error", e => {
            diagnostics("api", { method, path, error: e.code ?? e.message, ms: Date.now() - startedAt, signed })
            reject(e)
        })
        req.end(data)
    })
}

// Everything sent to a TV goes through here, one call at a time
const requestQueues = new Map()
function runInTurn(host, call, gap = MIN_REQUEST_GAP_MS) {
    if (!requestQueues.has(host)) requestQueues.set(host, { last: Promise.resolve(), doneAt: 0 })
    const queue = requestQueues.get(host)
    const turn = queue.last.then(async () => {
        const wait = queue.doneAt + gap - Date.now()
        if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait))
        try {
            return await call()
        } finally {
            queue.doneAt = Date.now()
        }
    })
    queue.last = turn.catch(() => { })
    return turn
}

function digestHeader(method, path, username, password, challenge, count = 1) {
    const fields = {}
    for (const [, key, quoted, plain] of challenge.matchAll(/(\w+)=(?:"([^"]*)"|([^,\s]+))/g)) {
        fields[key] = quoted ?? plain
    }
    const qop = (fields.qop || "auth").split(",")[0].trim()
    const cnonce = crypto.randomBytes(8).toString("hex")
    const nc = count.toString(16).padStart(8, "0")
    const response = md5(`${md5(`${username}:${fields.realm}:${password}`)}:${fields.nonce}:${nc}:${cnonce}:${qop}:${md5(`${method}:${path}`)}`)
    return `Digest username="${username}", realm="${fields.realm}", nonce="${fields.nonce}", uri="${path}", response="${response}", algorithm=MD5, qop=${qop}, nc=${nc}, cnonce="${cnonce}"`
        + (fields.opaque ? `, opaque="${fields.opaque}"` : "")
}

function parseBody(text) {
    const trimmed = text.trim()
    // Setters answer with an empty body, "Ok" or a small HTML page
    if (trimmed[0] !== "{" && trimmed[0] !== "[") return null
    try {
        return JSON.parse(trimmed)
    } catch (e) {
        return null
    }
}

function isPortOpen(host, port, timeout = 2000) {
    return new Promise(resolve => {
        const socket = net.connect({ host, port })
        const done = result => {
            socket.destroy()
            resolve(result)
        }
        socket.setTimeout(timeout, () => done(false))
        socket.once("connect", () => done(true))
        socket.once("error", () => done(false))
    })
}

function pairingDevice(deviceId) {
    return {
        device_name: "Twinkle Tray",
        device_os: "Windows",
        app_name: "Twinkle Tray",
        app_id: "twinkletray",
        type: "native",
        id: deviceId
    }
}

class PhilipsTV {
    constructor(host, credentials = {}) {
        this.host = host
        this.deviceId = credentials.deviceId
        this.authKey = credentials.authKey
        this.digest = null
        this.backup = null
        this.backupPairing = null
        this.backupOptions = credentials.backupOptions ?? {}
        this.setBackupCredentials(credentials.backup)
    }

    get hasBackup() {
        return !!this.backup
    }

    // "launcher" while the TV's home screen is up, as the backup link last reported it
    get backupChannelState() {
        const text = this.backup?.lastWatched?.get("channels/state")
        try {
            return (text ? JSON.parse(text).state : null)
        } catch (e) {
            return null
        }
    }

    setBackupCredentials(credentials) {
        this.closeBackup()
        this.backupCredentials = credentials ?? null
        // Kept open between the screen saver keys, which come every minute, and it
        // records what the TV reports about itself, to see if it can tell when it's on
        this.backup = (credentials ? this.backupClient(credentials, { lingerMs: BACKUP_LINGER_MS, watchTopics: ["state/power", "state", "channels/state"], ...this.backupOptions }) : null)
    }

    backupClient(credentials, options = {}) {
        return new TitanMqttClient({ getHost: () => this.host, credentials, log: diagnostics, ...this.backupOptions, ...options })
    }

    closeBackup() {
        this.backup?.close()
        this.backupPairing?.close()
        this.backupPairing = null
    }

    // Makes the TV show a PIN, and resolves with how many seconds it stays valid
    async startBackupPairing() {
        this.backupPairing?.close()
        this.backupPairing = this.backupClient(null, { lingerMs: PAIRING_LINGER_MS })
        return (await this.backupPairing.startPairing()).timeout
    }

    // A wrong PIN can be tried again for as long as the TV allows
    async finishBackupPairing(pin) {
        if (!this.backupPairing) throw new TVError("Pairing wasn't started.")
        const credentials = await this.backupPairing.finishPairing(pin)
        this.backupPairing.close()
        this.backupPairing = null
        this.setBackupCredentials(credentials)
        return credentials
    }

    // Moves the focus up on the TV if something's on screen that has one, as a visible test
    async testBackup() {
        const startedAt = Date.now()
        await this.backup.sendKeyCode(KEY_CODES.CursorUp)
        const ms = Date.now() - startedAt
        const info = await this.backup.readInfo().catch(e => ({ infoError: e.message }))
        diagnostics("mqtt.tested", { ms, ...info })
        return { ms }
    }

    // What everything answers right now, for the log. It sends nothing the TV acts on.
    async diagnosticsSnapshot({ apiDown = false, includeBackup = false } = {}) {
        const snapshot = { cast: await this.isOn(), apiPort: await this.isReachable(), uptime: await getCastUptime(this.host) }
        if (apiDown) {
            snapshot.system = await this.getSystem().then(() => 200, e => e.status ?? (e.code ?? e.message))
        }
        if (includeBackup) {
            const client = this.backup ?? this.backupClient(null)
            try {
                snapshot.mqtt = { ok: true, paired: !!this.backup, ...(await client.checkHealth()) }
            } catch (e) {
                snapshot.mqtt = { ok: false, paired: !!this.backup, error: e.message }
            } finally {
                if (!this.backup) client.close()
            }
        }
        return snapshot
    }

    request(method, endpoint, body, options) {
        return runInTurn(this.host, () => this.send(method, endpoint, body, options), (method === "GET" ? MIN_REQUEST_GAP_MS : COMMAND_GAP_MS))
    }

    async send(method, endpoint, body, { auth = true, timeout, deviceId = this.deviceId, authKey = this.authKey } = {}) {
        const path = `/6${endpoint}`
        const signed = auth && deviceId
        // Asking for a new challenge costs an extra connection, so the last one is used
        // for as long as the TV takes it. If it doesn't, its refusal comes with a new one.
        const known = (signed && this.digest?.deviceId === deviceId ? this.digest : null)
        if (known) known.count++
        let response = await rawRequest(this.host, method, path, body, known ? { Authorization: digestHeader(method, path, deviceId, authKey, known.challenge, known.count) } : {}, timeout)
        const challenge = response.headers["www-authenticate"]
        if (response.status === 401 && signed && challenge?.includes("Digest")) {
            this.digest = { deviceId, challenge, count: 1 }
            response = await rawRequest(this.host, method, path, body, { Authorization: digestHeader(method, path, deviceId, authKey, challenge) }, timeout)
        }
        if (response.status !== 200) {
            throw new TVError(`${method} ${endpoint}: HTTP ${response.status}`, response.status)
        }
        return parseBody(response.text)
    }

    getSystem() {
        return this.request("GET", "/system", undefined, { auth: false })
    }

    // Makes the TV show a PIN. Pass the result to pairGrant() along with the PIN.
    async pairRequest() {
        const system = await this.getSystem()
        const deviceId = crypto.randomBytes(8).toString("hex")
        const result = await this.request("POST", "/pair/request", {
            access: { scope: ["read", "write", "control"], featuring: system?.featuring ?? {} },
            device: pairingDevice(deviceId)
        }, { auth: false })
        if (result?.error_id !== "SUCCESS") throw new TVError(`Pairing refused: ${result?.error_id ?? "no response"}`)
        return { deviceId, authKey: result.auth_key, timestamp: parseInt(result.timestamp), timeout: parseInt(result.timeout ?? 30) }
    }

    async pairGrant(pairing, pin) {
        const signature = crypto.createHmac("sha1", PAIRING_KEY).update(`${pairing.timestamp}${pin}`).digest("base64")
        const result = await this.request("POST", "/pair/grant", {
            auth: {
                pin,
                auth_timestamp: pairing.timestamp,
                auth_signature: signature,
                auth_appId: "1",
                auth_key: pairing.authKey
            },
            device: pairingDevice(pairing.deviceId)
        }, { deviceId: pairing.deviceId, authKey: pairing.authKey })
        if (result?.error_id !== "SUCCESS") throw new TVError(`Pairing refused: ${result?.error_id ?? "no response"}`)
        this.deviceId = pairing.deviceId
        this.authKey = result.auth_key || pairing.authKey
        return { deviceId: this.deviceId, authKey: this.authKey }
    }

    isOn() {
        return isPortOpen(this.host, CAST_PORT)
    }

    isReachable() {
        return isPortOpen(this.host, API_PORT)
    }

    async getWakeMacs() {
        const devices = await this.request("GET", "/network/devices")
        return (devices ?? []).filter(device => device["wake-on-lan"] === "Enabled" && device.mac).map(device => device.mac)
    }

    getVolume() {
        return this.request("GET", "/audio/volume")
    }

    setVolume(current, muted = false) {
        return this.request("POST", "/audio/volume", { muted, current })
    }

    sendKeyOverApi(key) {
        return this.request("POST", "/input/key", { key })
    }

    // Goes over the backup if there is one and the API is known to be down, or has just
    // refused it. Resolves with which way it went.
    async sendKey(key, options) {
        try {
            return await this.routeKey(key, options)
        } catch (e) {
            // The TV may be doing what it was asked, so callers shouldn't assume otherwise
            if (TOGGLE_KEYS.has(key) && couldHaveLanded(e)) e.mayHaveLanded = true
            throw e
        }
    }

    // preferBackup sends it over the backup link first, for keys sent often enough that
    // they shouldn't add to the API's load. Only for keys that are safe to send twice.
    async routeKey(key, { apiDown = false, preferBackup = false } = {}) {
        const code = (Object.hasOwn(KEY_CODES, key) ? KEY_CODES[key] : undefined)
        if (!this.backup || code === undefined) {
            await this.sendKeyOverApi(key)
            return { via: "api" }
        }

        if (apiDown || (preferBackup && !TOGGLE_KEYS.has(key))) {
            try {
                await this.backup.sendKeyCode(code)
                if (apiDown) diagnostics("key", { key, via: "backup", reason: "api down" })
                return { via: "backup" }
            } catch (e) {
                // A key that only got as far as being unconfirmed may have landed
                diagnostics("key.backupFailed", { key, error: e.message, code: e.code })
                if (!canResendKey(key, e)) throw e
            }
            await this.sendKeyOverApi(key)
            return { via: "api" }
        }

        try {
            await this.sendKeyOverApi(key)
            return { via: "api" }
        } catch (apiError) {
            if (!canResendKey(key, apiError)) throw apiError
            try {
                await this.backup.sendKeyCode(code)
            } catch (e) {
                diagnostics("key.backupFailed", { key, error: e.message })
                throw apiError
            }
            diagnostics("key", { key, via: "backup", reason: apiError.message })
            return { via: "backup", apiError }
        }
    }

    pressButton(button, options) {
        if (!Object.hasOwn(REMOTE_KEYS, button)) throw new TVError(`There's no "${button}" button.`, "unsupported")
        return this.sendKey(REMOTE_KEYS[button], options)
    }

    // Only call this on a TV that's on, since the key is a toggle that could wake one
    standby(options) {
        return this.sendKey("Standby", options)
    }

    // HDMI, as opposed to the TV's own apps and home screen. It doesn't say which input.
    async isShowingExternalInput() {
        return (await this.request("GET", "/context"))?.level1 === "WatchExtension"
    }

    // "external" on an HDMI input, "own" on the TV's home screen and apps (which Titan
    // OS reports as "NetTv"), or null for anything else
    async getShowing() {
        const level1 = (await this.request("GET", "/context"))?.level1
        if (level1 === "WatchExtension") return "external"
        if (level1 === "NetTv") return "own"
        return null
    }

    // Empty while Ambilight is off
    async getAmbilightConfig() {
        const config = await this.request("GET", "/ambilight/currentconfiguration")
        return (config?.styleName ? config : null)
    }

    setAmbilightConfig(config) {
        const style = AMBILIGHT_STYLES.find(entry => entry.id === ambilightStyleId(config))
        return this.request("POST", "/ambilight/currentconfiguration", style ? ambilightStyleConfig(style) : config)
    }

    setAmbilightStyle(id) {
        const style = AMBILIGHT_STYLES.find(entry => entry.id === id)
        if (!style) throw new TVError("This TV doesn't have that Ambilight style.", "unsupported")
        return this.setAmbilightConfig(ambilightStyleConfig(style))
    }

    // The "OFF" style and "ambilight/power" are acknowledged but ignored. Only the
    // settings menu entry works, and its ID is looked up in case it differs by model.
    async turnOffAmbilight() {
        const structure = await this.request("GET", "/menuitems/settings/structure")
        const nodeId = findMenuNode(structure?.node, "ambilight_off")?.node_id
        if (nodeId === undefined) throw new TVError("Ambilight off isn't available on this TV", "unsupported")
        await this.request("POST", "/menuitems/settings/update", {
            values: [{ value: { Nodeid: nodeId, nodeid: nodeId, node_id: nodeId } }]
        })
    }
}

function findMenuNode(node, context) {
    if (!node) return undefined
    if (node.context === context) return node
    for (const child of node.data?.nodes ?? []) {
        const found = findMenuNode(child, context)
        if (found) return found
    }
    return undefined
}

// The Cast receiver keeps answering when the control API doesn't, so it can still
// identify the TV. Titan OS leaves "undefined_" placeholders in front of the model.
function getCastName(host, timeout = 3000) {
    return new Promise(resolve => {
        const req = http.get({ host, port: CAST_INFO_PORT, path: "/setup/eureka_info?params=name", timeout }, res => {
            let text = ""
            res.setEncoding("utf8")
            res.on("data", chunk => text += chunk)
            res.on("end", () => {
                try {
                    const name = JSON.parse(text).name
                    resolve(typeof name === "string" ? name.replace(/^(undefined_)+/, "") : null)
                } catch (e) {
                    resolve(null)
                }
            })
        })
        req.on("timeout", () => req.destroy())
        req.on("error", () => resolve(null))
    })
}

function wakeOnLan(macs, host) {
    return new Promise(resolve => {
        const socket = dgram.createSocket("udp4")
        socket.once("error", () => {
            socket.close()
            resolve(false)
        })
        socket.bind(() => {
            socket.setBroadcast(true)
            const sends = []
            for (const mac of macs) {
                const macBytes = Buffer.from(mac.replace(/[:-]/g, ""), "hex")
                if (macBytes.length !== 6) continue
                const packet = Buffer.concat([Buffer.alloc(6, 0xff), ...Array(16).fill(macBytes)])
                for (const address of ["255.255.255.255", host]) {
                    sends.push(new Promise(done => socket.send(packet, 9, address, () => done())))
                }
            }
            Promise.all(sends).then(() => {
                socket.close()
                resolve(sends.length > 0)
            })
        })
    })
}

// How long the TV has been running, which shows a real restart. Null if it isn't answering.
function getCastUptime(host, timeout = 3000) {
    return new Promise(resolve => {
        const req = http.get({ host, port: CAST_INFO_PORT, path: "/setup/eureka_info?params=uptime", timeout }, res => {
            let text = ""
            res.setEncoding("utf8")
            res.on("data", chunk => text += chunk)
            res.on("end", () => {
                try {
                    resolve(JSON.parse(text).uptime ?? null)
                } catch (e) {
                    resolve(null)
                }
            })
        })
        req.on("timeout", () => req.destroy())
        req.on("error", () => resolve(null))
        req.on("close", () => resolve(null))
    })
}

// Finds Philips TVs on the network by their UPnP announcement. A TV whose control
// API isn't answering is still listed, after the rest, using its Cast name.
function discover(timeout = 3000) {
    return new Promise(resolve => {
        const hosts = new Set()
        const sockets = []
        const search = Buffer.from('M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: "ssdp:discover"\r\nMX: 2\r\nST: urn:schemas-upnp-org:device:MediaRenderer:1\r\n\r\n')

        // Multicast only leaves through one adapter, and on a PC with virtual
        // adapters (WSL, Hyper-V) that's easily not the one the TV is on.
        for (const addresses of Object.values(os.networkInterfaces())) {
            for (const { family, internal, address } of addresses) {
                if (family !== "IPv4" || internal) continue
                const socket = dgram.createSocket("udp4")
                sockets.push(socket)
                socket.on("message", (message, remote) => hosts.add(remote.address))
                socket.on("error", () => { })
                socket.bind(0, address, () => {
                    socket.setMulticastInterface(address)
                    socket.send(search, 1900, "239.255.255.250")
                })
            }
        }

        setTimeout(async () => {
            sockets.forEach(socket => socket.close())
            const found = await Promise.all(Array.from(hosts).map(async host => {
                try {
                    const system = await new PhilipsTV(host).request("GET", "/system", undefined, { auth: false, timeout: 3000 })
                    return (system?.api_version ? { host, name: system.name, apiAvailable: true } : null)
                } catch (e) {
                    const name = await getCastName(host)
                    return (name ? { host, name, apiAvailable: false } : null)
                }
            }))
            resolve(found.filter(tv => tv).sort((a, b) => b.apiAvailable - a.apiAvailable))
        }, timeout)
    })
}

module.exports = { PhilipsTV, TVError, wakeOnLan, discover, getCastName, AMBILIGHT_STYLES, ambilightStyleId, setTVDiagnostics, canResendKey }
