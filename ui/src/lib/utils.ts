import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Merge class names, letting a later Tailwind utility beat an earlier one in
 * the same group.
 *
 * The convention every shadcn/ui component is written against: without it,
 * passing `className="bg-white"` to a component whose base is `bg-background`
 * leaves both in the string and the winner is whichever CSS rule the bundler
 * happened to emit last.
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
