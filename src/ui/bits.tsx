import type { ReactNode } from "react";

export function money(n: number) {
  return n.toLocaleString(undefined, { style: "currency", currency: "USD" });
}

export function when(ms: number) {
  if (!ms) return "—";
  return new Date(ms).toLocaleString();
}

export function tone(decision: string) {
  if (decision.includes("reject") || decision.includes("block")) return "bad";
  if (decision.includes("pending") || decision.includes("paused")) return "warn";
  return "ok";
}

export function Pill({ children, kind }: { children: ReactNode; kind?: string }) {
  return <span className={`pill ${kind ?? ""}`}>{children}</span>;
}

export function asList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    if (typeof item === "string") return item;
    if (item && typeof item === "object" && "label" in item) return String((item as { label: unknown }).label);
    return JSON.stringify(item);
  });
}

export function hunksOf(payload: Record<string, unknown>) {
  const raw = payload.hunks;
  if (!Array.isArray(raw)) return [] as { kind: string; text: string }[];
  return raw.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const row = item as { kind?: unknown; text?: unknown };
    return [{ kind: String(row.kind ?? ""), text: String(row.text ?? "") }];
  });
}
