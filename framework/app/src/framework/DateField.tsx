import { isValidDate, isValidTime } from './dates';
import { Field } from './Field';

/**
 * Date and time entry. Web uses the browser's native pickers (DateField.web.tsx).
 * Native falls back to validated text until a picker is added for the phone builds.
 */
export function DateField({
  label,
  value,
  onChange,
  optional,
  width = 170,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  optional?: boolean;
  width?: number;
}) {
  const bad = value !== '' && !isValidDate(value);
  return (
    <Field
      label={optional ? `${label} (optional)` : label}
      value={value}
      onChangeText={onChange}
      placeholder="2026-10-31"
      keyboardType="numbers-and-punctuation"
      error={bad ? 'Use year-month-day, like 2026-10-31' : null}
      width={width}
    />
  );
}

export function TimeField({
  label,
  value,
  onChange,
  width = 120,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  width?: number;
}) {
  const bad = value !== '' && !isValidTime(value);
  return (
    <Field
      label={label}
      value={value}
      onChangeText={onChange}
      placeholder="14:30"
      keyboardType="numbers-and-punctuation"
      error={bad ? 'Use 24-hour time, like 14:30' : null}
      width={width}
    />
  );
}
