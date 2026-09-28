import type { StepResult } from './actions.ts';
import type { CommandSummary } from './core.ts';

function label(key: string): string {
  const words = key.replace(/[_-]+/g, ' ').trim();
  return words ? words[0].toUpperCase() + words.slice(1) : words;
}

function failureClause(r: StepResult): string {
  return /no URL configured/i.test(r.message ?? '') ? `${label(r.label)} has no link yet.` : `${label(r.label)} didn't open.`;
}

function build(s: CommandSummary): string {
  const d = s.decision;
  switch (s.outcome) {
    case 'none': return '';
    case 'unknown': return s.errors.length > 0 ? "I couldn't reach my brain." : "I don't know how to do that yet.";
    case 'rejected': return "I can't do that.";
    case 'declined': return 'Okay, cancelled.';
    case 'failed': {
      const failed = s.results.filter((r) => !r.ok);
      if (s.results.some((r) => r.ok)) return ['Done.', ...failed.map(failureClause)].join(' ');
      return ["That didn't work.", ...failed.slice(0, 1).map(failureClause)].join(' ');
    }
    case 'executed':
      if (d.intent === 'remember_fact') return "Got it, I'll remember that.";
      if (d.intent === 'open_app') return `Opening ${label(d.target ?? '')}.`;
      if (d.intent === 'open_workspace') return `Opening your ${label(d.target ?? '').toLowerCase()} workspace.`;
      return 'Done.';
  }
  return '';
}

// Replies must never contain the wake word, or Izza could wake itself.
export function spokenReply(s: CommandSummary): string {
  return build(s).replace(/jarvis|izza/gi, 'it');
}
