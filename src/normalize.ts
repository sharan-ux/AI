export function normalizePhrase(text: string): string {
  const cleaned = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.replace(/^(?:(?:hey|ok|okay)\s+)?(?:jarvis|izza)(?:\s+|$)/, '').trim();
}
