import clsx from "clsx";
import type { ReactNode } from "react";

type Props = {
  title: string;
  subtitle?: string;
  right?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
};

export default function Panel({
  title,
  subtitle,
  right,
  children,
  className,
  bodyClassName,
}: Props) {
  return (
    <section
      className={clsx(
        "flex h-full min-h-0 flex-col overflow-hidden rounded-[2px] border border-[var(--color-panel-border)] bg-[var(--color-panel)]",
        className,
      )}
    >
      <header className="flex h-7 shrink-0 items-center justify-between border-b border-[var(--color-panel-border)] bg-[var(--color-panel-header)] px-2.5">
        <div className="flex items-baseline gap-2 truncate">
          <h2 className="text-[9px] uppercase tracking-[0.22em] text-[var(--color-accent)]">
            {title}
          </h2>
          {subtitle && (
            <span className="truncate text-[9px] uppercase tracking-[0.18em] text-[var(--color-muted)]">
              {subtitle}
            </span>
          )}
        </div>
        {right && (
          <div className="shrink-0 text-[10px] text-[var(--color-muted)]">
            {right}
          </div>
        )}
      </header>
      <div
        className={clsx(
          "min-h-0 flex-1 overflow-auto p-2.5 text-[12px] leading-tight",
          bodyClassName,
        )}
      >
        {children}
      </div>
    </section>
  );
}
