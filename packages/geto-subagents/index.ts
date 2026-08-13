/**
 * geto-subagents v2 — fork-based, tmux-hosted subagents for pi.
 *
 * Registers /review, /find, /plan (role presets), /chain (sequential steps via
 * an overlay dialog), /subagents (list), and a generic `subagent` tool.
 *
 * Key design:
 * - Child sessions are FORKS of the parent session file (`pi --fork <file>`),
 *   so the subagent inherits the full conversation and appears as a child
 *   session in /resume's tree — no vague handoff of tasks or context.
 * - The child reports its result back (atomic result.json on agent_settled)
 *   and shuts down; the parent returns the output to the caller.
 * - `pi --attach-subagent <id>` attaches/switches to the child's tmux session
 *   (dedicated socket, separate tmux server).
 * - View ladder (zellij is optional, everything degrades gracefully):
 *   1. zellij floating pane (stacked per subagent) when inside zellij
 *   2. tmux new-window when inside tmux
 *   3. otherwise just print the attach hint — works from any terminal
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text, type Component } from "@earendil-works/pi-tui";
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { ROLES, type AgentRole } from "./agents.ts";

const ATTACH_FLAG = "attach-subagent";
const CHILD_ENV = "PI_TMUX_SUBAGENT_CHILD";
const RESULT_ENV = "PI_TMUX_SUBAGENT_RESULT";
const GOAL_DISABLE_ENV = "GETO_GOALS_DISABLED";
const RUNS_DIR = "tmux-subagents";
const CHAINS_DIR = "tmux-subagents-chains";
const POLL_INTERVAL_MS = 500;
const PANE_PREVIEW_LINES = 18;
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const EXTENSION_PATH = fileURLToPath(import.meta.url);
const MAX_BYTES = 50 * 1024;
const MAX_LINES = 2000;

type RunStatus = "queued" | "running" | "completed" | "failed";

interface ChildResult {
  version: 1;
  status: "completed" | "failed";
  output: string;
  error?: string;
  stopReason?: string;
  sessionFile?: string;
  provider?: string;
  model?: string;
  thinking?: string;
  finishedAt: number;
}

interface RunDetails {
  status: RunStatus;
  task: string;
  cwd: string;
  tmuxSession: string;
  attachCommand: string;
  captureCommand: string;
  killCommand: string;
  provider: string;
  model: string;
  thinking: string;
  pane?: string;
  output?: string;
  sessionFile?: string;
  startedAt?: number;
  finishedAt?: number;
}

interface RunSpec {
  task: string;
  cwd: string;
  attachmentId: string;
  tmuxSession: string;
  tmuxTarget: string;
  attachCommand: string;
  captureCommand: string;
  killCommand: string;
  provider: string;
  model: string;
  thinking: string;
  trusted: boolean;
}

interface SpawnOptions {
  task: string;
  cwd: string;
  provider: string;
  model: string;
  thinking: string;
  attachmentId: string;
  role?: AgentRole;
  parentSessionFile?: string;
  chainDir?: string;
  trusted: boolean;
  attach: boolean;
  zellij: boolean;
}

// ── small helpers ────────────────────────────────────────────────────────────

function getAgentDir(): string {
  const envDir = process.env.PI_AGENT_DIR;
  if (envDir) return envDir.replace(/^~/, homedir());
  return path.join(homedir(), ".pi", "agent");
}

/** Single-quote for a POSIX shell command line (tmux runs commands via $SHELL -c). */
function shq(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n) + "…";
}

function truncateToolText(text: string): string {
  const bytes = Buffer.byteLength(text);
  if (bytes <= MAX_BYTES) return text;
  const lines = text.split("\n");
  if (lines.length > MAX_LINES) {
    return lines.slice(0, MAX_LINES).join("\n") + "\n\n[Output truncated. Full output is available in the child session file.]";
  }
  return Buffer.from(text).subarray(0, MAX_BYTES).toString("utf8") + "\n\n[Output truncated. Full output is available in the child session file.]";
}

function tmuxSocketPath(): string {
  return path.join(getAgentDir(), "tmux-subagents.sock");
}

function tmuxSessionName(sessionId: string): string {
  return `geto-${sessionId.slice(0, 6)}`;
}

function currentTmuxSocket(): string | undefined {
  return process.env.TMUX?.split(",", 1)[0]?.trim() || undefined;
}

function attachFlagValue(argv: string[]): string | undefined {
  const flag = `--${ATTACH_FLAG}`;
  for (let index = 2; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === "--") break;
    if (argument === flag) {
      const value = argv[index + 1];
      return !value || value.startsWith("--") ? "" : value;
    }
    if (argument.startsWith(`${flag}=`)) return argument.slice(flag.length + 1);
  }
  return undefined;
}

function tmuxArgs(...args: string[]): string[] {
  return ["-S", tmuxSocketPath(), ...args];
}

function updateTmuxCommands(spec: RunSpec): void {
  spec.attachCommand = `pi --${ATTACH_FLAG} ${shq(spec.attachmentId)}`;
  spec.captureCommand = `tmux -S ${shq(tmuxSocketPath())} capture-pane -p -J -t ${shq(spec.tmuxTarget)}`;
  spec.killCommand = `tmux -S ${shq(tmuxSocketPath())} kill-session -t ${shq(spec.tmuxSession)}`;
}

// ── attach mode: pi --attach-subagent <id> ───────────────────────────────────

function attachToSubagentAndExit(rawTarget: string): never {
  const target = rawTarget.trim();
  if (!target) {
    console.error(`Error: --${ATTACH_FLAG} requires the session id printed by the subagent tool.`);
    process.exit(2);
  }

  let socket = tmuxSocketPath();
  let session: string;
  if (target.startsWith("v1.")) {
    // Keep attachment working for sessions started before session-id targets.
    try {
      const legacy = JSON.parse(Buffer.from(target.slice(3), "base64url").toString("utf8")) as { s?: unknown; p?: unknown };
      if (typeof legacy.s !== "string" || !legacy.s || typeof legacy.p !== "string" || !legacy.p) {
        throw new Error("missing tmux session or socket");
      }
      session = legacy.s;
      socket = legacy.p;
    } catch (error) {
      console.error(`Error: invalid legacy subagent target: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(2);
    }
  } else {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(target)) {
      console.error(`Error: invalid subagent session id: ${target}`);
      process.exit(2);
    }
    session = tmuxSessionName(target);
  }

  const sameServer = currentTmuxSocket() === socket;
  const args = ["-S", socket, sameServer ? "switch-client" : "attach-session", "-t", session];
  const env = { ...process.env };
  if (!sameServer) {
    delete env.TMUX;
    delete env.TMUX_PANE;
  }
  const result = spawnSync("tmux", args, { stdio: "inherit", env });
  if (result.error) console.error(`Failed to run tmux: ${result.error.message}`);
  process.exit(result.status ?? 1);
}

// ── pi CLI invocation (robust: node <script> as two argv elements) ───────────

function getPiInvocationParts(): string[] {
  const currentScript = process.argv[1];
  if (currentScript && existsSync(currentScript)) {
    return [process.execPath, currentScript];
  }
  const execName = path.basename(process.execPath).toLowerCase();
  if (!/^(node|bun)(\.exe)?$/.test(execName)) {
    return [process.execPath];
  }
  return ["pi"];
}

// ── child mode: report the final assistant result, then shut down ────────────

function textFromAssistant(message: Record<string, unknown>): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is { type: "text"; text: string } => {
      return Boolean(part && typeof part === "object" && part.type === "text" && typeof part.text === "string");
    })
    .map((part) => part.text)
    .join("\n");
}

function findLastAssistant(ctx: ExtensionContext): Record<string, unknown> | undefined {
  const branch = ctx.sessionManager.getBranch();
  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = branch[index];
    if (entry.type !== "message") continue;
    const message = entry.message as unknown as Record<string, unknown>;
    if (message.role === "assistant") return message;
  }
  return undefined;
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporaryPath, filePath);
}

function registerChildReporter(pi: ExtensionAPI, resultPath: string): void {
  let reported = false;

  const report = async (ctx: ExtensionContext, fallbackError?: string): Promise<void> => {
    if (reported) return;
    reported = true;

    const assistant = findLastAssistant(ctx);
    const stopReason = typeof assistant?.stopReason === "string" ? assistant.stopReason : undefined;
    const assistantError = typeof assistant?.errorMessage === "string" ? assistant.errorMessage : undefined;
    const failed = !assistant || stopReason === "error" || stopReason === "aborted" || Boolean(fallbackError);
    const output = assistant ? textFromAssistant(assistant) : "";
    const result: ChildResult = {
      version: 1,
      status: failed ? "failed" : "completed",
      output,
      error: fallbackError ?? assistantError ?? (!assistant ? "Subagent exited without an assistant response." : undefined),
      stopReason,
      sessionFile: ctx.sessionManager.getSessionFile(),
      provider: typeof assistant?.provider === "string" ? assistant.provider : ctx.model?.provider,
      model: typeof assistant?.model === "string" ? assistant.model : ctx.model?.id,
      thinking: pi.getThinkingLevel(),
      finishedAt: Date.now(),
    };

    try {
      await writeJsonAtomic(resultPath, result);
    } catch (error) {
      console.error(`[geto-subagents] Failed to write result: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  // agent_settled was added after older peer type declarations but is present
  // in the Pi runtime this extension targets.
  (pi.on as unknown as (event: "agent_settled", handler: (event: unknown, ctx: ExtensionContext) => void | Promise<void>) => void)(
    "agent_settled",
    async (_event, ctx) => {
      await report(ctx);
      ctx.shutdown();
    },
  );

  pi.on("session_shutdown", async (_event, ctx) => {
    if (!reported) await report(ctx, "Subagent session shut down before the task settled.");
  });
}

// ── pane preview / formatting ────────────────────────────────────────────────

function trimPane(output: string): string {
  const lines = output.replace(/\r/g, "").split("\n");
  while (lines.length > 0 && !lines[0]?.trim()) lines.shift();
  while (lines.length > 0 && !lines[lines.length - 1]?.trim()) lines.pop();
  return lines.slice(-PANE_PREVIEW_LINES).join("\n");
}

function formatDuration(startedAt: number | undefined, finishedAt = Date.now()): string | undefined {
  if (startedAt === undefined) return undefined;
  const seconds = Math.max(0, Math.round((finishedAt - startedAt) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}

function detailsFor(spec: RunSpec, status: RunStatus, extra: Partial<RunDetails> = {}): RunDetails {
  return { status, task: spec.task, cwd: spec.cwd, tmuxSession: spec.tmuxSession, attachCommand: spec.attachCommand, captureCommand: spec.captureCommand, killCommand: spec.killCommand, provider: spec.provider, model: spec.model, thinking: spec.thinking, ...extra };
}

function partialText(details: RunDetails): string {
  const lines = [
    `Subagent ${details.status} in tmux session ${details.tmuxSession}.`,
    `Attach: ${details.attachCommand}`,
    `Capture: ${details.captureCommand}`,
  ];
  if (details.pane) lines.push("", details.pane);
  return lines.join("\n");
}

function resultText(details: RunDetails): string {
  const duration = formatDuration(details.startedAt, details.finishedAt);
  const lines = [
    `Subagent ${details.status}${duration ? ` after ${duration}` : ""}.`,
    `Model: ${details.provider}/${details.model} (${details.thinking})`,
    `tmux: ${details.tmuxSession}`,
    `Attach: ${details.attachCommand}`,
    `Capture: ${details.captureCommand}`,
    `Clean up: ${details.killCommand}`,
  ];
  if (details.sessionFile) lines.push(`Child session (fork of your conversation): ${details.sessionFile}`);
  if (details.output) lines.push("", details.output);
  return truncateToolText(lines.join("\n"));
}

async function abortableDelay(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (signal?.aborted) throw new Error("Subagent aborted.");
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => signal?.removeEventListener("abort", onAbort);
    const timer = setTimeout(() => { cleanup(); resolve(); }, ms);
    const onAbort = () => { clearTimeout(timer); cleanup(); reject(new Error("Subagent aborted.")); };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function validateCwd(cwd: string): Promise<void> {
  let info;
  try { info = await stat(cwd); } catch { throw new Error(`Subagent working directory does not exist: ${cwd}`); }
  if (!info.isDirectory()) throw new Error(`Subagent working directory is not a directory: ${cwd}`);
}

function isSameOrDescendant(base: string, candidate: string): boolean {
  const relative = path.relative(base, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function resolveModel(ctx: ExtensionContext, providerOverride: string | undefined, modelOverride: string | undefined): { provider: string; model: string } {
  const explicitProvider = providerOverride?.trim();
  const explicitModel = modelOverride?.trim();
  let provider = explicitProvider || ctx.model?.provider || "";
  let model = explicitModel || ctx.model?.id || "";

  const slashIndex = explicitModel?.indexOf("/") ?? -1;
  if (explicitModel && slashIndex > 0) {
    const modelProvider = explicitModel.slice(0, slashIndex);
    if (!explicitProvider) {
      provider = modelProvider;
      model = explicitModel.slice(slashIndex + 1);
    } else if (explicitProvider === modelProvider) {
      model = explicitModel.slice(slashIndex + 1);
    }
  }

  if (!provider || !model) {
    throw new Error("No model is active. Pass both provider and model to the subagent tool.");
  }
  return { provider, model };
}

// ── argument parsing for role commands: /review <prompt> [model] [flags] ─────

function looksLikeModel(tok: string, available: string[]): boolean {
  if (tok.includes("/") || tok.includes(":")) return true;
  const t = tok.toLowerCase();
  if (available.includes(t)) return true;
  return t.length >= 4 && available.some((m) => m.includes(t));
}

function parseArgs(raw: string, available: string[]): { prompt: string; model?: string; attach: boolean; zellij: boolean } {
  const tokens = raw.trim().split(/\s+/).filter(Boolean);
  let model: string | undefined;
  let attach = true;
  let zellij = process.env.GETO_SUBAGENTS_VIEW !== "attach";
  const rest: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === "--model") { model = tokens[i + 1]; i++; continue; }
    if (t.startsWith("--model=")) { model = t.slice("--model=".length); continue; }
    if (t === "--no-attach") { attach = false; continue; }
    if (t === "--no-zellij") { zellij = false; continue; }
    rest.push(t);
  }
  if (!model && rest.length > 1) {
    const last = rest[rest.length - 1];
    if (looksLikeModel(last, available)) { model = last; rest.pop(); }
  }
  return { prompt: rest.join(" ").trim(), model, attach, zellij };
}

// ── view ladder: zellij floating pane → tmux window → attach hint ────────────

async function zellijAvailable(): Promise<boolean> {
  if (process.env.ZELLIJ_SESSION_NAME || process.env.ZELLIJ) return true;
  try {
    const out = execFileSync("zellij", ["action", "dump-layout"], { timeout: 5_000, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return !/no active session/i.test(out);
  } catch {
    return false;
  }
}

/** Best-effort: open the subagent in a zellij floating pane or a tmux window. Returns a human note. */
async function openSubagentView(
  exec: (cmd: string, args: string[], opts?: { timeout?: number }) => Promise<{ code: number; stdout: string; stderr: string }>,
  spec: RunSpec,
  useZellij: boolean,
): Promise<string> {
  if (useZellij && (await zellijAvailable())) {
    try {
      const res = await exec(
        "zellij",
        ["action", "new-pane", "--floating", "--width", "72%", "--height", "58%", spec.attachCommand],
        { timeout: 5_000 },
      );
      if (res.code === 0) return "Opened in a zellij floating pane (stacked with other subagents).";
    } catch { /* fall through */ }
  }
  if (process.env.TMUX) {
    try {
      const sess = await exec("tmux", ["display-message", "-p", "#S"], { timeout: 5_000 });
      const name = sess.code === 0 && sess.stdout.trim() ? sess.stdout.trim() : undefined;
      if (name) {
        const res = await exec("tmux", ["new-window", "-d", "-n", spec.tmuxSession, "-c", spec.cwd, spec.attachCommand], { timeout: 5_000 });
        if (res.code === 0) return `Opened in a new tmux window of "${name}" (flip with Ctrl+B n/p).`;
      }
    } catch { /* fall through */ }
  }
  return "";
}

// ── spawn: fork of the parent session, detached tmux session, result polling ─

async function buildChildCommand(opts: SpawnOptions, paths: { roleFile?: string; taskFile: string; resultPath: string }): Promise<string> {
  const piArgs = [
    ...getPiInvocationParts(),
    ...(opts.parentSessionFile ? ["--fork", opts.parentSessionFile] : []),
    "--session-id",
    opts.attachmentId,
    "--name",
    `geto ${opts.role?.label ?? "subagent"} ${opts.attachmentId.slice(0, 6)}`,
    "--provider",
    opts.provider,
    "--model",
    opts.model,
    "--thinking",
    opts.thinking,
    opts.trusted ? "--approve" : "--no-approve",
    ...(opts.role && paths.roleFile ? ["--append-system-prompt", paths.roleFile] : []),
    "--extension",
    EXTENSION_PATH,
    `@${paths.taskFile}`,
  ];
  return [
    "exec env",
    `${CHILD_ENV}=1`,
    `${RESULT_ENV}=${shq(paths.resultPath)}`,
    `${GOAL_DISABLE_ENV}=1`,
    piArgs.map(shq).join(" "),
  ].join(" ");
}

async function spawnSubagent(
  exec: (cmd: string, args: string[], opts?: { timeout?: number }) => Promise<{ code: number; stdout: string; stderr: string }>,
  ctx: { cwd: string; sessionManager?: { getSessionId?: () => string; getSessionFile?: () => string | undefined } },
  opts: SpawnOptions,
  signal?: AbortSignal,
  onUpdate?: (details: RunDetails) => void,
): Promise<{ tmuxName: string; attachCommand: string; sessionFile?: string; result: ChildResult; viewNote: string }> {
  const sessionId = opts.attachmentId;
  const tmuxName = tmuxSessionName(sessionId);
  const parentSessionId = ctx.sessionManager?.getSessionId?.() ?? "unknown";
  const runDir = path.join(getAgentDir(), RUNS_DIR, parentSessionId, sessionId);
  const resultPath = path.join(runDir, "result.json");
  const taskFile = path.join(runDir, "task.md");
  const roleFile = opts.role ? path.join(runDir, "role.md") : undefined;
  const tmuxSession = tmuxName;
  const tmuxTarget = `${tmuxSession}:0.0`;
  const spec: RunSpec = {
    task: opts.task,
    cwd: opts.cwd,
    attachmentId: sessionId,
    tmuxSession,
    tmuxTarget,
    attachCommand: "",
    captureCommand: "",
    killCommand: "",
    provider: opts.provider,
    model: opts.model,
    thinking: opts.thinking,
    trusted: opts.trusted,
  };
  updateTmuxCommands(spec);

  await validateCwd(opts.cwd);
  await mkdir(runDir, { recursive: true, mode: 0o700 });

  const taskLines = [
    `# ${opts.role ? opts.role.taskHeader : "DELEGATED TASK"}`,
    "",
    `Project root: ${opts.cwd}`,
  ];
  if (opts.parentSessionFile) taskLines.push(`Forked from session: ${opts.parentSessionFile}`);
  taskLines.push(
    "",
    "You are running as a child session (fork) of the main conversation. The trailing `subagent` tool call in the history is the call that created you — ignore it.",
  );
  if (opts.chainDir) taskLines.push("", `Shared chain directory (may be referenced as {chain_dir}): ${opts.chainDir}`);
  taskLines.push("", "## Task", opts.task, "", "Work autonomously. Use your tools (including geto_graph_* if available) to inspect the codebase. When finished, summarize your findings concisely.");
  await writeFile(taskFile, taskLines.join("\n"), { encoding: "utf8", mode: 0o600 });
  if (opts.role && roleFile) {
    await writeFile(roleFile, opts.role.systemPrompt, { encoding: "utf8", mode: 0o600 });
  }

  const childCommand = await buildChildCommand(opts, { roleFile, taskFile, resultPath });

  const tmuxVersion = await exec("tmux", ["-V"], { timeout: 5_000 });
  if (tmuxVersion.code !== 0) {
    throw new Error(`tmux is required for subagents: ${tmuxVersion.stderr.trim() || "tmux not found"}`);
  }

  const startedAt = Date.now();
  const created = await exec("tmux", tmuxArgs("new-session", "-d", "-s", tmuxSession, "-n", "pi", "-c", opts.cwd));
  if (created.code !== 0) {
    throw new Error(`Failed to create tmux session: ${created.stderr.trim() || created.stdout.trim()}`);
  }

  const viewNote = await openSubagentView(exec, spec, opts.zellij).catch(() => "");

  try {
    const remain = await exec("tmux", tmuxArgs("set-window-option", "-t", `${tmuxSession}:0`, "remain-on-exit", "on"));
    if (remain.code !== 0) throw new Error(remain.stderr.trim() || "Failed to set remain-on-exit.");

    const initialDetails = detailsFor(spec, "running", { startedAt });
    onUpdate?.(initialDetails);

    const sent = await exec("tmux", tmuxArgs("send-keys", "-t", tmuxTarget, "-l", "--", childCommand));
    if (sent.code !== 0) throw new Error(sent.stderr.trim() || "Failed to start child Pi.");
    const entered = await exec("tmux", tmuxArgs("send-keys", "-t", tmuxTarget, "Enter"));
    if (entered.code !== 0) throw new Error(entered.stderr.trim() || "Failed to submit child command.");

    let lastPane = "";
    let childResult: ChildResult | undefined;
    while (!childResult) {
      if (signal?.aborted) throw new Error("Subagent aborted.");
      try {
        childResult = JSON.parse(await readFile(resultPath, "utf8")) as ChildResult;
        break;
      } catch {
        // The result file is created atomically when the child settles.
      }

      const paneResult = await exec("tmux", tmuxArgs("capture-pane", "-p", "-J", "-t", tmuxTarget), { timeout: 5_000 });
      if (paneResult.code === 0) {
        const pane = trimPane(paneResult.stdout);
        if (pane && pane !== lastPane) {
          lastPane = pane;
          onUpdate?.(detailsFor(spec, "running", { pane, startedAt }));
        }
      }

      const dead = await exec("tmux", tmuxArgs("display-message", "-p", "-t", tmuxTarget, "#{pane_dead}"));
      if (dead.code === 0 && dead.stdout.trim() === "1") {
        await abortableDelay(100, signal);
        try {
          childResult = JSON.parse(await readFile(resultPath, "utf8")) as ChildResult;
          break;
        } catch {
          throw new Error(`Child Pi exited before reporting a result.\n\n${lastPane || "No pane output."}\n\nInspect: ${spec.captureCommand}`);
        }
      }

      await abortableDelay(POLL_INTERVAL_MS, signal);
    }

    const finalPaneResult = await exec("tmux", tmuxArgs("capture-pane", "-p", "-J", "-t", tmuxTarget), { timeout: 5_000 });
    const finalPane = finalPaneResult.code === 0 ? trimPane(finalPaneResult.stdout) : lastPane;
    const status: RunStatus = childResult.status === "completed" ? "completed" : "failed";
    let rawOutput = childResult.output.trim();
    if (childResult.status === "failed" && childResult.error?.trim()) {
      rawOutput += `${rawOutput ? "\n\n" : ""}Error: ${childResult.error.trim()}`;
    }
    const output = truncateToolText(rawOutput || "(no text output)");
    const details = detailsFor(spec, status, {
      pane: finalPane,
      output,
      sessionFile: childResult.sessionFile,
      provider: childResult.provider ?? spec.provider,
      model: childResult.model ?? spec.model,
      thinking: childResult.thinking ?? spec.thinking,
      startedAt,
      finishedAt: childResult.finishedAt,
    });

    if (childResult.status === "failed") {
      throw new Error(resultText(details));
    }
    return { tmuxName, attachCommand: spec.attachCommand, sessionFile: childResult.sessionFile, result: childResult, viewNote };
  } catch (error) {
    if (signal?.aborted) {
      await exec("tmux", tmuxArgs("kill-session", "-t", tmuxSession)).catch(() => {});
    }
    throw error;
  }
}

// ── parent-side serial queue ─────────────────────────────────────────────────

// ── extension ────────────────────────────────────────────────────────────────

// exported for tests
export { parseArgs, shq, buildChildCommand, tmuxSessionName, spawnSubagent, openSubagentView };

export default function (pi: ExtensionAPI) {
  pi.registerFlag(ATTACH_FLAG, {
    description: "Attach using the child session id printed by the subagent tool",
    type: "string",
  });
  const attachTarget = attachFlagValue(process.argv);
  if (attachTarget !== undefined) attachToSubagentAndExit(attachTarget);

  if (process.env[CHILD_ENV] === "1") {
    const resultPath = process.env[RESULT_ENV];
    if (!resultPath) {
      console.error(`[geto-subagents] ${RESULT_ENV} is required in child mode.`);
      return;
    }
    registerChildReporter(pi, resultPath);
    return;
  }

  let queueTail: Promise<void> = Promise.resolve();
  let queueDepth = 0;
  let activeSession: string | undefined;

  const withSerialExecution = async <T>(
    signal: AbortSignal | undefined,
    onQueued: () => void,
    fn: () => Promise<T>,
  ): Promise<T> => {
    const queued = queueDepth > 0;
    queueDepth++;
    const previous = queueTail;
    let release!: () => void;
    queueTail = new Promise<void>((resolve) => { release = resolve; });
    if (queued) onQueued();
    try {
      await previous;
      if (signal?.aborted) throw new Error("Subagent aborted while waiting in the serial queue.");
      return await fn();
    } finally {
      queueDepth--;
      release();
    }
  };

  pi.on("session_shutdown", async () => {
    if (!activeSession) return;
    await pi.exec("tmux", tmuxArgs("kill-session", "-t", activeSession)).catch(() => {});
    activeSession = undefined;
  });

  // ── generic subagent tool (AI-callable) ─────────────────────────────────────

  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description:
      "Run one delegated task in a separate Pi process inside tmux. The child session is a FORK of the current conversation (full context inherited, appears as a child session in /resume). Calls are serialized: only one child works at a time. The child inherits the current provider, model, and thinking level unless overridden. Live pane output and a copy/paste pi --attach-subagent command are shown while it runs. Output is capped at 50KB or 2000 lines; the complete child session is preserved on disk.",
    promptSnippet: "Run one delegated task in a fork-based, tmux-backed Pi session",
    promptGuidelines: [
      "Use subagent once per delegated task; subagent calls are serialized automatically, so prefer multiple simple calls over asking one child to orchestrate other children.",
    ],
    parameters: Type.Object({
      task: Type.String({ description: "The complete task for the child Pi process" }),
      cwd: Type.Optional(Type.String({ description: "Working directory. Defaults to the current project." })),
      provider: Type.Optional(Type.String({ description: "Provider override. Defaults to the current provider." })),
      model: Type.Optional(Type.String({ description: "Model id or provider/model override. Defaults to the current model." })),
      thinking: Type.Optional(StringEnum(THINKING_LEVELS, { description: "Thinking level override. Defaults to the current thinking level." })),
    }),

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      if (!params.task.trim()) throw new Error("Subagent task must not be empty.");
      const cwd = path.resolve(ctx.cwd, params.cwd?.trim() || ".");
      const selectedModel = resolveModel(ctx, params.provider, params.model);
      const thinking = params.thinking ?? pi.getThinkingLevel();
      const parentSessionFile = ctx.sessionManager.getSessionFile();
      const attachmentId = randomUUID();
      const run = () =>
        spawnSubagent(
          (cmd, args, opts) => pi.exec(cmd, args, opts),
          ctx,
          {
            task: params.task,
            cwd,
            provider: selectedModel.provider,
            model: selectedModel.model,
            thinking,
            attachmentId,
            parentSessionFile: parentSessionFile && existsSync(parentSessionFile) ? parentSessionFile : undefined,
            trusted: isSameOrDescendant(path.resolve(ctx.cwd), cwd) && ctx.isProjectTrusted(),
            attach: true,
            zellij: process.env.GETO_SUBAGENTS_VIEW !== "attach",
          },
          signal,
          (details) => onUpdate?.({ content: [{ type: "text", text: partialText(details) }], details }),
        );

      return withSerialExecution(
        signal,
        () => onUpdate?.({ content: [{ type: "text", text: "Waiting for the active subagent to finish..." }], details: detailsFor({ task: params.task, cwd, attachmentId, tmuxSession: "", tmuxTarget: "", attachCommand: "", captureCommand: "", killCommand: "", provider: selectedModel.provider, model: selectedModel.model, thinking, trusted: false }, "queued") }),
        async () => {
          const s = await run();
          const finalDetails = detailsFor(
            { task: params.task, cwd, attachmentId, tmuxSession: s.tmuxName, tmuxTarget: "", attachCommand: s.attachCommand, captureCommand: "", killCommand: "", provider: selectedModel.provider, model: selectedModel.model, thinking, trusted: false },
            "completed",
            { output: truncateToolText(s.result.output.trim() || "(no text output)"), sessionFile: s.sessionFile, startedAt: Date.now(), finishedAt: s.result.finishedAt },
          );
          const note = s.viewNote ? `\n${s.viewNote}` : "";
          return { content: [{ type: "text", text: resultText(finalDetails) + note }], details: finalDetails };
        },
      );
    },
  });

  // ── role commands: /review /find /plan ─────────────────────────────────────

  for (const role of Object.values(ROLES)) {
    pi.registerCommand(role.command, {
      description: role.description,
      getArgumentCompletions(prefix: string) {
        const opts = ["--model", "--no-attach", "--no-zellij"];
        return opts.filter((o) => o.startsWith(prefix)).map((value) => ({ value, label: value }));
      },
      handler: async (args, ctx) => {
        const available = ((ctx.modelRegistry?.getAvailable?.() ?? []) as { id?: string; provider?: string }[])
          .flatMap((m) => [m.id ?? "", `${m.provider}/${m.id}`].filter(Boolean));
        const { prompt, model, attach, zellij } = parseArgs(args ?? "", available);
        if (!prompt) {
          ctx.ui.notify(`usage: /${role.command} <prompt> [model] — e.g. /${role.command} review the auth refactor anthropic/claude-sonnet-4-5`, "info");
          return;
        }
        try {
          const selectedModel = model ? resolveModel(ctx, undefined, model) : { provider: ctx.model?.provider ?? "", model: ctx.model?.id ?? "" };
          const parentSessionFile = ctx.sessionManager.getSessionFile();
          const s = await withSerialExecution(
            undefined,
            () => {},
            () =>
              spawnSubagent(
                (cmd, args, opts) => pi.exec(cmd, args, opts),
                ctx,
                {
                  task: prompt,
                  cwd: ctx.cwd,
                  provider: selectedModel.provider,
                  model: selectedModel.model,
                  thinking: pi.getThinkingLevel(),
                  attachmentId: randomUUID(),
                  role,
                  parentSessionFile: parentSessionFile && existsSync(parentSessionFile) ? parentSessionFile : undefined,
                  trusted: ctx.isProjectTrusted(),
                  attach,
                  zellij,
                },
              ),
          );
          const lines = [
            `${role.label} subagent finished (${s.result.status})`,
            `tmux session: ${s.tmuxName}`,
            `attach (any terminal): ${s.attachCommand}`,
            s.sessionFile ? `child session (fork): ${s.sessionFile}` : "",
            s.viewNote,
            "",
            truncate(s.result.output.trim() || "(no output)", 3000),
          ].filter(Boolean);
          ctx.ui.notify(lines.join("\n"), s.result.status === "completed" ? "info" : "warning");
        } catch (err) {
          ctx.ui.notify(`failed to spawn ${role.label}: ${String(err).slice(0, 300)}`, "error");
        }
      },
    });
  }

  // ── /chain: sequential subagents via an overlay dialog ─────────────────────

  pi.registerCommand("chain", {
    description: "Run a sequential subagent chain. Usage: /chain <step1> | <step2> | ... Steps may use {chain_dir} for a shared scratch directory. Each step forks the previous step's session.",
    getArgumentCompletions() {
      return null;
    },
    handler: async (args, ctx) => {
      const steps = (args ?? "").split("|").map((s) => s.trim()).filter(Boolean);
      if (steps.length < 1) {
        ctx.ui.notify("usage: /chain <step1> | <step2> | ... — each step is a task; {chain_dir} is a shared scratch dir", "info");
        return;
      }

      const run = async () => {
        const chainId = randomUUID();
        const chainDir = path.join(getAgentDir(), CHAINS_DIR, chainId);
        await mkdir(chainDir, { recursive: true, mode: 0o700 });
        const parentSessionFile = ctx.sessionManager.getSessionFile();
        let forkFrom = parentSessionFile && existsSync(parentSessionFile) ? parentSessionFile : undefined;
        const outputs: string[] = [];

        for (let i = 0; i < steps.length; i++) {
          const task = steps[i].replaceAll("{chain_dir}", chainDir);
          ctx.ui.setStatus("chain", `step ${i + 1}/${steps.length}: ${truncate(task.split("\n")[0] ?? task, 60)}...`);
          try {
            const s = await withSerialExecution(
              undefined,
              () => {},
              () =>
                spawnSubagent(
                  (cmd, args, opts) => pi.exec(cmd, args, opts),
                  ctx,
                  {
                    task,
                    cwd: ctx.cwd,
                    provider: ctx.model?.provider ?? "",
                    model: ctx.model?.id ?? "",
                    thinking: pi.getThinkingLevel(),
                    attachmentId: randomUUID(),
                    parentSessionFile: forkFrom,
                    chainDir,
                    trusted: ctx.isProjectTrusted(),
                    attach: true,
                    zellij: process.env.GETO_SUBAGENTS_VIEW !== "attach",
                  },
                ),
            );
            outputs.push(`## Step ${i + 1}\n${s.result.output.trim() || "(no output)"}`);
            if (s.sessionFile) forkFrom = s.sessionFile; // chain: next step forks this child
            if (s.result.status === "failed") {
              ctx.ui.notify(`chain stopped at step ${i + 1} (failed).`, "warning");
              break;
            }
          } catch (err) {
            ctx.ui.notify(`chain step ${i + 1} failed: ${String(err).slice(0, 300)}`, "error");
            break;
          }
        }
        ctx.ui.setStatus("chain", "");
        ctx.ui.notify(`chain done (${outputs.length}/${steps.length} steps)\n\n${truncate(outputs.join("\n\n"), 4000)}`, "info");
      };

      if (!ctx.hasUI) {
        await run();
        return;
      }

      const previews = steps.map((s, i) => `${i + 1}. ${truncate((s.split("\n")[0] ?? s).trim(), 80)}`);
      const confirmed = await ctx.ui.custom<boolean>(
        (tui, theme, keybindings, done) => {
          const lines = [
            theme.bold(theme.fg("accent", `Chain: ${steps.length} step${steps.length > 1 ? "s" : ""} (fork-based)`)),
            "",
            ...previews.map((p) => theme.fg("muted", p)),
            "",
            theme.fg("dim", "{chain_dir} = shared scratch dir · each step forks the previous session"),
            "",
            theme.fg("dim", "[Enter] Run · [Esc] Cancel"),
          ];
          const text = new Text(lines.join("\n"), 1, 1) as Component;
          text.handleInput = (data: string): void => {
            if (data === "return") done(true);
            else if (data === "escape") done(false);
          };
          return text;
        },
        { overlay: true, overlayOptions: { anchor: "center", width: "65%", maxHeight: "45%" } },
      );
      if (confirmed) await run();
    },
  });

  // ── /subagents: list running subagent tmux sessions ────────────────────────

  pi.registerCommand("subagents", {
    description: "List running geto-* subagent tmux sessions. Usage: /subagents",
    handler: async (_args, ctx) => {
      const res = await pi.exec("tmux", tmuxArgs("ls"));
      if (res.code !== 0) {
        ctx.ui.notify("no tmux server running (or tmux not installed) — nothing to list", "info");
        return;
      }
      const lines = res.stdout.split("\n").filter((l) => /^geto-/.test(l));
      ctx.ui.notify(lines.length ? lines.join("\n") + "\n\nattach: pi --attach-subagent <id>" : "no geto-* subagent tmux sessions running", "info");
    },
  });
}
