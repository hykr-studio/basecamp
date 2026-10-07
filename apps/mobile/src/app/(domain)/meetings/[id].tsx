import { useLocalSearchParams } from 'expo-router';
import { MeetingDetail } from '../../../domain/screens/MeetingDetail';

/** /meetings/:id — the meeting screen (also shown in the canvas, see canvas/screens.tsx). */
export default function MeetingRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <MeetingDetail id={id} />;
}
