import type { InputHTMLAttributes } from "react";

interface CheckboxFieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
}

export function CheckboxField({ label, ...rest }: CheckboxFieldProps) {
  return (
    <div className="field">
      <label>
        <input type="checkbox" {...rest} />{" "}
        {label}
      </label>
    </div>
  );
}
