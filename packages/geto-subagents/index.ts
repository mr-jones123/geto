/**
 * geto-subagents — tmux-hosted subagents for pi.
 *
 * Registers /review, /find, /plan: each spawns a detached tmux session running
 * a fresh interactive `pi` instance with its OWN session file (a separate leaf
 * from the main conversation tree), seeded with context from the parent
 * session + git state. Attach from any terminal with `tmux attach -t <name>`.
 *
 * Model: by default the subagent uses pi's default model ("let AI pick").
 * Override positionally (/review <prompt> <model>) or with --model <id>.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFile, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROLES, type AgentRole } from "./agents.ts";

// ── small helpers ────────────────────────────────────────────────────────────

/** Single-quote for a POSIX shell command line (tmux runs commands via $SHELL -c). */
function shq(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n) + "…";
}

function textOf(entry: { role?: string; content?: unknown }): string {
  const c = entry.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return c
      .filter((p): p is { type: "text"; text: string } => !!p && p.type === "text" && typeof p.text === "string")
      .map((p) => p.text)
      .join("\n");
  }
  return "";
}

function execFileP(cmd: string, args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 30_000 }, (err, stdout, stderr) => {
      if (err) {
        resolve({ ok: false, stdout: String(stdout), stderr: String(stderr || err.message) });
      } else {
        resolve({ ok: true, stdout: String(stdout), stderr: String(stderr) });
      }
    });
  });
}

/** Robust pi CLI invocation: `node <cli-script>` when known, else `pi` on PATH. */
function piInvocation(): string {
  const script = process.argv[1];
  if (script && !script.startsWith("/$bunfs/") && existsSync(script)) {
    return `${process.execPath} ${shq(script)}`;
  }
  return "pi";
}

// ── argument parsing: /review <prompt> [model] [--model <id>] [--no-attach] ──

function looksLikeModel(tok: string, available: string[]): boolean {
  if (tok.includes("/") || tok.includes(":")) return true; // provider/id, provider/id:thinking
  const t = tok.toLowerCase();
  if (available.includes(t)) return true;
  // fuzzy: reasonably-specific substring against the available catalog
  return t.length >= 4 && available.some((m) => m.includes(t));
}

function parseArgs(
  raw: string,
  available: string[],
): { prompt: string; model?: string; attach: boolean } {
  const tokens = raw.trim().split(/\s+/).filter(Boolean);
  let model: string | undefined;
  let attach = true;
  const rest: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === "--model") { model = tokens[i + 1]; i++; continue; }
    if (t.startsWith("--model=")) { model = t.slice("--model=".length); continue; }
    if (t === "--no-attach") { attach = false; continue; }
    rest.push(t);
  }
  if (!model && rest.length > 1) {
    const last = rest[rest.length - 1];
    if (looksLikeModel(last, available)) { model = last; rest.pop(); }
  }
  return { prompt: rest.join(" ").trim(), model, attach };
}

// ── context from the parent conversation + repo state ───────────────────────

function gitOut(ctx: { cwd: string }, args: string[]): string {
  try {
    return execFileSync("git", args, { cwd: ctx.cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

function collectContext(ctx: { cwd: string; sessionManager?: { getEntries?: () => unknown[] } }): string {
  const parts: string[] = [];
  const branch = gitOut(ctx, ["branch", "--show-current"]);
  if (branch) parts.push(`git branch: ${branch}`);
  const log = gitOut(ctx, ["log", "--oneline", "-8"]);
  if (log) parts.push(`recent commits:\n${log}`);
  const status = gitOut(ctx, ["status", "--short"]);
  if (status) parts.push(`working tree changes:\n${status.split("\n").slice(0, 25).join("\n")}`);

  try {
    const entries = (ctx.sessionManager?.getEntries?.() ?? []) as { role?: string; content?: unknown }[];
    const lines: string[] = [];
    for (let i = entries.length - 1; i >= 0 && lines.length < 6; i--) {
      const e = entries[i];
      if (e.role !== "user" && e.role !== "assistant") continue;
      const text = textOf(e).trim();
      if (!text) continue;
      lines.unshift(`${e.role}: ${truncate(text, 400)}`);
    }
    if (lines.length) parts.push(`recent parent-session conversation (for context):\n${lines.join("\n")}`);
  } catch {
    /* session read is best-effort */
  }
  return parts.join("\n\n");
}

// ── spawn ────────────────────────────────────────────────────────────────────

async function spawnSubagent(
  ctx: { cwd: string; sessionManager?: { getEntries?: () => unknown[] } },
  role: AgentRole,
  prompt: string,
  model?: string,
): Promise<{ tmuxName: string; attachCmd: string; sessionId: string }> {
  const sessionId = randomUUID();
  const short = sessionId.slice(0, 6);
  const tmuxName = `geto-${role.id}-${short}`;

  const dir = mkdtempSync(join(tmpdir(), "geto-subagent-"));
  const roleFile = join(dir, "role.md");
  const taskText = [
    `# ${role.taskHeader}`,
    "",
    `Project root: ${ctx.cwd}`,
    "",
    collectContext(ctx),
    "",
    "## Task",
    prompt,
    "",
    "Work autonomously. Use your tools (including geto_graph_* if available) to inspect the codebase. When finished, summarize your findings concisely.",
  ].join("\n");
  writeFileSync(roleFile, role.systemPrompt, "utf8");

  const piArgs = [
    "--session-id", sessionId, // own session file = separate leaf, never loses context
    "--name", `geto ${role.label} ${short}`,
    "--append-system-prompt", roleFile,
    ...(model ? ["--model", model] : []),
    taskText, // inline initial message (shq handles quoting/newlines)
  ];
  const shellCmd = [piInvocation(), ...piArgs].map(shq).join(" ");

  const res = await execFileP("tmux", ["new-session", "-d", "-s", tmuxName, "-c", ctx.cwd, shellCmd]);
  if (!res.ok) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    if (/ENOENT|not found/i.test(res.stderr)) throw new Error("tmux is not installed or not on PATH");
    throw new Error(res.stderr.trim() || res.stdout.trim() || `tmux exited non-zero`);
  }
  return { tmuxName, attachCmd: `tmux attach -t ${tmuxName}`, sessionId };
}

// ── extension ────────────────────────────────────────────────────────────────

// exported for tests
export { parseArgs, shq, spawnSubagent };

export default function (pi: ExtensionAPI) {
  for (const role of Object.values(ROLES)) {
    pi.registerCommand(role.command, {
      description: role.description,
      getArgumentCompletions(prefix: string) {
        const opts = ["--model", "--no-attach"];
        return opts.filter((o) => o.startsWith(prefix)).map((value) => ({ value, label: value }));
      },
      handler: async (args, ctx) => {
        const available = ((ctx.modelRegistry?.getAvailable?.() ?? []) as { id?: string; provider?: string }[])
          .flatMap((m) => [m.id ?? "", `${m.provider}/${m.id}`].filter(Boolean));
        const { prompt, model, attach } = parseArgs(args ?? "", available);
        if (!prompt) {
          ctx.ui.notify(`usage: /${role.command} <prompt> [model] — e.g. /${role.command} review the auth refactor anthropic/claude-sonnet-4-5`, "info");
          return;
        }
        try {
          const s = await spawnSubagent(ctx, role, prompt, model);
          const modelNote = model ? `model: ${model}` : "model: AI picks the default";
          const lines = [
            `spawned ${role.label} subagent — ${modelNote}`,
            `tmux session: ${s.tmuxName}`,
            `attach (any terminal): ${s.attachCmd}`,
            `session id: ${s.sessionId}`,
            attach ? "" : "(--no-attach: tmux session created; nothing else to do)",
          ].filter(Boolean);
          ctx.ui.notify(lines.join("\n"), "info");
        } catch (err) {
          ctx.ui.notify(`failed to spawn ${role.label}: ${String(err).slice(0, 300)}`, "error");
        }
      },
    });
  }

  pi.registerCommand("subagents", {
    description: "List running geto-* subagent tmux sessions. Usage: /subagents",
    handler: async (_args, ctx) => {
      const res = await execFileP("tmux", ["ls"]);
      if (!res.ok) {
        ctx.ui.notify("no tmux server running (or tmux not installed) — nothing to list", "info");
        return;
      }
      const lines = res.stdout.split("\n").filter((l) => /^geto-/.test(l));
      ctx.ui.notify(lines.length ? lines.join("\n") + "\n\nattach: tmux attach -t <name>" : "no geto-* subagent tmux sessions running", "info");
    },
  });
}
