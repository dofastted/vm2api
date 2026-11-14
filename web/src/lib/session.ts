import { randomUUID } from './random-uuid'

const LS_TOKEN = 'kin_console_token'
const LS_USER = 'kin_console_user'
const LS_BASE = 'kin_api_base'
const LS_SESSION_ID = 'kin_console_session_id'
const COOKIE = 'kin_panel_token'

const sessionListeners = new Set<() => void>()

function notifySessionChanged() {
  for (const listener of sessionListeners) listener()
}

/** Same-tab sign-in/out plus changes made by another console tab. */
export function subscribeSession(listener: () => void) {
  sessionListeners.add(listener)
  window.addEventListener('storage', listener)
  return () => {
    sessionListeners.delete(listener)
    window.removeEventListener('storage', listener)
  }
}

export { LS_TOKEN, LS_USER, LS_BASE, COOKIE }

export function sameOriginPanel(host = location.hostname): boolean {
  return /^kin\.fkcodex\.com$/i.test(host || '')
}

export function apiBase(): string {
  const host = location.hostname || ''
  if (sameOriginPanel(host)) return ''
  const saved = (localStorage.getItem(LS_BASE) || '').replace(/\/$/, '')
  if (saved) return saved
  // No saved base: talk to the backend that served this page.
  return ''
}

export function setApiBase(base: string) {
  const trimmed = base.trim().replace(/\/$/, '')
  if (sameOriginPanel() || !trimmed) {
    localStorage.removeItem(LS_BASE)
  } else {
    localStorage.setItem(LS_BASE, trimmed)
  }
  notifySessionChanged()
}

function clearClientCookie(name: string) {
  document.cookie = `${name}=; Path=/; Max-Age=0; SameSite=Lax`
}

export function sessionToken(): string {
  return (localStorage.getItem(LS_TOKEN) || '').trim()
}

/** Non-secret namespace for tab-local state. Never use the bearer as a storage key. */
export function sessionInstance(): string {
  return localStorage.getItem(LS_SESSION_ID) || 'legacy'
}

export function hasSession(): boolean {
  return Boolean(sessionToken())
}

type PanelSessionExpiredListener = () => void
const panelSessionExpiredListeners = new Set<PanelSessionExpiredListener>()
let panelSessionExpiredHandled = false

/** Register UI handler: toast + redirect after panel 401 (see panelFetch). */
export function onPanelSessionExpired(listener: PanelSessionExpiredListener) {
  panelSessionExpiredListeners.add(listener)
  return () => panelSessionExpiredListeners.delete(listener)
}

export function expirePanelSession() {
  if (panelSessionExpiredHandled) return
  panelSessionExpiredHandled = true
  clearSession()
  for (const listener of panelSessionExpiredListeners) listener()
}

export function setSession(token: string, user?: string) {
  clearClientCookie(COOKIE)
  clearClientCookie('kin_console_token')
  if (token) {
    panelSessionExpiredHandled = false
    localStorage.setItem(LS_TOKEN, token)
    localStorage.setItem(LS_SESSION_ID, randomUUID())
  } else localStorage.removeItem(LS_TOKEN)
  if (user) localStorage.setItem(LS_USER, user)
  notifySessionChanged()
}

export function clearSession() {
  localStorage.removeItem(LS_TOKEN)
  localStorage.removeItem(LS_USER)
  localStorage.removeItem(LS_SESSION_ID)
  clearClientCookie(COOKIE)
  clearClientCookie('kin_console_token')
  notifySessionChanged()
}

export function storedUser(): string {
  return localStorage.getItem(LS_USER) || ''
}
