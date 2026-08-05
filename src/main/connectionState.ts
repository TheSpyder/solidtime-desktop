import { ipcMain } from 'electron'

// Whether the renderer has a working, authenticated server connection,
// updated via 'connectionStateChanged'. The monitors subscribe so they run
// only during an active session: a logged-out app never prompts and never
// records. The signal does not flap on transient refetch failures (the
// renderer's query data persists), so there is no start/stop churn.

let sessionActive = false
const listeners: Array<(active: boolean) => void> = []

export function registerConnectionStateListener() {
    ipcMain.on('connectionStateChanged', (_event, connected: boolean) => {
        if (connected === sessionActive) return
        sessionActive = connected
        console.log('Connection state changed:', connected)
        for (const listener of listeners) {
            listener(connected)
        }
    })
}

export function isSessionActive(): boolean {
    return sessionActive
}

export function onSessionStateChanged(listener: (active: boolean) => void) {
    listeners.push(listener)
}
