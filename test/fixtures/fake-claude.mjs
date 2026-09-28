// Stand-in for `claude -p --input-format stream-json --output-format stream-json`.
import { createInterface } from 'node:readline';

const arg = process.argv.find((a) => a.startsWith('--mode='));
const mode = arg ? arg.slice(7) : (process.env.FAKE_MODE ?? 'echo');
const sid = process.env.FAKE_SESSION ?? 'fake-session';
const out = (m) => process.stdout.write(JSON.stringify(m) + '\n');

out({ type: 'system', subtype: 'init', session_id: sid, mcp_servers: [] });
if (mode === 'crash') process.exit(3);
let n = 0;
createInterface({ input: process.stdin }).on('line', (line) => {
  const msg = JSON.parse(line);
  const text = typeof msg.message?.content === 'string' ? msg.message.content : '';
  n++;
  if (mode === 'silent') return;
  if (mode === 'crash-after-first' && n > 1) process.exit(4);
  out({ type: 'assistant', message: { content: [{ type: 'text', text: `working on: ${text.slice(0, 40)}` }, { type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }] } });
  const reply = mode === 'done' ? `Implemented it.\nSTATUS: DONE — ${text.slice(0, 40)}`
    : mode === 'question' ? 'Which validator file should I use?\nSTATUS: QUESTION — which file'
    : `echo: ${text}`;
  out({ type: 'result', subtype: 'success', is_error: false, result: reply, session_id: sid });
});
