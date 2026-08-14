/**
 * geto-goals — durable autonomous goal loop for pi (Codex /goal style).
 *
 * /goal set <text> [--done <criteria>] [--max-iterations N] [--budget $]
 * /goal show | edit <text> | pause | resume | clear | status
 *
 * Design (survives compaction by construction):
 * - The goal is STATE, not context: it lives in <project>/.pi/goals/goal.json.
 *   Compaction can only delete context; it cannot touch the file.
 * - Every turn starts with the goal re-injected verbatim (before_agent_start),
 *   so no matter how much history was summarized, the agent always sees the
 *   full goal + last step/next step.
 * - The agent reports progress via the goal_report tool, which writes to the
 *   file (source of truth) and mirrors a short entry to the transcript.
 * - agent_settled restarts the loop (follow-up message) while the goal is
 *   active and guards (iterations, cost budget, stuck detection) allow it.
 * - session_compact re-appends the goal state to the transcript and resumes.
 * - Children spawned by geto-subagents set GETO_GOALS_DISABLED=1 and are
 *   excluded from the loop.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Type } from "typebox";

const GOAL_SUBDIR = "goals";
const GOAL_FILE = "goal.json";
const DISABLE_ENV = "GETO_GOALS_DISABLED";
const DEFAULT_MAX_ITERATIONS = 50;
const MAX_NOTES = 40;

type GoalStatus = "active" | "paused" | "done" | "blocked";

interface ProgressNote {
  ts: number;
  note: string;
}

interface GoalState {
  text: string;
  definitionOfDone?: string;
  status: GoalStatus;
  progress: ProgressNote[];
  loop: {
    iterations: number;
    maxIterations: number;
    maxCostUsd?: number;
    lastStep?: string;
    nextStep?: string;
  };
  createdAt: number;
  updatedAt: number;
}

function goalPath(cwd: string): string {
  return join(cwd, ".pi", GOAL_SUBDIR, GOAL_FILE);
}

async function loadGoal(cwd: string): Promise<GoalState | null> {
  const p = goalPath(cwd);
  try {
    if (!existsSync(p)) return null;
    const raw = await readFile(p, "utf8");
    return JSON.parse(raw) as GoalState;
  } catch {
    return null;
  }
}

async function saveGoal(cwd: string, goal: GoalState): Promise<string> {
  const p = goalPath(cwd);
  await mkdir(join(cwd, ".pi", GOAL_SUBDIR), { recursive: true, mode: 0o700 });
  const tmp = `${p}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(goal, null, 2), { encoding: "utf8", mode: 0o600 });
  await rename(tmp, p);
  return p;
}

function goalPrompt(g: GoalState): string {
  const lines = [
    "## ACTIVE GOAL (persistent — report progress with goal_report)",
    `Goal: ${g.text}`,
  ];
  if (g.definitionOfDone) lines.push(`Definition of done: ${g.definitionOfDone}`);
  if (g.loop.lastStep) lines.push(`Last step: ${g.loop.lastStep}`);
  if (g.loop.nextStep) lines.push(`Next step: ${g.loop.nextStep}`);
  const recent = g.progress.slice(-3);
  if (recent.length) lines.push(`Recent progress: ${recent.map((n) => n.note).join(" | ")}`);
  lines.push(
    `Iterations: ${g.loop.iterations}/${g.loop.maxIterations}${g.loop.maxCostUsd ? ` · budget: $${g.loop.maxCostUsd}` : ""}`,
    "When you make progress, complete, or hit a blocker, call goal_report(status, note). The loop continues while the goal is active.",
  );
  return lines.join("\n");
}

/** Loop guard: should the agent be asked to continue? */
function shouldContinue(g: GoalState, costUsd: number): { yes: boolean; reason?: string } {
  if (g.status !== "active") return { yes: false, reason: `goal ${g.status}` };
  if (g.loop.iterations >= g.loop.maxIterations) return { yes: false, reason: `reached max iterations (${g.loop.iterations}/${g.loop.maxIterations})` };
  if (g.loop.maxCostUsd !== undefined && costUsd > g.loop.maxCostUsd) return { yes: false, reason: `budget exhausted ($${costUsd.toFixed(2)} > $${g.loop.maxCostUsd})` };
  const notes = g.progress;
  if (notes.length >= 2) {
    const a = notes[notes.length - 1];
    const b = notes[notes.length - 2];
    if (a.note === b.note) return { yes: false, reason: "stuck (two identical progress reports in a row)" };
  }
  return { yes: true };
}

function sumCostUsd(ctx: ExtensionContext): number {
  let total = 0;
  try {
    for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.type !== "message") continue;
      const msg = entry.message as { usage?: { cost?: { total?: number } } };
      const t = msg.usage?.cost?.total;
      if (typeof t === "number" && Number.isFinite(t)) total += t;
    }
  } catch {
    /* best-effort */
  }
  return total;
}

// exported for tests
export { goalPath, loadGoal, saveGoal, goalPrompt, shouldContinue };

export default function (pi: ExtensionAPI) {
  const active = (): boolean => process.env[DISABLE_ENV] !== "1";

  // ── per-turn injection: the goal is state, re-supplied every turn ──────────

  pi.on("before_agent_start", async (event, ctx) => {
    if (!active()) return;
    const g = await loadGoal(ctx.cwd);
    if (!g || g.status !== "active") return;
    event.systemPrompt += "\n\n" + goalPrompt(g);
  });

  // ── loop: restart while the goal is active and guards allow ────────────────

  // agent_settled is emitted from inside the previous run's finally. Starting the
  // next run synchronously there nests runs (R1.finally → settled → await R2 → …)
  // and, once any run aborts, cascades into an infinite abort loop: every aborted
  // run re-fires settled, which starts a new run that aborts instantly. Continuations
  // are deferred one macrotask so the previous run fully unwinds first, and the flag
  // collapses double-settles within the same tick.
  let continuationScheduled = false;

  pi.on("agent_settled", async (_event, ctx) => {
    if (!active()) return;
    const g = await loadGoal(ctx.cwd);
    if (!g) return;
    const check = shouldContinue(g, sumCostUsd(ctx));
    if (!check.yes) {
      if (g.status === "active") {
        g.status = "paused";
        g.updatedAt = Date.now();
        await saveGoal(ctx.cwd, g);
        ctx.ui.notify(`goal paused: ${check.reason ?? "loop guard"}. /goal resume to continue.`, "warning");
      }
      return;
    }
    g.loop.iterations += 1; // each loop restart counts — caps runaway loops even without goal_report calls
    g.updatedAt = Date.now();
    await saveGoal(ctx.cwd, g);
    if (continuationScheduled) return;
    continuationScheduled = true;
    setTimeout(() => {
      continuationScheduled = false;
      if (!ctx.isIdle()) return; // the user or another extension started a run meanwhile
      pi.sendUserMessage(
        `Continue working toward the active goal. Use goal_report to record progress, completion (done), or a blocker (blocked). Goal state: ${goalPath(ctx.cwd)}`,
      );
    }, 0);
  });

  // ── compaction: re-append the goal to the transcript and resume ────────────

  pi.on("session_compact", async (_event, ctx) => {
    if (!active()) return;
    const g = await loadGoal(ctx.cwd);
    if (!g || g.status !== "active") return;
    pi.appendEntry("goal-status", { text: g.text, status: g.status, progress: g.progress.slice(-3), file: goalPath(ctx.cwd) });
    await pi.sendUserMessage(
      `(compaction happened) Continue working toward the active goal. Full state: ${goalPath(ctx.cwd)}. Report via goal_report.`,
    );
  });

  // ── goal_report tool: the agent's progress channel ─────────────────────────

  pi.registerTool({
    name: "goal_report",
    label: "Goal Report",
    description:
      "Report progress toward the active goal, mark it done, or declare a blocker. Writing to the durable goal file; the loop continues while the goal stays active.",
    promptSnippet: "Report goal progress / completion / blockers",
    parameters: Type.Object({
      status: StringEnum(["progress", "done", "blocked"] as const, { description: "progress = keep going, done = goal achieved, blocked = cannot continue without user input" }),
      note: Type.String({ description: "Concise summary of what happened, what's next (for progress), or what's blocking." }),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const g = await loadGoal(ctx.cwd);
      if (!g) {
        return { content: [{ type: "text", text: "No active goal. Set one with /goal set <text>." }], details: {} };
      }
      if (g.status !== "active") {
        return { content: [{ type: "text", text: `Goal is ${g.status} — not running.` }], details: { status: g.status } };
      }
      g.progress.push({ ts: Date.now(), note: params.note });
      if (g.progress.length > MAX_NOTES) g.progress = g.progress.slice(-MAX_NOTES);
      g.updatedAt = Date.now();
      if (params.status === "done") {
        g.status = "done";
      } else if (params.status === "blocked") {
        g.status = "blocked";
      } else {
        g.status = "active";
        g.loop.lastStep = params.note;
      }
      const file = await saveGoal(ctx.cwd, g);
      pi.appendEntry("goal-status", { status: g.status, note: params.note, text: g.text });
      const check = shouldContinue(g, sumCostUsd(ctx));
      const lines = [
        `goal ${g.status} — recorded (${g.progress.length} notes).`,
        `Iterations: ${g.loop.iterations}/${g.loop.maxIterations}${g.loop.maxCostUsd ? ` · budget $${g.loop.maxCostUsd}` : ""}`,
        file,
      ];
      if (!check.yes) lines.push(`Loop will stop: ${check.reason}`);
      return { content: [{ type: "text", text: lines.join("\n") }], details: { status: g.status, file } };
    },
  });

  // ── /goal command ──────────────────────────────────────────────────────────

  pi.registerCommand("goal", {
    description: "Durable autonomous goal loop. Usage: /goal set <text> [--done <criteria>] [--max-iterations N] [--budget $] | show | edit <text> | pause | resume | clear | status",
    getArgumentCompletions(prefix: string) {
      const opts = ["set", "show", "edit", "pause", "resume", "clear", "status"];
      return opts.filter((o) => o.startsWith(prefix)).map((value) => ({ value, label: value }));
    },
    handler: async (args, ctx) => {
      const tokens = (args ?? "").trim().split(/\s+/).filter(Boolean);
      const cmd = tokens[0] ?? "show";
      const rest = tokens.slice(1).join(" ");
      const SUBCOMMANDS = new Set(["set", "show", "edit", "pause", "resume", "clear", "status"]);
      // "/goal <free text>" starts a goal — alias for set
      const isSet = cmd === "set" || !SUBCOMMANDS.has(cmd);

      const g = await loadGoal(ctx.cwd);

      if (isSet) {
        const raw = cmd === "set" ? rest : (args ?? "").trim();
        if (!raw) {
          ctx.ui.notify("usage: /goal set <text> [--done <criteria>] [--max-iterations N] [--budget $]", "info");
          return;
        }
        let text = raw;
        let definitionOfDone: string | undefined;
        let maxIterations = DEFAULT_MAX_ITERATIONS;
        let maxCostUsd: number | undefined;
        const mDone = text.match(/--done\s+(.+?)(?=\s+--|$)/);
        if (mDone) { definitionOfDone = mDone[1].trim(); text = text.replace(mDone[0], "").trim(); }
        const mIter = text.match(/--max-iterations\s+(\d+)/);
        if (mIter) { maxIterations = Number(mIter[1]); text = text.replace(mIter[0], "").trim(); }
        const mBudget = text.match(/--budget\s+([\d.]+)/);
        if (mBudget) { maxCostUsd = Number(mBudget[1]); text = text.replace(mBudget[0], "").trim(); }
        const now = Date.now();
        const goal: GoalState = {
          text: text || raw,
          definitionOfDone,
          status: "active",
          progress: [],
          loop: { iterations: 0, maxIterations, maxCostUsd },
          createdAt: now,
          updatedAt: now,
        };
        const file = await saveGoal(ctx.cwd, goal);
        ctx.ui.notify(`goal set — active. File: ${file}\nThe agent loop will continue autonomously until done, blocked, paused, or budget/iteration limits.`, "info");
        // Kick off the first iteration immediately (Codex /goal behavior): when
        // idle, start the agent now; when streaming, the agent_settled handler
        // picks the goal up after the current run settles.
        if (ctx.isIdle()) {
          pi.sendUserMessage(
            `A new goal is active. Start working on it now. Use goal_report to record progress, completion (done), or a blocker (blocked). Goal state: ${goalPath(ctx.cwd)}`,
          );
        }
        return;
      }

      if (!g) {
        ctx.ui.notify("no goal set. /goal set <text> to start.", "info");
        return;
      }

      if (cmd === "show" || cmd === "status") {
        ctx.ui.notify(`${goalPrompt(g)}\n\nFile: ${goalPath(ctx.cwd)}`, "info");
        return;
      }
      if (cmd === "edit") {
        if (!rest) { ctx.ui.notify("usage: /goal edit <new text>", "info"); return; }
        g.text = rest;
        g.updatedAt = Date.now();
        await saveGoal(ctx.cwd, g);
        ctx.ui.notify("goal updated.", "info");
        return;
      }
      if (cmd === "pause") {
        g.status = "paused";
        g.updatedAt = Date.now();
        await saveGoal(ctx.cwd, g);
        ctx.ui.notify("goal paused.", "info");
        return;
      }
      if (cmd === "resume") {
        g.status = "active";
        g.updatedAt = Date.now();
        await saveGoal(ctx.cwd, g);
        ctx.ui.notify("goal resumed — the loop continues on the next turn.", "info");
        return;
      }
      if (cmd === "clear") {
        const p = goalPath(ctx.cwd);
        try {
          const { rm } = await import("node:fs/promises");
          if (existsSync(p)) await rm(p, { force: true });
          ctx.ui.notify("goal cleared.", "info");
        } catch {
          ctx.ui.notify("failed to clear goal file.", "error");
        }
        return;
      }
      ctx.ui.notify("unknown /goal subcommand. Use set | show | edit | pause | resume | clear | status.", "info");
    },
  });
}
