import { TextField } from "../components";
import { Choice } from "./Choice";
import { DateField } from "./DateField";

export function PaymentFields({
  method,
  reference,
  date,
  onMethod,
  onReference,
  onDate,
}: {
  method: string;
  reference: string;
  date: string;
  onMethod: (value: string) => void;
  onReference: (value: string) => void;
  onDate?: (value: string) => void;
}) {
  return (
    <fieldset className="flex min-w-0 flex-col gap-4">
      <legend className="mb-3 text-sm font-medium">Payment received</legend>
      <Choice
        label="Payment method"
        required
        value={method}
        onChange={onMethod}
        options={[
          { value: "Bank transfer", label: "Bank transfer" },
          { value: "Cash", label: "Cash" },
          { value: "Mobile money", label: "Mobile money" },
          { value: "Other", label: "Other" },
        ]}
      />
      {onDate ? (
        <DateField
          label="Payment date (UTC)"
          value={date}
          onChange={onDate}
          placeholder="Select payment date"
        />
      ) : (
        <p className="text-sm text-muted-foreground">Payment date: {date} (UTC)</p>
      )}
      <TextField label="Transaction reference" value={reference} onChange={onReference} required />
    </fieldset>
  );
}
