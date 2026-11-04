// Reads and changes each display's Windows HDR setting. The native request is based
// on https://github.com/xanderfrangos/twinkle-tray/pull/1313 by stccff.

const CONFIRM_ATTEMPTS = 10
const CONFIRM_INTERVAL_MS = 300

// HDR identifies a display by its device path, without the trailing interface GUID
const hdrPath = devicePath => devicePath.split("#{")[0]

class DisplayHDR {
    constructor({ native, wait = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
        this.native = native
        this.wait = wait
        this.displays = []
    }

    refresh() {
        try {
            this.displays = this.native.getDisplays()
        } catch (e) {
            console.log("Couldn't read HDR state", e.message)
            this.displays = []
        }
    }

    // "on", "off", or "unsupported". Windows only lists active displays, and a
    // display that's mirrored to one without HDR reports that it doesn't support it.
    stateOf(devicePath) {
        const path = hdrPath(devicePath)
        const display = this.displays.find(entry => entry.path === path)
        if (!display?.hdrSupported) return "unsupported"
        return (display.hdrEnabled ? "on" : "off")
    }

    async set(devicePath, on) {
        const wanted = (on ? "on" : "off")
        this.refresh()
        const current = this.stateOf(devicePath)
        if (current === "unsupported") throw new Error("This display can't use HDR right now.")
        if (current === wanted) return

        if (!this.native.setHDR(hdrPath(devicePath), on)) throw new Error("Windows wouldn't change HDR on this display.")

        // The display has to renegotiate its signal, so this can take a moment
        for (let attempt = 0; attempt < CONFIRM_ATTEMPTS; attempt++) {
            await this.wait(CONFIRM_INTERVAL_MS)
            this.refresh()
            if (this.stateOf(devicePath) === wanted) return
        }
        throw new Error("Windows accepted the HDR change, but the display didn't switch.")
    }

    toggle(devicePath) {
        this.refresh()
        return this.set(devicePath, this.stateOf(devicePath) !== "on")
    }
}

module.exports = { DisplayHDR }
