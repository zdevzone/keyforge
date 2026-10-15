import { CalendarDays } from "lucide-react";
import { useId, useState, type ComponentProps } from "react";

import { Button } from "@/components/ui/button";
import { Calendar, CalendarDayButton } from "@/components/ui/calendar";
import { Field, FieldLabel } from "@/components/ui/field";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
function dateValue(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
function CalendarDay(props: ComponentProps<typeof CalendarDayButton>) {
  return <CalendarDayButton {...props} data-date={dateValue(props.day.date)} />;
}
/** Date-only values stay in local calendar days until the API interprets UTC expiry. */
export function DateField({
  label,
  value,
  onChange,
  placeholder = "No expiry",
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  const id = useId(),
    [open, setOpen] = useState(false);
  const date = value ? new Date(value + "T12:00:00") : undefined;
  function choose(next: Date | undefined) {
    onChange(
      next
        ? next.getFullYear() +
            "-" +
            String(next.getMonth() + 1).padStart(2, "0") +
            "-" +
            String(next.getDate()).padStart(2, "0")
        : "",
    );
    setOpen(false);
  }
  return (
    <Field className="console-date">
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            id={id}
            variant="outline"
            aria-label={
              label +
              ": " +
              (date
                ? date.toLocaleDateString()
                : placeholder === "No expiry"
                  ? "never"
                  : placeholder)
            }
            className="w-full justify-between font-normal"
          >
            <span>
              {date
                ? date.toLocaleDateString(undefined, {
                    year: "numeric",
                    month: "short",
                    day: "numeric",
                  })
                : placeholder}
            </span>
            <CalendarDays aria-hidden="true" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" aria-label={label + " calendar"} className="w-auto p-0">
          <Calendar
            mode="single"
            selected={date}
            defaultMonth={date}
            onSelect={choose}
            captionLayout="dropdown"
            components={{ DayButton: CalendarDay }}
          />
          <div className="flex justify-between gap-3 border-t p-3">
            <Button variant="ghost" size="sm" onClick={() => choose(undefined)}>
              Clear
            </Button>
            <Button variant="outline" size="sm" onClick={() => choose(new Date())}>
              Today
            </Button>
          </div>
        </PopoverContent>
      </Popover>
    </Field>
  );
}
