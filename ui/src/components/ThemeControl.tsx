import { Moon, Sun } from "lucide-react";
import { useSyncExternalStore } from "react";

import { Toggle } from "@/components/ui/toggle";

import { Tooltip } from "./Tooltip";
type Theme = "light" | "dark";

const listeners = new Set<() => void>();
function storedTheme(): Theme {
  try {
    const value = localStorage.getItem("keyforge.theme");
    if (value === "light" || value === "dark") return value;
  } catch {
    /* Appearance remains usable when storage is disabled. */
  }
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}
let theme = storedTheme();
function apply() {
  document.documentElement.classList.toggle("dark", theme === "dark");
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
}
apply();
export function setTheme(next: Theme) {
  theme = next;
  apply();
  try {
    localStorage.setItem("keyforge.theme", next);
  } catch {
    /* In-memory preference still applies. */
  }
  listeners.forEach((listener) => listener());
}
window.addEventListener("storage", (event) => {
  if (event.key === "keyforge.theme") {
    theme = storedTheme();
    apply();
    listeners.forEach((listener) => listener());
  }
});
export function useTheme() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => theme,
  );
}
export function ThemeControl() {
  const current = useTheme(),
    label = `Switch to ${current === "light" ? "dark" : "light"} theme`;
  return (
    <span className="console-theme-control">
      <Tooltip content={label} side="bottom">
        <Toggle
          aria-label={label}
          pressed={current === "dark"}
          onPressedChange={(dark) => setTheme(dark ? "dark" : "light")}
          size="sm"
        >
          {current === "light" ? <Sun aria-hidden="true" /> : <Moon aria-hidden="true" />}
        </Toggle>
      </Tooltip>
    </span>
  );
}
