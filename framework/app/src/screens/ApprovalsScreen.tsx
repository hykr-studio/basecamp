import { ScrollView } from 'react-native';
import { ScreenTitle } from '../components/ScreenTitle';
import { useScreenContext } from '../framework/assistant-context';
import { WaitingForYou } from '../framework/WaitingForYou';
import { styles } from '../theme';

/** Everything waiting for this person's decision (`/approvals`), each one decided in place. */
export function ApprovalsScreen() {
  useScreenContext({ screen: 'approvals' });
  return (
    <ScrollView contentContainerStyle={styles.content}>
      <ScreenTitle
        title="Approvals"
        subtitle="What waits for your decision: the assistant's requests, and the business's."
      />
      <WaitingForYou place="Approvals" />
    </ScrollView>
  );
}
