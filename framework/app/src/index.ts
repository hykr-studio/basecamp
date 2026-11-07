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
  type AcceptanceClient,
  AcceptanceClientProvider,
  AcceptDocument,
  RecordAcceptance,
  useAccept,
  useAcceptanceClient,
  useAcceptanceKinds,
  useAcceptanceStatus,
  useAcceptances,
  useRequestAcceptanceCode,
  useStartESign,
} from './features/acceptance';
export { CreditsScreen, creditsPlugin, formatCredits, parseCredits } from './features/credits';
export {
  RecordDocuments,
  useDocument,
  useDocumentKinds,
  useDocuments,
  useRenderDocument,
  useSendDocument,
} from './features/documents';
export {
  FileField,
  FileThumbs,
  fileFieldPolicy,
  type PickedFile,
  pickDocuments,
  pickPhotos,
  useFiles,
  useFileUpload,
} from './features/files';
export * from './features/index';
export { JobProgress, useCancelJob, useJob, useJobs } from './features/jobs';
export { createInvalidator, liveKeysFor } from './features/live/keys';
export {
  addressOf,
  currentLocation,
  type Fix,
  type FixAccuracy,
  LocationField,
  LocationUnavailable,
  pointOf,
  useCurrentLocation,
} from './features/location';
export {
  BrandMark,
  brandTokens,
  CustomFieldInputs,
  CustomFieldValues,
  hideOff,
  useBranding,
  useClientSettings,
  useCustomFields,
  useFeature,
  useFieldLabel,
} from './features/settings';
export {
  ApprovalCard,
  ApprovalItem,
  amountText,
  DecisionScrollView,
  useApprovalStatus,
  useShownInline,
  useStakes,
} from './framework/ApprovalCard';
export { AssistantActivity } from './framework/AssistantActivity';
export { ASSISTANT_ICON, AssistantMark, ByAssistant } from './framework/AssistantMark';
export {
  type AppModule,
  type AppPlugin,
  type AppRoute,
  type AppSettings,
  defineAppModule,
  isAppModule,
  type NavItem,
  type Suggestion,
  type WebMcpScreen,
  type WebMcpScreens,
} from './framework/app-domain';
export { AssistantProvider, useAssistant, useScreenContext } from './framework/assistant-context';
export { chooseBusiness, currentBusiness } from './framework/business';
export {
  bindAll,
  type ComposedApp,
  type ComposedRoute,
  type ComposedWebMcp,
  composeApp,
  FRAMEWORK_NAV,
  type ModuleList,
  matchRoute,
  orderModules,
} from './framework/compose-app';
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
  type CatalogOf,
  cachedRecord,
  type EntityList,
  type EntityMutations,
  type EntityName,
  entityApi,
  errorMessage,
  type MergedEntities,
  type Register,
  type RegisteredCatalog,
  specs,
  useApprovals,
  useCommand,
  useEntity,
  useEntityList,
  useEntityMutation,
  useEntitySummary,
  useUndoableDelete,
  writeCommand,
  writeEntity,
} from './framework/hooks';
export { isFocused, isHovered } from './framework/hover';
export { Icon, type IconName } from './framework/Icon';
export { Loading } from './framework/Loading';
export { useLang, useT } from './framework/lang';
export { Markdown } from './framework/Markdown';
export { useMoneyText } from './framework/money';
export {
  filterNav,
  runSignedIn,
  SignedIn,
  useNavFilters,
  wrapProviders,
} from './framework/plugins';
export { ToastProvider, useToast } from './framework/Toast';
export { TryPrompt } from './framework/TryPrompt';
export { useUndo } from './framework/undo';
export { type Verb, verbOf } from './framework/verbs';
export { WaitingForYou } from './framework/WaitingForYou';
export { inApp, webHref } from './framework/web-link';
export {
  isQueued,
  type PendingError,
  type PendingOp,
  type PendingState,
  type PendingWrite,
  type QueuedWrite,
} from './framework/write-queue';
export { cn } from './lib/utils';
export {
  type AppRuntime,
  getApp,
  getCatalog,
  getRegistry,
  getRuntime,
  hrefFor,
  setRuntime,
  webMcpFor,
} from './runtime';
export { ApprovalScreen } from './screens/ApprovalScreen';
export { ApprovalsScreen } from './screens/ApprovalsScreen';
export { NotFoundScreen } from './screens/NotFoundScreen';
export { PageScreen } from './screens/PageScreen';
export { PagesScreen } from './screens/PagesScreen';
export { colors, fonts, listRow, space, styles } from './theme';
export { InlineView } from './views/InlineView';
export { OpenRow, Rows, ViewCard } from './views/parts';
export { useAct } from './views/useAct';
export { type ProvidedData, useViewData, type ViewData, ViewDataProvider } from './views/view-data';
