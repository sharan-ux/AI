// Electron utilityProcess message handler for speech engine.
export function attachWorker(port, engine) {
  const post = (m) => port.postMessage(m);

  port.on('message', async ({ data: m }) => {
    // Guard against malformed messages
    if (!m || !('id' in m)) return;

    try {
      if (m.op === 'speak') post({ id: m.id, ok: true, result: await engine.speak(m.text) });
      else if (m.op === 'transcribe') post({ id: m.id, ok: true, result: await engine.transcribe(m.pcm) });
      else post({ id: m.id, ok: false, error: `unknown op ${m.op}` });
    } catch (e) {
      post({ id: m.id, ok: false, error: e.message });
    }
  });
}
