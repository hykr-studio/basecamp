// The business's setup in the app (A11): its feature flags (destinations of what is switched off
// are hidden, `useFeature` for anything else), its branding (the theme's colours, `useBranding`,
// `<BrandMark>`) and its own phrases. One plugin: `<AppShell plugins={[settingsPlugin()]}>`.
import type { ClientSettings } from '@hykr/contracts';
import { setTenantPhrases } from '@hykr/i18n';
import { useQuery } from '@tanstack/react-query';
import { type ReactNode, useEffect, useMemo, useRef } from 'react';
import { Image, Text, View } from 'react-native';
import { Uniwind } from 'uniwind';
import { create } from 'zustand';
import { api } from '../../api';
import type { AppPlugin, NavItem } from '../../framework/app-domain';
import { colors, fonts, space } from '../../theme';
import { brandTokens, hideOff, themeSignature } from './tokens';

/** Who is signed in, as the plugin knows it (the shell tells it). */
const useSignedIn = create<{ userId: string | null }>(() => ({ userId: null }));

/** The theme's own colours, to go back to at sign-out. */
const themeColors = { ...colors };

/** Put a business's colours into the theme (StyleSheet values and Tailwind variables). */
function applyBranding(settings: ClientSettings | undefined) {
  const { tokens, cssVars } = brandTokens(settings?.branding.colors);
  Object.assign(colors, themeColors, tokens);
  const reset = Object.fromEntries(
    Object.entries(
      brandTokens({
        primary: themeColors.primary,
        primaryText: themeColors.primaryText,
        rail: themeColors.rail,
      }).cssVars,
    ),
  );
  try {
    Uniwind.updateCSSVariables(Uniwind.currentTheme, { ...reset, ...cssVars });
  } catch {
    // An environment without Uniwind's runtime (tests): the StyleSheet values still apply.
  }
  setTenantPhrases(settings?.phrases ?? {});
}

const SETTINGS_KEY = ['settings'] as const;

/** The signed-in business's settings: undefined while they load (everything gated is off). */
export function useClientSettings(): ClientSettings | undefined {
  const userId = useSignedIn((s) => s.userId);
  const q = useQuery({
    queryKey: [...SETTINGS_KEY, userId],
    queryFn: () => api.settings.get(),
    enabled: userId !== null,
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });
  return userId ? q.data : undefined;
}

/** Is this flag on for the business? False until its settings load, and on any doubt. */
export function useFeature(key: string): boolean {
  return useClientSettings()?.features.includes(key) ?? false;
}

/** The business's branding: its name, logo and colours (null fields: the product's). */
export function useBranding() {
  return useClientSettings()?.branding ?? null;
}

/**
 * Applies the business's branding and phrases (in render, so the first paint after they arrive
 * already has them). Drawing the screens again with them is the shell's job, through the
 * plugin's redraw key; nothing here remounts, so the plugins stay signed in. While they load (or
 * between sign-ins) the last ones stay; at sign-out the product's own theme comes back.
 */
function SettingsProvider({ children }: { children: ReactNode }) {
  const settings = useClientSettings();
  const userId = useSignedIn((s) => s.userId);
  const applied = useRef('product');
  if (settings) {
    const signature = themeSignature(settings.branding.colors, settings.phrases);
    if (signature !== applied.current) {
      applyBranding(settings);
      applied.current = signature;
    }
  }
  useEffect(() => {
    if (userId !== null) return;
    applyBranding(undefined);
    applied.current = 'product';
  }, [userId]);
  return <>{children}</>;
}

/**
 * The shell's redraw key: the business's look and words. Settings that change nothing (the
 * product's colours, no phrases of its own) keep the product's key, so they redraw nothing;
 * while they load, the last key stays.
 */
function useThemeKey(): string {
  const settings = useClientSettings();
  const last = useRef('product');
  if (settings) last.current = themeSignature(settings.branding.colors, settings.phrases);
  return last.current;
}

/** Hides the destinations of what the business switched off. */
function useSettingsNav(items: readonly NavItem[]): readonly NavItem[] {
  const off = useClientSettings()?.off;
  return useMemo(() => hideOff(items, off), [items, off]);
}

/** The business's logo and name, where a screen wants them (the product's name without them). */
export function BrandMark({ fallback }: { fallback: string }) {
  const branding = useBranding();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
      {branding?.logoUrl ? (
        <Image
          source={{ uri: branding.logoUrl }}
          accessibilityIgnoresInvertColors
          style={{ width: 28, height: 28, borderRadius: 6 }}
        />
      ) : null}
      <Text style={{ fontFamily: fonts.heading, fontSize: 17, color: colors.text }}>
        {branding?.name ?? fallback}
      </Text>
    </View>
  );
}

/** The settings plugin: flags, branding and phrases for the signed-in business. */
export function settingsPlugin(): AppPlugin {
  return {
    name: 'settings',
    Provider: SettingsProvider,
    Brand: BrandMark,
    onSignedIn: (user) => {
      useSignedIn.setState({ userId: user.id });
      return () => useSignedIn.setState({ userId: null });
    },
    useNav: useSettingsNav,
    useRedrawKey: useThemeKey,
  };
}
