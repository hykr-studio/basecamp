import type { Address, GeoPoint } from '@hykr/contracts';
import * as Location from 'expo-location';
import { Platform } from 'react-native';

/** Where the device is, and how sure it is: the radius in metres it may be off by, if known. */
export type Fix = { point: GeoPoint; accuracyM: number | null; at: string };

/** How hard to look: `high` uses GPS (slower, more battery), `balanced` Wi-Fi and cells. */
export type FixAccuracy = 'balanced' | 'high';

/** The person refused location access, or the device has it switched off. */
export class LocationUnavailable extends Error {}

/**
 * The device's position now, after asking for foreground permission. What it reports (and its
 * accuracy) is what the person sends: the server decides with its own geofence check.
 */
export async function currentLocation(o: { accuracy?: FixAccuracy } = {}): Promise<Fix> {
  const permission = await Location.requestForegroundPermissionsAsync();
  if (!permission.granted)
    throw new LocationUnavailable('Location is not allowed for this app. Allow it in Settings.');
  if (Platform.OS !== 'web' && !(await Location.hasServicesEnabledAsync()))
    throw new LocationUnavailable('Location is switched off on this device.');
  const fix = await Location.getCurrentPositionAsync({
    accuracy: o.accuracy === 'balanced' ? Location.Accuracy.Balanced : Location.Accuracy.High,
  });
  return {
    point: { lat: fix.coords.latitude, lng: fix.coords.longitude },
    accuracyM: fix.coords.accuracy ?? null,
    at: new Date(fix.timestamp).toISOString(),
  };
}

/** The device geocoder exists on phones only (Expo has none on the web). */
const geocodes = Platform.OS === 'ios' || Platform.OS === 'android';

/** The postal address at a point, from the device's geocoder; null where there is none. */
export async function addressOf(point: GeoPoint): Promise<Address | null> {
  if (!geocodes) return null;
  const [found] = await Location.reverseGeocodeAsync({
    latitude: point.lat,
    longitude: point.lng,
  });
  if (!found) return null;
  const line1 =
    [found.streetNumber, found.street].filter(Boolean).join(' ') || found.name || found.district;
  if (!line1) return null;
  const country = found.isoCountryCode?.toUpperCase();
  return {
    line1,
    ...(found.district && found.district !== line1 ? { line2: found.district } : {}),
    ...(found.city ? { locality: found.city } : {}),
    ...(found.region ? { region: found.region } : {}),
    ...(found.postalCode ? { postalCode: found.postalCode } : {}),
    ...(country && /^[A-Z]{2}$/.test(country) ? { country } : {}),
  };
}

/** The point of an address the person typed, from the device's geocoder; null if none. */
export async function pointOf(address: string): Promise<GeoPoint | null> {
  if (!geocodes || !address.trim()) return null;
  const [found] = await Location.geocodeAsync(address);
  return found ? { lat: found.latitude, lng: found.longitude } : null;
}
