// Sends the TV to standby while the main thread is blocked waiting on a Windows
// shutdown. See NetworkTV.standbyBeforeExit().

const { workerData } = require("worker_threads")
const { PhilipsTV } = require("./PhilipsTV")

const { host, deviceId, authKey, done } = workerData

function finish(result) {
    Atomics.store(done, 0, result)
    Atomics.notify(done, 0)
}

new PhilipsTV(host, { deviceId, authKey }).sendKey("Standby").then(() => finish(1), () => finish(2))
