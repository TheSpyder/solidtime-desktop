import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
    powerMonitorOn: vi.fn(),
    getSystemIdleTime: vi.fn(() => 0),
    ipcMainOn: vi.fn(),
    showMessageBox: vi.fn(),
    appQuit: vi.fn(),
    appFocus: vi.fn(),
    flashFrame: vi.fn(),
    isMinimized: vi.fn(() => false),
    isVisible: vi.fn(() => true),
    windowShow: vi.fn(),
    windowFocus: vi.fn(),
    webContentsSend: vi.fn(),
    getAppSettings: vi.fn(),
    isTimerRunning: vi.fn(() => true),
    isSessionActive: vi.fn(() => true),
    onSessionStateChanged: vi.fn(),
    dbInsertValues: vi.fn(async () => {}),
    disableInstallOnQuit: vi.fn(),
    pauseActivityTracking: vi.fn(async () => {}),
    resumeActivityTracking: vi.fn(),
}))

vi.mock('electron', () => ({
    app: { quit: mocks.appQuit, focus: mocks.appFocus },
    powerMonitor: {
        on: mocks.powerMonitorOn,
        getSystemIdleTime: mocks.getSystemIdleTime,
    },
    ipcMain: {
        on: mocks.ipcMainOn,
    },
    dialog: {
        showMessageBox: mocks.showMessageBox,
    },
}))

vi.mock('../mainWindow', () => ({
    getMainWindow: () => ({
        flashFrame: mocks.flashFrame,
        isMinimized: mocks.isMinimized,
        isVisible: mocks.isVisible,
        show: mocks.windowShow,
        focus: mocks.windowFocus,
        webContents: { send: mocks.webContentsSend },
    }),
}))

vi.mock('../autoUpdater', () => ({
    disableInstallOnQuit: mocks.disableInstallOnQuit,
}))

vi.mock('../settings', () => ({
    getAppSettings: mocks.getAppSettings,
}))

vi.mock('../timerState', () => ({
    isTimerRunning: mocks.isTimerRunning,
}))

vi.mock('../connectionState', () => ({
    isSessionActive: mocks.isSessionActive,
    onSessionStateChanged: mocks.onSessionStateChanged,
}))

vi.mock('../activityTracker', () => ({
    pauseActivityTracking: mocks.pauseActivityTracking,
    resumeActivityTracking: mocks.resumeActivityTracking,
}))

vi.mock('../db/client', () => ({
    db: { insert: () => ({ values: mocks.dbInsertValues }) },
}))

vi.mock('../db/schema', () => ({
    activityPeriods: {},
    validateNewActivityPeriod: vi.fn(),
}))

// Wednesday, 10:00 local time
const WEDNESDAY_10AM = new Date(2026, 6, 8, 10, 0, 0)

interface SavedPeriod {
    start: string
    end: string
    isIdle: boolean
}

function savedPeriods(): SavedPeriod[] {
    const calls = mocks.dbInsertValues.mock.calls as unknown as [SavedPeriod][]
    return calls.map(([period]) => period)
}

function savedIdlePeriods(): SavedPeriod[] {
    return savedPeriods().filter((period) => period.isIdle)
}

function getPowerHandler(event: string): () => void {
    const call = mocks.powerMonitorOn.mock.calls.find(([name]) => name === event)
    if (!call) throw new Error(`No powerMonitor handler registered for ${event}`)
    return call[1]
}

function getSessionListener(): (active: boolean) => void {
    const call = mocks.onSessionStateChanged.mock.calls[0]
    if (!call) throw new Error('No session state listener registered')
    return call[0]
}

async function initialize() {
    vi.setSystemTime(WEDNESDAY_10AM)
    mocks.getAppSettings.mockResolvedValue({
        idleDetectionEnabled: true,
        idleThresholdMinutes: 5,
    })
    const presence = await import('../presence')
    await presence.initializePresence()
    const idleMonitor = await import('../idleMonitor')
    await idleMonitor.initializeIdleMonitor()
    return idleMonitor
}

async function advanceMinutes(minutes: number) {
    await vi.advanceTimersByTimeAsync(minutes * 60 * 1000)
}

describe('idleMonitor threshold-aware blocks', () => {
    beforeEach(() => {
        vi.resetModules()
        vi.clearAllMocks()
        vi.useFakeTimers()
        mocks.getSystemIdleTime.mockReturnValue(0)
        mocks.isTimerRunning.mockReturnValue(true)
        mocks.isSessionActive.mockReturnValue(true)
        mocks.showMessageBox.mockResolvedValue({ response: 0 }) // "Keep Idle Time"
    })

    afterEach(() => {
        vi.useRealTimers()
    })

    it('a sleep shorter than the idle threshold stays active with no dialog', async () => {
        await initialize()

        await advanceMinutes(1)
        getPowerHandler('suspend')()
        await advanceMinutes(2)
        getPowerHandler('resume')()
        await advanceMinutes(1)

        expect(mocks.showMessageBox).not.toHaveBeenCalled()
        // No period break: nothing saved, the active period spans the sleep
        expect(savedPeriods()).toHaveLength(0)
    })

    it('a sleep past the idle threshold counts as idle from the suspend time', async () => {
        await initialize()

        await advanceMinutes(1)
        const suspendTime = Date.now()
        getPowerHandler('suspend')()
        await advanceMinutes(10)
        getPowerHandler('resume')()
        await vi.advanceTimersByTimeAsync(100)

        // The keep/discard dialog appears because a timer is running
        expect(mocks.showMessageBox).toHaveBeenCalledTimes(1)

        // The idle period is always recorded, regardless of the dialog choice
        const idlePeriods = savedIdlePeriods()
        expect(idlePeriods).toHaveLength(1)
        const idleStartMs = new Date(idlePeriods[0].start).getTime()
        expect(Math.abs(idleStartMs - suspendTime)).toBeLessThanOrEqual(1000)
        const idleEndMs = new Date(idlePeriods[0].end).getTime()
        expect(idleEndMs - idleStartMs).toBeGreaterThanOrEqual(10 * 60 * 1000 - 1000)
    })

    it('keyboard idle before the block counts toward the threshold', async () => {
        await initialize()

        await advanceMinutes(1)
        // Idle for 4 minutes at the desk, then a 2-minute sleep: 6 minutes
        // without input crosses the 5-minute threshold
        mocks.getSystemIdleTime.mockReturnValue(240)
        const lastInput = Date.now() - 240 * 1000
        getPowerHandler('suspend')()
        mocks.getSystemIdleTime.mockReturnValue(0)
        await advanceMinutes(2)
        getPowerHandler('resume')()
        await vi.advanceTimersByTimeAsync(100)

        expect(mocks.showMessageBox).toHaveBeenCalledTimes(1)
        // Idle runs from the last input, not from the suspend
        const idlePeriods = savedIdlePeriods()
        expect(idlePeriods).toHaveLength(1)
        expect(Math.abs(new Date(idlePeriods[0].start).getTime() - lastInput)).toBeLessThanOrEqual(
            1000
        )
    })

    it('pre-block idle plus a short block below the threshold stays active', async () => {
        await initialize()

        await advanceMinutes(1)
        // 2 minutes idle + 2 minutes asleep = 4 minutes without input, under
        // the 5-minute threshold
        mocks.getSystemIdleTime.mockReturnValue(120)
        getPowerHandler('suspend')()
        mocks.getSystemIdleTime.mockReturnValue(0)
        await advanceMinutes(2)
        getPowerHandler('resume')()
        await advanceMinutes(1)

        expect(mocks.showMessageBox).not.toHaveBeenCalled()
        expect(savedPeriods()).toHaveLength(0)
    })

    it('a short lock behaves like a short sleep', async () => {
        await initialize()

        await advanceMinutes(1)
        getPowerHandler('lock-screen')()
        await advanceMinutes(2)
        getPowerHandler('unlock-screen')()
        await advanceMinutes(1)

        expect(mocks.showMessageBox).not.toHaveBeenCalled()
        expect(savedPeriods()).toHaveLength(0)
    })

    it('suppressNextIdleDialog saves the idle period without asking', async () => {
        const idleMonitor = await initialize()

        await advanceMinutes(1)
        getPowerHandler('suspend')()
        await advanceMinutes(10)
        idleMonitor.suppressNextIdleDialog()
        getPowerHandler('resume')()
        await vi.advanceTimersByTimeAsync(100)

        expect(mocks.showMessageBox).not.toHaveBeenCalled()
        expect(savedIdlePeriods()).toHaveLength(1)
    })

    it('a resume with the screen still locked defers to the unlock', async () => {
        await initialize()

        await advanceMinutes(1)
        const lockTime = Date.now()
        getPowerHandler('lock-screen')()
        getPowerHandler('suspend')()
        await advanceMinutes(10)
        getPowerHandler('resume')()
        await vi.advanceTimersByTimeAsync(100)
        expect(mocks.showMessageBox).not.toHaveBeenCalled()

        await advanceMinutes(2)
        getPowerHandler('unlock-screen')()
        await vi.advanceTimersByTimeAsync(100)

        expect(mocks.showMessageBox).toHaveBeenCalledTimes(1)
        // Idle runs from the lock (first block) to the unlock
        const idlePeriods = savedIdlePeriods()
        expect(idlePeriods).toHaveLength(1)
        expect(Math.abs(new Date(idlePeriods[0].start).getTime() - lockTime)).toBeLessThanOrEqual(
            1000
        )
    })

    it('a pre-existing idle state resumes normally regardless of the gap length', async () => {
        await initialize()

        await advanceMinutes(1)
        // User has been away from the keyboard past the threshold: the poll
        // flags idle before any suspend happens
        mocks.getSystemIdleTime.mockReturnValue(400)
        await vi.advanceTimersByTimeAsync(2000)

        getPowerHandler('suspend')()
        await advanceMinutes(2) // Short sleep, but idle predated it
        mocks.getSystemIdleTime.mockReturnValue(0)
        getPowerHandler('resume')()
        await vi.advanceTimersByTimeAsync(100)

        expect(mocks.showMessageBox).toHaveBeenCalledTimes(1)
    })

    it('a stale idle clock after waking cannot double-count the recorded gap', async () => {
        await initialize()

        await advanceMinutes(1)
        getPowerHandler('suspend')()
        await advanceMinutes(15)
        // Waking did not register as input: the OS idle clock still spans the sleep
        mocks.getSystemIdleTime.mockReturnValue(16 * 60)
        getPowerHandler('resume')()
        // The poll keeps running with the stale clock
        await advanceMinutes(2)

        // One idle classification, one dialog — the poll must not re-flag the
        // same span from the pre-sleep input
        expect(mocks.showMessageBox).toHaveBeenCalledTimes(1)
        expect(savedIdlePeriods()).toHaveLength(1)
    })

    it('a stale suppression is cleared when monitoring restarts', async () => {
        const idleMonitor = await initialize()

        // A workday auto-stop suppressed a dialog that never happened (e.g.
        // idle detection was toggled); the flag must not survive the restart
        idleMonitor.suppressNextIdleDialog()
        await idleMonitor.stopIdleMonitoring()
        idleMonitor.startIdleMonitoring()

        await advanceMinutes(1)
        mocks.getSystemIdleTime.mockReturnValue(400)
        await vi.advanceTimersByTimeAsync(2000)
        mocks.getSystemIdleTime.mockReturnValue(0)
        await vi.advanceTimersByTimeAsync(2000)

        // The genuine idle transition still asks the user
        expect(mocks.showMessageBox).toHaveBeenCalledTimes(1)
    })

    it('no dialog when no timer is running; the idle period saves automatically', async () => {
        mocks.isTimerRunning.mockReturnValue(false)
        await initialize()

        await advanceMinutes(1)
        getPowerHandler('suspend')()
        await advanceMinutes(10)
        getPowerHandler('resume')()
        await vi.advanceTimersByTimeAsync(100)

        expect(mocks.showMessageBox).not.toHaveBeenCalled()
        expect(savedIdlePeriods()).toHaveLength(1)
    })

    it('does not prompt or record before the session start signal', async () => {
        mocks.isSessionActive.mockReturnValue(false)
        await initialize()

        await advanceMinutes(1)
        getPowerHandler('suspend')()
        await advanceMinutes(10)
        getPowerHandler('resume')()
        await vi.advanceTimersByTimeAsync(100)

        expect(mocks.showMessageBox).not.toHaveBeenCalled()
        expect(savedPeriods()).toHaveLength(0)
    })

    it('the settings toggle alone does not start monitoring without a session', async () => {
        mocks.isSessionActive.mockReturnValue(false)
        await initialize()

        const call = mocks.ipcMainOn.mock.calls.find(
            ([channel]) => channel === 'updateIdleDetectionEnabled'
        )
        if (!call) throw new Error('No updateIdleDetectionEnabled handler registered')
        call[1](null, true)

        await advanceMinutes(1)
        getPowerHandler('suspend')()
        await advanceMinutes(10)
        getPowerHandler('resume')()
        await vi.advanceTimersByTimeAsync(100)

        expect(mocks.showMessageBox).not.toHaveBeenCalled()
        expect(savedPeriods()).toHaveLength(0)
    })

    it('starts monitoring on the session start signal', async () => {
        mocks.isSessionActive.mockReturnValue(false)
        await initialize()

        mocks.isSessionActive.mockReturnValue(true)
        getSessionListener()(true)

        await advanceMinutes(1)
        getPowerHandler('suspend')()
        await advanceMinutes(10)
        getPowerHandler('resume')()
        await vi.advanceTimersByTimeAsync(100)

        expect(mocks.showMessageBox).toHaveBeenCalledTimes(1)
        expect(savedIdlePeriods()).toHaveLength(1)
    })

    it('stops monitoring on the logout signal', async () => {
        await initialize()

        // The active period accumulated while logged in is saved at logout
        await advanceMinutes(5)
        mocks.isSessionActive.mockReturnValue(false)
        getSessionListener()(false)
        await vi.advanceTimersByTimeAsync(100)
        expect(savedPeriods()).toHaveLength(1)
        expect(savedPeriods()[0].isIdle).toBe(false)

        mocks.dbInsertValues.mockClear()
        getPowerHandler('suspend')()
        await advanceMinutes(10)
        getPowerHandler('resume')()
        await vi.advanceTimersByTimeAsync(100)

        expect(mocks.showMessageBox).not.toHaveBeenCalled()
        expect(savedPeriods()).toHaveLength(0)
    })
})
