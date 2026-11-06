/**
 * @hykr/back-office: the staff's web back office as a library. An application renders
 * <BackOfficeShell> from its root _layout and re-exports the screens from thin route files
 * (/ → ConversationsScreen, /conversation/[id] → ConversationScreen, /templates → TemplatesScreen,
 * /members → MembersScreen).
 */
export { BackOfficeShell, type BackOfficeShellProps } from './BackOfficeShell';
export { type BackOfficeConfig, backOfficeConfig, configure } from './config';
export { ConversationScreen } from './screens/ConversationScreen';
export { ConversationsScreen } from './screens/ConversationsScreen';
export { MembersScreen } from './screens/MembersScreen';
export { TemplatesScreen } from './screens/TemplatesScreen';
