import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

export type GatewayPtyOwner = {
  ownerKey: string;
  connId: string;
  deviceId?: string;
};

export type GatewayPtySession = {
  sessionId: string;
  owner: GatewayPtyOwner;
  shell: string;
  cwd: string;
  cols: number;
  rows: number;
  createdAt: number;
  exitedAt?: number;
  exitCode?: number | null;
};

type PtyExitEvent = { exitCode: number; signal?: number };
type PtyDisposable = { dispose: () => void };
type PtySpawnHandle = {
  pid: number;
  write: (data: string | Buffer) => void;
  resize?: (cols: number, rows: number) => void;
  onData: (listener: (value: string) => void) => PtyDisposable | void;
  onExit: (listener: (event: PtyExitEvent) => void) => PtyDisposable | void;
  kill: (signal?: string) => void;
};

type PtySpawn = (
  file: string,
  args: string[] | string,
  options: {
    name?: string;
    cols?: number;
    rows?: number;
    cwd?: string;
    env?: Record<string, string>;
  },
) => PtySpawnHandle;

type PtyModule = {
  spawn?: PtySpawn;
  default?: { spawn?: PtySpawn };
};

type ActiveSession = GatewayPtySession & {
  pty: PtySpawnHandle;
  outputDispose?: PtyDisposable | null;
  exitDispose?: PtyDisposable | null;
};

const sessions = new Map<string, ActiveSession>();

function sanitizeDim(value: unknown, fallback: number, max: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.max(1, Math.min(max, Math.floor(n)));
}

function resolveDefaultShell(): string {
  const shell = (process.env.OPENCLAW_PTY_SHELL || process.env.SHELL || "").trim();
  if (shell) return shell;
  return process.platform === "win32" ? "powershell.exe" : "/bin/zsh";
}

function resolveAllowedShells(defaultShell: string): Set<string> {
  const raw = (process.env.OPENCLAW_PTY_ALLOWED_SHELLS || "").trim();
  const values = raw
    ? raw.split(",").map((v) => v.trim()).filter(Boolean)
    : [defaultShell];
  return new Set(values);
}

function resolveShell(requested?: string): string {
  const defaultShell = resolveDefaultShell();
  if (!requested?.trim()) return defaultShell;
  const candidate = requested.trim();
  const allowed = resolveAllowedShells(defaultShell);
  if (!allowed.has(candidate)) {
    throw new Error(`shell not allowed: ${candidate}`);
  }
  return candidate;
}

function resolveCwd(requested?: string): string {
  const base = process.env.OPENCLAW_PTY_CWD || process.cwd();
  const home = os.homedir();
  const fallback = path.resolve(base || home);
  if (!requested?.trim()) return fallback;
  const expanded = requested.startsWith("~/") ? path.join(home, requested.slice(2)) : requested;
  return path.resolve(expanded);
}

function toStringEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string") out[key] = value;
  }
  return out;
}

async function loadSpawn(): Promise<PtySpawn> {
  const mod = (await import("@lydell/node-pty")) as unknown as PtyModule;
  const spawn = mod.spawn ?? mod.default?.spawn;
  if (!spawn) throw new Error("PTY support is unavailable");
  return spawn;
}

export async function createGatewayPtySession(params: {
  owner: GatewayPtyOwner;
  cols?: number;
  rows?: number;
  cwd?: string;
  shell?: string;
  onOutput: (event: { sessionId: string; data: string; connId: string }) => void;
  onExit: (event: { sessionId: string; code: number | null; connId: string }) => void;
}): Promise<GatewayPtySession> {
  const spawn = await loadSpawn();
  const cols = sanitizeDim(params.cols, 80, 500);
  const rows = sanitizeDim(params.rows, 24, 200);
  const shell = resolveShell(params.shell);
  const cwd = resolveCwd(params.cwd);
  const sessionId = crypto.randomUUID();
  const pty = spawn(shell, [], {
    name: process.env.TERM || "xterm-256color",
    cols,
    rows,
    cwd,
    env: toStringEnv(process.env),
  });
  const session: ActiveSession = {
    sessionId,
    owner: { ...params.owner },
    shell,
    cwd,
    cols,
    rows,
    createdAt: Date.now(),
    pty,
  };
  session.outputDispose =
    pty.onData((data) => {
      params.onOutput({ sessionId, data, connId: session.owner.connId });
    }) ?? null;
  session.exitDispose =
    pty.onExit((event) => {
      session.exitedAt = Date.now();
      session.exitCode = event.exitCode ?? null;
      try {
        params.onExit({ sessionId, code: session.exitCode, connId: session.owner.connId });
      } finally {
        destroyGatewayPtySession(sessionId);
      }
    }) ?? null;
  sessions.set(sessionId, session);
  return publicSession(session);
}

function publicSession(session: ActiveSession): GatewayPtySession {
  return {
    sessionId: session.sessionId,
    owner: { ...session.owner },
    shell: session.shell,
    cwd: session.cwd,
    cols: session.cols,
    rows: session.rows,
    createdAt: session.createdAt,
    exitedAt: session.exitedAt,
    exitCode: session.exitCode,
  };
}

export function listGatewayPtySessionsByOwner(ownerKey: string): GatewayPtySession[] {
  return Array.from(sessions.values())
    .filter((session) => session.owner.ownerKey === ownerKey)
    .map(publicSession);
}

export function getGatewayPtySession(sessionId: string): GatewayPtySession | undefined {
  const session = sessions.get(sessionId);
  return session ? publicSession(session) : undefined;
}

export function touchGatewayPtySessionOwner(params: { sessionId: string; connId: string }): void {
  const session = sessions.get(params.sessionId);
  if (!session) return;
  session.owner.connId = params.connId;
}

export function writeGatewayPtySession(sessionId: string, data: string): void {
  const session = sessions.get(sessionId);
  if (!session) throw new Error(`PTY session not found: ${sessionId}`);
  session.pty.write(data);
}

export function resizeGatewayPtySession(sessionId: string, cols?: number, rows?: number): void {
  const session = sessions.get(sessionId);
  if (!session) throw new Error(`PTY session not found: ${sessionId}`);
  const nextCols = sanitizeDim(cols, session.cols, 500);
  const nextRows = sanitizeDim(rows, session.rows, 200);
  session.cols = nextCols;
  session.rows = nextRows;
  session.pty.resize?.(nextCols, nextRows);
}

export function destroyGatewayPtySession(sessionId: string): void {
  const session = sessions.get(sessionId);
  if (!session) return;
  sessions.delete(sessionId);
  try {
    session.outputDispose?.dispose();
  } catch {}
  try {
    session.exitDispose?.dispose();
  } catch {}
  try {
    session.pty.kill("SIGKILL");
  } catch {}
}

export function assertGatewayPtyOwnership(params: {
  sessionId: string;
  ownerKey: string;
  connId: string;
}): GatewayPtySession {
  const session = sessions.get(params.sessionId);
  if (!session) throw new Error(`PTY session not found: ${params.sessionId}`);
  if (session.owner.ownerKey !== params.ownerKey) {
    throw new Error(`PTY session access denied: ${params.sessionId}`);
  }
  session.owner.connId = params.connId;
  return publicSession(session);
}
