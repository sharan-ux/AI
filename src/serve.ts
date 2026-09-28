import { handleCommand } from './core.ts';
import type { CoreContext } from './core.ts';
import { preRouteToAgent } from './router.ts';
import { spokenReply } from './spoken.ts';

export type ServeContext = Omit<CoreContext, 'ask' | 'print'>;
type Write = (msg: Record<string, unknown>) => void;
type Agent = { userTurn(text: string): Promise<string> };

const MAX_QUEUE = 3;

export function createServer(base: ServeContext, write: Write, agent?: Agent) {
  const queue: { id: string; text: string }[] = [];
  const asks = new Map<string, (v: boolean | null) => void>();
  const agentAsks = new Map<string, { kind: 'confirm' | 'text'; resolve: (v: boolean | string | null) => void }>();
  const agentInFlight = new Set<Promise<unknown>>();
  let running = false;
  let closed = false;
  let askSeq = 0;
  let agentSeq = 0;
  let lastProgress = 0;

  // Agent turns run in their own lane: they never hold the local `running` lock or a queue slot,
  // so a multi-minute manager turn cannot block quick commands. The hub already serializes its
  // own manager turns, so no extra lock is added here — agentInFlight just lets idle()/close()
  // account for turns that are still in progress.
  function dispatchAgent(id: string, text: string) {
    const p = (async () => {
      try {
        const say = await agent!.userTurn(text);
        write({ type: 'done', id, outcome: 'agent', say, lines: [] });
      } catch (e) {
        write({ type: 'done', id, outcome: 'failed', say: "I couldn't reach my manager brain.", lines: [`✗ ${(e as Error).message}`] });
      }
    })();
    agentInFlight.add(p);
    p.finally(() => agentInFlight.delete(p));
  }

  async function run(cmd: { id: string; text: string }) {
    const lines: string[] = [];
    write({ type: 'state', state: 'thinking' });
    const ctx: CoreContext = {
      ...base,
      print: (line) => { lines.push(line); },
      ask: (question) => new Promise((resolve) => {
        if (closed) return resolve(null);
        const id = `q${++askSeq}`;
        asks.set(id, resolve);
        write({ type: 'ask', id, question });
      }),
    };
    try {
      const summary = await handleCommand(cmd.text, ctx);
      if (agent && summary.outcome === 'unknown') { dispatchAgent(cmd.id, cmd.text); return; }
      write({ type: 'done', id: cmd.id, outcome: summary.outcome, say: spokenReply(summary), lines });
    } catch (e) {
      write({ type: 'done', id: cmd.id, outcome: 'failed', say: 'Something went wrong, please try again.', lines: [...lines, `✗ ${(e as Error).message}`] });
    }
  }

  function pump() {
    if (running) return;
    const next = queue.shift();
    if (!next) return;
    running = true;
    run(next).finally(() => { running = false; pump(); });
  }

  return {
    handleLine(line: string) {
      if (!line.trim()) return;
      let msg: any;
      try { msg = JSON.parse(line); } catch { write({ type: 'warning', message: 'ignored a line that is not JSON' }); return; }
      if (msg?.type === 'command' && typeof msg.id === 'string' && typeof msg.text === 'string') {
        if (agent && preRouteToAgent(msg.text)) {
          write({ type: 'state', state: 'thinking' });
          dispatchAgent(msg.id, msg.text);
          return;
        }
        if (running && queue.length >= MAX_QUEUE) {
          write({ type: 'done', id: msg.id, outcome: 'unknown', say: "I'm still working on the last one.", lines: [] });
          return;
        }
        queue.push({ id: msg.id, text: msg.text });
        pump();
        return;
      }
      if (msg?.type === 'answer' && typeof msg.id === 'string') {
        const agentAsk = agentAsks.get(msg.id);
        if (agentAsk) {
          agentAsks.delete(msg.id);
          const v = msg.value;
          agentAsk.resolve(agentAsk.kind === 'text' ? (typeof v === 'string' ? v : null) : (v === true ? true : v === false ? false : null));
          return;
        }
        const resolve = asks.get(msg.id);
        if (resolve) { asks.delete(msg.id); resolve(msg.value === true ? true : msg.value === false ? false : null); }
        return;
      }
      write({ type: 'warning', message: `ignored message of type ${String(msg?.type)}` });
    },
    close() {
      closed = true;
      for (const [id, resolve] of asks) { asks.delete(id); resolve(null); }
      for (const [id, agentAsk] of agentAsks) { agentAsks.delete(id); agentAsk.resolve(null); }
    },
    async idle() {
      while (running || queue.length > 0 || agentInFlight.size > 0) await new Promise((r) => setTimeout(r, 5));
    },
    askUser(question: string, kind: 'confirm' | 'text'): Promise<boolean | string | null> {
      if (closed) return Promise.resolve(null);
      const id = `a${++agentSeq}`;
      return new Promise((resolve) => { agentAsks.set(id, { kind, resolve }); write({ type: 'agent-ask', id, question, kind }); });
    },
    say(text: string) { write({ type: 'agent-say', text }); },
    progress() {
      const t = Date.now();
      if (t - lastProgress < 2000) return;
      lastProgress = t;
      write({ type: 'agent-progress' });
    },
  };
}
