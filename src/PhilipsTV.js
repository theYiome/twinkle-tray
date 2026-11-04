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

const API_PORT = 1926
const CAST_PORT = 8009
const CAST_INFO_PORT = 8008
const REQUEST_TIMEOUT = 8000
// The TV's API server is reported to lock up under bursts of requests, until it's
// unplugged. It closes every connection, so spacing requests out is what's left.
const MIN_REQUEST_GAP_MS = 700

// Philips' app secret for signing pairing grants. It's the same for every client.
const PAIRING_KEY = Buffer.from("ZmVay1EQVFOaZhwQ4Kv81ypLAZNczV9sG4KkseXWn1NEk6cXmPKO/MCa9sryslvLCFMnNe4Z4CPXzToowvhHvA==", "base64")

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
            res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text }))
        })
        req.on("timeout", () => req.destroy(new TVError(`${method} ${path} timed out`)))
        req.on("error", reject)
        req.end(data)
    })
}

// Everything sent to a TV goes through here, one call at a time
const requestQueues = new Map()
function runInTurn(host, call) {
    if (!requestQueues.has(host)) requestQueues.set(host, { last: Promise.resolve(), doneAt: 0 })
    const queue = requestQueues.get(host)
    const turn = queue.last.then(async () => {
        const wait = queue.doneAt + MIN_REQUEST_GAP_MS - Date.now()
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
    }

    request(method, endpoint, body, options) {
        return runInTurn(this.host, () => this.send(method, endpoint, body, options))
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

    sendKey(key) {
        return this.request("POST", "/input/key", { key })
    }

    // Empty while Ambilight is off
    async getAmbilightConfig() {
        const config = await this.request("GET", "/ambilight/currentconfiguration")
        return (config?.styleName ? config : null)
    }

    setAmbilightConfig(config) {
        return this.request("POST", "/ambilight/currentconfiguration", config)
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

module.exports = { PhilipsTV, TVError, wakeOnLan, discover, getCastName }
