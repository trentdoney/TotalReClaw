import type { CommandExecution } from "./src/types.ts";
import {
  buildRecallContext,
  createResolvedConfig,
  finalizeSession,
  finalizeSessionFromEvent,
  recordAgentTurn,
  runAutoCheck,
} from "./src/engine.ts";
import { executeTotalReClawCommand } from "./src/command.ts";

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  details?: Record<string, unknown>;
};

type HookHandler = (
  event: Record<string, unknown>,
  ctx: Record<string, unknown>,
) => Promise<{ prependContext?: string } | void>;

function asTextResult(result: CommandExecution): ToolResult {
  return {
    content: [{ type: "text", text: result.text }],
    details: result.details,
  };
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms);
    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
  });
}

const plugin = {
  id: "totalreclaw",
  name: "TotalReClaw",
  description: "OpenClaw operational memory that recalls prior records and session context before work repeats itself.",
  configSchema: {
    parse(value: unknown) {
      return value ?? {};
    },
  },
  register(api: {
    pluginConfig?: Record<string, unknown>;
    logger: { info: (message: string) => void; warn: (message: string) => void; error: (message: string) => void };
    resolvePath: (input: string) => string;
    registerTool: (factory: (ctx: Record<string, unknown>) => unknown) => void;
    on: (hookName: string, handler: HookHandler) => void;
  }) {
    const pluginRoot = api.resolvePath(".");
    const resolved = createResolvedConfig(api.pluginConfig, pluginRoot);

    api.registerTool((_ctx) => ({
      name: "totalreclaw",
      label: "TotalReClaw",
      description:
        "Recall, capture, summarize, and resolve OpenClaw operational memory. Used by the /totalreclaw skill command.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          command: {
            type: "string",
            description: "Raw TotalReClaw command arguments after /totalreclaw.",
          },
          commandName: {
            type: "string",
          },
          skillName: {
            type: "string",
          },
        },
        required: ["command", "commandName", "skillName"],
      },
      async execute(_toolCallId: string, params: Record<string, unknown>) {
        const rawCommand = typeof params.command === "string" ? params.command : "";
        const result = await executeTotalReClawCommand(rawCommand, resolved);
        return asTextResult(result);
      },
    }));

    const safeRegister = (hookName: string, handler: HookHandler) => {
      try {
        api.on(hookName, async (event, ctx) => {
          try {
            return await handler(event, ctx);
          } catch (error) {
            api.logger.warn(
              `[totalreclaw] ${hookName} failed open: ${error instanceof Error ? error.message : String(error)}`,
            );
            return;
          }
        });
      } catch (error) {
        api.logger.warn(
          `[totalreclaw] hook registration skipped for ${hookName}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    };

    safeRegister("before_prompt_build", async (event) => {
      if (!resolved.enabled || !resolved.enableAutoRecall) {
        return;
      }
      const prompt = typeof event.prompt === "string" ? event.prompt : "";
      if (!prompt.trim() || prompt.trim().startsWith("/")) {
        return;
      }

      const prependContext = await withTimeout(buildRecallContext({ prompt }, resolved), resolved.hookTimeoutMs);
      if (!prependContext) {
        return;
      }
      return { prependContext };
    });

    safeRegister("agent_end", async (event, ctx) => {
      if (!resolved.enabled || !resolved.enableAutoCapture) {
        return;
      }
      await recordAgentTurn(event, ctx, resolved);
    });

    for (const hookName of ["command:new", "command:reset"]) {
      safeRegister(hookName, async (event, ctx) => {
        if (!resolved.enabled || !resolved.enableAutoCapture) {
          return;
        }
        try {
          await finalizeSessionFromEvent(event, ctx, resolved);
        } catch {
          return;
        }
      });
    }

    api.logger.info(
      `[totalreclaw] Plugin loaded (enabled=${resolved.enabled}, autoRecall=${resolved.enableAutoRecall}, db=${resolved.dbPath})`,
    );
  },
};

export default plugin;
export { executeTotalReClawCommand } from "./src/command.ts";
export {
  createResolvedConfig,
  runAutoCheck,
  checkTask,
  importOpenClawHistory,
  recordAgentTurn,
  finalizeSession,
  finalizeSessionFromEvent,
} from "./src/engine.ts";
