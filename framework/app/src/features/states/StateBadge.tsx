import { type EntitySpec, isFrozen, stateLabel, statesOf, versionedOf } from '@hykr/contracts';
import { Text, View } from 'react-native';
import { Icon } from '../../framework/Icon';
import { useT } from '../../framework/lang';
import { colors, space } from '../../theme';

/**
 * A record's state as people call it ("Submitted"), with a lock when the record is frozen and
 * its revision when it has more than one ("v2"). Nothing for an entity without states.
 */
export function StateBadge({
  spec,
  row,
}: {
  spec: EntitySpec;
  row: Readonly<Record<string, unknown>>;
}) {
  const { lang } = useT();
  const trait = statesOf(spec);
  if (!trait) return null;
  const state = String(row[trait.field] ?? '');
  const frozen = isFrozen(versionedOf(spec), row);
  const revision = typeof row.revision === 'number' && row.revision > 1 ? `v${row.revision}` : '';
  const terminal = trait.states[state]?.terminal;
  const tone = terminal ? colors.muted : colors.approvalText;
  return (
    <View
      accessibilityLabel={[stateLabel(trait, state, lang), revision, frozen ? 'locked' : '']
        .filter(Boolean)
        .join(', ')}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        alignSelf: 'flex-start',
        gap: space.xs,
        paddingHorizontal: space.sm,
        paddingVertical: 2,
        borderRadius: 999,
        backgroundColor: terminal ? colors.disabledBg : colors.approvalBg,
      }}
    >
      {frozen ? <Icon name="lock" size={12} color={tone} /> : null}
      <Text style={{ fontSize: 13, fontWeight: '600', color: tone }}>
        {stateLabel(trait, state, lang)}
        {revision ? ` · ${revision}` : ''}
      </Text>
    </View>
  );
}
