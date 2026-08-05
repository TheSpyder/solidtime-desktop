import { ipcMain } from 'electron'

// Shared timer-running state, updated by the renderer via 'timerStateChanged'.
// Consumed by the idle monitor (suppress dialog when no timer runs) and the
// workday monitor (only prompt when no timer runs).

let timerRunning = false

export function registerTimerStateListener() {
    ipcMain.on('timerStateChanged', (_event, running: boolean) => {
        timerRunning = running
        console.log('Timer state changed:', running)
    })
}

export function isTimerRunning(): boolean {
    return timerRunning
}
