import { type CSSProperties, useId } from 'react';
import { Text, View } from 'react-native';
import { colors, space, styles } from '../theme';

/** The browser's own date and time pickers: no format to remember, no typos. */
const inputStyle: CSSProperties = {
  font: 'inherit',
  fontSize: 15,
  color: colors.text,
  background: colors.card,
  border: `1px solid ${colors.border}`,
  borderRadius: 8,
  padding: '10px 12px',
  minHeight: 44,
  boxSizing: 'border-box',
  width: '100%',
};

function NativeInput({
  type,
  label,
  value,
  onChange,
  width,
}: {
  type: 'date' | 'time';
  label: string;
  value: string;
  onChange: (v: string) => void;
  width: number;
}) {
  const id = useId();
  return (
    <View style={{ gap: space.xs, width }}>
      <label htmlFor={id} style={{ display: 'contents' }}>
        <Text style={styles.label}>{label}</Text>
      </label>
      <input
        id={id}
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={inputStyle}
      />
    </View>
  );
}

export function DateField(props: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  optional?: boolean;
  width?: number;
}) {
  return (
    <NativeInput
      type="date"
      label={props.optional ? `${props.label} (optional)` : props.label}
      value={props.value}
      onChange={props.onChange}
      width={props.width ?? 170}
    />
  );
}

export function TimeField(props: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  width?: number;
}) {
  return (
    <NativeInput
      type="time"
      label={props.label}
      value={props.value}
      onChange={props.onChange}
      width={props.width ?? 130}
    />
  );
}
