/**
 * useChatContext — client for the per-(user, page) customer-service chat API.
 *
 * Identity: signed-in visitors are recognized by their Bearer JWT; anonymous
 * visitors by a device UUID minted once into localStorage (X-Device-Id).
 * Every page owns its own transcript; the server streams the assistant
 * reply as SSE (`data: {"delta": ...}` … `data: {"done": true}`).
 */

import { apiBaseUrl } from './wsUrl.js';
import { useAuth } from './useAuth.js';

const API_BASE = apiBaseUrl();
const DEVICE_KEY = 'drone.chat.device';

function mintUuid() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

function deviceId() {
  let id = localStorage.getItem(DEVICE_KEY);
  if (!id) {
    id = mintUuid();
    localStorage.setItem(DEVICE_KEY, id);
  }
  return id;
}

function headers() {
  const { token } = useAuth();
  const h = { 'X-Device-Id': deviceId() };
  if (token.value) h.Authorization = `Bearer ${token.value}`;
  return h;
}

export function useChatContext() {
  /** Past text turns of this (visitor, page); [] when fresh/expired. */
  async function loadHistory(page) {
    try {
      const res = await fetch(
        `${API_BASE}/api/chat/history?page=${encodeURIComponent(page)}`,
        { headers: headers() },
      );
      if (!res.ok) return [];
      const data = await res.json();
      return Array.isArray(data.messages) ? data.messages : [];
    } catch {
      return [];
    }
  }

  /** Forget this (visitor, page) conversation — server and model both. */
  async function clearContext(page) {
    try {
      await fetch(`${API_BASE}/api/chat/context?page=${encodeURIComponent(page)}`, {
        method: 'DELETE',
        headers: headers(),
      });
    } catch {
      /* clearing is best-effort */
    }
  }

  /**
   * Send one user turn and stream the assistant reply.
   * onDelta(text) fires per SSE chunk. Rejects when the server reported an
   * error event or the HTTP call failed.
   */
  async function streamTurn(page, text, locale, { onDelta } = {}) {
    const res = await fetch(`${API_BASE}/api/chat/turn`, {
      method: 'POST',
      headers: { ...headers(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ page, text, locale }),
    });
    if (!res.ok || !res.body) throw new Error('chat_turn_failed');
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let errored = false;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const raw = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const line = raw.trim();
        if (!line.startsWith('data:')) continue;
        try {
          const evt = JSON.parse(line.slice(5));
          if (evt.delta) onDelta?.(evt.delta);
          if (evt.error) errored = true;
        } catch {
          /* partial line: ignore */
        }
      }
    }
    if (errored) throw new Error('chat_turn_failed');
  }

  return { loadHistory, clearContext, streamTurn };
}
