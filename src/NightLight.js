// Reads and adjusts Windows Night Light. Windows has no API for it, so this edits the
// two CloudStore registry values that Windows keeps it in, which are stored as Bond
// CompactBinary v1. The format is undocumented and may change, so anything that isn't
// understood leaves the feature unavailable rather than risking a bad write.
//
// Based on the work in https://github.com/xanderfrangos/twinkle-tray/pull/1338 by
// binbuf, which worked out the format and the live preview flag.

const { EventEmitter } = require("events")

const CURRENT_KEY = "Software\\Microsoft\\Windows\\CurrentVersion\\CloudStore\\Store\\DefaultAccount\\Current"
const STATE_NAME = "windows.data.bluelightreduction.bluelightreductionstate"
const SETTINGS_NAME = "windows.data.bluelightreduction.settings"
const VALUE_NAME = "Data"

const MIN_KELVIN = 1200
const MAX_KELVIN = 6500
const FILETIME_EPOCH_OFFSET_SECONDS = 11644473600n
const FILETIME_TICKS_PER_SECOND = 10000000n
const WRITE_ATTEMPTS = 2

const BOND = { Bool: 2, UInt8: 3, UInt16: 4, UInt32: 5, UInt64: 6, Float: 7, Double: 8, String: 9, Struct: 10, List: 11, Set: 12, Map: 13, Int8: 14, Int16: 15, Int32: 16, Int64: 17, WString: 18 }

// Field 0 being present is what turns Night Light on
const STATE_ON_FIELD = Buffer.from([0x10, 0x00])
// Field 70 applies a new temperature straight away. Windows' own slider sets it while
// dragging and removes it on release.
const PREVIEW_FIELD = Buffer.from([0xc2, 0x46, 0x01])
const PREVIEW_FIELD_ID = 70
const STATE_ON_FIELD_ID = 0
const TRANSITION_FIELD_ID = 20
const KELVIN_FIELD_ID = 40
const SCHEDULE_FIELD_ID = 0

class BondReader {
    constructor(buffer) {
        this.buffer = buffer
        this.pos = 0
    }

    readByte() {
        if (this.pos >= this.buffer.length) throw new Error("Unexpected end of Bond data")
        return this.buffer[this.pos++]
    }

    readHeader() {
        if (this.readByte() !== 0x43 || this.readByte() !== 0x42 || this.readByte() !== 0x01 || this.readByte() !== 0x00) {
            throw new Error("Invalid Bond header")
        }
    }

    readFieldHeader() {
        const raw = this.readByte()
        const type = raw & 0x1f
        const idBits = raw & 0xe0
        if (type === 0) {
            if (idBits === 0) return { stop: true }
            throw new Error("Invalid Bond field header")
        }
        if (type === 1 && idBits === 0) return { stopBase: true }
        let id
        if (idBits === 0xe0) {
            id = this.readByte() | (this.readByte() << 8)
        } else if (idBits === 0xc0) {
            id = this.readByte()
        } else {
            id = idBits >> 5
        }
        return { id, type }
    }

    readVarint() {
        let value = 0n
        let shift = 0n
        while (true) {
            const byte = this.readByte()
            value |= BigInt(byte & 0x7f) << shift
            if (byte < 0x80) return value
            shift += 7n
        }
    }

    skipValue(type) {
        switch (type) {
            case BOND.Bool:
            case BOND.UInt8:
            case BOND.Int8:
                this.readByte()
                break
            case BOND.UInt16:
            case BOND.UInt32:
            case BOND.UInt64:
            case BOND.Int16:
            case BOND.Int32:
            case BOND.Int64:
                this.readVarint()
                break
            case BOND.Float:
                this.pos += 4
                break
            case BOND.Double:
                this.pos += 8
                break
            case BOND.String:
                this.pos += Number(this.readVarint())
                break
            case BOND.WString:
                this.pos += Number(this.readVarint()) * 2
                break
            case BOND.Struct:
                while (true) {
                    const field = this.readFieldHeader()
                    if (field.stop) break
                    if (!field.stopBase) this.skipValue(field.type)
                }
                break
            case BOND.List:
            case BOND.Set: {
                const elementType = this.readByte() & 0x1f
                const count = Number(this.readVarint())
                for (let i = 0; i < count; i++) this.skipValue(elementType)
                break
            }
            case BOND.Map: {
                const keyType = this.readByte() & 0x1f
                const valueType = this.readByte() & 0x1f
                const count = Number(this.readVarint())
                for (let i = 0; i < count; i++) {
                    this.skipValue(keyType)
                    this.skipValue(valueType)
                }
                break
            }
            default:
                throw new Error(`Unknown Bond type: ${type}`)
        }
    }
}

function encodeVarint(value) {
    const bytes = []
    let remaining = BigInt(value)
    while (remaining >= 0x80n) {
        bytes.push(Number(remaining & 0x7fn) | 0x80)
        remaining >>= 7n
    }
    bytes.push(Number(remaining))
    return Buffer.from(bytes)
}

const zigzagEncode = value => (BigInt(value) << 1n) ^ (BigInt(value) >> 63n)
const zigzagDecode = value => Number((value >> 1n) ^ (-(value & 1n)))

// The value is an envelope around the real data, with a timestamp and a byte list:
// { 0: { 0: true }, 1: { 0: timestamp, 1: { 1: list<int8> } } }
function wrapEnvelope(timestamp, payload) {
    return Buffer.concat([
        Buffer.from([0x43, 0x42, 0x01, 0x00, 0x0a, 0x02, 0x01, 0x00, 0x2a, 0x06]),
        encodeVarint(timestamp),
        Buffer.from([0x2a, 0x2b, 0x0e]),
        encodeVarint(payload.length),
        payload,
        Buffer.from([0x00, 0x00, 0x00])
    ])
}

function readEnvelope(buffer) {
    const reader = new BondReader(buffer)
    reader.readHeader()
    const expect = bytes => {
        for (const byte of bytes) {
            if (reader.readByte() !== byte) throw new Error("Unrecognized Night Light envelope")
        }
    }
    expect([0x0a, 0x02, 0x01, 0x00, 0x2a, 0x06])
    const timestamp = reader.readVarint()
    expect([0x2a, 0x2b, 0x0e])
    const length = Number(reader.readVarint())
    const payload = buffer.subarray(reader.pos, reader.pos + length)
    // Everything gets rewritten on a save, so it has to rebuild exactly
    if (!wrapEnvelope(timestamp, payload).equals(buffer)) throw new Error("Unrecognized Night Light envelope")
    return payload
}

function readFields(payload) {
    const reader = new BondReader(payload)
    reader.readHeader()
    const fields = []
    while (true) {
        const start = reader.pos
        const field = reader.readFieldHeader()
        // The per-device copies end their fields with an end-of-base marker. Anything
        // after it would be a derived struct's fields, which this doesn't handle.
        if (field.stopBase) {
            if (!reader.readFieldHeader().stop) throw new Error("Unrecognized Night Light data")
            return { fields, stopAt: start }
        }
        if (field.stop) return { fields, stopAt: start }
        const valueStart = reader.pos
        reader.skipValue(field.type)
        fields.push({ id: field.id, type: field.type, start, valueStart, end: reader.pos })
    }
}

function readState(buffer) {
    const payload = readEnvelope(buffer)
    const { fields } = readFields(payload)
    const onField = fields.find(field => field.id === STATE_ON_FIELD_ID)
    const transition = fields.find(field => field.id === TRANSITION_FIELD_ID)
    if ((onField && onField.type !== BOND.Int32) || (transition && transition.type !== BOND.UInt64)) {
        throw new Error("Unrecognized Night Light state")
    }
    return { payload, on: !!onField, onField, transition }
}

function readSettings(buffer) {
    const payload = readEnvelope(buffer)
    const { fields, stopAt } = readFields(payload)
    const kelvinField = fields.find(field => field.id === KELVIN_FIELD_ID)
    if (!kelvinField || (kelvinField.type !== BOND.Int16 && kelvinField.type !== BOND.Int32)) {
        throw new Error("Unrecognized Night Light settings")
    }
    const scheduleField = fields.find(field => field.id === SCHEDULE_FIELD_ID && field.type === BOND.Bool)
    const reader = new BondReader(payload)
    reader.pos = kelvinField.valueStart
    return {
        payload,
        fields,
        stopAt,
        kelvin: zigzagDecode(reader.readVarint()),
        scheduleEnabled: !!scheduleField && payload[scheduleField.valueStart] !== 0,
        previewing: fields.some(field => field.id === PREVIEW_FIELD_ID)
    }
}

function timestamps(now) {
    const timestamp = BigInt(Math.floor(now / 1000))
    return {
        timestamp,
        filetime: (timestamp + FILETIME_EPOCH_OFFSET_SECONDS) * FILETIME_TICKS_PER_SECOND + BigInt((now % 1000) * 10000)
    }
}

function patchState(buffer, on, now = Date.now()) {
    const { payload, on: wasOn, onField, transition } = readState(buffer)
    const { timestamp, filetime } = timestamps(now)
    const parts = []
    let cursor = 4
    parts.push(payload.subarray(0, 4))
    if (on && !wasOn) {
        // It has the lowest ID, so it goes straight after the header
        parts.push(STATE_ON_FIELD)
    } else if (!on && wasOn) {
        parts.push(payload.subarray(cursor, onField.start))
        cursor = onField.end
    }
    if (transition) {
        parts.push(payload.subarray(cursor, transition.valueStart), encodeVarint(filetime))
        cursor = transition.end
    }
    parts.push(payload.subarray(cursor))
    return wrapEnvelope(timestamp, Buffer.concat(parts))
}

// kelvin and preview are left as they are when undefined. Every other field is kept byte for byte.
function patchSettings(buffer, { kelvin, preview }, now = Date.now()) {
    const { payload, fields, stopAt } = readSettings(buffer)
    const parts = [payload.subarray(0, 4)]
    let previewWritten = false
    for (const field of fields) {
        // Bond needs its fields in order of ascending ID
        if (preview === true && !previewWritten && field.id > PREVIEW_FIELD_ID) {
            parts.push(PREVIEW_FIELD)
            previewWritten = true
        }
        if (field.id === KELVIN_FIELD_ID && kelvin !== undefined) {
            parts.push(payload.subarray(field.start, field.valueStart), encodeVarint(zigzagEncode(kelvin)))
        } else if (field.id === PREVIEW_FIELD_ID && preview !== undefined) {
            if (preview) {
                parts.push(PREVIEW_FIELD)
                previewWritten = true
            }
        } else {
            parts.push(payload.subarray(field.start, field.end))
        }
    }
    if (preview === true && !previewWritten) parts.push(PREVIEW_FIELD)
    parts.push(payload.subarray(stopAt))
    return wrapEnvelope(timestamps(now).timestamp, Buffer.concat(parts))
}

const kelvinToLevel = kelvin => Math.round(100 - ((Math.max(MIN_KELVIN, Math.min(MAX_KELVIN, kelvin)) - MIN_KELVIN) / (MAX_KELVIN - MIN_KELVIN)) * 100)
const levelToKelvin = level => Math.round(MAX_KELVIN - (level / 100) * (MAX_KELVIN - MIN_KELVIN))

function toLevel(level) {
    const number = (level === null || level === undefined || level === "" ? NaN : Number(level))
    if (!Number.isFinite(number)) throw Object.assign(new Error("A Night Light level has to be a number."), { status: 400 })
    return Math.max(0, Math.min(100, Math.round(number)))
}

// Levels: 1-100 turns Night Light on at that strength. 0 releases it back to Windows,
// which means off, or following the schedule if there is one.
class NightLight extends EventEmitter {
    constructor({ reg, root = CURRENT_KEY, commitDelay = 400, log = console.log }) {
        super()
        this.reg = reg
        this.root = root
        this.commitDelay = commitDelay
        this.log = log
        this.mainCopy = this.copyPaths("default", "")
        this.queue = Promise.resolve()
        this.commitTimer = null
        this.kelvinBeforeDrag = null
        this.error = null
        this.status = this.readStatus()
    }

    readValue(path) {
        try {
            const key = this.reg.openKey(this.reg.HKCU, path, this.reg.Access.READ)
            if (!key) return null
            try {
                const value = this.reg.getValue(key, null, VALUE_NAME)
                return (Buffer.isBuffer(value) ? value : null)
            } finally {
                this.reg.closeKey(key)
            }
        } catch (e) {
            return null
        }
    }

    writeValue(path, buffer) {
        const key = this.reg.openKey(this.reg.HKCU, path, this.reg.Access.ALL_ACCESS)
        if (!key) throw new Error("Couldn't open Night Light's registry key.")
        try {
            this.reg.setValueRaw(key, VALUE_NAME, this.reg.ValueType.BINARY, buffer)
        } finally {
            this.reg.closeKey(key)
        }
    }

    copyPaths(prefix, suffix) {
        return {
            state: `${this.root}\\${prefix}$${STATE_NAME}${suffix}\\${STATE_NAME}${suffix}`,
            settings: `${this.root}\\${prefix}$${SETTINGS_NAME}${suffix}\\${SETTINGS_NAME}${suffix}`
        }
    }

    // Newer Windows builds also keep per-device copies, under a key named after the
    // device's ID, and may use either one, so all of them get changed
    perDeviceCopies() {
        try {
            const key = this.reg.openKey(this.reg.HKCU, this.root, this.reg.Access.READ)
            if (!key) return []
            try {
                const suffix = `$${STATE_NAME}perdevice`
                return this.reg.enumKeyNames(key)
                    .filter(name => name.toLowerCase().endsWith(suffix) && name.length > suffix.length)
                    .map(name => this.copyPaths(name.slice(0, -suffix.length), "perdevice"))
            } finally {
                this.reg.closeKey(key)
            }
        } catch (e) {
            return []
        }
    }

    // Every copy that's there, each with its own paths. A per-device one comes first,
    // as it's the one read back.
    readCopies() {
        const found = []
        for (const copy of [...this.perDeviceCopies(), this.mainCopy]) {
            const state = this.readValue(copy.state)
            const settings = this.readValue(copy.settings)
            if (state && settings) found.push({ ...copy, buffers: { state, settings } })
        }
        return found
    }

    readStatus() {
        const unavailable = reason => ({ supported: false, on: false, level: 0, scheduleEnabled: false, reason, perDevice: false })
        const copies = this.readCopies()
        if (!copies.length) return unavailable("missing")
        try {
            // A copy that can't be read can't be changed either, so then none are
            const parsed = copies.map(({ buffers }) => ({ ...readState(buffers.state), ...readSettings(buffers.settings) }))
            const { on, kelvin, scheduleEnabled } = parsed[0]
            return { supported: true, on, level: (on ? Math.max(1, kelvinToLevel(kelvin)) : 0), scheduleEnabled, reason: null, perDevice: false }
        } catch (e) {
            this.log("Night Light data isn't in a recognized format, so it won't be changed:", e.message)
            return unavailable("format")
        }
    }

    getState() {
        return { ...this.status, adjusting: !!this.commitTimer, error: this.error }
    }

    refresh() {
        this.status = this.readStatus()
    }

    enqueue(task) {
        const result = this.queue.then(task, task)
        this.queue = result.then(() => { }, () => { })
        return result
    }

    // For a slider being dragged: applies right away and saves once it stops moving
    adjust(level) {
        const desired = toLevel(level)
        this.error = null
        clearTimeout(this.commitTimer)
        this.commitTimer = setTimeout(() => this.commitAdjustment(desired), this.commitDelay)
        return this.enqueue(() => this.applyPreview(desired)).catch(e => this.fail(e))
    }

    async commitAdjustment(level) {
        this.commitTimer = null
        try {
            await this.enqueue(() => this.applyLevel(level))
        } catch (e) {
            this.fail(e)
        }
        this.refresh()
        this.emit("changed")
    }

    fail(e) {
        this.log("Couldn't change Night Light:", e.message)
        this.error = e.message
    }

    // Applies a level in one step
    async setLevel(level) {
        const desired = toLevel(level)
        clearTimeout(this.commitTimer)
        this.commitTimer = null
        this.error = null
        try {
            await this.enqueue(() => this.applyLevel(desired))
        } catch (e) {
            this.fail(e)
            throw e
        } finally {
            this.refresh()
            this.emit("changed")
        }
    }

    applyPreview(level) {
        const copies = this.readCopies()
        if (!copies.length) throw new Error("Night Light's settings couldn't be read.")
        const parsed = copies.map(copy => ({ copy, settings: readSettings(copy.buffers.settings), state: readState(copy.buffers.state) }))
        if (this.kelvinBeforeDrag === null) this.kelvinBeforeDrag = parsed[0].settings.kelvin
        // 0 has no temperature to show, and gets dealt with when the drag is saved
        if (level === 0) return
        for (const { copy, state } of parsed) {
            this.writeValue(copy.settings, patchSettings(copy.buffers.settings, { kelvin: levelToKelvin(level), preview: true }))
            // Windows only previews while Night Light is on
            if (!state.on) this.writeValue(copy.state, patchState(copy.buffers.state, true))
        }
    }

    applyLevel(level) {
        // Dragging to 0 passes through almost neutral temperatures, which shouldn't
        // become the strength Windows uses the next time Night Light turns on.
        const restoreKelvin = (level === 0 && this.kelvinBeforeDrag !== null ? this.kelvinBeforeDrag : undefined)

        for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt++) {
            const copies = this.readCopies()
            if (!copies.length) throw new Error("Night Light's settings couldn't be read.")
            const writes = copies.map(({ buffers, state: statePath, settings: settingsPath }) => {
                const state = readState(buffers.state)
                const settings = readSettings(buffers.settings)
                let newSettings = null
                if (level > 0) {
                    newSettings = patchSettings(buffers.settings, { kelvin: levelToKelvin(level), preview: false })
                } else if (settings.previewing || restoreKelvin !== undefined) {
                    newSettings = patchSettings(buffers.settings, { kelvin: restoreKelvin, preview: false })
                }
                const newState = (state.on !== (level > 0) ? patchState(buffers.state, level > 0) : null)
                return { statePath, settingsPath, newSettings, newState }
            })

            // If Windows changed any of them in the meantime, start over from its version
            const latest = this.readCopies()
            const unchanged = latest.length === copies.length && latest.every((copy, i) =>
                copy.buffers.state.equals(copies[i].buffers.state) && copy.buffers.settings.equals(copies[i].buffers.settings))
            if (!unchanged) continue

            for (const { statePath, settingsPath, newSettings, newState } of writes) {
                if (newSettings) this.writeValue(settingsPath, newSettings)
                if (newState) this.writeValue(statePath, newState)
            }

            const status = this.readStatus()
            if (status.supported && status.on === (level > 0) && status.level === level) {
                this.kelvinBeforeDrag = null
                return
            }
        }
        throw new Error("Windows didn't keep the Night Light change.")
    }

    // A crash mid-drag would otherwise leave the preview flag behind
    clearPreview() {
        return this.enqueue(() => {
            let cleared = false
            for (const { settings, buffers } of this.readCopies()) {
                try {
                    if (!readSettings(buffers.settings).previewing) continue
                    this.writeValue(settings, patchSettings(buffers.settings, { preview: false }))
                    cleared = true
                } catch (e) {
                    this.log("Couldn't clear the Night Light preview:", e.message)
                }
            }
            return cleared
        })
    }
}

module.exports = { NightLight, kelvinToLevel, levelToKelvin, readState, readSettings, patchState, patchSettings, wrapEnvelope, readEnvelope }
