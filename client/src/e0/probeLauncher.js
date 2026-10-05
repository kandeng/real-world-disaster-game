// E0 probe launcher — DEV/AUDIT ONLY (see src/workers/e0CordisProbe.worker.js).
// Spawns the Cordis probe as a Vite-bundled module worker and mirrors its
// messages into the console + window.__e0Probe for inspection.
export function startE0Probe() {
  const worker = new Worker(new URL('../workers/e0CordisProbe.worker.js', import.meta.url), { type: 'module' });
  const messages = [];
  worker.onmessage = (e) => {
    const m = e.data || {};
    messages.push(m);
    if (m.type === 'e0.phase') console.log(`[e0] ${m.ok ? 'PASS' : 'FAIL'} ${m.name}`, m.detail ?? '');
    else if (m.type === 'e0.done') console.log(`[e0] DONE allOk=${m.allOk} — ${m.summary}`);
    else if (m.type === 'e0.error') console.error('[e0] ERROR', m.message);
    else console.log('[e0]', m);
  };
  worker.onerror = (err) => console.error('[e0] worker error', err);
  window.__e0Probe = {
    messages,
    worker,
    stop: () => worker.postMessage({ type: 'stop' }),
    terminate: () => worker.terminate(),
  };
  return worker;
}
