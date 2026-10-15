/** The date editor uses UTC days; unchanged edits retain the exact timestamp. */
export function expiryDate(original: string | null | undefined): string {
  return original ? new Date(original).toISOString().slice(0, 10) : "";
}
export function expiryFromDate(date: string, original?: string | null): string | null {
  if (!date) return null;
  if (original && expiryDate(original) === date) return original;
  return new Date(date + "T23:59:59Z").toISOString();
}
