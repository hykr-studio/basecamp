// The scripted model's scripts for the framework's own features, one file per feature, one line
// per file (a union merge keeps both sides' lines; see .gitattributes). A new feature adds its
// file and its line here; each set's `order` decides where its scripts run, not this list.
export { commentsScripts } from './comments.js';
export { filesScripts } from './files.js';
export { handoffScripts } from './handoff.js';
export { pagesScripts } from './pages.js';
export { testingScripts } from './testing.js';
