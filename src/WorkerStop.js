// Stops a child process without waiting on it forever. A worker stuck inside a display
// driver call may not exit when told to, and nothing after a wake can run until this
// returns. Kept apart from the app so this can be tested with a fake child.

const STOP_TIMEOUT_MS = 5000

// Resolves with whether it really exited. If it didn't, it's left behind and the caller
// carries on without it. Rejects if it can't even be told to exit.
function stopChild(child, { timeoutMs = STOP_TIMEOUT_MS } = {}) {
    return new Promise((resolve, reject) => {
        let timeout
        const cleanup = () => {
            clearTimeout(timeout)
            child.removeListener("exit", handleExit)
            child.removeListener("close", handleExit)
        }
        const handleExit = () => {
            cleanup()
            resolve(true)
        }

        child.once("exit", handleExit)
        child.once("close", handleExit)
        timeout = setTimeout(() => {
            cleanup()
            resolve(false)
        }, timeoutMs)

        try {
            if (!child.kill()) {
                if (child.exitCode !== null) {
                    handleExit()
                } else {
                    cleanup()
                    reject(new Error("Child process could not be terminated."))
                }
            }
        } catch (error) {
            cleanup()
            reject(error)
        }
    })
}

module.exports = { stopChild, STOP_TIMEOUT_MS }
