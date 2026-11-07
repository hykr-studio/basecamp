import { type Address, addressText, type GeoPoint } from '@hykr/contracts';
import { Text, View } from 'react-native';
import { Button } from '../../components/Button';
import { space, styles } from '../../theme';
import { useCurrentLocation } from './hooks';
import { addressOf } from './location';

type Props = {
  label: string;
  /** The record's point, or null. */
  value: GeoPoint | null | undefined;
  onChange: (point: GeoPoint | null) => void;
  /** The record's address, shown with the point; filled from the device's geocoder if given. */
  address?: Address | null;
  onAddress?: (address: Address | null) => void;
  hint?: string;
};

const coords = (p: GeoPoint) => `${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}`;

/**
 * A record's place in a form: its address and point, "Use my location" to take the device's
 * position (and, on a phone, the address there), and clearing it. The record keeps them when
 * the form is saved, in the same write as its other fields.
 */
export function LocationField({ label, value, onChange, address, onAddress, hint }: Props) {
  const here = useCurrentLocation({ accuracy: 'high' });
  const use = async () => {
    const fix = await here.locate();
    if (!fix) return;
    onChange(fix.point);
    if (onAddress) {
      const found = await addressOf(fix.point).catch(() => null);
      if (found) onAddress(found);
    }
  };
  return (
    <View style={{ gap: space.xs }}>
      <Text style={styles.label}>{label}</Text>
      {address ? <Text style={styles.text}>{addressText(address)}</Text> : null}
      <Text style={styles.muted}>{value ? coords(value) : 'No place set'}</Text>
      <View style={[styles.row, { flexWrap: 'wrap' }]}>
        <Button
          title={value ? 'Use my location instead' : 'Use my location'}
          icon="map-pin"
          variant="secondary"
          busy={here.busy}
          onPress={use}
        />
        {value ? (
          <Button
            title="Clear"
            variant="ghost"
            onPress={() => {
              onChange(null);
              onAddress?.(null);
            }}
          />
        ) : null}
      </View>
      {here.error ? <Text style={styles.error}>{here.error}</Text> : null}
      {hint ? <Text style={styles.muted}>{hint}</Text> : null}
    </View>
  );
}
