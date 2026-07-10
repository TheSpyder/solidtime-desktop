import { ref, watch } from 'vue'

export interface AppSettings {
    widgetActivated: boolean
    trayTimerActivated: boolean
    idleDetectionEnabled: boolean
    idleThresholdMinutes: number
    activityTrackingEnabled: boolean
    workdayTrackingEnabled: boolean
    workdayReminderThresholdMinutes: number
    workdayDays: number[]
    workdayStartTime: string
    workdayEndTime: string
}

// Reactive settings that sync with the database
export const isWidgetActivated = ref(true)
export const isTrayTimerActivated = ref(true)
export const idleDetectionEnabled = ref(true)
export const idleThresholdMinutes = ref(5)
export const activityTrackingEnabled = ref(false) // Off by default
export const workdayTrackingEnabled = ref(false) // Off by default
export const workdayReminderThresholdMinutes = ref(10)
export const workdayDays = ref<number[]>([1, 2, 3, 4, 5]) // Mon-Fri, 0 = Sunday
export const workdayStartTime = ref('09:00')
export const workdayEndTime = ref('17:00')

let isInitialized = false

/**
 * Initialize settings from the database
 */
export async function initializeSettings() {
    if (isInitialized) return

    try {
        const result = await window.electronAPI.getSettings()
        if (result.success && result.data) {
            isWidgetActivated.value = result.data.widgetActivated
            isTrayTimerActivated.value = result.data.trayTimerActivated
            idleDetectionEnabled.value = result.data.idleDetectionEnabled
            idleThresholdMinutes.value = result.data.idleThresholdMinutes
            activityTrackingEnabled.value = result.data.activityTrackingEnabled
            workdayTrackingEnabled.value = result.data.workdayTrackingEnabled
            workdayReminderThresholdMinutes.value = result.data.workdayReminderThresholdMinutes
            workdayDays.value = result.data.workdayDays
            workdayStartTime.value = result.data.workdayStartTime
            workdayEndTime.value = result.data.workdayEndTime
        }

        isInitialized = true

        // Watch for changes and sync to database
        watch(isWidgetActivated, (value) => {
            updateSetting({ widgetActivated: value })
        })

        watch(isTrayTimerActivated, (value) => {
            updateSetting({ trayTimerActivated: value })
        })

        watch(idleDetectionEnabled, (value) => {
            updateSetting({ idleDetectionEnabled: value })
            // Also notify main process for idle detection
            window.electronAPI.updateIdleDetectionEnabled(value)
        })

        watch(idleThresholdMinutes, (value) => {
            updateSetting({ idleThresholdMinutes: value })
            // Also notify main process for idle detection
            window.electronAPI.updateIdleThreshold(value)
        })

        watch(activityTrackingEnabled, (value) => {
            updateSetting({ activityTrackingEnabled: value })
        })

        watch(workdayTrackingEnabled, (value) => {
            updateSetting({ workdayTrackingEnabled: value })
            updateWorkdaySettings()
        })

        watch(workdayReminderThresholdMinutes, (value) => {
            updateSetting({ workdayReminderThresholdMinutes: value })
            updateWorkdaySettings()
        })

        watch(
            workdayDays,
            (value) => {
                updateSetting({ workdayDays: [...value] })
                updateWorkdaySettings()
            },
            { deep: true }
        )

        watch(workdayStartTime, (value) => {
            updateSetting({ workdayStartTime: value })
            updateWorkdaySettings()
        })

        watch(workdayEndTime, (value) => {
            updateSetting({ workdayEndTime: value })
            updateWorkdaySettings()
        })
    } catch (error) {
        console.error('Failed to initialize settings:', error)
    }
}

/**
 * Push the full workday config to the main process monitor
 */
function updateWorkdaySettings() {
    window.electronAPI.updateWorkdaySettings({
        enabled: workdayTrackingEnabled.value,
        reminderThresholdMinutes: workdayReminderThresholdMinutes.value,
        days: [...workdayDays.value],
        startTime: workdayStartTime.value,
        endTime: workdayEndTime.value,
    })
}

/**
 * Update settings in the database
 */
async function updateSetting(partialSettings: Partial<AppSettings>) {
    try {
        const result = await window.electronAPI.updateSettings(partialSettings)
        if (!result.success) {
            console.error('Failed to update settings:', result.error)
        }
    } catch (error) {
        console.error('Failed to update settings:', error)
    }
}
