type Tone = "accent" | "warn" | "down" | "muted";

const TONE_STYLES: Record<Tone, { bg: string; fg: string }> = {
  accent:  { bg: "rgba(88,228,197,0.08)",  fg: "var(--color-accent)" },
  warn:    { bg: "rgba(245,176,66,0.10)",   fg: "var(--color-warn)" },
  down:    { bg: "rgba(255,90,120,0.10)",   fg: "var(--color-down)" },
  muted:   { bg: "rgba(106,117,133,0.10)",  fg: "var(--color-muted)" },
};

type Props = {
  label: string;
  tone: Tone;
};

export default function PanelStatusBadge({ label, tone }: Props) {
  const s = TONE_STYLES[tone];
  return (
    <span
      className="rounded-[1px] px-1 py-px text-[8px] font-bold uppercase tracking-[0.18em]"
      style={{ background: s.bg, color: s.fg }}
    >
      {label}
    </span>
  );
}
