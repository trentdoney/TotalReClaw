import path from "node:path";

import {
  acceptDraft,
  checkTask,
  createDraftFromText,
  explainQuery,
  finalizeSession,
  getSessionSummaryCommand,
  getSessionTimelineCommand,
  importOpenClawHistory,
  listSessions,
  loadCaptureFile,
  resolveConflict,
  runDemo,
} from "./engine.ts";
import type { CommandExecution, ResolvedConfig } from "./types.ts";

function tokenize(raw: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;

  for (let i = 0; i < raw.length; i += 1) {
    const char = raw[i];
    if (quote) {
      if (char === quote) {
        quote = null;
      } else if (char === "\\" && raw[i + 1]) {
        current += raw[i + 1];
        i += 1;
      } else {
        current += char;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }

  if (current) {
    tokens.push(current);
  }
  return tokens;
}

function usage(): CommandExecution {
  return {
    text: [
      "TotalReClaw commands:",
      "/totalreclaw check \"<query>\"",
      "/totalreclaw recall \"<query>\"",
      "/totalreclaw sessions [<query>]",
      "/totalreclaw summary --latest|--session <id>",
      "/totalreclaw timeline --session <id>|\"<query>\"",
      "/totalreclaw session close [--current|--session <id>]",
      "/totalreclaw session import [--db <path>] [--limit <n>] [--conversation <id>|--session <id>] [--accept]",
      "/totalreclaw capture --file <path>",
      "/totalreclaw capture --stdin \"<summary>\"",
      "/totalreclaw capture --accept <draft-id>",
      "/totalreclaw explain \"<query>\"",
      "/totalreclaw resolve \"<query>\" [--action keep-newer|keep-older|merge|defer] [--left <record-id> --right <record-id>]",
      "/totalreclaw demo",
    ].join("\n"),
  };
}

function readOption(tokens: string[], key: string): string | undefined {
  const index = tokens.indexOf(key);
  if (index === -1) {
    return undefined;
  }
  const value = tokens[index + 1];
  if (!value || value.startsWith("--")) {
    return undefined;
  }
  return value;
}

function hasFlag(tokens: string[], key: string): boolean {
  return tokens.includes(key);
}

function stripOption(tokens: string[], key: string, consumeValue: boolean = true): string[] {
  const index = tokens.indexOf(key);
  if (index === -1) {
    return tokens;
  }
  const next = [...tokens];
  next.splice(index, consumeValue ? 2 : 1);
  return next;
}

async function executeRecall(query: string, config: ResolvedConfig): Promise<CommandExecution> {
  const result = await checkTask(query, config);
  return {
    text: [
      `Verdict: ${result.verdict} (${result.confidence})`,
      `Summary: ${result.summary}`,
      `Next step: ${result.recommended_next_step}`,
      result.evidence.length > 0
        ? `Evidence: ${result.evidence.map((entry) => `${entry.kind}:${entry.id}:${entry.score}`).join(", ")}`
        : "Evidence: none",
    ].join("\n"),
    details: result as unknown as Record<string, unknown>,
  };
}

export async function executeTotalReClawCommand(
  rawCommand: string,
  config: ResolvedConfig,
): Promise<CommandExecution> {
  const tokens = tokenize(rawCommand.trim());
  const subcommand = tokens.shift()?.toLowerCase();
  if (!subcommand) {
    return usage();
  }

  if (subcommand === "check" || subcommand === "recall") {
    const query = tokens.join(" ").trim();
    if (!query) {
      throw new Error(`${subcommand} requires a query.`);
    }
    return executeRecall(query, config);
  }

  if (subcommand === "sessions") {
    const query = tokens.join(" ").trim() || undefined;
    return listSessions(query, config);
  }

  if (subcommand === "summary") {
    const sessionId = readOption(tokens, "--session");
    const latest = hasFlag(tokens, "--latest");
    return getSessionSummaryCommand(latest ? "latest" : sessionId, config);
  }

  if (subcommand === "timeline") {
    const sessionId = readOption(tokens, "--session");
    let cleaned = stripOption(tokens, "--session");
    cleaned = stripOption(cleaned, "--latest", false);
    const query = cleaned.join(" ").trim();
    const target = sessionId ?? query;
    if (!target) {
      throw new Error("timeline requires --session <id> or a query.");
    }
    return getSessionTimelineCommand(target, config);
  }

  if (subcommand === "session") {
    const action = tokens.shift()?.toLowerCase();
    if (action === "close") {
      const sessionId = readOption(tokens, "--session");
      const current = hasFlag(tokens, "--current");
      return finalizeSession(current ? "current" : sessionId, config);
    }
    if (action === "import") {
      const sessionId = readOption(tokens, "--session");
      const conversationId = readOption(tokens, "--conversation");
      const dbPath = readOption(tokens, "--db");
      const accept = hasFlag(tokens, "--accept");
      const limitRaw = readOption(tokens, "--limit");
      const limit = limitRaw ? Number.parseInt(limitRaw, 10) : undefined;
      if (limitRaw && !Number.isFinite(limit)) {
        throw new Error("session import --limit must be an integer.");
      }
      return importOpenClawHistory({ dbPath, limit, sessionId, conversationId, accept }, config);
    }
    throw new Error("session supports `close` and `import`.");
  }

  if (subcommand === "capture") {
    const acceptId = readOption(tokens, "--accept");
    if (acceptId) {
      return acceptDraft(acceptId, config);
    }

    const filePath = readOption(tokens, "--file");
    if (filePath) {
      const rawText = await loadCaptureFile(path.resolve(filePath));
      return createDraftFromText(rawText, filePath, config);
    }

    if (tokens.includes("--stdin")) {
      const cleaned = stripOption(tokens, "--stdin", false).join(" ").trim();
      if (!cleaned) {
        throw new Error("capture --stdin requires inline text after the flag.");
      }
      return createDraftFromText(cleaned, "stdin", config);
    }

    throw new Error("capture requires --file, --stdin, or --accept.");
  }

  if (subcommand === "explain") {
    const query = tokens.join(" ").trim();
    if (!query) {
      throw new Error("explain requires a query.");
    }
    return explainQuery(query, config);
  }

  if (subcommand === "resolve") {
    const action = readOption(tokens, "--action");
    const left = readOption(tokens, "--left");
    const right = readOption(tokens, "--right");
    let cleaned = [...tokens];
    for (const key of ["--action", "--left", "--right"]) {
      cleaned = stripOption(cleaned, key);
    }
    const query = cleaned.join(" ").trim();
    if (!query && !(left && right)) {
      throw new Error("resolve requires a query or explicit --left/--right record ids.");
    }
    return resolveConflict(query || `${left} ${right}`, config, action, left, right);
  }

  if (subcommand === "demo") {
    return runDemo(config);
  }

  return usage();
}
