/**
 * The app's version, the same as package.json's (`npm run bump <x.y.z>` sets both, with the app
 * project and the Linux metadata; test/repo/version.test.ts checks they agree). A constant rather
 * than a read of package.json, so the bundled host knows it wherever it runs.
 */
export const VERSION = "0.1.4";
