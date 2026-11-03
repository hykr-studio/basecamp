/**
 * @hykr/app: the framework's Expo app as a library. An application renders <AppShell> from
 * its root _layout, re-exports the framework's screens from thin route files, and builds its
 * own screens from the hooks and components below. Primitive (shadcn-style) components are
 * in @hykr/app/ui.
 */

export { AppShell, type AppShellProps } from './AppShell';
export { api, auth, type SessionUser } from './api';
export { applyCanvasIntent, useCanvas } from './canvas/store';
export { Button } from './components/Button';
export { ScreenTitle, SectionHeading } from './components/ScreenTitle';
export { type AppConfig, appConfig, configure } from './config';
export {
  ApprovalCard,
  ApprovalItem,
  DecisionScrollView,
  useApprovalStatus,
  useShownInline,
} from './framework/ApprovalCard';
export { AssistantActivity } from './framework/AssistantActivity';
export { ASSISTANT_ICON, AssistantMark, ByAssistant } from './framework/AssistantMark';
export {
  type AppDomain,
  defineAppDomain,
  type NavItem,
  type Suggestion,
} from './framework/app-domain';

export { AssistantProvider, useAssistant, useScreenContext } from './framework/assistant-context';
export { DateField, TimeField } from './framework/DateField';
export {
  at,
  clock,
  dayBounds,
  dayLabel,
  expiresIn,
  isValidDate,
  isValidTime,
  relativeDay,
  timeZone,
  todayLocal,
  when,
} from './framework/dates';
export { EmptyState, LoadError } from './framework/EmptyState';
export { Field } from './framework/Field';
export { type Chip, FilterChips, SearchBox } from './framework/FilterChips';
export { History } from './framework/History';
export {
  type EntityList,
  type EntityMutations,
  type EntityName,
  entityApi,
  errorMessage,
  type Register,
  type RegisteredCatalog,
  specs,
  useApprovals,
  useCommand,
  useEntity,
  useEntityList,
  useEntityMutation,
  useUndoableDelete,
} from './framework/hooks';
export { isFocused, isHovered } from './framework/hover';
export { Icon, type IconName } from './framework/Icon';
export { Loading } from './framework/Loading';
export { useLang, useT } from './framework/lang';
export { Markdown } from './framework/Markdown';
export { ToastProvider, useToast } from './framework/Toast';
export { TryPrompt } from './framework/TryPrompt';
export { type Verb, verbOf } from './framework/verbs';
export { WaitingForYou } from './framework/WaitingForYou';
export { inApp, webHref } from './framework/web-link';
export { cn } from './lib/utils';
export {
  type AppRuntime,
  getAppDomain,
  getCatalog,
  getRegistry,
  getRuntime,
  setRuntime,
} from './runtime';
export { NotFoundScreen } from './screens/NotFoundScreen';
export { PageScreen } from './screens/PageScreen';
export { PagesScreen } from './screens/PagesScreen';
export { colors, fonts, listRow, space, styles } from './theme';

export { InlineView } from './views/InlineView';
export { OpenRow, Rows, ViewCard } from './views/parts';
export { useAct } from './views/useAct';
