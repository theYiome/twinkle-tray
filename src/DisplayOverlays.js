// Dims a display with a black, click-through window on top of it. Unlike a gamma
// ramp this works in HDR and can go nearly black, but it can't reach exclusive
// fullscreen apps, and it dims the pixels rather than the panel.

const { BrowserWindow, screen } = require("electron")
const { WindowUtils } = require("tt-windows-utils")
const { MINIMUM_DIM_LEVEL } = require("./DimRange")

const HWND_TOPMOST = -1
const SWP_NOACTIVATE = 0x0010
const TOPMOST_CHECK_MS = 5000
const PLACEMENT_RETRY_MS = 250

class DisplayOverlays {
    constructor() {
        this.overlays = new Map()
        this.topmostTimer = null
    }

    // Each entry is { bounds: { x, y, width, height }, level }, in physical pixels
    apply(entries) {
        // Mirrored displays share a desktop area, and stacking overlays would dim twice
        const wanted = new Map()
        for (const { bounds, level } of entries) {
            if (!bounds || !(level < 100)) continue
            const id = `${bounds.x},${bounds.y},${bounds.width},${bounds.height}`
            const existing = wanted.get(id)
            wanted.set(id, { bounds, level: Math.min(level, existing?.level ?? 100) })
        }

        for (const [id, overlay] of this.overlays) {
            if (!wanted.has(id)) {
                overlay.window.destroy()
                this.overlays.delete(id)
            }
        }

        for (const [id, { bounds, level }] of wanted) {
            let overlay = this.overlays.get(id)
            if (!overlay) {
                overlay = { window: this.createWindow(bounds), bounds }
                this.overlays.set(id, overlay)
            }
            overlay.window.setOpacity((100 - Math.max(MINIMUM_DIM_LEVEL, level)) / 100)
        }

        if (this.overlays.size && !this.topmostTimer) {
            this.topmostTimer = setInterval(() => this.stayOnTop(), TOPMOST_CHECK_MS)
        } else if (!this.overlays.size && this.topmostTimer) {
            clearInterval(this.topmostTimer)
            this.topmostTimer = null
        }
    }

    createWindow(bounds) {
        const window = new BrowserWindow({
            ...screen.screenToDipRect(null, bounds),
            show: false,
            enableLargerThanScreen: true,
            frame: false,
            thickFrame: false,
            hasShadow: false,
            // Not resizable or movable by the user anyway, since it ignores the
            // mouse. Turning these off would make it refuse exact placement.
            minimizable: false,
            maximizable: false,
            fullscreenable: false,
            focusable: false,
            skipTaskbar: true,
            backgroundColor: "#000000",
            webPreferences: {
                sandbox: true,
                devTools: false
            }
        })
        window.setIgnoreMouseEvents(true)
        window.setAlwaysOnTop(true, "screen-saver")
        // Screenshots and screen sharing should show the real picture
        window.setContentProtection(true)
        window.loadURL("data:text/html,<body style='background:%23000'></body>")
        window.setOpacity(0)
        window.showInactive()
        this.place(window, bounds)
        // Crossing onto a display with different scaling makes Windows resize the
        // window to match, so it only lands correctly once it's already there.
        setTimeout(() => {
            if (!window.isDestroyed()) this.place(window, bounds)
        }, PLACEMENT_RETRY_MS)
        return window
    }

    // Electron positions windows in scaled units, which don't line up across
    // displays with different scaling. The native call takes physical pixels.
    place(window, { x, y, width, height }) {
        WindowUtils.setWindowPos(window.getNativeWindowHandle().readBigUInt64LE(), HWND_TOPMOST, x, y, width, height, SWP_NOACTIVATE)
    }

    stayOnTop() {
        for (const { window, bounds } of this.overlays.values()) {
            this.place(window, bounds)
        }
    }

    destroy() {
        this.apply([])
    }
}

module.exports = { DisplayOverlays }
