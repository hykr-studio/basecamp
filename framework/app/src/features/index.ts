// The app's framework features, one export per line (a union merge keeps lines added in
// parallel). Each is an AppPlugin factory an application lists in `<AppShell plugins>`.
export { type LiveOptions, livePlugin } from './live/LivePlugin';
export { ConnectionsScreen, connectionsPlugin, scopeWords } from './mcp';
export { type PushOptions, pushPlugin } from './push/PushPlugin';
export { settingsPlugin } from './settings';
export * from './states';
export * from './webmcp';
