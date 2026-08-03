// Rough token estimate from text (~4 chars/token) — used as a fallback when a provider returns
// no usage, so a call is never silently counted as 0 tokens. Not exact, but far better than 0.
export function estimateTokensFromText(t: string | undefined | null): number {
  return Math.ceil((t?.length ?? 0) / 4);
}
