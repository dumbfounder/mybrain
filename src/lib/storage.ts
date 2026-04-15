import type { StoredState } from '../types'

const STORAGE_KEY = 'mybrain-state-v1'

export const loadState = (): StoredState => {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)

    if (!raw) {
      return { items: [] }
    }

    const parsed = JSON.parse(raw) as StoredState

    if (!Array.isArray(parsed.items)) {
      return { items: [] }
    }

    return parsed
  } catch {
    return { items: [] }
  }
}

export const saveState = (state: StoredState) => {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
}
