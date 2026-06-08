/**
 * First token of a person's name, for compact bylines / contributor chips.
 * Falls back to "CG" when there's no usable name (never an email — emails must
 * not leak into public UI).
 */
export function getFirstName(fullName?: string | null): string {
  if (!fullName) return "CG";
  const first = fullName.trim().split(/\s+/)[0];
  return first || "CG";
}
