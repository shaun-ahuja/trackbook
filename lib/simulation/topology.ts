import { DYNAMICS_CONFIG } from "./dynamicsConfig";

// Per-route contagion topology. Weights come from DYNAMICS_CONFIG.contagion
// — this file only declares the *relationships* (same trunk, transfer hub).
// Edit relationships here; tune weights in dynamicsConfig.
//
// Every market is included as a key in ROUTE_TOPOLOGY (even isolated ones
// like S) so the contagion loop doesn't need to special-case missing keys.

const { sameTrunk, transferHub, systemwide } = DYNAMICS_CONFIG.contagion;

// Markets sharing a trunk (color group). Strong coupling — disruption on
// one route is highly correlated with disruption on a peer.
const TRUNK_GROUPS: readonly (readonly string[])[] = [
  ["1", "2", "3"],          // 7 Avenue
  ["4", "5", "6"],          // Lexington
  ["A", "C", "E"],          // 8 Avenue
  ["B", "D", "F", "M"],     // 6 Avenue
  ["N", "Q", "R", "W"],     // Broadway
  ["J", "Z"],               // Nassau
];

// Major transfer hubs that bridge trunks. Each entry lists routes that
// converge at one station — disruption upstream can spill across trunks.
const TRANSFER_HUBS: readonly (readonly string[])[] = [
  // Times Square — 1·2·3·7·N·Q·R·W (+ S shuttle)
  ["1", "2", "3", "7", "N", "Q", "R", "W", "S"],
  // Union Square — 4·5·6·N·Q·R·W·L
  ["4", "5", "6", "N", "Q", "R", "W", "L"],
  // Grand Central — 4·5·6·7·S
  ["4", "5", "6", "7", "S"],
  // 14 St / 8 Av — A·C·E·L
  ["A", "C", "E", "L"],
  // West 4 St — A·C·E·B·D·F·M
  ["A", "C", "E", "B", "D", "F", "M"],
  // Atlantic Av / Barclays — 2·3·4·5·B·D·N·Q·R·W
  ["2", "3", "4", "5", "B", "D", "N", "Q", "R", "W"],
  // Jay St / MetroTech — A·C·F·R
  ["A", "C", "F", "R"],
  // Court Sq — 7·E·G·M
  ["7", "E", "G", "M"],
  // Fulton St / Broadway-Nassau — 2·3·4·5·A·C·J·Z
  ["2", "3", "4", "5", "A", "C", "J", "Z"],
  // Lex/59 — 4·5·6·N·R·W
  ["4", "5", "6", "N", "R", "W"],
];

// All known market ids — defines the universe for systemwide contagion.
const ALL_MARKETS: readonly string[] = [
  "1", "2", "3",
  "4", "5", "6",
  "7",
  "A", "B", "C", "D", "E", "F",
  "G",
  "J", "Z",
  "L",
  "M",
  "N", "Q", "R", "W",
  "S",
];

function addWeight(
  acc: Record<string, Record<string, number>>,
  a: string,
  b: string,
  w: number,
): void {
  if (a === b) return;
  if (!acc[a]) acc[a] = {};
  // Use max so a stronger relationship (e.g. same trunk) wins over a
  // weaker one (e.g. transfer hub) when both apply.
  const prev = acc[a][b];
  if (prev === undefined || w > prev) acc[a][b] = w;
}

function buildTopology(): Record<string, Record<string, number>> {
  const acc: Record<string, Record<string, number>> = {};
  for (const m of ALL_MARKETS) acc[m] = {};

  // Systemwide tiny coupling — applies to every distinct pair.
  for (const a of ALL_MARKETS) {
    for (const b of ALL_MARKETS) {
      addWeight(acc, a, b, systemwide);
    }
  }

  // Transfer hubs.
  for (const hub of TRANSFER_HUBS) {
    for (const a of hub) {
      for (const b of hub) {
        addWeight(acc, a, b, transferHub);
      }
    }
  }

  // Same trunk — strongest coupling, applied last so it overrides.
  for (const trunk of TRUNK_GROUPS) {
    for (const a of trunk) {
      for (const b of trunk) {
        addWeight(acc, a, b, sameTrunk);
      }
    }
  }

  return acc;
}

export const ROUTE_TOPOLOGY: Record<string, Record<string, number>> = buildTopology();

export function neighborsOf(marketId: string): Record<string, number> {
  return ROUTE_TOPOLOGY[marketId] ?? {};
}
