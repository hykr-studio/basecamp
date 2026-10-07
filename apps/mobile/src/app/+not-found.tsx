import { router } from 'expo-router';
import { View } from 'react-native';
import { EmptyState } from '../framework/EmptyState';
import { styles } from '../theme';

export default function NotFound() {
  return (
    <View style={styles.content}>
      <EmptyState
        icon="compass"
        title="This page doesn't exist"
        body="The link may be old or mistyped."
        action={{ label: 'Go to Today', onPress: () => router.navigate('/') }}
      />
    </View>
  );
}
