import { useId, type ComponentProps } from "react";

import { Checkbox as Control } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
export function Checkbox({
  label,
  description,
  id,
  ...props
}: ComponentProps<typeof Control> & { label?: string; description?: string }) {
  const generated = useId(),
    controlId = id ?? generated;
  return (
    <div className="flex items-start gap-3">
      <Control
        {...props}
        id={controlId}
        aria-describedby={description ? controlId + "-description" : undefined}
      />
      <div className="flex flex-col gap-1">
        {label && <Label htmlFor={controlId}>{label}</Label>}
        {description && (
          <p id={controlId + "-description"} className="text-sm text-muted-foreground">
            {description}
          </p>
        )}
      </div>
    </div>
  );
}
