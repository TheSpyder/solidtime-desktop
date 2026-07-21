import { app, ipcMain, powerMonitor } from 'electron'
import dayjs from 'dayjs'
import type { Dayjs } from 'dayjs'
import { getAppSettings } from './settings'

// Shared presence signal: the one place that watches user input and power
// events and decides whether the user is present. The idle monitor, the
// workday monitor, and the activity tracker subscribe as policy consumers;
// the input poll runs while at least one subscriber is registered, so any
// single feature being enabled is enough to keep the signal alive.
//
// Gap rule (shared by all consumers): a pause — keyboard idle, sleep, or
// lock — shorter than the idle threshold is continuous activity; a longer
// one counts as idle starting at the last input before the pause.
//
// Event order contract for a single unblock: `onUnblocked` fires before the
// `onIdleStart`/`onIdleEnd` pair classifying the same gap. A listener acting
// on the unblock (the workday auto-stop) is therefore guaranteed to run
// before listeners acting on the idle period (the idle keep/discard dialog),
// without any constraint on module initialization order.

export interface BlockInfo {
    /** When the block (suspend, lock, user switch) happened. */
    blockedAt: Dayjs
    /** The last user input before the block — where work actually stopped. */
    lastInput: Dayjs
}

export interface UnblockInfo extends BlockInfo {
    /** When the system unblocked (resume, unlock, user switch back). */
    unblockedAt: Dayjs
    /** Whether the input gap spanning the block crossed the idle threshold. */
    gapIsIdle: boolean
}

export interface PresenceListener {
    /**
     * The user went idle: no input for the idle threshold, or a block gap
     * classified as idle. `idleStart` is the last input time.
     */
    onIdleStart?(idleStart: Dayjs): void
    /** The user is back after an idle period spanning [idleStart, idleEnd]. */
    onIdleEnd?(idleStart: Dayjs, idleEnd: Dayjs): void
    /** The system blocked. Whether the gap counts as idle is decided at unblock. */
    onBlocked?(info: BlockInfo): void
    /** The system unblocked. Fires before the idle events for the same gap. */
    onUnblocked?(info: UnblockInfo): void
    /** The system is shutting down. Fires after the final onIdleStart. */
    onShutdown?(): void
}

let listeners: PresenceListener[] = []
let pollInterval: NodeJS.Timeout | null = null
let idleThreshold = 300 // seconds
let userIdle = false
let idleStartTime: Dayjs | null = null
let isScreenLocked = false // Defer resume handling until unlock so the gap ends at the unlock time
let blockedAt: Dayjs | null = null
let lastInputBeforeBlock: Dayjs | null = null
// The system idle clock is not reset by waking the machine, so after an idle
// gap has been recorded the clock may still reach back past it. Clamping the
// last input to this floor prevents the same gap from being counted twice.
let inputFloor: Dayjs | null = null
let powerEventsRegistered = false

/**
 * The moment of the last user input, derived from the system idle time.
 */
export function lastInputTime(): Dayjs {
    const lastInput = dayjs().subtract(powerMonitor.getSystemIdleTime(), 'seconds')
    return inputFloor && lastInput.isBefore(inputFloor) ? inputFloor : lastInput
}

/**
 * Current idle threshold in seconds — the shared gap rule for all consumers:
 * a pause shorter than this counts as continuous activity.
 */
export function getIdleThresholdSeconds(): number {
    return idleThreshold
}

/** Whether the presence signal currently classifies the user as idle. */
export function isUserIdle(): boolean {
    return userIdle
}

/** Start of the current idle period, or null when the user is active. */
export function currentIdleStart(): Dayjs | null {
    return idleStartTime
}

export async function initializePresence() {
    const appSettings = await getAppSettings()
    idleThreshold = appSettings.idleThresholdMinutes * 60

    console.log('Presence initialized with idle threshold:', idleThreshold, 'seconds')

    ipcMain.on('updateIdleThreshold', (_event, thresholdMinutes: number) => {
        if (typeof thresholdMinutes === 'number' && thresholdMinutes > 0) {
            idleThreshold = thresholdMinutes * 60
            console.log('Idle threshold updated to:', idleThreshold, 'seconds')
        } else {
            console.warn('Invalid idle threshold value:', thresholdMinutes)
        }
    })

    registerPowerMonitorEvents()
}

/**
 * Registers a presence consumer. The input poll runs while at least one
 * consumer is subscribed. Returns an unsubscribe function.
 *
 * The presence state may already be idle at subscription time (another
 * consumer kept the signal alive) — query isUserIdle() when that matters.
 */
export function subscribePresence(listener: PresenceListener): () => void {
    listeners.push(listener)
    if (listeners.length === 1) {
        startPoll()
    }
    return () => {
        listeners = listeners.filter((registered) => registered !== listener)
        if (listeners.length === 0) {
            stopPoll()
        }
    }
}

function emit<K extends keyof PresenceListener>(
    event: K,
    ...args: Parameters<NonNullable<PresenceListener[K]>>
) {
    for (const listener of listeners) {
        try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            ;(listener[event] as ((...eventArgs: any[]) => void) | undefined)?.(...args)
        } catch (error) {
            console.error(`Presence listener failed on ${event}:`, error)
        }
    }
}

function transitionToIdle(idleStart: Dayjs) {
    if (userIdle) return // Guard against double-fire (e.g. macOS suspend firing twice)

    userIdle = true
    idleStartTime = idleStart
    console.log(`User became idle at ${idleStart.toISOString()}`)
    emit('onIdleStart', idleStart)
}

function transitionToActive(idleEnd: Dayjs) {
    if (!userIdle || !idleStartTime) return // Guard against double-fire

    const idleStart = idleStartTime
    userIdle = false
    idleStartTime = null
    console.log(
        `User became active at ${idleEnd.toISOString()}, idle since ${idleStart.toISOString()}`
    )
    emit('onIdleEnd', idleStart, idleEnd)
}

/**
 * The system blocked (suspend, lock, user switch). Whether the gap counts as
 * idle is decided at unblock time by comparing it against the idle threshold —
 * a short sleep or lock is not idle, the same as a short pause at the keyboard.
 */
function handleBlock(reason: string) {
    console.log(`powerMonitor: ${reason}`)
    if (blockedAt) return // e.g. lock followed by suspend; keep the first block time

    // Stop the poll BEFORE recording the block so a final tick can't mutate
    // state mid-transition
    clearPollInterval()
    blockedAt = dayjs()
    // Keyboard idle leading into the block counts toward the gap, the same
    // as if the user had stayed at the desk
    lastInputBeforeBlock = lastInputTime()
    emit('onBlocked', { blockedAt, lastInput: lastInputBeforeBlock })
}

/**
 * The system unblocked (resume, unlock, user switch back). Emits onUnblocked
 * with the gap classification, then the matching idle transitions: already
 * idle before the block → the recorded idle simply ends here; gap past the
 * threshold → an idle period from the last input; otherwise continuous
 * activity with no transition at all.
 */
function handleUnblock(reason: string) {
    console.log(`powerMonitor: ${reason}`)
    if (!blockedAt || !lastInputBeforeBlock) return

    const blockStart = blockedAt
    const lastInput = lastInputBeforeBlock
    blockedAt = null
    lastInputBeforeBlock = null

    const now = dayjs()
    const gapIsIdle = userIdle || now.diff(lastInput, 'seconds') >= idleThreshold
    emit('onUnblocked', { blockedAt: blockStart, lastInput, unblockedAt: now, gapIsIdle })

    if (userIdle) {
        // Already idle before the block: the existing idle period ends here
        transitionToActive(now)
        inputFloor = now
    } else if (gapIsIdle) {
        transitionToIdle(lastInput)
        transitionToActive(now)
        inputFloor = now
    } else {
        console.log(
            `Input gap of ${now.diff(lastInput, 'seconds')}s is below the idle threshold, staying active`
        )
    }
    restartPollInterval()
}

function registerPowerMonitorEvents() {
    if (powerEventsRegistered) return
    powerEventsRegistered = true

    powerMonitor.on('suspend', () => handleBlock('system suspend'))

    powerMonitor.on('lock-screen', () => {
        isScreenLocked = true
        handleBlock('screen locked')
    })

    powerMonitor.on('resume', () => {
        if (isScreenLocked) {
            console.log('powerMonitor: resume with screen still locked, waiting for unlock')
            return
        }
        handleUnblock('system resume')
    })

    powerMonitor.on('unlock-screen', () => {
        isScreenLocked = false
        handleUnblock('screen unlocked')
    })

    // macOS and Linux emit an event when the system is about to shut down.
    // Delay to let listeners save state and run normal app.quit() handlers.
    // Shutdown always ends the active span at the shutdown time; the gap
    // classification doesn't apply because there is no unblock to measure to.
    powerMonitor.on('shutdown', (event?: Electron.Event) => {
        event?.preventDefault()
        console.log('powerMonitor: system shutdown')
        clearPollInterval()
        transitionToIdle(dayjs())
        emit('onShutdown')
        app.quit()
    })

    // macOS specific events for multi user switching
    powerMonitor.on('user-did-resign-active', () => handleBlock('user session resigned active'))
    powerMonitor.on('user-did-become-active', () => handleUnblock('user session became active'))
}

function clearPollInterval() {
    if (pollInterval) {
        clearInterval(pollInterval)
        pollInterval = null
    }
}

function restartPollInterval() {
    if (listeners.length === 0) return
    clearPollInterval()
    pollInterval = setInterval(() => {
        const idleSince = lastInputTime()

        if (dayjs().diff(idleSince, 'seconds') >= idleThreshold) {
            transitionToIdle(idleSince)
        } else {
            transitionToActive(dayjs())
        }
    }, 1000)
}

function startPoll() {
    if (pollInterval) return

    console.log('Starting presence poll')

    // Check the current input state immediately so the initial state is
    // correct; the user may already have been idle when the first consumer
    // subscribed
    const idleSince = lastInputTime()
    if (dayjs().diff(idleSince, 'seconds') >= idleThreshold) {
        userIdle = true
        idleStartTime = idleSince
        console.log(
            `User already idle when the poll started. Idle since: ${idleSince.toISOString()}`
        )
    } else {
        userIdle = false
        idleStartTime = null
    }

    restartPollInterval()
}

function stopPoll() {
    console.log('Stopping presence poll')
    clearPollInterval()
}
