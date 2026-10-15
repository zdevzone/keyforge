import type { LucideIcon } from "lucide-react";
import type { ComponentProps } from "react";

import { Button } from "../components";
import { Tooltip } from "./Tooltip";

export function ActionButton({
  label,
  icon: Icon,
  compact = false,
  ...props
}: Omit<ComponentProps<typeof Button>, "children"> & {
  label: string;
  icon: LucideIcon;
  compact?: boolean;
}) {
  const button = (
    <Button
      {...props}
      variant={props.variant ?? "secondary"}
      aria-label={label}
      className={compact ? "console-icon-action" : props.className}
    >
      <Icon aria-hidden="true" data-icon="inline-start" />
      {!compact && label}
    </Button>
  );
  return compact ? <Tooltip content={label}>{button}</Tooltip> : button;
}
