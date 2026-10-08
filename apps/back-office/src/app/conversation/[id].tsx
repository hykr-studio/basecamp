import { router, useLocalSearchParams } from 'expo-router';
import { View } from 'react-native';
import { Conversation } from '../../components/Conversation';
import { Button } from '../../components/ui';

export default function ConversationScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return (
    <View className="flex-1">
      <View className="flex-row bg-card px-2 py-1">
        <Button label="← Conversations" tone="quiet" onPress={() => router.replace('/')} />
      </View>
      <Conversation id={id} onClosed={() => router.replace('/')} />
    </View>
  );
}
