import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Pressable, TextInput, View } from 'react-native';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { api } from '../api';
import { timeZone } from '../framework/dates';
import { errorMessage } from '../framework/hooks';
import { Icon } from '../framework/Icon';
import { useLang } from '../framework/lang';
import { colors } from '../theme';

/**
 * The person's WhatsApp number: messages from it reach the same assistant, answered in
 * words (no screen there). Linked with a one-time code sent to the number, so only someone
 * holding the phone can link it; the assistant cannot.
 */
export function WhatsAppLink() {
  const client = useQueryClient();
  const { lang } = useLang();
  const link = useQuery({ queryKey: ['whatsapp'], queryFn: () => api.whatsapp.get() });
  const [editing, setEditing] = useState(false);
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [codeSent, setCodeSent] = useState(false);
  const reset = () => {
    setEditing(false);
    setCodeSent(false);
    setPhone('');
    setCode('');
  };
  const send = useMutation({
    mutationFn: () => api.whatsapp.sendCode(phone, timeZone(), lang),
    onSuccess: () => setCodeSent(true),
  });
  const save = useMutation({
    mutationFn: () => api.whatsapp.verify(phone, code),
    onSuccess: () => {
      reset();
      return client.invalidateQueries({ queryKey: ['whatsapp'] });
    },
  });
  const remove = useMutation({
    mutationFn: () => api.whatsapp.unlink(),
    onSuccess: () => client.invalidateQueries({ queryKey: ['whatsapp'] }),
  });

  if (editing && codeSent) {
    return (
      <View className="gap-1.5">
        <Text variant="label">Code sent to WhatsApp</Text>
        <Text variant="muted">Type the 6-digit code that arrived on {phone}.</Text>
        <TextInput
          value={code}
          onChangeText={(v) => setCode(v.replace(/\D/g, '').slice(0, 6))}
          accessibilityLabel="The 6-digit code"
          placeholder="123456"
          placeholderTextColor={colors.placeholder}
          keyboardType="number-pad"
          textContentType="oneTimeCode"
          autoComplete="one-time-code"
          autoFocus
          onSubmitEditing={() => code.length === 6 && save.mutate()}
          className="min-h-11 rounded-control border border-border bg-card px-3 text-body text-text"
        />
        {save.error && <Text variant="error">{errorMessage(save.error)}</Text>}
        <View className="flex-row gap-1">
          <Button
            size="sm"
            disabled={code.length !== 6 || save.isPending}
            onPress={() => save.mutate()}
          >
            <Text>Link</Text>
          </Button>
          <Button
            size="sm"
            variant="subtle"
            onPress={() => send.mutate()}
            disabled={send.isPending}
          >
            <Text>Send again</Text>
          </Button>
          <Button size="sm" variant="subtle" onPress={reset}>
            <Text>Cancel</Text>
          </Button>
        </View>
      </View>
    );
  }

  if (editing) {
    return (
      <View className="gap-1.5">
        <Text variant="label">WhatsApp number</Text>
        <TextInput
          value={phone}
          onChangeText={setPhone}
          accessibilityLabel="WhatsApp number, with the country code"
          placeholder="e.g. +91 98765 43210"
          placeholderTextColor={colors.placeholder}
          keyboardType="phone-pad"
          autoFocus
          onSubmitEditing={() => phone.trim() && send.mutate()}
          className="min-h-11 rounded-control border border-border bg-card px-3 text-body text-text"
        />
        {send.error && <Text variant="error">{errorMessage(send.error)}</Text>}
        <View className="flex-row gap-1">
          <Button
            size="sm"
            disabled={!phone.trim() || send.isPending}
            onPress={() => send.mutate()}
          >
            <Text>Send code</Text>
          </Button>
          <Button size="sm" variant="subtle" onPress={reset}>
            <Text>Cancel</Text>
          </Button>
        </View>
      </View>
    );
  }

  if (link.data) {
    return (
      <View className="flex-row items-center gap-1.5">
        <Icon name="message-square" color={colors.success} size={14} />
        <Text variant="muted" className="flex-1" numberOfLines={1}>
          WhatsApp +{link.data.address}
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Unlink WhatsApp"
          onPress={() => remove.mutate()}
          className="min-h-9 justify-center px-1"
        >
          <Text variant="muted" className="text-primary">
            Unlink
          </Text>
        </Pressable>
      </View>
    );
  }

  return (
    <Pressable
      accessibilityRole="button"
      onPress={() => setEditing(true)}
      className="min-h-9 flex-row items-center gap-1.5 self-start"
    >
      <Icon name="message-square" color={colors.primary} size={14} />
      <Text variant="muted" className="text-primary">
        Link WhatsApp
      </Text>
    </Pressable>
  );
}
