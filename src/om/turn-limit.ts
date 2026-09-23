import type { FinishTurn } from '@earendil-works/pi-agent-core';

/** Pi 0.87 replaced shouldStopAfterTurn with finishTurn decisions. */
export function createTurnLimit(maxTurns?: number): FinishTurn | undefined {
  if (maxTurns === undefined || !Number.isFinite(maxTurns) || maxTurns <= 0) return undefined;
  let completed = 0;
  return ({ message }) => {
    // Preserve the host's hard-exit semantics; errors are not normal turns.
    if (message.stopReason === 'error' || message.stopReason === 'aborted') return undefined;
    completed++;
    return completed >= maxTurns ? { action: 'end' } : undefined;
  };
}
