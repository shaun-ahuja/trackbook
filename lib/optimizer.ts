import type { OptimizerDecision, SimState } from "./types";
import { buildScenarioMatrix } from "./simulation/rollout";
import { DEFAULT_REWARD_PARAMS } from "./simulation/rolloutReward";

// Posts the scenario matrix to the Julia optimizer via the Next.js proxy.
// Returns null if the optimizer is unavailable or the request fails.
export async function fetchOptimizerDecision(
  state: SimState,
  marketId: string,
): Promise<Omit<OptimizerDecision, "computedAtTick"> | null> {
  let matrix;
  try {
    matrix = buildScenarioMatrix(
      state,
      marketId,
      50,   // M: trajectories per plan
      15,   // H: horizon steps
      DEFAULT_REWARD_PARAMS,
      0.97, // gamma: discount factor
    );
  } catch {
    return null;
  }

  try {
    const res = await fetch("/api/optimizer", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(matrix),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    return (await res.json()) as Omit<OptimizerDecision, "computedAtTick">;
  } catch {
    return null;
  }
}
