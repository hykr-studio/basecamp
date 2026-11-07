/**
 * @hykr/back-office: the staff's web back office as a library. An application renders
 * <BackOfficeShell> from its root _layout and re-exports the screens from thin route files
 * (/ → ConversationsScreen, /conversation/[id] → ConversationScreen, /templates → TemplatesScreen,
 * /members → MembersScreen, /agents → AgentsScreen, /settings → SettingsScreen).
 */
export { BackOfficeShell, type BackOfficeShellProps } from './BackOfficeShell';
export { type BackOfficeConfig, backOfficeConfig, configure } from './config';
export { AgentsScreen } from './screens/AgentsScreen';
export { ConversationScreen } from './screens/ConversationScreen';
export { ConversationsScreen } from './screens/ConversationsScreen';
export { MembersScreen } from './screens/MembersScreen';
export { SettingsScreen } from './screens/SettingsScreen';
export { TemplatesScreen } from './screens/TemplatesScreen';
