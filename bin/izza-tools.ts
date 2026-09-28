import { createInterface } from 'node:readline';
import { MANAGER_TOOLS, WORKER_TOOLS, createMcpHandler } from '../src/agent/mcpServer.ts';

// MCP stdio server launched by each Izza claude process; forwards every tool call to the Agent Hub.
const url = process.env.IZZA_HUB_URL ?? '';
const token = process.env.IZZA_HUB_TOKEN ?? '';
const actor = process.env.IZZA_ACTOR ?? 'worker:unknown';

async function callTool(name: string, args: Record<string, unknown>): Promise<string> {
  try {
    const res = await fetch(`${url}/tool`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-izza-token': token },
      body: JSON.stringify({ actor, name, args }),
      signal: AbortSignal.timeout(15 * 60 * 1000),
    });
    const body: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error ?? `hub HTTP ${res.status}`);
    if (typeof body.text !== 'string') throw new Error('hub response missing text');
    return body.text;
  } catch (e) {
    // The permission tool is a gate, not a chat reply: if we can't reach the hub, fail closed
    // with a normal (non-isError) deny result instead of surfacing a generic tool error.
    if (name === 'permission') {
      const reason = (e as Error).message || 'unknown error';
      return JSON.stringify({ behavior: 'deny', message: `Izza's permission gate is unreachable (${reason}); treat this as denied.` });
    }
    throw e;
  }
}

const handle = createMcpHandler({ tools: actor === 'manager' ? MANAGER_TOOLS : WORKER_TOOLS, callTool });
createInterface({ input: process.stdin }).on('line', async (line) => {
  let msg: unknown;
  try { msg = JSON.parse(line); } catch { return; }
  const reply = await handle(msg);
  if (reply) process.stdout.write(`${JSON.stringify(reply)}\n`);
});
