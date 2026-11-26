import { isJobFinished, type JobInfo } from '@hykr/contracts';
import { StyleSheet, Text, View } from 'react-native';
import { Button } from '../../components/Button';
import { colors, space, styles } from '../../theme';
import { FileThumbs } from '../files/FileThumbs';

const STATUS: Record<JobInfo['status'], string> = {
  queued: 'Waiting to start',
  running: 'Running',
  succeeded: 'Done',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

/**
 * One job: its status, a progress bar while it runs, its latest message or its error, and its
 * result files when it is done. With `onCancel`, an unfinished job has a Cancel button.
 */
export function JobProgress({
  job,
  label,
  onCancel,
  cancelling,
}: {
  job: JobInfo;
  /** What the job is, for people ("Render"). Default: its kind. */
  label?: string;
  onCancel?: () => void;
  cancelling?: boolean;
}) {
  const open = !isJobFinished(job.status);
  const pct = job.progress ?? (job.status === 'succeeded' ? 100 : 0);
  const tone =
    job.status === 'failed'
      ? colors.danger
      : job.status === 'succeeded'
        ? colors.success
        : colors.muted;
  return (
    <View style={s.box} accessibilityLabel={`${label ?? job.kind}: ${STATUS[job.status]}`}>
      <View style={s.head}>
        <Text style={styles.label}>{label ?? job.kind}</Text>
        <Text style={[s.status, { color: tone }]}>
          {STATUS[job.status]}
          {job.status === 'running' && job.progress !== null ? ` · ${job.progress}%` : ''}
        </Text>
      </View>
      {open ? (
        <View
          style={s.track}
          accessibilityRole="progressbar"
          accessibilityValue={{ min: 0, max: 100, now: pct }}
        >
          <View style={[s.fill, { width: `${pct}%` }]} />
        </View>
      ) : null}
      {job.error ? (
        <Text style={[styles.muted, { color: colors.danger }]}>{job.error.message}</Text>
      ) : job.message ? (
        <Text style={styles.muted}>{job.message}</Text>
      ) : null}
      {job.files.length ? <FileThumbs ids={job.files} /> : null}
      {open && onCancel ? (
        <Button title="Cancel" variant="danger" onPress={onCancel} busy={cancelling} />
      ) : null}
    </View>
  );
}

const s = StyleSheet.create({
  box: { gap: space.sm },
  head: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  status: { fontSize: 13, fontWeight: '600' },
  track: {
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.divider,
    overflow: 'hidden',
  },
  fill: { height: 6, borderRadius: 3, backgroundColor: colors.primary },
});
