/* oxlint-disable jsx-a11y/prefer-tag-over-role -- A button with combobox role is the shadcn/WAI-ARIA select-only combobox trigger. */
import { Check, ChevronsUpDown } from "lucide-react";
import { useId, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
type ChoiceOption = { value: string; label: string; disabled?: boolean; keywords?: string[] };
type ChoiceProps = {
  label: string;
  options: ChoiceOption[];
  value?: string;
  onChange: (value: string) => void;
  hideLabel?: boolean;
  searchable?: boolean;
  id?: string;
  name?: string;
  description?: string;
  disabled?: boolean;
  required?: boolean;
  placeholder?: string;
  emptyMessage?: string;
  className?: string;
};
/** Shadcnblocks command/popover composition with catalog-only values. */
export function Choice({
  label,
  options,
  value = "",
  onChange,
  hideLabel,
  searchable,
  id,
  name,
  description,
  disabled,
  required,
  placeholder = "Select an option",
  emptyMessage = "No options found.",
  className,
}: ChoiceProps) {
  const generated = useId(),
    controlId = id ?? generated;
  const [open, setOpen] = useState(false);
  const [invalid, setInvalid] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const selected = options.find((option) => option.value === value);
  const useSearch = searchable ?? options.length > 7;
  const emptyValue = "__keyforge_empty_option__";
  return (
    <Field
      className={cn("console-choice", hideLabel && "console-choice-compact", className)}
      data-disabled={disabled}
      data-invalid={invalid || undefined}
    >
      <FieldLabel htmlFor={controlId} className={hideLabel ? "sr-only" : undefined}>
        {label}
      </FieldLabel>
      {useSearch ? (
        <>
          <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
              <Button
                ref={trigger}
                id={controlId}
                variant="outline"
                role="combobox"
                aria-haspopup="dialog"
                aria-controls={controlId + "-popup"}
                aria-label={label}
                aria-expanded={open}
                aria-required={required}
                aria-invalid={invalid || undefined}
                disabled={disabled}
                className="w-full justify-between font-normal"
              >
                <span className="truncate">{selected?.label ?? placeholder}</span>
                <ChevronsUpDown aria-hidden="true" />
              </Button>
            </PopoverTrigger>
            <PopoverContent
              id={controlId + "-popup"}
              align="start"
              className="w-[var(--radix-popover-trigger-width)] min-w-56 p-0"
            >
              <Command>
                <CommandInput
                  aria-label={"Search " + label.toLowerCase()}
                  placeholder={"Search " + label.toLowerCase() + "…"}
                />
                <CommandList>
                  <CommandEmpty>{emptyMessage}</CommandEmpty>
                  <CommandGroup>
                    {options.map((option) => (
                      <CommandItem
                        key={option.value}
                        value={option.value || emptyValue}
                        keywords={[option.label, ...(option.keywords ?? [])]}
                        disabled={option.disabled}
                        onSelect={() => {
                          setInvalid(false);
                          onChange(option.value);
                          setOpen(false);
                        }}
                      >
                        <span className="min-w-0 flex-1 truncate">{option.label}</span>
                        {value === option.value && <Check aria-hidden="true" />}
                      </CommandItem>
                    ))}
                  </CommandGroup>
                </CommandList>
              </Command>
            </PopoverContent>
          </Popover>
          {required ? (
            <input
              className="sr-only"
              tabIndex={-1}
              aria-hidden="true"
              value={selected ? "selected" : ""}
              required
              disabled={disabled}
              onChange={() => {}}
              onInvalid={(event) => {
                event.preventDefault();
                setInvalid(true);
                trigger.current?.focus();
              }}
            />
          ) : null}
          {name && <input type="hidden" name={name} value={value} />}
        </>
      ) : (
        <Select
          value={value || emptyValue}
          onValueChange={(next) => onChange(next === emptyValue ? "" : next)}
          name={name}
          required={required}
          disabled={disabled}
        >
          <SelectTrigger id={controlId} aria-label={label} className="w-full">
            <SelectValue placeholder={placeholder} />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {options.map((option) => (
                <SelectItem
                  key={option.value}
                  value={option.value || emptyValue}
                  disabled={option.disabled}
                >
                  {option.label}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      )}
      {description && <FieldDescription>{description}</FieldDescription>}
      {invalid && (
        <FieldError role="alert">
          Select {label.toLowerCase()} from the available options.
        </FieldError>
      )}
    </Field>
  );
}
