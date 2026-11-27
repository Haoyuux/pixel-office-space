import { MODEL_CHOICES, type ModelChoice } from '@office/shared';

/** Console slash commands (run locally, never sent to the agents). */
export type CommandName = 'resume' | 'model' | 'new' | 'clear' | 'chat' | 'change' | 'auto' | 'cancel' | 'status' | 'team' | 'help';
export interface CommandDef { name: CommandName; args?: string; desc: string }

export const COMMANDS: CommandDef[] = [
  { name: 'resume', args: '[title]', desc: 'Open past conversations (filter by title)' },
  { name: 'model', args: '[name]', desc: 'Pick the Claude model for this project' },
  { name: 'new', desc: 'Start a fresh conversation' },
  { name: 'clear', desc: 'Same as /new — the next message starts fresh' },
  { name: 'chat', desc: 'Chat mode: just an answer, nothing is changed' },
  { name: 'change', desc: 'Change mode: always plan and build' },
  { name: 'auto', desc: 'Auto mode: the PM decides' },
  { name: 'cancel', desc: 'Cancel the running ticket' },
  { name: 'status', desc: 'Claude Code and project status' },
  { name: 'team', desc: 'Edit the team' },
  { name: 'help', desc: 'List the commands' },
];

export const MODEL_DESC: Record<ModelChoice, string> = {
  default: "Claude Code's default", opus: 'Most capable', sonnet: 'Balanced', haiku: 'Fastest', fable: 'Fable',
};

/** A popup row: `run` is the composer text that row stands for. */
export interface Suggestion { label: string; value: string; desc: string; run: string; complete: string }

/** Popup rows for the composer text: commands by prefix after `/`, models after `/model `; none otherwise. */
export function suggest(text: string): Suggestion[] {
  const m = /^\/model\s+(\S*)$/.exec(text);
  if (m) {
    return MODEL_CHOICES.filter(x => x.startsWith(m[1].toLowerCase()))
      .map(x => ({ label: x, value: x, desc: MODEL_DESC[x], run: `/model ${x}`, complete: `/model ${x}` }));
  }
  const c = /^\/(\S*)$/.exec(text);
  if (!c) return [];
  return COMMANDS.filter(x => x.name.startsWith(c[1].toLowerCase()))
    .map(x => ({ label: `/${x.name}`, value: x.name, desc: x.desc, run: `/${x.name}`, complete: x.args ? `/${x.name} ` : `/${x.name}` }));
}

/** `/name arg…` → its parts; null when the text is not a command. */
export function parseCommand(text: string): { name: string; arg: string; known: boolean } | null {
  const m = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!m) return null;
  const name = m[1].toLowerCase();
  return { name, arg: (m[2] ?? '').trim(), known: COMMANDS.some(c => c.name === name) };
}

export const isModel = (s: string): s is ModelChoice => (MODEL_CHOICES as string[]).includes(s);
