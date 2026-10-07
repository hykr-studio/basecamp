import { Text, View } from 'react-native';
import { space, styles } from '../theme';

/**
 * Just enough markdown for notes: # headings, - lists, paragraphs. Notes are written by
 * people and by close-meeting; rendering them beats showing "## Decisions" literally.
 */
export function Markdown({ text, lines }: { text: string; lines?: number }) {
  const blocks = text.split('\n').filter((l, i, all) => l.trim() || (i > 0 && all[i - 1].trim()));
  const shown = lines ? blocks.filter((l) => l.trim()).slice(0, lines) : blocks;
  return (
    <View style={{ gap: space.xs }}>
      {shown.map((line, i) => {
        const key = `${i}:${line}`;
        if (!line.trim()) return <View key={key} style={{ height: space.xs }} />;
        const heading = /^#{1,6}\s+(.*)$/.exec(line);
        if (heading)
          return (
            <Text key={key} style={[styles.label, { marginTop: space.xs }]}>
              {heading[1]}
            </Text>
          );
        const item = /^\s*[-*]\s+(.*)$/.exec(line);
        if (item)
          return (
            <Text key={key} style={styles.text}>
              {'•  '}
              {item[1]}
            </Text>
          );
        return (
          <Text key={key} style={styles.text}>
            {line}
          </Text>
        );
      })}
    </View>
  );
}
