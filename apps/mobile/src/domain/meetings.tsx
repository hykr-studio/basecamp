import type { MeetingView } from '@app/contracts';
import { Badge } from '@/components/ui/badge';
import { Text } from '@/components/ui/text';

/** A meeting that already started and is not closed: its real job now is to be closed. */
export const needsClosing = (m: { status: string; startsAt: string }) =>
  m.status !== 'closed' && new Date(m.startsAt).getTime() <= Date.now();

/** Status as the person needs it (as StatusBadge in components/Rows.tsx). */
export function MeetingStatus({ meeting }: { meeting: MeetingView }) {
  if (needsClosing(meeting))
    return (
      <Badge variant="warn">
        <Text>Needs closing</Text>
      </Badge>
    );
  if (meeting.status === 'closed')
    return (
      <Badge>
        <Text>Closed</Text>
      </Badge>
    );
  if (meeting.status === 'held')
    return (
      <Badge variant="info">
        <Text>Held</Text>
      </Badge>
    );
  return (
    <Badge variant="success">
      <Text>Upcoming</Text>
    </Badge>
  );
}
