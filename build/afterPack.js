// Ad-hoc code-sign the macOS .app after packing.
//
// This is NOT a real Apple Developer ID signature: it does not pass Gatekeeper and does
// not enable Squirrel.Mac auto-update. What it DOES do is give the bundle a stable code
// identity (a fixed cdhash tied to appId com.souljaterm.app) so macOS TCC remembers
// permission grants — Full Disk Access, folder access, mic — across launches instead of
// forgetting them every time and re-prompting. That's the cure for "asks 50 times".
//
// When the Apple Developer ID lands: set a real `identity` (or CSC_LINK/CSC_NAME env),
// flip mac.hardenedRuntime → true in package.json, and add an afterSign notarize step.
// This hook then no-ops automatically (it bails when a real identity is configured), so
// electron-builder's own Developer-ID signing takes over and auto-update starts working.
const { execFileSync } = require('child_process');
const path = require('path');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  // A real cert is configured — let electron-builder sign properly; don't clobber it.
  if (process.env.CSC_LINK || process.env.CSC_NAME) return;
  // For a universal build, electron-builder packs each arch into a "…-temp" dir and then merges
  // them. Ad-hoc signing a slice rewrites its Electron Framework _CodeSignature/CodeResources, so
  // the two slices no longer match and the merge aborts ("Expected all non-binary files to have
  // identical SHAs"). Skip the temp slices — sign only the final merged app (and single-arch builds).
  if (/-temp$/.test(context.appOutDir)) return;

  const appName = `${context.packager.appInfo.productFilename}.app`;
  const appPath = path.join(context.appOutDir, appName);
  // --force: replace any existing/placeholder signature
  // --deep:  also sign nested helpers, frameworks, and the unpacked node-pty binary
  // "-":     the ad-hoc identity (no certificate)
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' });
  console.log(`[afterPack] ad-hoc signed ${appName} (stable identity, no Gatekeeper/auto-update)`);
};
