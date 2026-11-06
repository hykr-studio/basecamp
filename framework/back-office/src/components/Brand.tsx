// The business's name and logo in the back office (A11, white label): from its settings once
// signed in; before that, from the verified custom domain the page is served on, if it is one.
import { useQuery } from '@tanstack/react-query';
import { Image, Platform, Text, View } from 'react-native';
import { api } from '../api';

type Brand = { name: string | null; logoUrl: string | null } | null | undefined;

type MarkProps = {
  /** The product's name, while the business has none (or none is known yet). */
  fallback: string;
  /** After the name, in the same line: " back office". */
  suffix?: string;
  className?: string;
};

function Mark({ brand, fallback, suffix = '', className }: MarkProps & { brand: Brand }) {
  return (
    <View className="flex-row items-center gap-2">
      {brand?.logoUrl ? (
        <Image
          source={{ uri: brand.logoUrl }}
          accessibilityIgnoresInvertColors
          style={{ width: 28, height: 28, borderRadius: 6 }}
        />
      ) : null}
      <Text className={className}>
        {brand?.name ?? fallback}
        {suffix}
      </Text>
    </View>
  );
}

/** The signed-in business's name and logo (the settings the Settings screen edits). */
export function BusinessBrand(props: MarkProps) {
  const settings = useQuery({ queryKey: ['settings'], queryFn: api.settings.get });
  return <Mark brand={settings.data?.branding} {...props} />;
}

/** The page's own address on the web, when it could be a business's (https); nothing elsewhere. */
const pageOrigin = () => {
  if (Platform.OS !== 'web' || typeof window === 'undefined') return null;
  const { origin } = window.location;
  return origin.startsWith('https://') ? origin : null;
};

/**
 * Before signing in: on a business's verified address, its name and logo; anywhere else (the
 * product's own address, a 404, a refused request) the product's name.
 */
export function DomainBrand(props: MarkProps) {
  const origin = pageOrigin();
  const brand = useQuery({
    queryKey: ['branding', 'public', origin],
    queryFn: () => api.settings.publicBranding(origin ?? undefined),
    enabled: origin !== null,
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
  });
  return <Mark brand={brand.data} {...props} />;
}
