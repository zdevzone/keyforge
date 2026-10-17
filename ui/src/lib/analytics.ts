import type { BeforeSendEvent } from "@vercel/analytics";

/** Report public surfaces only, with documentation slugs grouped together. */
export function publicAnalyticsPath(pathname: string): string | null {
  if (["/welcome", "/docs", "/request-license", "/docs/:slug"].includes(pathname)) return pathname;
  return /^\/docs\/[a-z0-9-]+$/.test(pathname) ? "/docs/:slug" : null;
}

export function sanitizeAnalyticsEvent(event: BeforeSendEvent): BeforeSendEvent | null {
  if (event.type !== "pageview") return null;
  try {
    const url = new URL(event.url);
    const path = publicAnalyticsPath(url.pathname);
    if (!path || url.protocol !== "https:" || url.username || url.password) return null;
    // Reconstruct instead of spreading: no search, fragments or extra event fields.
    return { type: "pageview", url: url.origin + path };
  } catch {
    return null;
  }
}
