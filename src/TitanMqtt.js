// Client for the MQTT v5 channel that Titan OS TVs run on port 8883, which is what their
// official phone app uses. It's a separate server from the JointSpace API, so it's used
// here as a backup for sending keys when that API has stopped answering.
//
// This protocol isn't documented. What's here comes from
// https://github.com/bedirhanyildirim/philips-titan-os-55pml9019-remote (MIT), and from
// connecting to a 48OLED770, which accepts an anonymous connection but nothing further.
//
// Only the few packets this needs are implemented. Everything is QoS 0, so a key has no
// acknowledgement from the TV. A ping after it at least shows the server received it.

const crypto = require("crypto")
const tls = require("tls")

const PORT = 8883
const KEEPALIVE_SECONDS = 30
const PING_EVERY_MS = 20000
const CONNECT_TIMEOUT_MS = 6000
const REQUEST_TIMEOUT_MS = 6000
// Connecting is quick, so it's only kept open while it's likely to be used again
const LINGER_MS = 60000
const PAIRING_LINGER_MS = 180000
const SUBSCRIBE_SETTLE_MS = 300

// Bundled with the Titan OS Mobile app. SHA-256 fingerprint
// BC:91:11:1A:19:E8:21:6E:14:59:58:2C:CC:97:74:55:74:FC:7C:5F:85:8C:DE:54:AA:1B:7C:26:C8:0D:DE:DA
const TITAN_ROOT_CA = `-----BEGIN CERTIFICATE-----
MIIFszCCA5ugAwIBAgIUKKf5oPbMLyZOQKygD5UL0iixNVowDQYJKoZIhvcNAQEL
BQAwYTELMAkGA1UEBhMCRVMxEjAQBgNVBAgMCUJhcmNlbG9uYTESMBAGA1UEBwwJ
QmFyY2Vsb25hMRAwDgYDVQQKDAdUaXRhbk9TMRgwFgYDVQQDDA9UaXRhbm9zIFJv
b3QgQ0EwHhcNMjQxMTE4MDg0MjM3WhcNNDYxMDE0MDg0MjM3WjBhMQswCQYDVQQG
EwJFUzESMBAGA1UECAwJQmFyY2Vsb25hMRIwEAYDVQQHDAlCYXJjZWxvbmExEDAO
BgNVBAoMB1RpdGFuT1MxGDAWBgNVBAMMD1RpdGFub3MgUm9vdCBDQTCCAiIwDQYJ
KoZIhvcNAQEBBQADggIPADCCAgoCggIBALUdzSkFl/+utLPy1TcOWo951L+ACx5J
fRu+kpso3RBu59YGFeWsj+N2VQ633qWeNB1HwawbwLmtrt5dLHQQzC8UsAf6XJnG
3ritoJV0bIA3GFYhgQ2sLYZv1Y1lWsSSxMGDbJU/y8+iWTUhvKVCN9flUSYnpoZw
VCvKBpLh7rBm53zTP2TvUCCakZmey7C2zIRXmWj/gLbHbxXqKB44xjKp1Y9Gy5Qt
vKOHxY61W+hhKOuaaSTbV+I/EitILzjm3bh8RytPP+HZsXgEdPj7izwLkzoSXKGW
b0v1qnNtu8SP7t9/tSpbAMOUmcR9hTVJ2Fl57CnT/4otFVjXirMd6RvsxRvBpdBL
qawO4h1nG+GIQdkqKaI7q8hrXqZa5pwnqttzei16T8LzUw6BxM9eJziykahfKork
kCm27u9+b1ABrTMjrPtyRXuzaN7c8Id/3ILetn+ErGzyNd2P1Ey8yTyc5sPsVFdJ
dRQ1MLN4igoDr8iVc6ODkzJq8y9pM3q2QLAwkY7rXx/UWt9CIhFBwL2aedEUBAQ1
04aJIYjo5E6QzGUu6ATKg3K8Rhnw55N9YINPOnWJS7OXIy0We4EwYHBKI0yzxSzw
QrAl7hYOxfe3RbjBDnjx8kUVUmJXVihtOXLcxvA53ZChP2HSLCieBlibxiKcFKff
zdeTwsBZWgClAgMBAAGjYzBhMB0GA1UdDgQWBBQu2FmLX8AfqTYuaCvnZEOemgSs
MjAfBgNVHSMEGDAWgBQu2FmLX8AfqTYuaCvnZEOemgSsMjAPBgNVHRMBAf8EBTAD
AQH/MA4GA1UdDwEB/wQEAwIBBjANBgkqhkiG9w0BAQsFAAOCAgEATvARxcgSy/i3
/sX0IL1sIwkvP/Orv3Hofj0rBuW/zwB/xu+g+i5n121GsTXDefgpspfUCIjcfMWg
jj4MYQKs0xwSaiWdIeHvWe6z4SWz/2r/Tly2tRsdfs71g3V62OZFlldYHAglqAS+
AmGevi2CPPqXHWoKZgvH4iuPKuwaTyHYh6BizcJlJaXsFn7FUwU7uQn8B7mZJACm
EDhtBEO/7RvqJy8uTe8q6LYkT36mfySYx3JUBjEVMRcir+YNILomqfBVxBUYLakY
9ES95o1/aUMGLekwDnBiNNCfXEyrLeZrq0RNm6Uua9h+VOTuL118DuK6QQZceeQM
oDoOCH6h52n9A2l/67VpfsEbV5AcaSxpA9xpMwd3iNy7E4XmsEyPheZnVf8gHDMi
VsAhOPGYuJD1yEsOl6LnDvtUdpHnSC/KBzYajToaWt2d4p6SRGNT0gP1qk39A3mv
t5X7NUEc1/TiZN3owYAdV35YzqhDYnJKsjSVw2Uh3UzYzY99cDdqsOUNOOKJWSWX
0b7XRSEh94j9a2zRi08pS1WJWve1VdgUuxXZLpjBb9oXIseMiLQIcdYcemUP+KCt
9AUaeZ36gOXeK5kFHEONPS01gt4+I1JPL/grmry54AyHK/CrqxsM7Tzp0UNe1NdI
MEEK6k/nerFuPlrcS37OXQVgLqKTAdY=
-----END CERTIFICATE-----`

class TitanMqttError extends Error {
    constructor(message, code) {
        super(message)
        this.name = "TitanMqttError"
        this.code = code
    }
}

//
// Packets
//

const PACKET = { CONNECT: 1, CONNACK: 2, PUBLISH: 3, SUBSCRIBE: 8, SUBACK: 9, PINGREQ: 12, PINGRESP: 13, DISCONNECT: 14 }
const PROPERTY = { RESPONSE_TOPIC: 0x08, CORRELATION_DATA: 0x09 }

function encodeVarint(value) {
    const bytes = []
    do {
        let byte = value % 128
        value = Math.floor(value / 128)
        if (value > 0) byte |= 128
        bytes.push(byte)
    } while (value > 0)
    return Buffer.from(bytes)
}

function encodeString(value) {
    const data = Buffer.from(value)
    return Buffer.concat([Buffer.from([data.length >> 8, data.length & 255]), data])
}

function packet(first, body = Buffer.alloc(0)) {
    return Buffer.concat([Buffer.from([first]), encodeVarint(body.length), body])
}

function connectPacket({ clientId, username, password }) {
    const flags = 0x02 | (username ? 0x80 : 0) | (password ? 0x40 : 0)
    return packet(PACKET.CONNECT << 4, Buffer.concat([
        encodeString("MQTT"),
        Buffer.from([5, flags, 0, KEEPALIVE_SECONDS, 0]),
        encodeString(clientId),
        ...(username ? [encodeString(username)] : []),
        ...(password ? [encodeString(password)] : [])
    ]))
}

function subscribePacket(id, topic) {
    return packet((PACKET.SUBSCRIBE << 4) | 2, Buffer.concat([Buffer.from([id >> 8, id & 255, 0]), encodeString(topic), Buffer.from([0])]))
}

function publishPacket(topic, payload, responseTopic) {
    const properties = (responseTopic
        ? Buffer.concat([Buffer.from([PROPERTY.RESPONSE_TOPIC]), encodeString(responseTopic), Buffer.from([PROPERTY.CORRELATION_DATA]), encodeString(responseTopic)])
        : Buffer.alloc(0))
    return packet(PACKET.PUBLISH << 4, Buffer.concat([encodeString(topic), encodeVarint(properties.length), properties, Buffer.from(JSON.stringify(payload))]))
}

function decodeVarint(buffer, offset) {
    let value = 0, multiplier = 1, position = offset
    while (position < buffer.length) {
        const byte = buffer[position++]
        value += (byte & 127) * multiplier
        if (!(byte & 128)) return { value, length: position - offset }
        multiplier *= 128
        if (multiplier > 128 ** 4) throw new TitanMqttError("Malformed packet length")
    }
    return null
}

// Takes whatever has arrived so far, and returns the complete packets and what's left
function readPackets(buffer) {
    const packets = []
    let offset = 0
    while (offset + 1 < buffer.length) {
        const length = decodeVarint(buffer, offset + 1)
        if (!length) break
        const start = offset + 1 + length.length
        if (buffer.length < start + length.value) break
        packets.push({ type: buffer[offset] >> 4, flags: buffer[offset] & 15, body: buffer.subarray(start, start + length.value) })
        offset = start + length.value
    }
    return { packets, rest: buffer.subarray(offset) }
}

function decodePublish({ flags, body }) {
    const topicLength = body.readUInt16BE(0)
    const topic = body.toString("utf8", 2, 2 + topicLength)
    let offset = 2 + topicLength
    if ((flags >> 1) & 3) offset += 2 // A packet ID, which only QoS 1 and 2 have
    const properties = decodeVarint(body, offset)
    return { topic, payload: body.subarray(offset + properties.length + properties.value) }
}

// With expired certificates allowed, the TLS library can't be left to check who signed it:
// it may report an unrelated expired certificate as only expired. So the chain the server
// sent is walked here, and has to end at the pinned root. Dates are ignored, since the date
// on it says nothing about who it is.
function chainsToPinnedCa(peerCertificate, ca) {
    const root = new crypto.X509Certificate(ca)
    let details = peerCertificate
    if (!details?.raw) return false
    let current = new crypto.X509Certificate(details.raw)
    for (let depth = 0; depth < 8; depth++) {
        if (current.verify(root.publicKey)) return true
        const issuer = details.issuerCertificate
        if (!issuer?.raw || issuer === details) return false
        const next = new crypto.X509Certificate(issuer.raw)
        if (!next.ca || !current.verify(next.publicKey)) return false
        current = next
        details = issuer
    }
    return false
}

// The TV reports how long its PIN lasts, but this has only been seen in one person's notes
function pairingSeconds(reported) {
    return (Number.isFinite(reported) && reported >= 1 && reported <= 600 ? reported : 60)
}

function pairingResult(pin, challenge) {
    return crypto.createHmac("sha256", String(pin)).update(challenge).digest("hex")
}

// What's safe and useful to keep from the TV's "info" message. It also holds MAC addresses.
function summarizeInfo(info) {
    return {
        model: info?.model,
        firmware: info?.fw_version,
        market: info?.market,
        serverVersion: info?.mqttv_version,
        topics: info?.mqttv_topics
    }
}

//
// Client
//

class TitanMqttClient {
    // getHost is a function since the TV's address can change. log(event, fields) gets
    // what happened, and never credentials.
    // watchTopics are subscribed to on every connection, and changes to them are logged
    constructor({ getHost, credentials = null, log = () => { }, ca = TITAN_ROOT_CA, port = PORT, lingerMs = LINGER_MS, connectTimeoutMs = CONNECT_TIMEOUT_MS, requestTimeoutMs = REQUEST_TIMEOUT_MS, watchTopics = [] }) {
        this.watchTopics = watchTopics
        this.lastWatched = new Map()
        this.getHost = getHost
        this.credentials = credentials
        this.log = log
        this.ca = ca
        this.port = port
        this.lingerMs = lingerMs
        this.connectTimeoutMs = connectTimeoutMs
        this.requestTimeoutMs = requestTimeoutMs
        this.socket = null
        this.connecting = null
        this.pendingSocket = null
        this.nextPacketId = 1
        this.subscriptions = new Map()
        this.messages = new Map()
        this.pings = []
        this.lingerTimer = null
        this.pingTimer = null
    }

    get isConnected() {
        return !!this.socket && !this.connecting
    }

    connect() {
        if (this.connecting) return this.connecting
        if (this.socket) {
            this.touch()
            return Promise.resolve()
        }
        const startedAt = Date.now()
        const anonymous = !this.credentials
        this.connecting = new Promise((resolve, reject) => {
            let settled = false
            let pending = Buffer.alloc(0)
            const socket = tls.connect({
                host: this.getHost(),
                port: this.port,
                ca: this.ca,
                // Checked below, since an expired certificate is still acceptable
                rejectUnauthorized: false,
                // The TV's certificate doesn't name its address
                checkServerIdentity: () => undefined
            })
            this.pendingSocket = socket
            const fail = error => {
                if (settled) return
                settled = true
                clearTimeout(timeout)
                this.pendingSocket = null
                socket.destroy()
                reject(error)
            }
            const timeout = setTimeout(() => fail(new TitanMqttError("Timed out connecting", "connectTimeout")), this.connectTimeoutMs)
            socket.once("secureConnect", () => {
                const certificate = socket.getPeerCertificate(true)
                let trusted = false
                try {
                    trusted = chainsToPinnedCa(certificate, this.ca)
                } catch (e) {
                    this.log("mqtt.certCheckFailed", { error: e.message })
                }
                if (!trusted) {
                    this.log("mqtt.certRejected", { subject: certificate?.subject?.CN, issuer: certificate?.issuer?.CN, tls: String(socket.authorizationError) })
                    return fail(new TitanMqttError("That isn't a Titan OS TV: its certificate isn't signed by the expected root.", "certificate"))
                }
                if (socket.authorizationError) this.log("mqtt.certNote", { tls: String(socket.authorizationError), validTo: certificate?.valid_to })
                const username = this.credentials?.username
                socket.write(connectPacket({
                    clientId: `eos-${username ?? crypto.randomBytes(16).toString("hex")}`,
                    username,
                    password: this.credentials?.password
                }))
            })
            socket.on("data", data => {
                try {
                    const { packets, rest } = readPackets(Buffer.concat([pending, data]))
                    pending = rest
                    for (const received of packets) {
                        if (received.type === PACKET.CONNACK && !settled) {
                            const reason = received.body[1]
                            if (reason !== 0) {
                                this.log("mqtt.refused", { reason, anonymous })
                                return fail(new TitanMqttError(`The TV refused the connection (0x${reason.toString(16)})`, reason))
                            }
                            settled = true
                            clearTimeout(timeout)
                            this.pendingSocket = null
                            this.socket = socket
                            this.startTimers()
                            this.log("mqtt.connected", { ms: Date.now() - startedAt, anonymous })
                            resolve()
                            if (!anonymous) this.watch()
                        } else {
                            this.handlePacket(received)
                        }
                    }
                } catch (e) {
                    this.log("mqtt.badPacket", { error: e.message })
                    socket.destroy(e)
                }
            })
            socket.on("error", error => {
                this.log("mqtt.socketError", { error: error.code ?? error.message })
                fail(error)
            })
            socket.on("close", () => {
                fail(new TitanMqttError("The connection closed", "closed"))
                if (this.socket === socket) this.handleClosed()
            })
        }).finally(() => {
            this.connecting = null
        })
        return this.connecting
    }

    // Only what changed is logged, since retained values come again on every connection
    async watch() {
        for (const topic of this.watchTopics) {
            this.messages.set(topic, payload => {
                const text = payload.toString().slice(0, 300)
                if (this.lastWatched.get(topic) === text) return
                this.lastWatched.set(topic, text)
                this.log("mqtt.state", { topic, payload: text })
            })
            try {
                await this.subscribe(topic)
            } catch (e) {
                this.messages.delete(topic)
            }
        }
    }

    handlePacket(received) {
        if (received.type === PACKET.SUBACK) {
            const id = received.body.readUInt16BE(0)
            const properties = decodeVarint(received.body, 2)
            const reason = received.body[2 + properties.length + properties.value]
            this.subscriptions.get(id)?.(reason)
            this.subscriptions.delete(id)
        } else if (received.type === PACKET.PUBLISH) {
            const { topic, payload } = decodePublish(received)
            this.messages.get(topic)?.(payload)
        } else if (received.type === PACKET.PINGRESP) {
            this.pings.shift()?.()
        } else if (received.type === PACKET.DISCONNECT) {
            this.log("mqtt.disconnectedByTV", { reason: received.body[0] ?? 0 })
        }
    }

    handleClosed() {
        this.log("mqtt.closed")
        this.socket = null
        this.stopTimers()
        // Whoever was waiting on these times out by themselves
        this.subscriptions.clear()
        this.messages.clear()
        this.pings = []
    }

    startTimers() {
        this.touch()
        this.pingTimer = setInterval(() => this.ping().catch(e => this.log("mqtt.keepaliveFailed", { error: e.message })), PING_EVERY_MS)
        this.pingTimer.unref?.()
    }

    stopTimers() {
        clearTimeout(this.lingerTimer)
        clearInterval(this.pingTimer)
        this.lingerTimer = null
        this.pingTimer = null
    }

    // Any use keeps it open a little longer
    touch() {
        clearTimeout(this.lingerTimer)
        this.lingerTimer = setTimeout(() => this.close(), this.lingerMs)
        this.lingerTimer.unref?.()
    }

    close() {
        this.pendingSocket?.destroy()
        const socket = this.socket
        if (!socket) return
        this.handleClosed()
        try {
            socket.end(packet(PACKET.DISCONNECT << 4))
        } catch (e) { }
        setTimeout(() => socket.destroy(), 500).unref?.()
    }

    timed(promise, what) {
        let timer
        const timeout = new Promise((_, reject) => {
            timer = setTimeout(() => reject(new TitanMqttError(`Timed out waiting for ${what}`, "timeout")), this.requestTimeoutMs)
        })
        return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
    }

    ping() {
        const socket = this.socket
        if (!socket) return Promise.reject(new TitanMqttError("Not connected", "closed"))
        const pong = new Promise(resolve => this.pings.push(resolve))
        socket.write(packet(PACKET.PINGREQ << 4))
        // No answer means the connection's dead, and a late answer would be taken for another's
        return this.timed(pong, "a ping").catch(error => {
            socket.destroy()
            throw error
        })
    }

    async subscribe(topic) {
        const id = this.nextPacketId
        this.nextPacketId = (id % 65535) + 1
        const answer = new Promise(resolve => this.subscriptions.set(id, resolve))
        this.socket.write(subscribePacket(id, topic))
        const reason = await this.timed(answer, `the subscription to ${topic}`)
        if (reason >= 0x80) {
            this.log("mqtt.subscribeRefused", { topic, reason })
            throw new TitanMqttError(`The TV refused ${topic} (0x${reason.toString(16)})`, reason)
        }
    }

    // A message with no reply. The ping that follows only comes back once the server
    // has dealt with what's before it, but that doesn't mean the TV acted on it.
    async publish(topic, payload) {
        await this.connect()
        this.touch()
        this.socket.write(publishPacket(topic, payload))
        await this.ping()
    }

    async request(topic, payload) {
        await this.connect()
        this.touch()
        const responseTopic = `${topic}/${crypto.randomUUID()}`
        const reply = new Promise(resolve => this.messages.set(responseTopic, resolve))
        try {
            await this.subscribe(responseTopic)
            // The only client known to work on these TVs leaves this gap
            await new Promise(resolve => setTimeout(resolve, SUBSCRIBE_SETTLE_MS))
            this.socket.write(publishPacket(topic, payload, responseTopic))
            const message = JSON.parse((await this.timed(reply, `a reply to ${topic}`)).toString())
            if (message.error) {
                this.log("mqtt.requestRefused", { topic, code: message.error.code, message: message.error.message })
                throw new TitanMqttError(`${topic}: ${message.error.message ?? "refused"}`, message.error.code)
            }
            return message.data
        } finally {
            this.messages.delete(responseTopic)
        }
    }

    // The latest message on a topic that the server keeps one for
    async readRetained(topic) {
        await this.connect()
        this.touch()
        const message = new Promise(resolve => this.messages.set(topic, resolve))
        try {
            await this.subscribe(topic)
            return JSON.parse((await this.timed(message, topic)).toString())
        } finally {
            this.messages.delete(topic)
        }
    }

    sendKeyCode(code) {
        return this.publish("rc", { key_code: code })
    }

    // Makes the TV show a PIN. Needs a client with no credentials.
    async startPairing() {
        const data = await this.request("pairing/start", { type: "mobile" })
        if (!data?.challenge) throw new TitanMqttError("The TV didn't start pairing")
        this.challenge = data.challenge
        this.log("mqtt.pairingStarted", { timeout: data.timeout, attempts: data.attempts })
        return { timeout: pairingSeconds(data.timeout), attempts: data.attempts }
    }

    async finishPairing(pin) {
        const username = crypto.randomUUID()
        const data = await this.request("pairing/finish", { username, challenge_result: pairingResult(pin, this.challenge) })
        if (!data?.password) throw new TitanMqttError("The TV didn't accept the PIN")
        this.log("mqtt.paired")
        return { username: data.username ?? username, password: data.password }
    }

    async readInfo() {
        return summarizeInfo(await this.readRetained("info"))
    }

    // For the log: is it answering, and how quickly. Sends nothing to the TV itself.
    async checkHealth() {
        const startedAt = Date.now()
        await this.connect()
        await this.ping()
        return { ms: Date.now() - startedAt }
    }
}

// Linux input codes, as the Titan OS Mobile app sends them
const KEY_CODES = {
    Confirm: 352, Back: 158, Home: 102,
    CursorUp: 103, CursorDown: 108, CursorLeft: 105, CursorRight: 106,
    VolumeUp: 115, VolumeDown: 114, Mute: 113, Standby: 116
}

module.exports = {
    TitanMqttClient, TitanMqttError, KEY_CODES, TITAN_ROOT_CA, PAIRING_LINGER_MS,
    chainsToPinnedCa, pairingSeconds, pairingResult, summarizeInfo,
    connectPacket, subscribePacket, publishPacket, readPackets, decodePublish, PACKET
}
