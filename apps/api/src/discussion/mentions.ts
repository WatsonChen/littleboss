import type { AgentId } from '@littleboss/shared';

const ALIASES: Record<string, AgentId> = {
  claude: 'claude',
  gpt: 'gpt',
  chatgpt: 'gpt',
  gemini: 'gemini',
};

/** Agents @-mentioned in the text, in order of first mention, without repeats. */
export function parseMentions(text: string): AgentId[] {
  const found: AgentId[] = [];
  for (const m of text.matchAll(
    /(?:^|[^A-Za-z0-9_])@(claude|chatgpt|gpt|gemini)(?![A-Za-z0-9_])/gi,
  )) {
    const id = ALIASES[m[1]!.toLowerCase()]!;
    if (!found.includes(id)) found.push(id);
  }
  return found;
}
