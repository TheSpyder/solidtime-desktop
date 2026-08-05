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
    if (event === 'startBreak') {
        window.electronAPI.onStartBreak(() => {
            callback()
        })
    }
    if (event === 'resumeAfterBreak') {
        window.electronAPI.onResumeAfterBreak(() => {
            callback()
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
    if (event === 'startBreak') {
        window.electronAPI.startBreak()
    }
    if (event === 'resumeAfterBreak') {
        window.electronAPI.resumeAfterBreak()
    }
}
