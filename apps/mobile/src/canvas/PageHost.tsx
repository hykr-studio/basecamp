import type { PageBlock, PageSpec } from '@app/contracts';
import { registry } from '@app/ui-registry';
import { useWindowDimensions, View } from 'react-native';
import { InlineView } from '../views/InlineView';

/** Below this width a page stacks, and wide views swap in their narrow form. */
const NARROW = 700;

/**
 * One block: its own query, fetched with the person's session. A patch changes one block's
 * query, so only that block re-fetches; a tick in one block updates every block showing it.
 */
function Block({ block, narrow }: { block: PageBlock; narrow: boolean }) {
  const collapsed = narrow ? registry.getViewDef(block.view)?.collapseTo : undefined;
  return <InlineView view={collapsed ?? block.view} query={block.query} props={block.props} />;
}

/** A composed page: stack, or two columns with full-width rows (span: 'full'). */
export function PageHost({ page }: { page: PageSpec }) {
  const width = useWindowDimensions().width;
  const narrow = width < NARROW;
  if (page.layout === 'stack' || narrow) {
    return (
      <View className="gap-4">
        {page.blocks.map((b) => (
          <Block key={b.id} block={b} narrow={narrow} />
        ))}
      </View>
    );
  }
  return (
    <View className="flex-row flex-wrap gap-4">
      {page.blocks.map((b) => (
        <View key={b.id} className={b.span === 'full' ? 'w-full' : 'min-w-72 flex-1 basis-[45%]'}>
          <Block block={b} narrow={false} />
        </View>
      ))}
    </View>
  );
}
