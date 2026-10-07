import { PageScreen } from '@app/ui-registry';
import { bindScreen } from '@app/ui-registry/react';
import { useEntity } from '../framework/hooks';
import { Loading } from '../framework/Loading';
import { PageHost } from './PageHost';

/** A saved page, with today's data: its spec holds queries, so it is always current. */
export function SavedPageView({ id }: { id: string }) {
  const page = useEntity('pages', id);
  if (!page.data) return <Loading error={page.error} />;
  return <PageHost page={page.data.spec} />;
}

/** The framework's own canvas screen: a saved page. The domain binds its screens itself. */
export function bindPlatformScreens() {
  bindScreen(PageScreen, ({ id }) => <SavedPageView id={id} />);
}
