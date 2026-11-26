import { type EntitySpec, stateLabel, statesOf } from '@hykr/contracts';
import { router } from 'expo-router';
import { Pressable, Text, View } from 'react-native';
import { Icon } from '../../framework/Icon';
import { useT } from '../../framework/lang';
import { hrefFor } from '../../runtime';
import { colors, space, styles } from '../../theme';
import { useVersions } from './hooks';

/**
 * The revisions of a versioned record (v1, v2, v3), oldest first: each with its state and a
 * lock when frozen, the one shown marked, the others opening where the app shows that record.
 * Nothing when there is only one.
 */
export function VersionList({ spec, id }: { spec: EntitySpec; id: string }) {
  const { lang } = useT();
  const q = useVersions(spec.name, id);
  const versions = q.data ?? [];
  if (versions.length < 2) return null;
  const trait = statesOf(spec);
  return (
    <View style={{ gap: space.xs }}>
      {versions.map((v) => {
        const words = [
          `v${v.revision}`,
          v.state && trait ? stateLabel(trait, v.state, lang) : '',
          v.current ? 'this one' : '',
        ]
          .filter(Boolean)
          .join(' · ');
        const href = v.current ? null : hrefFor(spec.name, v.id);
        return (
          <Pressable
            key={v.id}
            accessibilityRole={href ? 'link' : 'text'}
            accessibilityLabel={words}
            disabled={!href}
            onPress={() => href && router.navigate(href as never)}
            style={styles.row}
          >
            <Icon
              name={v.frozen ? 'lock' : 'edit-3'}
              size={14}
              color={v.current ? colors.text : colors.muted}
            />
            <Text style={v.current ? styles.label : [styles.text, { color: colors.primary }]}>
              {words}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}
