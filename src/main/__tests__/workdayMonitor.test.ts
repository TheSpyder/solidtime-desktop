import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
    powerMonitorOn: vi.fn(),
    getSystemIdleTime: vi.fn(() => 0),
    ipcMainOn: vi.fn(),
    ipcMainHandle: vi.fn(),
    showMessageBox: vi.fn(),
    flashFrame: vi.fn(),
    webContentsSend: vi.fn(),
    getAppSettings: vi.fn(),
    getSetting: vi.fn(),
    setSetting: vi.fn(),
    getIdleThresholdSeconds: vi.fn(() => 300),
    suppressNextIdleDialog: vi.fn(),
    isTimerRunning: vi.fn(() => false),
}))

vi.mock('electron', () => ({
    powerMonitor: {
        on: mocks.powerMonitorOn,
        getSystemIdleTime: mocks.getSystemIdleTime,
    },
    ipcMain: {
        on: mocks.ipcMainOn,
        handle: mocks.ipcMainHandle,
    },
    dialog: {
        showMessageBox: mocks.showMessageBox,
    },
}))

vi.mock('../mainWindow', () => ({
    getMainWindow: () => ({
        flashFrame: mocks.flashFrame,
        webContents: { send: mocks.webContentsSend },
    }),
}))

vi.mock('../settings', () => ({
    getAppSettings: mocks.getAppSettings,
    getSetting: mocks.getSetting,
    setSetting: mocks.setSetting,
}))

vi.mock('../idleMonitor', async () => {
    const { default: dayjs } = await import('dayjs')
    return {
        getIdleThresholdSeconds: mocks.getIdleThresholdSeconds,
        suppressNextIdleDialog: mocks.suppressNextIdleDialog,
        // Mirror the real implementation against the mocked system idle time
        lastInputTime: () => dayjs().subtract(mocks.getSystemIdleTime(), 'seconds'),
    }
})

vi.mock('../timerState', () => ({
    isTimerRunning: mocks.isTimerRunning,
}))

const DEFAULT_WORKDAY_SETTINGS = {
    widgetActivated: true,
    trayTimerActivated: true,
    idleDetectionEnabled: true,
    idleThresholdMinutes: 5,
    activityTrackingEnabled: false,
    workdayTrackingEnabled: true,
    workdayReminderThresholdMinutes: 10,
    workdayDays: [1, 2, 3, 4, 5],
    workdayStartTime: '09:00',
    workdayEndTime: '17:00',
}

// Wednesday, 10:00 local time — inside the default Mon-Fri 09:00-17:00 schedule
const WEDNESDAY_10AM = new Date(2026, 6, 8, 10, 0, 0)

function getPowerHandler(event: string): () => void {
    const call = mocks.powerMonitorOn.mock.calls.find(([name]) => name === event)
    if (!call) throw new Error(`No powerMonitor handler registered for ${event}`)
    return call[1]
}

function getSettingsIpcHandler(): (event: unknown, settings: unknown) => void {
    const call = mocks.ipcMainOn.mock.calls.find(([channel]) => channel === 'updateWorkdaySettings')
    if (!call) throw new Error('No updateWorkdaySettings handler registered')
    return call[1]
}

function getPendingStopIpcHandler(): () => string | null {
    const call = mocks.ipcMainHandle.mock.calls.find(
        ([channel]) => channel === 'getPendingWorkdayStop'
    )
    if (!call) throw new Error('No getPendingWorkdayStop handler registered')
    return call[1]
}

function sendsTo(channel: string): unknown[][] {
    return mocks.webContentsSend.mock.calls.filter(([c]) => c === channel)
}

async function initialize(settingsOverrides = {}, startTime: Date = WEDNESDAY_10AM) {
    vi.setSystemTime(startTime)
    mocks.getAppSettings.mockResolvedValue({
        ...DEFAULT_WORKDAY_SETTINGS,
        ...settingsOverrides,
    })
    const { initializeWorkdayMonitor } = await import('../workdayMonitor')
    await initializeWorkdayMonitor()
}

async function advanceMinutes(minutes: number) {
    await vi.advanceTimersByTimeAsync(minutes * 60 * 1000)
}

describe('workdayMonitor reminder', () => {
    beforeEach(() => {
        vi.resetModules()
        vi.clearAllMocks()
        vi.useFakeTimers()
        mocks.getSystemIdleTime.mockReturnValue(0)
        mocks.getIdleThresholdSeconds.mockReturnValue(300)
        mocks.isTimerRunning.mockReturnValue(false)
        mocks.getSetting.mockResolvedValue(null)
        mocks.setSetting.mockResolvedValue(undefined)
        // Dialog stays open unless a test resolves it
        mocks.showMessageBox.mockReturnValue(new Promise(() => {}))
    })

    afterEach(() => {
        vi.useRealTimers()
    })

    it('prompts after the active threshold with no timer running', async () => {
        await initialize()

        await advanceMinutes(9)
        expect(mocks.showMessageBox).not.toHaveBeenCalled()

        await advanceMinutes(2)
        expect(mocks.showMessageBox).toHaveBeenCalledTimes(1)
        // Only one dialog while waiting for a response
        await advanceMinutes(15)
        expect(mocks.showMessageBox).toHaveBeenCalledTimes(1)
    })

    it('starting the timer backdates to the beginning of the streak', async () => {
        mocks.showMessageBox.mockResolvedValue({ response: 0 })
        await initialize()

        await advanceMinutes(11)

        const responses = sendsTo('workdayReminderResponse')
        expect(responses).toHaveLength(1)
        const payload = responses[0][1] as { choice: number; activeSince: string }
        expect(payload.choice).toBe(0)
        // Streak started at the first tick after initialization (within seconds
        // of 10:00), so the backdated start must be close to it
        const activeSinceMs = new Date(payload.activeSince).getTime()
        expect(activeSinceMs - WEDNESDAY_10AM.getTime()).toBeGreaterThanOrEqual(0)
        expect(activeSinceMs - WEDNESDAY_10AM.getTime()).toBeLessThanOrEqual(10_000)
    })

    it('does not prompt while a timer is running', async () => {
        mocks.isTimerRunning.mockReturnValue(true)
        await initialize()

        await advanceMinutes(30)
        expect(mocks.showMessageBox).not.toHaveBeenCalled()
    })

    it('starts a fresh streak after a timer stops', async () => {
        mocks.isTimerRunning.mockReturnValue(true)
        await initialize()
        await advanceMinutes(30)

        mocks.isTimerRunning.mockReturnValue(false)
        await advanceMinutes(9)
        expect(mocks.showMessageBox).not.toHaveBeenCalled()
        await advanceMinutes(2)
        expect(mocks.showMessageBox).toHaveBeenCalledTimes(1)
    })

    it('does not prompt on unmonitored days', async () => {
        // Saturday, 10:00
        await initialize({}, new Date(2026, 6, 11, 10, 0, 0))

        await advanceMinutes(30)
        expect(mocks.showMessageBox).not.toHaveBeenCalled()
    })

    it('does not prompt outside the time-of-day window', async () => {
        // Wednesday, 18:00 — after the 17:00 end
        await initialize({}, new Date(2026, 6, 8, 18, 0, 0))

        await advanceMinutes(30)
        expect(mocks.showMessageBox).not.toHaveBeenCalled()
    })

    it('activity before the window prompts at window open, backdated to the true start', async () => {
        mocks.showMessageBox.mockResolvedValue({ response: 0 })
        // Wednesday, 08:30 — half an hour before the window opens
        const preWindowStart = new Date(2026, 6, 8, 8, 30, 0)
        await initialize({}, preWindowStart)

        // Threshold met long before 09:00 but no prompt outside the window
        await advanceMinutes(29)
        expect(mocks.showMessageBox).not.toHaveBeenCalled()

        // Crossing 09:00 prompts immediately
        await advanceMinutes(2)
        expect(mocks.showMessageBox).toHaveBeenCalledTimes(1)

        // Backdated to the real streak start before the window, not to 09:00
        const payload = sendsTo('workdayReminderResponse')[0][1] as { activeSince: string }
        const activeSinceMs = new Date(payload.activeSince).getTime()
        expect(activeSinceMs - preWindowStart.getTime()).toBeGreaterThanOrEqual(0)
        expect(activeSinceMs - preWindowStart.getTime()).toBeLessThanOrEqual(10_000)
    })

    it('an idle gap longer than the idle threshold breaks the streak', async () => {
        await initialize()

        await advanceMinutes(8)
        // User walks away: idle exceeds the 300s idle threshold
        mocks.getSystemIdleTime.mockReturnValue(400)
        await advanceMinutes(1)
        // User returns
        mocks.getSystemIdleTime.mockReturnValue(0)

        // A full new threshold is required; 8 earlier minutes don't count
        await advanceMinutes(9)
        expect(mocks.showMessageBox).not.toHaveBeenCalled()
        await advanceMinutes(2)
        expect(mocks.showMessageBox).toHaveBeenCalledTimes(1)
    })

    it('"Not Now" snoozes for a full threshold but keeps the streak start', async () => {
        mocks.showMessageBox.mockResolvedValueOnce({ response: 1 })
        mocks.showMessageBox.mockResolvedValueOnce({ response: 0 })
        await initialize()

        // First prompt at ~10 minutes, answered "Not Now"
        await advanceMinutes(11)
        expect(mocks.showMessageBox).toHaveBeenCalledTimes(1)
        expect(sendsTo('workdayReminderResponse')).toHaveLength(0)

        // Second prompt after another threshold, answered "Start Timer"
        await advanceMinutes(11)
        expect(mocks.showMessageBox).toHaveBeenCalledTimes(2)
        const responses = sendsTo('workdayReminderResponse')
        expect(responses).toHaveLength(1)

        // Backdated to the original streak start, not the snooze time
        const payload = responses[0][1] as { activeSince: string }
        const activeSinceMs = new Date(payload.activeSince).getTime()
        expect(activeSinceMs - WEDNESDAY_10AM.getTime()).toBeLessThanOrEqual(10_000)
    })

    it('a lock shorter than the idle threshold preserves the streak', async () => {
        mocks.showMessageBox.mockResolvedValue({ response: 0 })
        await initialize()

        await advanceMinutes(8)
        getPowerHandler('lock-screen')()
        await advanceMinutes(2)
        getPowerHandler('unlock-screen')()

        // 8 active + 2 locked + 1 active = threshold met with the original start
        await advanceMinutes(1)
        expect(mocks.showMessageBox).toHaveBeenCalledTimes(1)

        const payload = sendsTo('workdayReminderResponse')[0][1] as { activeSince: string }
        const activeSinceMs = new Date(payload.activeSince).getTime()
        expect(activeSinceMs - WEDNESDAY_10AM.getTime()).toBeLessThanOrEqual(10_000)
    })

    it('a lock longer than the idle threshold resets the streak', async () => {
        mocks.showMessageBox.mockResolvedValue({ response: 0 })
        await initialize()

        await advanceMinutes(8)
        getPowerHandler('lock-screen')()
        await advanceMinutes(6)
        getPowerHandler('unlock-screen')()
        const unlockTime = Date.now()

        await advanceMinutes(9)
        expect(mocks.showMessageBox).not.toHaveBeenCalled()
        await advanceMinutes(2)
        expect(mocks.showMessageBox).toHaveBeenCalledTimes(1)

        // Backdate must not reach before the unlock, even though the system
        // idle time is mocked as 0 the entire time
        const payload = sendsTo('workdayReminderResponse')[0][1] as { activeSince: string }
        expect(new Date(payload.activeSince).getTime()).toBeGreaterThanOrEqual(unlockTime)
    })

    it('can be disabled and re-enabled at runtime via IPC', async () => {
        await initialize()
        const updateSettings = getSettingsIpcHandler()

        updateSettings(null, {
            enabled: false,
            reminderThresholdMinutes: 10,
            days: [1, 2, 3, 4, 5],
            startTime: '09:00',
            endTime: '17:00',
        })
        await advanceMinutes(30)
        expect(mocks.showMessageBox).not.toHaveBeenCalled()

        updateSettings(null, {
            enabled: true,
            reminderThresholdMinutes: 5,
            days: [1, 2, 3, 4, 5],
            startTime: '09:00',
            endTime: '17:00',
        })
        await advanceMinutes(6)
        expect(mocks.showMessageBox).toHaveBeenCalledTimes(1)
    })

    it('does not start monitoring when disabled in settings', async () => {
        await initialize({ workdayTrackingEnabled: false })

        await advanceMinutes(30)
        expect(mocks.showMessageBox).not.toHaveBeenCalled()
    })
})

describe('workdayMonitor boundary auto-stop', () => {
    beforeEach(() => {
        vi.resetModules()
        vi.clearAllMocks()
        vi.useFakeTimers()
        mocks.getSystemIdleTime.mockReturnValue(0)
        mocks.getIdleThresholdSeconds.mockReturnValue(300)
        mocks.isTimerRunning.mockReturnValue(true)
        mocks.getSetting.mockResolvedValue(null)
        mocks.setSetting.mockResolvedValue(undefined)
        mocks.showMessageBox.mockReturnValue(new Promise(() => {}))
    })

    afterEach(() => {
        vi.useRealTimers()
    })

    it('stops the timer when suspending outside the workday window', async () => {
        // Wednesday, 18:00 — after the workday ended
        await initialize({}, new Date(2026, 6, 8, 18, 0, 0))

        await advanceMinutes(5)
        const suspendTime = Date.now()
        getPowerHandler('suspend')()
        await advanceMinutes(30)
        getPowerHandler('resume')()

        const stops = sendsTo('stopTimer')
        expect(stops).toHaveLength(1)
        const endTimeMs = new Date(stops[0][1] as string).getTime()
        expect(Math.abs(endTimeMs - suspendTime)).toBeLessThanOrEqual(1000)
        expect(mocks.suppressNextIdleDialog).toHaveBeenCalledTimes(1)
    })

    it('ends the auto-stop at the last input, not the block time', async () => {
        // Wednesday, 18:00 — after the workday ended
        await initialize({}, new Date(2026, 6, 8, 18, 0, 0))

        await advanceMinutes(5)
        // User has been idle for 3 minutes when the machine suspends
        mocks.getSystemIdleTime.mockReturnValue(180)
        const lastInput = Date.now() - 180 * 1000
        getPowerHandler('suspend')()
        mocks.getSystemIdleTime.mockReturnValue(0)
        await advanceMinutes(30)
        getPowerHandler('resume')()

        const stops = sendsTo('stopTimer')
        expect(stops).toHaveLength(1)
        const endTimeMs = new Date(stops[0][1] as string).getTime()
        expect(Math.abs(endTimeMs - lastInput)).toBeLessThanOrEqual(1000)
    })

    it('persists the pending stop at suspend and clears it on resume', async () => {
        await initialize({}, new Date(2026, 6, 8, 18, 0, 0))

        getPowerHandler('suspend')()
        expect(mocks.setSetting).toHaveBeenCalledWith(
            'workday_pending_stop',
            expect.stringContaining('2026')
        )

        getPowerHandler('resume')()
        expect(mocks.setSetting).toHaveBeenCalledWith('workday_pending_stop', '')
    })

    it('does not stop the timer for a sleep contained in the workday window', async () => {
        await initialize() // Wednesday 10:00

        await advanceMinutes(5)
        getPowerHandler('suspend')()
        await advanceMinutes(30)
        getPowerHandler('resume')()

        expect(sendsTo('stopTimer')).toHaveLength(0)
        expect(mocks.suppressNextIdleDialog).not.toHaveBeenCalled()
    })

    it('stops the timer when a sleep crosses the window end', async () => {
        // Wednesday, 16:00 — inside the window
        await initialize({}, new Date(2026, 6, 8, 16, 0, 0))

        await advanceMinutes(30)
        const suspendTime = Date.now()
        getPowerHandler('suspend')()
        // Sleeps until 20:00, past the 17:00 window end
        await advanceMinutes(210)
        getPowerHandler('resume')()

        const stops = sendsTo('stopTimer')
        expect(stops).toHaveLength(1)
        const endTimeMs = new Date(stops[0][1] as string).getTime()
        expect(Math.abs(endTimeMs - suspendTime)).toBeLessThanOrEqual(1000)
    })

    it('stops the old timer when a sleep runs into the next workday', async () => {
        // Wednesday, 14:00
        await initialize({}, new Date(2026, 6, 8, 14, 0, 0))

        const suspendTime = Date.now()
        getPowerHandler('suspend')()
        // Wakes Thursday 10:00, inside the next workday window
        await advanceMinutes(20 * 60)
        getPowerHandler('resume')()

        const stops = sendsTo('stopTimer')
        expect(stops).toHaveLength(1)
        const endTimeMs = new Date(stops[0][1] as string).getTime()
        expect(Math.abs(endTimeMs - suspendTime)).toBeLessThanOrEqual(1000)
    })

    it('defers the boundary evaluation until unlock when resuming locked', async () => {
        // Wednesday, 16:50 — locks, then sleeps through the window end
        await initialize({}, new Date(2026, 6, 8, 16, 50, 0))

        const lockTime = Date.now()
        getPowerHandler('lock-screen')()
        getPowerHandler('suspend')()
        await advanceMinutes(40)
        getPowerHandler('resume')()
        // Still locked: no decision yet
        expect(sendsTo('stopTimer')).toHaveLength(0)

        await advanceMinutes(5)
        getPowerHandler('unlock-screen')()

        // Stopped at the lock time (the first block), not the suspend time
        const stops = sendsTo('stopTimer')
        expect(stops).toHaveLength(1)
        const endTimeMs = new Date(stops[0][1] as string).getTime()
        expect(Math.abs(endTimeMs - lockTime)).toBeLessThanOrEqual(1000)
    })

    it('does not stop anything when no timer is running', async () => {
        mocks.isTimerRunning.mockReturnValue(false)
        await initialize({}, new Date(2026, 6, 8, 18, 0, 0))

        getPowerHandler('suspend')()
        await advanceMinutes(30)
        getPowerHandler('resume')()

        expect(sendsTo('stopTimer')).toHaveLength(0)
    })

    it('does not stop anything when workday tracking is disabled', async () => {
        await initialize({ workdayTrackingEnabled: false }, new Date(2026, 6, 8, 18, 0, 0))

        getPowerHandler('suspend')()
        await advanceMinutes(30)
        getPowerHandler('resume')()

        expect(sendsTo('stopTimer')).toHaveLength(0)
        expect(mocks.setSetting).not.toHaveBeenCalledWith(
            'workday_pending_stop',
            expect.stringContaining('2026')
        )
    })

    it('persists a pending stop at shutdown with a running timer', async () => {
        await initialize({}, new Date(2026, 6, 8, 16, 0, 0))

        getPowerHandler('shutdown')()
        expect(mocks.setSetting).toHaveBeenCalledWith(
            'workday_pending_stop',
            expect.stringContaining('2026')
        )
    })

    it('offers a boundary stop from a previous session to the renderer once', async () => {
        // Yesterday (Tuesday) 18:00 — a boundary crossing relative to now
        const blockTime = new Date(2026, 6, 7, 18, 0, 0)
        mocks.getSetting.mockResolvedValue(blockTime.toISOString())

        await initialize()

        // Cleared from storage so it cannot fire twice across restarts
        expect(mocks.setSetting).toHaveBeenCalledWith('workday_pending_stop', '')

        const getPendingStop = getPendingStopIpcHandler()
        const pendingStop = getPendingStop()
        expect(pendingStop).not.toBeNull()
        expect(
            Math.abs(new Date(pendingStop!).getTime() - blockTime.getTime())
        ).toBeLessThanOrEqual(1000)
        // Collected exactly once
        expect(getPendingStop()).toBeNull()
    })

    it('discards a previous-session stop that stayed within the same window', async () => {
        // Earlier today, inside the same workday window as now
        const blockTime = new Date(2026, 6, 8, 9, 30, 0)
        mocks.getSetting.mockResolvedValue(blockTime.toISOString())

        await initialize() // Wednesday 10:00

        expect(mocks.setSetting).toHaveBeenCalledWith('workday_pending_stop', '')
        expect(getPendingStopIpcHandler()()).toBeNull()
    })
})
