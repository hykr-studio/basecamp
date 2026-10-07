// Uniwind compiles Tailwind classes at build time. It must be the outermost Metro wrapper.
const { getDefaultConfig } = require('expo/metro-config');
const { withUniwindConfig } = require('uniwind/metro');

module.exports = withUniwindConfig(getDefaultConfig(__dirname), {
  cssEntryFile: './global.css',
  dtsFile: './src/uniwind-types.d.ts',
  polyfills: { rem: 16 },
});
