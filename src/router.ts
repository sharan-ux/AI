// Ticket keys (also as spoken: "pay 142", "Pay-142") and talk about work go to the manager agent.
const TICKET_SPOKEN = /\b[A-Za-z]{2,10}[-\s]\d{1,6}\b/;
const AGENT_WORDS = /\b(jira|ticket|tickets|task|tasks|worker|workers|work on|working on|status|everyone|how'?s|how is|what did you do|pull request|pr)\b/i;
const QUICK = /^(open|start|remember)\b/i;
const TICKET_KEY = /\b[A-Z][A-Z0-9]+-\d+\b/;

export function preRouteToAgent(text: string): boolean {
  const hasTicketShape = TICKET_SPOKEN.test(text) || TICKET_KEY.test(text);
  // A command starting with a quick verb (open/start/remember) that has no ticket shape at all
  // stays local, even if it happens to name "jira" (e.g. "open jira"). This check comes first so
  // it overrides AGENT_WORDS for that case.
  if (QUICK.test(text.trim()) && !hasTicketShape) return false;
  if (AGENT_WORDS.test(text)) return true;
  return hasTicketShape;
}
