export function cents(n: number): string {
  return `${n.toFixed(1)}¢`;
}

export function pct(p: number, digits = 1): string {
  return `${(p * 100).toFixed(digits)}%`;
}

export function signed(n: number, digits = 2): string {
  const s = n >= 0 ? "+" : "−";
  return `${s}${Math.abs(n).toFixed(digits)}`;
}

export function signedDollars(centsTotal: number): string {
  const dollars = centsTotal / 100;
  const s = dollars >= 0 ? "+" : "−";
  return `${s}$${Math.abs(dollars).toFixed(2)}`;
}

export function clockHHMMSS(ms: number): string {
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

export function clockHHMM(ms: number): string {
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

export function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}
