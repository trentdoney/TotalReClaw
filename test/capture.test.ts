import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import { createResolvedConfig, executeTotalReClawCommand, finalizeSession, recordAgentTurn } from "../index.ts";
import { loadSessionSummaries } from "../src/store.ts";

const require = createRequire(import.meta.url);
type DatabaseSyncCtor = new (location: string) => import("node:sqlite").DatabaseSync;
const { DatabaseSync } = require("node:sqlite") as { DatabaseSync: DatabaseSyncCtor };

function makeConfig(root: string) {
  return createResolvedConfig(
    {
      dbPath: path.join(root, "totalreclaw.db"),
      storePath: path.join(root, "lessons.jsonl"),
      draftPath: path.join(root, "review"),
      sessionStatePath: path.join(root, "state", "sessions"),
      enableAutoRecall: true,
      enableAutoCapture: true,
    },
    root,
  );
}

function seedOpenClawHistory(dbPath: string): void {
  const db = new DatabaseSync(dbPath);
  try {
    const now = Date.now();
    const conversationStartedAt = new Date(now - 4 * 60_000).toISOString();
    const userMessageAt = new Date(now - 3 * 60_000).toISOString();
    const assistantMessageAt = new Date(now - 60_000).toISOString();

    db.exec(`
      CREATE TABLE conversations (
        conversation_id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        title TEXT,
        bootstrapped_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE messages (
        message_id INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id INTEGER NOT NULL REFERENCES conversations(conversation_id) ON DELETE CASCADE,
        seq INTEGER NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('system', 'user', 'assistant', 'tool')),
        content TEXT NOT NULL,
        token_count INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (conversation_id, seq)
      );
    `);

    db.prepare(
      `
        INSERT INTO conversations (conversation_id, session_id, title, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
      `,
    ).run(1, "hist-sess-1", "Gateway restart postmortem", conversationStartedAt, assistantMessageAt);

    const insertMessage = db.prepare(
      `
        INSERT INTO messages (conversation_id, seq, role, content, token_count, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `,
    );
    insertMessage.run(
      1,
      1,
      "user",
      "OpenClaw gateway restart keeps failing after the plugin install.",
      12,
      userMessageAt,
    );
    insertMessage.run(
      1,
      2,
      "assistant",
      "Root cause: we used an invented CLI command. Fix: run openclaw gateway restart and check openclaw gateway status first. Outcome: restart worked.",
      28,
      assistantMessageAt,
    );
  } finally {
    db.close();
  }
}

describe("capture flow", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((entry) => rm(entry, { recursive: true, force: true })));
  });

  it("creates a draft and redacts inline secrets", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "totalreclaw-capture-"));
    roots.push(root);
    const config = makeConfig(root);

    const response = await executeTotalReClawCommand(
      'capture --stdin "Summary: Fix plugin auth. Details: bearer token leaked in logs. Fix: redact the token before saving. Authorization: Bearer abcdefghijklmnop."',
      config,
    );

    expect(response.text).toContain("Draft created:");
    const draftId = response.text.match(/Draft created: (\S+)/)?.[1];
    expect(draftId).toBeTruthy();

    const draftPath = path.join(root, "review", `${draftId}.json`);
    const draft = await readFile(draftPath, "utf8");
    expect(draft).toContain("[REDACTED_TOKEN]");
    expect(draft).not.toContain("abcdefghijklmnop");
  });

  it("accepts a manual record into the durable sqlite store", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "totalreclaw-accept-"));
    roots.push(root);
    const config = makeConfig(root);

    const draft = await executeTotalReClawCommand(
      'capture --stdin "Task Summary: Fix missing skill. Failure Symptom: skill missing from openclaw skills check. Root Cause: plugin manifest omitted the skills path. Fix: add skills/TotalReClaw to openclaw.plugin.json and restart."',
      config,
    );
    const draftId = draft.text.match(/Draft created: (\S+)/)?.[1];
    expect(draftId).toBeTruthy();

    const accepted = await executeTotalReClawCommand(`capture --accept ${draftId}`, config);
    expect(accepted.text).toContain("Accepted draft");

    const recall = await executeTotalReClawCommand('recall "fix missing skill after plugin install"', config);
    expect(recall.text).toContain("Verdict: prior_fix_found");
  });

  it("finalizes a session into a draft and accepts the session summary bundle", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "totalreclaw-session-"));
    roots.push(root);
    const config = makeConfig(root);

    await recordAgentTurn(
      {
        agent: { id: "openclaw-agent" },
        session: { id: "sess-123" },
        prompt: "Install TotalReClaw on the remote host and verify the plugin is visible.",
        messages: [
          { role: "user", content: "Install TotalReClaw on the remote host and verify the plugin is visible." },
          {
            role: "assistant",
            content:
              "Decision: use SQLite for durable records. Outcome: the installer should update the remote config and restart OpenClaw. Command: ssh remote-host openclaw gateway restart",
          },
        ],
      },
      {},
      config,
    );

    const draftResult = await finalizeSession("current", config);
    expect(draftResult.text).toContain("Session draft created:");
    const draftId = draftResult.text.match(/Session draft created: (\S+)/)?.[1];
    expect(draftId).toBeTruthy();

    const draftPath = path.join(root, "review", `${draftId}.json`);
    const draft = JSON.parse(await readFile(draftPath, "utf8")) as { linked_records: unknown[]; session_summary?: { session_id: string } };
    expect(draft.session_summary?.session_id).toBe("sess-123");
    expect(draft.linked_records.length).toBeGreaterThan(0);

    const accepted = await executeTotalReClawCommand(`capture --accept ${draftId}`, config);
    expect(accepted.text).toContain("with");

    const summary = await executeTotalReClawCommand("summary --latest", config);
    expect(summary.text).toContain("Session: sess-123");

    const timeline = await executeTotalReClawCommand("timeline --session sess-123", config);
    expect(timeline.text).toContain("# TotalReClaw timeline");
  });

  it("writes session state only during explicit accumulation", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "totalreclaw-accumulator-"));
    roots.push(root);
    const config = makeConfig(root);

    await recordAgentTurn(
      {
        agent: { id: "openclaw-agent" },
        session: { id: "sess-live" },
        prompt: "Check the remote plugin config on the target host.",
        messages: [{ role: "assistant", content: "Blocked waiting on the remote gateway state. ssh remote-host openclaw plugins info totalreclaw" }],
      },
      {},
      config,
    );

    const sessions = await executeTotalReClawCommand("sessions", config);
    expect(sessions.text).toContain("Active accumulators:");

    const stateDir = path.join(root, "state", "sessions");
    const files = await readdir(stateDir);
    expect(files.some((entry) => entry.endsWith(".pending.json"))).toBe(true);

    const recall = await executeTotalReClawCommand('recall "remote plugin config on the target host"', config);
    expect(recall.text).toContain("Verdict: no_match");
  });

  it("imports historical OpenClaw sessions and accepts them into durable memory", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "totalreclaw-import-"));
    roots.push(root);
    const config = makeConfig(root);
    const historyDb = path.join(root, "lcm.db");
    seedOpenClawHistory(historyDb);

    const imported = await executeTotalReClawCommand(`session import --db ${historyDb} --accept`, config);
    expect(imported.text).toContain("Created drafts: 1");
    expect(imported.text).toContain("Accepted sessions: 1");

    const summary = await executeTotalReClawCommand("summary --latest", config);
    expect(summary.text).toContain("Session: hist-sess-1");

    const recall = await executeTotalReClawCommand('recall "gateway restart wrong cli command"', config);
    expect(recall.text).toContain("Verdict: prior_fix_found");

    const reimported = await executeTotalReClawCommand(`session import --db ${historyDb} --accept`, config);
    expect(reimported.text).toContain("Skipped existing: 1");

    const summaries = await loadSessionSummaries(config);
    expect(summaries).toHaveLength(1);
  });
});
