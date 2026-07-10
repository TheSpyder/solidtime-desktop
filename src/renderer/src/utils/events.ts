export async function listenForBackendEvent(event: string, callback: (value?: string) => void) {
    if (event === 'startTimer') {
        window.electronAPI.onStartTimer(() => {
            callback()
        })
    }
    if (event === 'stopTimer') {
        window.electronAPI.onStopTimer((endTime?: string) => {
            callback(endTime)
        })
    }
}

export async function sendEventToWindow(_: string, event: string) {
    if (event === 'startTimer') {
        window.electronAPI.startTimer()
    }
    if (event === 'stopTimer') {
        window.electronAPI.stopTimer()
    }
}
