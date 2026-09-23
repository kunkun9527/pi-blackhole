import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { findLatestCompactionEntry, projectAppendOnlyContext } from "../core/compaction-chain.js";
import {
  applyRetainedToolOutputProjection,
  isRetainedToolOutputProjection,
} from "../core/tool-output-budget.js";
import { isPiVccCompactionDetailsV2 } from "../details.js";
import { debugLog } from "../om/debug-log.js";
import type { Runtime } from "../om/runtime.js";
import { readStoredFullSummary } from "./before-compact.js";

/** Replay persisted compaction state without moving it between provider calls. */
export function registerCompactionContextHook(pi: ExtensionAPI, runtime: Runtime): void {
  pi.on("context", (event: any, ctx: any) => {
    runtime.ensureConfig(ctx.cwd ?? process.cwd());
    const dbg = (ev: string, data?: Record<string, unknown>) =>
      debugLog(ev, data, runtime.config.debugLog === true);
    let branchEntries: any[];
    let projected: any[] = event.messages;
    let latest: any;
    try {
      branchEntries = ctx.sessionManager.getBranch();
      latest = findLatestCompactionEntry(branchEntries);
      projected = projectAppendOnlyContext(projected, branchEntries);
    } catch (error) {
      // Keep Pi's complete fallback summary if the projection cannot be built.
      dbg("compaction_context.projection_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    const storedFullSummary = readStoredFullSummary(latest);

    if (
      isPiVccCompactionDetailsV2(latest?.details) &&
      projected === event.messages &&
      !storedFullSummary
    ) {
      return;
    }

    if (storedFullSummary && typeof latest?.summary === "string") {
      let replaced = false;
      projected = projected.map((message: any) => {
        if (
          !replaced &&
          message?.role === "compactionSummary" &&
          message?.summary === latest.summary
        ) {
          replaced = true;
          return {
            ...message,
            summary: storedFullSummary,
          };
        }
        return message;
      });
    }

    const persistedProjection = (latest?.details as any)?.retainedToolOutputProjection;
    if (isRetainedToolOutputProjection(persistedProjection)) {
      try {
        projected = applyRetainedToolOutputProjection(
          projected,
          branchEntries,
          persistedProjection,
        );
      } catch (error) {
        dbg("compaction_context.tool_output_projection_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return projected === event.messages ? undefined : { messages: projected };
  });
}
