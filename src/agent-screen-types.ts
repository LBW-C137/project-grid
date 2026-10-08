// What the reading view knows about the agent's own terminal screen (see terminal-screen.ts for the rows and
// agent-screen.ts for the parser). Everything is read from text the CLI drew; null means "not on screen".

export type ScreenAgent = 'codex' | 'claude';

// The CLI's welcome lines: "Claude Code v2.1.293 / Opus 5.5 with high effort · Claude Max / C:\work\demo-app",
// or ">_ OpenAI Codex (v0.161.0) / C:\work\demo-app" with the model from Codex's footer.
export type ScreenBanner = {
  product: string;            // "Claude Code" | "OpenAI Codex"
  version: string | null;     // "2.1.293", "0.161.0"
  model: string | null;       // "Opus 5.5", "GPT-6.1-Sol"
  effort: string | null;      // "high"
  plan: string | null;        // "Claude Max"
  directory: string | null;   // as printed
};

// The footer under the input box: Claude "⏺ Opus 5.5 · demo-app · ctx 4%  ● high · /effort" and
// "⏸ manual mode on · ← for agents" / "⏵⏵ bypass permissions on (shift+tab to cycle)";
// Codex "GPT-6.1-Sol high · C:\work\demo-app · 828K wi…" and "? for shortcuts   ⚠ 1 warning · f2 to view".
export type ScreenStatus = {
  model: string | null;       // "Opus 5.5" / "GPT-6.1-Sol"
  effort: string | null;      // "high"
  context: string | null;     // "ctx 4%", "828K wi…" as printed
  mode: string | null;        // "manual mode on", "bypass permissions on", "accept edits on", "plan mode on" (Claude)
  notes: string[];            // other footer text worth showing as is, e.g. "⚠ 1 warning · f2 to view"
};

// A list the CLI is asking the user to pick from: a permission prompt or a menu such as /model.
export type ScreenOption = {
  number: number;             // the option's printed number (1-based)
  label: string;              // "Yes", "Yes, proceed", "Opus 5.5 ✔"
  detail: string;             // the rest of the option text, continuation rows joined with a space
  hotkey: string | null;      // Codex "(y)", "(p)", "(esc)" → "y", "p", "esc"; null when none is printed
  selected: boolean;          // the row with the CLI's cursor (Claude "❯", Codex "›")
};
export type ScreenChoice = {
  kind: 'permission' | 'menu';
  title: string;              // "Do you want to create hello.txt?", "Would you like to run the following command?",
                              // "Select model", "Select Model and Effort"
  context: string[];          // rows between the title area and the options worth showing (command, reason, file name)
  options: ScreenOption[];
  hint: string | null;        // "Esc to cancel · Tab to amend", "Press enter to confirm or esc to cancel", "enter select · esc back"
};

export type AgentScreen = {
  banner: ScreenBanner | null;
  status: ScreenStatus;
  choice: ScreenChoice | null;
  // The CLI's own popups over its input; the reading view has its own for "/" and "@", so these only tell it to
  // stay out of the way: 'slash' (command list), 'mention' (@ list), 'shortcuts' ("?" help), or none.
  overlay: 'none' | 'slash' | 'mention' | 'shortcuts';
};
