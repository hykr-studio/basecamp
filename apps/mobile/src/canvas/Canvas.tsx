import { registry } from '@app/ui-registry';
import { getScreen } from '@app/ui-registry/react';
import { useState } from 'react';
import { ScrollView, TextInput, View } from 'react-native';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { AssistantMark } from '../framework/AssistantMark';
import { entityApi, errorMessage } from '../framework/hooks';
import { Icon } from '../framework/Icon';
import { useToast } from '../framework/Toast';
import { colors } from '../theme';
import { PageHost } from './PageHost';
import { useCanvas } from './store';

/** Keep the page on the canvas: "Monday view" opens later from Pages, with that day's data. */
function SaveButton() {
  const state = useCanvas((s) => s.state);
  const show = useCanvas((s) => s.show);
  const toast = useToast();
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  if (state.kind !== 'page' || state.pageId) return null;

  const save = async () => {
    setBusy(true);
    try {
      const result = await entityApi('pages').create({ name: name.trim(), spec: state.page });
      if (result.status === 'done') {
        show({ kind: 'page', page: state.page, pageId: result.value.id });
        toast.show({ tone: 'success', message: `Saved “${name.trim()}” under Pages` });
      }
      setNaming(false);
    } catch (e) {
      toast.show({ tone: 'error', message: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };

  if (!naming)
    return (
      <Button
        variant="secondary"
        size="sm"
        accessibilityLabel="Save this page"
        onPress={() => {
          setName(state.page.title);
          setNaming(true);
        }}
      >
        <Icon name="bookmark" color={colors.text} size={14} />
        <Text>Save</Text>
      </Button>
    );
  return (
    <View className="flex-row items-center gap-1">
      <TextInput
        value={name}
        onChangeText={setName}
        autoFocus
        accessibilityLabel="Name for this page"
        onSubmitEditing={() => name.trim() && save()}
        className="min-h-9 w-44 rounded-control border border-border bg-card px-2 text-body text-text"
      />
      <Button size="sm" accessibilityLabel="Save it" disabled={!name.trim() || busy} onPress={save}>
        <Text>Save</Text>
      </Button>
    </View>
  );
}

/**
 * The canvas: the part of the screen the assistant can drive. It shows a registered screen
 * or a composed page; the person's own navigation stays outside it. Wide: beside the chat,
 * in place of the main column. Phone: a full-screen sheet, with a way back to the chat.
 */
export function Canvas({ onChat }: { onChat?: () => void }) {
  const state = useCanvas((s) => s.state);
  const close = useCanvas((s) => s.close);
  if (state.kind === 'closed') return null;

  const title =
    state.kind === 'page'
      ? state.page.title
      : `The ${registry.getScreenDef(state.screen)?.title ?? 'screen'}`;
  const Screen = state.kind === 'screen' ? getScreen(state.screen) : undefined;

  return (
    <View className="flex-1 bg-bg" role="region" aria-label={`Canvas: ${title}`}>
      <View className="min-h-14 flex-row items-center gap-2 border-b border-border bg-card px-4">
        <AssistantMark size={20} />
        <Text variant="heading" className="flex-1" numberOfLines={1}>
          {title}
        </Text>
        <SaveButton />
        {onChat && (
          <Button variant="subtle" size="sm" accessibilityLabel="Back to the chat" onPress={onChat}>
            <Icon name="message-circle" color={colors.primary} size={14} />
            <Text>Chat</Text>
          </Button>
        )}
        <Button variant="subtle" size="icon" accessibilityLabel="Close the canvas" onPress={close}>
          <Icon name="x" color={colors.primary} size={18} />
        </Button>
      </View>
      <ScrollView contentContainerClassName="mx-auto w-full max-w-[1100px] gap-4 p-4">
        {state.kind === 'page' ? (
          <PageHost page={state.page} />
        ) : Screen ? (
          <Screen {...state.params} />
        ) : (
          <Text variant="muted">This screen is not available in this app.</Text>
        )}
      </ScrollView>
    </View>
  );
}
