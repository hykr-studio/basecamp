import { useLocalSearchParams } from 'expo-router';
import { MeetingDetail } from './screens/MeetingDetail';

export { Meetings as MeetingsRoute } from './screens/Meetings';

/** /meetings/:id — the meeting screen (also shown in the canvas, bound in index.tsx). */
export function MeetingRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <MeetingDetail id={id} />;
}
