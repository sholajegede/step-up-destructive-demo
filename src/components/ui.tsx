import type { ReactNode } from "react";

/** A titled surface. `action` sits opposite the title. */
export function Panel({
  title,
  subtitle,
  action,
  children,
  className = "",
}: {
  title: string;
  subtitle?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={`flex flex-col rounded-xl border border-line bg-surface ${className}`}
    >
      <header className="flex items-start justify-between gap-3 border-b border-line px-4 py-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold tracking-tight">{title}</h2>
          {subtitle !== undefined && (
            <p className="mt-0.5 text-xs text-muted">{subtitle}</p>
          )}
        </div>
        {action}
      </header>
      {children}
    </section>
  );
}

export type Tone = "allow" | "challenge" | "deny" | "neutral" | "escaped";

const TONES: Record<Tone, string> = {
  allow: "bg-allow-bg text-allow",
  challenge: "bg-challenge-bg text-challenge",
  deny: "bg-deny-bg text-deny",
  escaped: "bg-escaped-bg text-escaped",
  neutral: "bg-surface-muted text-muted",
};

export function Badge({
  tone = "neutral",
  children,
  className = "",
}: {
  tone?: Tone;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-xs font-medium ${TONES[tone]} ${className}`}
    >
      {children}
    </span>
  );
}

/** Monospace inline value — refs, correlation ids, reason codes. */
export function Mono({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <code className={`font-mono text-[11px] ${className}`}>{children}</code>
  );
}

export function Button({
  variant = "primary",
  className = "",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost";
}) {
  const base =
    "inline-flex items-center justify-center gap-2 rounded-lg px-3.5 py-2 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-45";
  const variants = {
    primary: "bg-accent text-accent-foreground hover:opacity-90",
    secondary: "border border-line-strong hover:bg-surface-muted",
    ghost: "text-muted hover:bg-surface-muted hover:text-foreground",
  };
  return (
    <button className={`${base} ${variants[variant]} ${className}`} {...props} />
  );
}

/** Empty state. Says what the space is for, not merely that it is empty. */
export function Empty({ children }: { children: ReactNode }) {
  return (
    <p className="px-4 py-8 text-center text-sm text-muted">{children}</p>
  );
}

/** Loading placeholder that holds the same shape the content will take. */
export function Skeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="flex flex-col gap-2 p-4" aria-hidden>
      {Array.from({ length: rows }).map((_, index) => (
        <div
          key={index}
          className="h-8 animate-pulse rounded-md bg-surface-muted"
        />
      ))}
    </div>
  );
}

export function ErrorNote({
  title,
  children,
  onDismiss,
}: {
  title: string;
  children?: ReactNode;
  onDismiss?: () => void;
}) {
  return (
    <div className="flex items-start gap-3 rounded-lg border border-deny/30 bg-deny-bg px-4 py-3 text-sm">
      <div className="min-w-0 flex-1">
        <p className="font-medium text-deny">{title}</p>
        {children !== undefined && (
          <div className="mt-1 text-xs text-foreground/70">{children}</div>
        )}
      </div>
      {onDismiss !== undefined && (
        <button
          type="button"
          onClick={onDismiss}
          className="text-xs text-muted hover:text-foreground"
          aria-label="Dismiss"
        >
          Dismiss
        </button>
      )}
    </div>
  );
}

export function formatAge(seconds?: number): string {
  if (seconds === undefined) return "—";
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function formatTime(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}
