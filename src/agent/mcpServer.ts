export interface ToolDef { name: string; description: string; inputSchema: Record<string, unknown> }
type CallTool = (name: string, args: Record<string, unknown>) => Promise<string>;

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });
const str = (description: string) => ({ type: 'string', description });

export const PERMISSION_TOOL: ToolDef = {
  name: 'permission',
  description: 'Izza permission gate (called by Claude Code, not by the model).',
  inputSchema: { type: 'object', properties: { tool_name: { type: 'string' }, input: { type: 'object' }, tool_use_id: { type: 'string' } }, required: ['tool_name', 'input'] },
};

export const MANAGER_TOOLS: ToolDef[] = [
  { name: 'start_worker', description: 'Start (or resume) a worker Claude Code session for a Jira ticket in its own git worktree. Asks the user for the project folder the first time.', inputSchema: obj({ ticket: str('Ticket key, e.g. PAY-142'), project: str('Jira project key, e.g. PAY (defaults to the ticket prefix)'), title: str('Short ticket title'), brief: str('Everything the worker needs: goal, acceptance criteria, decisions, constraints') }, ['ticket', 'brief']) },
  { name: 'message_worker', description: 'Send a follow-up instruction or answer to a running worker.', inputSchema: obj({ worker: str('Ticket key of the worker'), text: str('Message') }, ['worker', 'text']) },
  { name: 'worker_status', description: 'Status and latest progress of one worker or all workers.', inputSchema: obj({ worker: str('Ticket key (optional)') }) },
  { name: 'stop_worker', description: 'Stop a worker; its task is marked paused.', inputSchema: obj({ worker: str('Ticket key'), reason: str('Why') }, ['worker']) },
  { name: 'open_vscode', description: "Open VS Code on a worker's worktree or a project folder.", inputSchema: obj({ worker: str('Ticket key'), path: str('Folder path') }) },
  { name: 'open_terminal_tab', description: "Open a Windows Terminal tab showing a worker's live progress.", inputSchema: obj({ worker: str('Ticket key') }, ['worker']) },
  { name: 'open_url', description: 'Open an https URL in Chrome (e.g. the Jira ticket).', inputSchema: obj({ url: str('https URL') }, ['url']) },
  { name: 'remember', description: 'Remember something. Use key "project:<KEY>" with a folder path to map a Jira project to a repo.', inputSchema: obj({ key: str('Key'), value: str('Value') }, ['key', 'value']) },
  { name: 'recall', description: 'Recall remembered values whose key contains the given text.', inputSchema: obj({ key: str('Key or part of it') }, ['key']) },
  { name: 'ask_user', description: 'Ask the user a question out loud and return their answer text (or "(no answer)").', inputSchema: obj({ question: str('One short question') }, ['question']) },
  { name: 'speak', description: 'Say a short update out loud (queued until the user is not mid-conversation).', inputSchema: obj({ text: str('One or two short sentences') }, ['text']) },
  PERMISSION_TOOL,
];

export const WORKER_TOOLS: ToolDef[] = [PERMISSION_TOOL];

export function createMcpHandler({ tools, callTool }: { tools: ToolDef[]; callTool: CallTool }) {
  return async function handle(msg: any): Promise<object | null> {
    if (msg?.id === undefined || msg?.id === null) return null;
    const ok = (result: unknown) => ({ jsonrpc: '2.0', id: msg.id, result });
    const err = (code: number, message: string) => ({ jsonrpc: '2.0', id: msg.id, error: { code, message } });
    switch (msg.method) {
      case 'initialize':
        return ok({ protocolVersion: msg.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'izza', version: '0.3.0' } });
      case 'ping':
        return ok({});
      case 'tools/list':
        return ok({ tools });
      case 'tools/call': {
        const name = msg.params?.name;
        if (!tools.some((t) => t.name === name)) return err(-32602, `unknown tool ${name}`);
        try {
          return ok({ content: [{ type: 'text', text: await callTool(name, msg.params?.arguments ?? {}) }] });
        } catch (e) {
          return ok({ content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true });
        }
      }
      default:
        return err(-32601, `method not found: ${msg.method}`);
    }
  };
}
