import { Analytics } from "@vercel/analytics/react";
import { useLocation } from "react-router-dom";

import { publicAnalyticsPath, sanitizeAnalyticsEvent } from "./lib/analytics";

export function PublicAnalytics() {
  const { pathname } = useLocation();
  const path = publicAnalyticsPath(pathname);
  if (import.meta.env.VITE_KEYFORGE_ANALYTICS !== "production" || !path) return null;
  return (
    <Analytics mode="production" route={path} path={path} beforeSend={sanitizeAnalyticsEvent} />
  );
}
