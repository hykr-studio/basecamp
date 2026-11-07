// The scripted model's scripts for the framework's own features, one file per feature, one line
// per file (a union merge keeps both sides' lines; see .gitattributes). A new feature adds its
// file and its line here; each set's `order` decides where its scripts run, not this list.
export { calendarScripts } from './calendar.js';
export { commentsScripts } from './comments.js';
export { documentsScripts } from './documents.js';
export { filesScripts } from './files.js';
export { handoffScripts } from './handoff.js';
export { jobsScripts } from './jobs.js';
export { memoryScripts } from './memory.js';
export { pagesScripts } from './pages.js';
export { statesScripts } from './states.js';
export { testingScripts } from './testing.js';
