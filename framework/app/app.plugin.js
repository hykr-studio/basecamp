// @hykr/app's Expo config plugin: `"plugins": ["@hykr/app"]` in the app's app.json. Each time
// Expo reads the app's config (expo start, expo export, a build), it writes what web push needs
// into the app's public/ folder, which the web build serves at the site's root:
//   public/push-sw.js            the service worker (a copy of @hykr/app's)
//   public/manifest.webmanifest  the name, an icon and display: standalone (iOS shows web push
//                                only for a site added to the Home Screen)
//   public/pwa-icon.png          the app's icon (expo.icon), for the manifest and notifications
// The files are generated: keep them out of git. It changes nothing on iOS or Android.
const fs = require('node:fs');
const path = require('node:path');

const SERVICE_WORKER = path.join(__dirname, 'push-sw.js');

/** A PNG's width and height, from its header; undefined for anything else. */
function pngSize(file) {
  try {
    const head = Buffer.alloc(24);
    const fd = fs.openSync(file, 'r');
    try {
      fs.readSync(fd, head, 0, 24, 0);
    } finally {
      fs.closeSync(fd);
    }
    if (head.readUInt32BE(0) !== 0x89504e47) return undefined;
    return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) };
  } catch {
    return undefined;
  }
}

/** Write a file only when its content changed, so a watcher is not woken for nothing. */
function writeIfChanged(file, content) {
  try {
    if (fs.readFileSync(file).equals(Buffer.from(content))) return;
  } catch {
    // Not there yet.
  }
  fs.writeFileSync(file, content);
}

/** The web push files for the app at `projectRoot`, from its config. Throws when it cannot. */
function writeWebPushFiles(projectRoot, config) {
  const pub = path.join(projectRoot, 'public');
  fs.mkdirSync(pub, { recursive: true });
  writeIfChanged(path.join(pub, 'push-sw.js'), fs.readFileSync(SERVICE_WORKER));

  const icons = [];
  const iconSource = config.icon ? path.resolve(projectRoot, config.icon) : undefined;
  if (iconSource && fs.existsSync(iconSource)) {
    writeIfChanged(path.join(pub, 'pwa-icon.png'), fs.readFileSync(iconSource));
    const size = pngSize(iconSource);
    icons.push({
      src: '/pwa-icon.png',
      type: 'image/png',
      ...(size ? { sizes: `${size.width}x${size.height}` } : {}),
    });
  }
  const manifest = {
    name: config.name,
    short_name: config.web?.shortName ?? config.name,
    start_url: '/',
    scope: '/',
    display: 'standalone',
    ...(config.web?.themeColor ? { theme_color: config.web.themeColor } : {}),
    ...(config.web?.backgroundColor ? { background_color: config.web.backgroundColor } : {}),
    icons,
  };
  writeIfChanged(path.join(pub, 'manifest.webmanifest'), `${JSON.stringify(manifest, null, 2)}\n`);
}

/** The config plugin: writes the files, and leaves the config as it is. */
function withHykrApp(config) {
  const projectRoot = config._internal?.projectRoot ?? process.cwd();
  try {
    writeWebPushFiles(projectRoot, config);
  } catch (e) {
    throw new Error(
      `@hykr/app could not write the web push files into ${path.join(projectRoot, 'public')}: ${e instanceof Error ? e.message : e}`,
    );
  }
  return config;
}

module.exports = withHykrApp;
module.exports.writeWebPushFiles = writeWebPushFiles;
