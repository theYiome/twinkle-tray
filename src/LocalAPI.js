// Optional HTTP interface for scripts and automation tools. It only listens on
// this PC and needs the token shown in settings.
//
// Other apps on the PC can reach the port, and so can web pages through the
// browser, which is why the token is required and the Host header is checked.
// Without the Host check, a page could rebind its own domain to 127.0.0.1.

const crypto = require("crypto")
const http = require("http")

const MAX_BODY_BYTES = 16 * 1024

function tokensMatch(given, expected) {
    const givenHash = crypto.createHash("sha256").update(`${given}`).digest()
    const expectedHash = crypto.createHash("sha256").update(`${expected}`).digest()
    return crypto.timingSafeEqual(givenHash, expectedHash)
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        let text = ""
        req.setEncoding("utf8")
        req.on("data", chunk => {
            text += chunk
            if (text.length > MAX_BODY_BYTES) reject(Object.assign(new Error("Body too large."), { status: 413 }))
        })
        req.on("end", () => {
            if (!text.trim()) return resolve({})
            try {
                resolve(JSON.parse(text))
            } catch (e) {
                reject(Object.assign(new Error("Body isn't valid JSON."), { status: 400 }))
            }
        })
        req.on("error", reject)
    })
}

class LocalAPI {
    // routes: { "GET /status": async (body, params) => result, "POST /display/:key/dim": ... }
    constructor({ getToken, routes }) {
        this.getToken = getToken
        this.routes = Object.entries(routes).map(([route, handler]) => {
            const [method, path] = route.split(" ")
            return { method, segments: path.split("/").filter(Boolean), handler }
        })
        this.server = null
        this.port = null
        this.lastError = null
    }

    matchRoute(method, pathname) {
        const segments = pathname.split("/").filter(Boolean)
        for (const route of this.routes) {
            if (route.method !== method || route.segments.length !== segments.length) continue
            const params = {}
            const matches = route.segments.every((segment, index) => {
                if (segment[0] === ":") {
                    params[segment.slice(1)] = decodeURIComponent(segments[index])
                    return true
                }
                return segment === segments[index]
            })
            if (matches) return { route, params }
        }
        return null
    }

    async handle(req, res) {
        const send = (status, body) => {
            res.writeHead(status, { "Content-Type": "application/json" })
            res.end(JSON.stringify(body))
        }

        try {
            const host = (req.headers.host ?? "").split(":")[0]
            if (host !== "127.0.0.1" && host !== "localhost") return send(403, { error: "Bad host." })

            const token = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "")
            if (!token || !tokensMatch(token, this.getToken())) return send(401, { error: "Missing or wrong token." })

            const { pathname } = new URL(req.url, "http://127.0.0.1")
            const match = this.matchRoute(req.method, pathname)
            if (!match) return send(404, { error: "No such route." })

            const body = await readBody(req)
            const result = await match.route.handler(body, match.params)
            send(200, result ?? { ok: true })
        } catch (e) {
            send(e.status ?? 500, { error: e.message })
        }
    }

    async start(port) {
        await this.stop()
        return new Promise(resolve => {
            const server = http.createServer((req, res) => this.handle(req, res))
            server.once("error", e => {
                this.lastError = e.code === "EADDRINUSE" ? `Port ${port} is already in use.` : e.message
                console.log("LocalAPI: couldn't start", e.message)
                this.server = null
                this.port = null
                resolve(false)
            })
            server.listen(port, "127.0.0.1", () => {
                this.server = server
                this.port = port
                this.lastError = null
                resolve(true)
            })
        })
    }

    stop() {
        return new Promise(resolve => {
            if (!this.server) return resolve()
            this.server.close(() => resolve())
            this.server.closeAllConnections?.()
            this.server = null
            this.port = null
        })
    }
}

module.exports = { LocalAPI }
