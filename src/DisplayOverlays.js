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

// Windows takes an always-on-top window covering a whole display for a fullscreen app,
// and then drops that display's taskbar below other windows and changes how its tray
// behaves. So a dimming overlay stops one pixel short. A blacked out display is meant
// to be covered completely, taskbar included.
function placementFor({ x, y, width, height }, blackout) {
    return { x, y, width, height: (blackout ? height : Math.max(1, height - 1)) }
}

// A blacked out display takes clicks, since a click on it is how to bring it back. That
// has to work when its taskbar is what's covered, and it keeps clicks off hidden windows.
const OVERLAY_PAGE = "data:text/html,<style>html,body{height:100%25;margin:0;background:%23000}</style><body onmousedown=\"document.title='restore'+Date.now()\"></body>"

class DisplayOverlays {
    constructor({ onRestore = () => { } } = {}) {
        this.onRestore = onRestore
        this.overlays = new Map()
        this.topmostTimer = null
    }

    // Each entry is { key, bounds: { x, y, width, height }, level, blackout }, in physical pixels
    apply(entries) {
        // Mirrored displays share a desktop area, and stacking overlays would dim twice
        const wanted = new Map()
        for (const { key, bounds, level, blackout = false } of entries) {
            if (!bounds || !(level < 100 || blackout)) continue
            const id = `${bounds.x},${bounds.y},${bounds.width},${bounds.height}`
            const existing = wanted.get(id)
            wanted.set(id, {
                bounds,
                level: Math.min(level, existing?.level ?? 100),
                blackout: blackout || !!existing?.blackout,
                keys: [...(existing?.keys ?? []), key]
            })
        }

        for (const [id, overlay] of this.overlays) {
            if (!wanted.has(id)) {
                overlay.window.destroy()
                this.overlays.delete(id)
            }
        }

        for (const [id, { bounds, level, blackout, keys }] of wanted) {
            let overlay = this.overlays.get(id)
            if (!overlay) {
                overlay = { window: this.createWindow(placementFor(bounds, false)), bounds, blackout: false }
                const created = overlay
                overlay.window.webContents.on("page-title-updated", (event, title) => {
                    if (created.blackout && title.startsWith("restore")) this.onRestore(created.keys)
                })
                // Clicks can't reach a page that's gone, so don't leave the screen black
                overlay.window.webContents.on("render-process-gone", () => {
                    if (created.blackout) this.onRestore(created.keys)
                })
                this.overlays.set(id, overlay)
            }
            overlay.keys = keys
            if (overlay.blackout !== blackout) {
                overlay.blackout = blackout
                overlay.window.setIgnoreMouseEvents(!blackout)
                this.place(overlay.window, placementFor(bounds, blackout))
            }
            overlay.window.setOpacity(blackout ? 1 : (100 - Math.max(MINIMUM_DIM_LEVEL, level)) / 100)
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
        window.loadURL(OVERLAY_PAGE)
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
        for (const { window, bounds, blackout } of this.overlays.values()) {
            this.place(window, placementFor(bounds, blackout))
        }
    }

    destroy() {
        this.apply([])
    }
}

module.exports = { DisplayOverlays, placementFor }
