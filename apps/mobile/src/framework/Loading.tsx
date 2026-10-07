import { ActivityIndicator } from 'react-native';
import { Text } from '@/components/ui/text';
import { colors } from '../theme';
import { errorMessage } from './hooks';

/** A record still loading, or why it could not be. */
export function Loading({ error }: { error?: unknown }) {
  return error ? (
    <Text variant="error">Couldn't load this: {errorMessage(error)}</Text>
  ) : (
    <ActivityIndicator color={colors.primary} className="mt-8" />
  );
}
