#!/bin/sh
# Build nanoflow.app from mac-notifier.js with what macOS ships: osacompile, plutil, codesign.
#   mac-notifier.sh <source .js> <app path> <stamp>
# The app gets its own name and id (so notifications say "nanoflow" and keep their own permission), stays out
# of the Dock (LSUIElement), wears hooks/nanoflow.icns, and records <stamp> so nanoflow rebuilds it when the
# source or this script changes. Signed ad hoc again after the edits, as an edited bundle no longer matches its
# signature.
set -e
source="$1"
app="$2"
stamp="$3"
# Its own folder per build, so two sessions building at once do not trip over each other; ending in .app,
# as osacompile makes an app only for such a name.
building="${app%.app}.$$.building.app"

mkdir -p "$(dirname "$app")"
rm -rf "$building"
/usr/bin/osacompile -l JavaScript -o "$building" "$source"
plist="$building/Contents/Info.plist"
# nanoflow's own icon beside the source, in place of the script icon: the .icns, and no asset catalog, which
# macOS would read first.
icon="$(dirname "$source")/nanoflow.icns"
if [ -f "$icon" ]; then
  cp "$icon" "$building/Contents/Resources/applet.icns"
  rm -f "$building/Contents/Resources/Assets.car"
  /usr/bin/plutil -remove CFBundleIconName "$plist" 2>/dev/null || true
fi
/usr/bin/plutil -replace CFBundleIdentifier -string ai.nanosite.nanoflow.notifier "$plist"
/usr/bin/plutil -replace CFBundleName -string nanoflow "$plist"
/usr/bin/plutil -replace LSUIElement -bool true "$plist"
/usr/bin/plutil -replace NanoflowNotifier -string "$stamp" "$plist"
/usr/bin/codesign --force --sign - "$building" >/dev/null 2>&1 || true
rm -rf "$app"
mv "$building" "$app"
