import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WindowInfo } from '../activity/backend'

const mocks = vi.hoisted(() => {
    const backend = {
        handler: null as ((info: unknown) => void) | null,
        start: vi.fn(async (onChange: (info: unknown) => void) => {
            backend.handler = onChange
        }),
        getActive: vi.fn(async () => null),
        stop: vi.fn(async () => {}),
    }
    return {
        backend,
        powerMonitorOn: vi.fn(),
        getSystemIdleTime: vi.fn(() => 0),
        ipcMainOn: vi.fn(),
        ipcMainHandle: vi.fn(),
        appQuit: vi.fn(),
        getAppSettings: vi.fn(),
        isSessionActive: vi.fn(() => true),
        onSessionStateChanged: vi.fn(),
        dbInsertValues: vi.fn(async () => {}),
    }
})

vi.mock('electron', () => ({
    app: { quit: mocks.appQuit },
    powerMonitor: {
        on: mocks.powerMonitorOn,
        getSystemIdleTime: mocks.getSystemIdleTime,
    },
    ipcMain: {
        on: mocks.ipcMainOn,
        handle: mocks.ipcMainHandle,
    },
}))

vi.mock('../settings', () => ({
    getAppSettings: mocks.getAppSettings,
}))

vi.mock('../permissions', () => ({
    hasScreenRecordingPermission: () => true,
}))

vi.mock('../connectionState', () => ({
    isSessionActive: mocks.isSessionActive,
    onSessionStateChanged: mocks.onSessionStateChanged,
}))

vi.mock('../db/client', () => ({
    db: { insert: () => ({ values: mocks.dbInsertValues }) },
}))

vi.mock('../db/schema', () => ({
    windowActivities: {},
    validateNewWindowActivity: vi.fn(),
}))

vi.mock('../activity/xWinBackend', () => ({
    XWinBackend: class {
        start = mocks.backend.start
        getActive = mocks.backend.getActive
        stop = mocks.backend.stop
    },
}))

// Wednesday, 10:00 local time
const WEDNESDAY_10AM = new Date(2026, 6, 8, 10, 0, 0)

interface SavedWindowActivity {
    timestamp: string
    durationSeconds: number
    appName: string
    windowTitle: string
}

function savedActivities(): SavedWindowActivity[] {
    const calls = mocks.dbInsertValues.mock.calls as unknown as [SavedWindowActivity][]
    return calls.map(([activity]) => activity)
}

function activityEndMs(activity: SavedWindowActivity): number {
    return new Date(activity.timestamp).getTime() + activity.durationSeconds * 1000
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

function windowInfo(id: number, appName: string, title: string): WindowInfo {
    return {
        id,
        title,
        info: { execName: appName, name: appName, path: '', processId: 1000 + id },
        os: 'linux',
        position: { x: 0, y: 0, width: 800, height: 600, isFullScreen: false },
        usage: { memory: 0 },
    }
}

async function focusWindow(info: WindowInfo) {
    mocks.backend.handler?.(info)
    // Let the async window-change handler settle
    await vi.advanceTimersByTimeAsync(0)
}

// Idle detection is deliberately disabled in these settings: window-activity
// truncation must work off the shared presence signal on its own, without
// the idle monitor (or the workday monitor) being enabled.
async function initialize() {
    vi.setSystemTime(WEDNESDAY_10AM)
    mocks.getAppSettings.mockResolvedValue({
        activityTrackingEnabled: true,
        idleDetectionEnabled: false,
        idleThresholdMinutes: 5,
    })
    const presence = await import('../presence')
    await presence.initializePresence()
    const activityTracker = await import('../activityTracker')
    await activityTracker.initializeActivityTracker()
    return activityTracker
}

async function advanceMinutes(minutes: number) {
    await vi.advanceTimersByTimeAsync(minutes * 60 * 1000)
}

describe('activityTracker presence awareness', () => {
    beforeEach(() => {
        vi.resetModules()
        vi.clearAllMocks()
        vi.useFakeTimers()
        vi.stubEnv('XDG_SESSION_TYPE', 'x11')
        mocks.backend.handler = null
        mocks.getSystemIdleTime.mockReturnValue(0)
        mocks.isSessionActive.mockReturnValue(true)
    })

    afterEach(() => {
        vi.unstubAllEnvs()
        vi.useRealTimers()
    })

    it('saves the previous window activity when the focused window changes', async () => {
        await initialize()

        await focusWindow(windowInfo(1, 'Code', 'main.ts'))
        await advanceMinutes(3)
        await focusWindow(windowInfo(2, 'Firefox', 'docs'))

        const activities = savedActivities()
        expect(activities).toHaveLength(1)
        expect(activities[0].appName).toBe('Code')
        expect(activities[0].durationSeconds).toBe(3 * 60)
    })

    it('keyboard idle truncates the current activity at the last input', async () => {
        await initialize()

        await focusWindow(windowInfo(1, 'Code', 'main.ts'))
        await advanceMinutes(10)
        // The user walked away: 6 minutes without input crosses the 5-minute
        // threshold, so the activity must end at the last input
        mocks.getSystemIdleTime.mockReturnValue(360)
        const lastInput = Date.now() - 360 * 1000
        await vi.advanceTimersByTimeAsync(1000)

        const activities = savedActivities()
        expect(activities).toHaveLength(1)
        expect(Math.abs(activityEndMs(activities[0]) - lastInput)).toBeLessThanOrEqual(2000)
    })

    it('resumes when the user returns, excluding the idle span', async () => {
        await initialize()

        await focusWindow(windowInfo(1, 'Code', 'main.ts'))
        await advanceMinutes(10)
        mocks.getSystemIdleTime.mockReturnValue(360)
        await vi.advanceTimersByTimeAsync(1000)

        // The user returns after being flagged idle
        mocks.getSystemIdleTime.mockReturnValue(0)
        await vi.advanceTimersByTimeAsync(1000)
        const resumeTime = Date.now()

        await advanceMinutes(2)
        await focusWindow(windowInfo(2, 'Firefox', 'docs'))

        const activities = savedActivities()
        expect(activities).toHaveLength(2)
        // The post-idle segment starts at the return, not at the original focus
        const secondStartMs = new Date(activities[1].timestamp).getTime()
        expect(Math.abs(secondStartMs - resumeTime)).toBeLessThanOrEqual(2000)
        expect(activities[1].durationSeconds).toBeGreaterThanOrEqual(2 * 60 - 2)
        expect(activities[1].durationSeconds).toBeLessThanOrEqual(2 * 60 + 2)
    })

    it('a long sleep truncates at the suspend and resumes at the wake', async () => {
        await initialize()

        await focusWindow(windowInfo(1, 'Code', 'main.ts'))
        await advanceMinutes(5)
        const suspendTime = Date.now()
        getPowerHandler('suspend')()

        await advanceMinutes(30)
        getPowerHandler('resume')()
        const resumeTime = Date.now()

        await advanceMinutes(2)
        await focusWindow(windowInfo(2, 'Firefox', 'docs'))

        const activities = savedActivities()
        expect(activities).toHaveLength(2)
        // First segment ends at the suspend, second starts at the wake
        expect(Math.abs(activityEndMs(activities[0]) - suspendTime)).toBeLessThanOrEqual(2000)
        const secondStartMs = new Date(activities[1].timestamp).getTime()
        expect(Math.abs(secondStartMs - resumeTime)).toBeLessThanOrEqual(2000)
    })

    it('a sleep shorter than the idle threshold joins up as continuous activity', async () => {
        await initialize()

        await focusWindow(windowInfo(1, 'Code', 'main.ts'))
        await advanceMinutes(5)
        const suspendTime = Date.now()
        getPowerHandler('suspend')()

        await advanceMinutes(2)
        getPowerHandler('resume')()

        await advanceMinutes(3)
        await focusWindow(windowInfo(2, 'Firefox', 'docs'))

        // Two segments that join up exactly at the suspend point: the same
        // continuity rule the activity periods use for sub-threshold gaps
        const activities = savedActivities()
        expect(activities).toHaveLength(2)
        expect(Math.abs(activityEndMs(activities[0]) - suspendTime)).toBeLessThanOrEqual(2000)
        const secondStartMs = new Date(activities[1].timestamp).getTime()
        expect(Math.abs(secondStartMs - suspendTime)).toBeLessThanOrEqual(2000)
        expect(activities[1].durationSeconds).toBeGreaterThanOrEqual(5 * 60 - 2)
    })

    it('window changes while the user is away accumulate no time', async () => {
        await initialize()

        await focusWindow(windowInfo(1, 'Code', 'main.ts'))
        await advanceMinutes(10)
        // The user walks away and a notification steals focus while idle
        mocks.getSystemIdleTime.mockReturnValue(360)
        await vi.advanceTimersByTimeAsync(1000)
        await focusWindow(windowInfo(2, 'Slack', 'notification'))
        mocks.getSystemIdleTime.mockReturnValue(600)
        await advanceMinutes(4)

        // The user returns, works a minute in the new window, then switches
        mocks.getSystemIdleTime.mockReturnValue(0)
        await vi.advanceTimersByTimeAsync(1000)
        await advanceMinutes(1)
        await focusWindow(windowInfo(3, 'Firefox', 'docs'))

        const slackActivities = savedActivities().filter((a) => a.appName === 'Slack')
        expect(slackActivities).toHaveLength(1)
        // Only the active minute counts, not the idle span it was focused for
        expect(slackActivities[0].durationSeconds).toBeLessThanOrEqual(60 + 2)
    })

    it('getCurrentActivity is null while the user is away and truthful when active', async () => {
        const activityTracker = await initialize()

        await focusWindow(windowInfo(1, 'Code', 'main.ts'))
        await advanceMinutes(2)
        expect(activityTracker.getCurrentActivity()?.durationSeconds).toBe(2 * 60)

        mocks.getSystemIdleTime.mockReturnValue(360)
        await vi.advanceTimersByTimeAsync(1000)
        expect(activityTracker.getCurrentActivity()).toBeNull()
    })

    it('stopping tracking saves the current activity and unsubscribes from presence', async () => {
        const activityTracker = await initialize()

        await focusWindow(windowInfo(1, 'Code', 'main.ts'))
        await advanceMinutes(2)
        await activityTracker.stopActivityTracking()

        expect(savedActivities()).toHaveLength(1)

        // Presence events after stopping must not write anything
        getPowerHandler('suspend')()
        await advanceMinutes(10)
        getPowerHandler('resume')()
        expect(savedActivities()).toHaveLength(1)
    })

    it('does not record before the session start signal, then starts on it', async () => {
        mocks.isSessionActive.mockReturnValue(false)
        await initialize()

        // The backend was never started, so nothing can be recorded
        expect(mocks.backend.start).not.toHaveBeenCalled()

        mocks.isSessionActive.mockReturnValue(true)
        getSessionListener()(true)
        await vi.advanceTimersByTimeAsync(0)

        await focusWindow(windowInfo(1, 'Code', 'main.ts'))
        await advanceMinutes(3)
        await focusWindow(windowInfo(2, 'Firefox', 'docs'))

        expect(savedActivities()).toHaveLength(1)
    })

    it('stops recording on the logout signal', async () => {
        await initialize()

        await focusWindow(windowInfo(1, 'Code', 'main.ts'))
        await advanceMinutes(2)

        mocks.isSessionActive.mockReturnValue(false)
        getSessionListener()(false)
        await vi.advanceTimersByTimeAsync(0)

        // The activity accumulated while logged in is saved at logout
        expect(savedActivities()).toHaveLength(1)
        expect(mocks.backend.stop).toHaveBeenCalled()
    })
})
