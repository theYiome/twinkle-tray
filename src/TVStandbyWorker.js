// Sends the TV to standby while the main thread is blocked waiting on a Windows
// shutdown. See NetworkTV.standbyBeforeExit().

const { workerData } = require("worker_threads")
const { PhilipsTV, setTVDiagnostics } = require("./PhilipsTV")
const { TVDiagnostics } = require("./TVDiagnostics")

const { host, deviceId, authKey, backup, apiDown, diagnosticsPath, done } = workerData

function finish(result) {
    Atomics.store(done, 0, result)
    Atomics.notify(done, 0)
}

if (diagnosticsPath) {
    const diagnostics = new TVDiagnostics(diagnosticsPath)
    setTVDiagnostics((event, fields) => diagnostics.write(event, { worker: true, ...fields }))
}

// The main thread only waits 3 seconds, and it can't be waiting on the backup that long. A key
// that may have landed counts as sent, since the TV going off is what's most likely.
const tv = new PhilipsTV(host, { deviceId, authKey, backup, backupOptions: { connectTimeoutMs: 1200, requestTimeoutMs: 1000, lingerMs: 2000, watchTopics: [] } })
tv.standby({ apiDown }).then(() => finish(1), e => finish(e.mayHaveLanded ? 1 : 2))
