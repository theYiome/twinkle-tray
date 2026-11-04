import React, { useEffect, useState } from "react"
import Slider from "./Slider"
import { SettingsOption, SettingsChild } from "./SettingsOption"

const send = (command, args) => window.sendDisplayControl(command, args)

function TVPairing({ T, tv }) {
    const [host, setHost] = useState(tv.host ?? "")
    const [found, setFound] = useState([])
    const [searching, setSearching] = useState(false)
    const [secondsLeft, setSecondsLeft] = useState(0)
    const [pin, setPin] = useState("")
    const [error, setError] = useState(false)

    useEffect(() => {
        if (secondsLeft <= 0) return
        const timeout = setTimeout(() => {
            if (secondsLeft === 1) setError(T.t("SETTINGS_TV_PIN_EXPIRED"))
            setSecondsLeft(secondsLeft - 1)
        }, 1000)
        return () => clearTimeout(timeout)
    }, [secondsLeft])

    const search = async () => {
        setSearching(true)
        setError(false)
        const response = await send("tv.discover")
        setSearching(false)
        if (!response.ok) return setError(response.error)
        setFound(response.result)
        if (response.result.length) {
            setHost(response.result[0].host)
        } else {
            setError(T.t("SETTINGS_TV_NOT_FOUND"))
        }
    }

    const startPairing = async () => {
        setError(false)
        const response = await send("tv.pairStart", { host: host.trim() })
        if (!response.ok) return setError(T.t("SETTINGS_TV_PAIR_FAILED", response.error))
        setPin("")
        setSecondsLeft(response.result)
    }

    const finishPairing = async () => {
        setError(false)
        const response = await send("tv.pairFinish", { pin: pin.trim() })
        if (!response.ok) return setError(T.t("SETTINGS_TV_PAIR_FAILED", response.error))
        setSecondsLeft(0)
    }

    return (
        <SettingsOption title={T.t("SETTINGS_TV_PAIR_TITLE")} description={T.t("SETTINGS_TV_PAIR_DESC")} startExpanded={true} expandable={true}>
            <SettingsChild>
                <div className="input-row display-control-row">
                    <input type="text" value={host} placeholder={T.t("SETTINGS_TV_ADDRESS_PLACEHOLDER")} onChange={e => setHost(e.target.value)} />
                    <a className="button" onClick={search}>{searching ? T.t("SETTINGS_TV_SEARCHING") : T.t("SETTINGS_TV_SEARCH")}</a>
                    <a className="button button-primary" onClick={startPairing}>{T.t("SETTINGS_TV_PAIR")}</a>
                </div>
                {found.map(tvFound => <div key={tvFound.host} className="option-description">{tvFound.name} ({tvFound.host})</div>)}
                {secondsLeft > 0 ? (
                    <div className="input-row display-control-row">
                        <input type="text" value={pin} autoFocus={true} placeholder={T.t("SETTINGS_TV_PIN_PLACEHOLDER", secondsLeft)} onChange={e => setPin(e.target.value)} onKeyDown={e => { if (e.key === "Enter") finishPairing() }} />
                        <a className="button button-primary" onClick={finishPairing}>{T.t("SETTINGS_TV_CONFIRM")}</a>
                    </div>
                ) : null}
                {error ? <div className="option-description display-control-error">{error}</div> : null}
            </SettingsChild>
        </SettingsOption>
    )
}

function PairedTV({ T, tv, displays }) {
    const toggle = (setting, checked) => (
        <div className="inputToggle-generic" data-textside="right">
            <input type="checkbox" checked={checked} data-checked={checked} onChange={e => send("tv.setOptions", { [setting]: e.target.checked })} />
            <div className="text">{checked ? T.t("GENERIC_ON") : T.t("GENERIC_OFF")}</div>
        </div>
    )

    return (
        <>
            <SettingsOption title={tv.name || T.t("PANEL_TV_NAME")} description={tv.host} input={<a className="button" onClick={() => send("tv.forget")}>{T.t("SETTINGS_TV_FORGET")}</a>} />
            <SettingsOption title={T.t("SETTINGS_TV_DISPLAY_TITLE")} description={T.t("SETTINGS_TV_DISPLAY_DESC")} input={(
                <select value={tv.displayPath} onChange={e => send("tv.setOptions", { displayPath: e.target.value })}>
                    <option value="">{T.t("SETTINGS_TV_DISPLAY_NONE")}</option>
                    {displays.map(display => <option key={display.devicePath} value={display.devicePath}>{display.name}</option>)}
                </select>
            )} />
            <SettingsOption title={T.t("SETTINGS_TV_WAKE_TITLE")} description={T.t("SETTINGS_TV_WAKE_DESC")} input={toggle("wakeOnStartup", tv.wakeOnStartup)} />
            <SettingsOption title={T.t("SETTINGS_TV_STANDBY_TITLE")} description={T.t("SETTINGS_TV_STANDBY_DESC")} input={toggle("standbyOnShutdown", tv.standbyOnShutdown)} />
            <SettingsOption title={T.t("SETTINGS_TV_AUTO_TITLE")} description={T.t("SETTINGS_TV_AUTO_DESC")} input={toggle("autoDisconnect", tv.autoDisconnect)} />
        </>
    )
}

function DisplayRow({ T, display }) {
    const [error, setError] = useState(false)
    const run = async (command, args) => {
        setError(false)
        const response = await send(command, { key: display.key, ...args })
        if (!response.ok) setError(response.error)
    }

    const status = (!display.active
        ? T.t("SETTINGS_DISPLAYS_OFF")
        : display.mirroredWith.length
            ? T.t("SETTINGS_DISPLAYS_MIRRORED", display.mirroredWith.join(", "))
            : T.t("SETTINGS_DISPLAYS_ON"))

    return (
        <SettingsOption title={display.name} description={status} startExpanded={true} expandable={true} input={(
            <a className="button" onClick={() => run("display.setActive", { active: !display.active })}>{display.active ? T.t("PANEL_TV_DISCONNECT") : T.t("PANEL_TV_CONNECT")}</a>
        )}>
            {display.active ? (
                <SettingsChild title={T.t("SETTINGS_DISPLAYS_DIM_TITLE")} description={T.t("SETTINGS_DISPLAYS_DIM_DESC")}>
                    <Slider level={display.dim} min={5} max={100} onChange={level => run("display.dim", { level })} scrollAmount={2} />
                </SettingsChild>
            ) : null}
            {display.active ? (
                <SettingsChild title={T.t("SETTINGS_DISPLAYS_MOVE_TITLE")} input={<a className="button" onClick={() => run("display.moveWindows")}>{T.t("PANEL_TV_MOVE_WINDOWS")}</a>} />
            ) : null}
            {error ? <SettingsChild description={error} /> : null}
        </SettingsOption>
    )
}

function Layouts({ T, layouts }) {
    const [name, setName] = useState("")
    const [error, setError] = useState(false)
    const run = async (command, args) => {
        setError(false)
        const response = await send(command, args)
        if (!response.ok) setError(response.error)
        return response.ok
    }

    return (
        <SettingsOption title={T.t("SETTINGS_LAYOUTS_TITLE")} description={T.t("SETTINGS_LAYOUTS_DESC")} startExpanded={true} expandable={true}>
            <SettingsChild>
                <div className="input-row display-control-row">
                    <input type="text" value={name} placeholder={T.t("SETTINGS_LAYOUTS_NAME_PLACEHOLDER")} onChange={e => setName(e.target.value)} />
                    <a className="button button-primary" onClick={async () => { if (await run("layout.save", { name })) setName("") }}>{T.t("SETTINGS_LAYOUTS_SAVE")}</a>
                </div>
                {error ? <div className="option-description display-control-error">{error}</div> : null}
            </SettingsChild>
            {layouts.map(layout => (
                <SettingsChild key={layout} title={layout} input={(
                    <div className="display-control-row">
                        <a className="button button-primary" onClick={() => run("layout.apply", { name: layout })}>{T.t("SETTINGS_LAYOUTS_APPLY")}</a>
                        <a className="button" onClick={() => run("layout.delete", { name: layout })}>{T.t("GENERIC_DELETE")}</a>
                    </div>
                )} />
            ))}
        </SettingsOption>
    )
}

function LocalAPISettings({ T, api }) {
    const [token, setToken] = useState(false)
    const [port, setPort] = useState(api.port)
    const [error, setError] = useState(false)

    const configure = async args => {
        setError(false)
        const response = await send("api.configure", args)
        if (!response.ok) setError(response.error)
    }
    const showToken = async command => {
        const response = await send(command)
        if (response.ok) setToken(response.result)
    }

    return (
        <SettingsOption title={T.t("SETTINGS_API_TITLE")} description={T.t("SETTINGS_API_DESC")} expandable={true} startExpanded={api.enabled} input={(
            <div className="inputToggle-generic" data-textside="right">
                <input type="checkbox" checked={api.enabled} data-checked={api.enabled} onChange={e => configure({ enabled: e.target.checked })} />
                <div className="text">{api.enabled ? T.t("GENERIC_ON") : T.t("GENERIC_OFF")}</div>
            </div>
        )}>
            <SettingsChild title={T.t("SETTINGS_API_PORT")} input={<input type="number" min="1024" max="65535" value={port} onChange={e => setPort(e.target.value)} onBlur={() => configure({ port })} />} />
            <SettingsChild title={T.t("SETTINGS_API_TOKEN")} description={token || T.t("SETTINGS_API_TOKEN_HIDDEN")} input={(
                <div className="display-control-row">
                    <a className="button" onClick={() => showToken("api.getToken")}>{T.t("SETTINGS_API_SHOW")}</a>
                    <a className="button" onClick={() => showToken("api.resetToken")}>{T.t("SETTINGS_API_RESET")}</a>
                </div>
            )} />
            <SettingsChild description={`curl -H "Authorization: Bearer <token>" http://127.0.0.1:${api.port}/status`} />
            {api.error || error ? <SettingsChild description={api.error || error} /> : null}
        </SettingsOption>
    )
}

export default function DisplayControlSettings({ T }) {
    const [control, setControl] = useState(window.displayControl)

    useEffect(() => {
        const handleUpdate = e => setControl(e.detail)
        window.addEventListener("displayControlUpdated", handleUpdate)
        window.ipc.send("request-display-control")
        return () => window.removeEventListener("displayControlUpdated", handleUpdate)
    }, [])

    if (!control) return null
    const { tv, displays, layouts, api } = control

    return (
        <>
            <div className="pageSection">
                <div className="sectionTitle">{T.t("SETTINGS_TV_TITLE")}</div>
                {tv.paired ? <PairedTV T={T} tv={tv} displays={displays} /> : <TVPairing T={T} tv={tv} />}
            </div>
            <div className="pageSection">
                <div className="sectionTitle">{T.t("GENERIC_ALL_DISPLAYS")}</div>
                {displays.map(display => <DisplayRow key={display.devicePath} T={T} display={display} />)}
            </div>
            <div className="pageSection">
                <Layouts T={T} layouts={layouts} />
                <LocalAPISettings T={T} api={api} />
            </div>
        </>
    )
}
