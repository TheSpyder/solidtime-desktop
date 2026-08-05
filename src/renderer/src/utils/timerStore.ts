import { ref } from 'vue'
import type { TimeEntry } from '@solidtime/api'
import { emptyTimeEntry } from './timeEntries.ts'

// Memory-only mirror of the server's timer state (same idea as the in-memory
// offlineUuidStore). Deliberately not persisted: only the server can restore
// a timer across app restarts, so stale local state can never outlive it.
export const currentTimeEntry = ref<TimeEntry>({ ...emptyTimeEntry })
export const lastTimeEntry = ref<TimeEntry>({ ...emptyTimeEntry })

export function resetTimerStore() {
    currentTimeEntry.value = { ...emptyTimeEntry }
    lastTimeEntry.value = { ...emptyTimeEntry }
}
