import { useQuery } from '@tanstack/react-query';
import { router } from 'expo-router';
import { useState } from 'react';
import { useWindowDimensions, View } from 'react-native';
import { api } from '../api';
import { Conversation } from '../components/Conversation';
import { Inbox } from '../components/Inbox';
import { Empty } from '../components/ui';

/** The inbox beside the open conversation; on a phone, the inbox, then the conversation. */
export default function Conversations() {
  const inbox = useQuery({
    queryKey: ['inbox'],
    queryFn: api.backoffice.inbox,
    refetchInterval: 10_000,
  });
  const wide = useWindowDimensions().width >= 900;
  const [selected, setSelected] = useState<string>();
  const select = (id: string) => (wide ? setSelected(id) : router.push(`/conversation/${id}`));
  return (
    <View className="flex-1 flex-row">
      <View className={wide ? 'w-96 border-r border-divider' : 'flex-1'}>
        <Inbox data={inbox.data} selectedId={selected} onSelect={select} />
      </View>
      {wide ? (
        <View className="flex-1">
          {selected ? (
            <Conversation key={selected} id={selected} onClosed={() => setSelected(undefined)} />
          ) : (
            <Empty title="Pick a conversation">
              The assistant stays quiet in a conversation until you hand it back.
            </Empty>
          )}
        </View>
      ) : null}
    </View>
  );
}
