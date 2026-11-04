// Named snapshots of the Windows display layout: which displays are on, where
// they sit, and their resolution and refresh rate.

const fs = require("fs")
const w32disp = require("win32-displayconfig")

class DisplayLayouts {
    constructor(filePath) {
        this.filePath = filePath
        this.layouts = {}
        try {
            if (fs.existsSync(filePath)) this.layouts = JSON.parse(fs.readFileSync(filePath, "utf8")) || {}
        } catch (e) {
            console.log("Couldn't read display layouts", e)
        }
    }

    list() {
        return Object.keys(this.layouts)
    }

    write() {
        fs.writeFileSync(this.filePath, JSON.stringify(this.layouts))
    }

    async save(name) {
        const trimmed = `${name ?? ""}`.trim()
        if (!trimmed) throw new Error("A layout needs a name.")
        this.layouts[trimmed] = await w32disp.displayConfigForRestoration()
        this.write()
    }

    delete(name) {
        delete this.layouts[name]
        this.write()
    }

    async apply(name) {
        const config = this.layouts[name]
        if (!config?.length) throw new Error(`There's no layout named "${name}".`)

        // Restoring only works on displays that are on, so those that the layout
        // needs have to be turned on first.
        const targets = await w32disp.listDisplayTargets()
        for (const { devicePath } of config) {
            const target = targets.find(entry => entry.devicePath === devicePath)
            if (target && !target.active) await w32disp.setDisplayActive({ devicePath, active: true })
        }

        await w32disp.restoreDisplayConfig({ config, persistent: true })
    }
}

module.exports = { DisplayLayouts }
