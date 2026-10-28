import { Platform } from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';

export const API_BASE_URL = 'https://ai-cycling-coach-822a.onrender.com';
const SESSION_FILE = `${FileSystem.documentDirectory || ''}velocoach_auth_session.json`;

export interface UsuarioAuth {
  id: number;
  email: string;
  nombre: string;
  ftp_actual: number;
  peso_actual: number;
  lthr: number;
  max_hr: number;
  intervals_athlete_id: string;
  intervals_conectado: boolean;
  disponibilidad?: string | null;
}

let _tokenActual: string | null = null;
let _usuarioActual: UsuarioAuth | null = null;
const _listeners: Set<() => void> = new Set();

function notificarCambios() {
  _listeners.forEach((fn) => fn());
}

export function getAuthToken() {
  return _tokenActual;
}

export function getAuthUser() {
  return _usuarioActual;
}

export function suscribirAuth(listener: () => void): () => void {
  _listeners.add(listener);
  return () => {
    _listeners.delete(listener);
  };
}

export async function guardarSesionLocal(token: string, usuario: UsuarioAuth) {
  _tokenActual = token;
  _usuarioActual = usuario;
  const payload = JSON.stringify({ token, usuario });
  try {
    if (Platform.OS === 'web' && typeof window !== 'undefined' && window.localStorage) {
      window.localStorage.setItem('velocoach_session', payload);
    } else if (FileSystem.documentDirectory) {
      await FileSystem.writeAsStringAsync(SESSION_FILE, payload);
    }
  } catch (e) {
    console.warn('No se pudo persistir la sesión:', e);
  }
  notificarCambios();
}

export async function cerrarSesionLocal() {
  _tokenActual = null;
  _usuarioActual = null;
  try {
    if (Platform.OS === 'web' && typeof window !== 'undefined' && window.localStorage) {
      window.localStorage.removeItem('velocoach_session');
    } else if (FileSystem.documentDirectory) {
      await FileSystem.deleteAsync(SESSION_FILE, { idempotent: true });
    }
  } catch {}
  notificarCambios();
}

export async function restaurarSesionLocal(): Promise<{ token: string; usuario: UsuarioAuth } | null> {
  try {
    let raw: string | null = null;
    if (Platform.OS === 'web' && typeof window !== 'undefined' && window.localStorage) {
      raw = window.localStorage.getItem('velocoach_session');
    } else if (FileSystem.documentDirectory) {
      const info = await FileSystem.getInfoAsync(SESSION_FILE);
      if (info.exists) {
        raw = await FileSystem.readAsStringAsync(SESSION_FILE);
      }
    }
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed?.token && parsed?.usuario) {
        _tokenActual = parsed.token;
        _usuarioActual = parsed.usuario;
        notificarCambios();
        return parsed;
      }
    }
  } catch {}
  return null;
}

// Interceptor global de fetch: inyecta automáticamente Authorization: Bearer <token>
// en cualquier llamada hacia nuestro backend en Render desde cualquier pestaña.
let _interceptorInstalado = false;
export function instalarInterceptorFetch() {
  if (_interceptorInstalado || typeof globalThis.fetch !== 'function') return;
  _interceptorInstalado = true;
  const originalFetch = globalThis.fetch.bind(globalThis);

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const urlStr = typeof input === 'string' ? input : input.toString();
    if (_tokenActual && (urlStr.includes('onrender.com') || urlStr.includes('localhost:8000') || urlStr.includes('192.168.'))) {
      const headers = new Headers(init?.headers || {});
      if (!headers.has('Authorization')) {
        headers.set('Authorization', `Bearer ${_tokenActual}`);
      }
      return originalFetch(input, { ...init, headers });
    }
    return originalFetch(input, init);
  };
}