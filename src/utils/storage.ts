import type { Schema } from '../types/schema'

// ── Current session (auto-save while working) ──────────────────────────────
const CURRENT_KEY = 'dbv_current'
const SESSION_VERSION = 2  // bump when session format changes

export interface CurrentSession {
  v: number
  schema: Schema
  positions: Record<string, { x: number; y: number }>
  saveId?: string
  saveName?: string
  activeLayoutId?: string | null   // layout the user was viewing, restored on reload
}

export function saveCurrentSession(data: Omit<CurrentSession, 'v'>) {
  localStorage.setItem(CURRENT_KEY, JSON.stringify({ v: SESSION_VERSION, ...data }))
}

export function loadCurrentSession(): CurrentSession | null {
  try {
    const raw = localStorage.getItem(CURRENT_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as CurrentSession
    // discard sessions from older, incompatible formats
    if (parsed.v !== SESSION_VERSION) {
      localStorage.removeItem(CURRENT_KEY)
      return null
    }
    return parsed
  } catch { return null }
}

export function clearCurrentSession() {
  localStorage.removeItem(CURRENT_KEY)
}

// ── Named saves ────────────────────────────────────────────────────────────
const SAVES_KEY = 'dbv_saves'

export interface SavedDB {
  id: string
  name: string
  savedAt: string   // ISO
  tableCount: number
  schema: Schema
  positions: Record<string, { x: number; y: number }>
}

export function getSaves(): SavedDB[] {
  try {
    const raw = localStorage.getItem(SAVES_KEY)
    return raw ? JSON.parse(raw) : []
  } catch { return [] }
}

export function saveDB(
  name: string,
  schema: Schema,
  positions: Record<string, { x: number; y: number }>,
  existingId?: string
): SavedDB {
  const saves = getSaves()
  const entry: SavedDB = {
    id: existingId ?? crypto.randomUUID(),
    name,
    savedAt: new Date().toISOString(),
    tableCount: schema.tables.length,
    schema,
    positions,
  }
  const idx = saves.findIndex(s => s.id === entry.id)
  if (idx >= 0) saves[idx] = entry
  else saves.unshift(entry)
  localStorage.setItem(SAVES_KEY, JSON.stringify(saves))
  return entry
}

export function deleteDB(id: string) {
  const saves = getSaves().filter(s => s.id !== id)
  localStorage.setItem(SAVES_KEY, JSON.stringify(saves))
}

