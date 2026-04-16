import type { StoredState } from '../types'
import { normalizeStoredState } from './migrations'

const STORAGE_KEY = 'mybrain-state-v1'

export const loadState = (): StoredState => {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)

    if (!raw) {
      return { projects: [] }
    }

    return normalizeStoredState(JSON.parse(raw))
  } catch {
    return { projects: [] }
  }
}

export const saveState = (state: StoredState) => {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
}
