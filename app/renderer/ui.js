// Text box (typing and Wispr Flow target), status line, error line.
export function createUI({ onSubmit, onTypingStarted = () => {} }) {
  const input = document.getElementById('cmd');
  const status = document.getElementById('status-line');
  const error = document.getElementById('error');
  let timer = 0, errorTimer = 0, lastLength = 0, freshStart = true;
  const submit = () => { clearTimeout(timer); const t = input.value.trim(); input.value = ''; lastLength = 0; freshStart = true; if (t) onSubmit(t); };
  // Wispr inserts whole phrases at once: auto-send 1.2 s after a paste-like insert. Hand typing needs Enter.
  input.addEventListener('input', (e) => {
    clearTimeout(timer);
    if (freshStart) { freshStart = false; onTypingStarted(); }
    const chunk = e.data ?? '';
    const grew = input.value.length - lastLength > 1;
    lastLength = input.value.length;
    if (e.isComposing) return;
    if (e.inputType === 'insertFromPaste' || e.inputType === 'insertReplacementText' || chunk.length > 1 || grew) timer = setTimeout(submit, 1200);
  });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
  return {
    focusInput() { input.focus(); },
    setStatus(text) { status.textContent = text ?? ''; },
    showError(text) {
      error.textContent = text ?? '';
      clearTimeout(errorTimer);
      errorTimer = setTimeout(() => { error.textContent = ''; }, 6000);
    },
  };
}
