#!/bin/sh
# Build nanoflow.app from mac-notifier.js with what macOS ships: osacompile, plutil, codesign.
#   mac-notifier.sh <source .js> <app path> <stamp>
# The app gets its own name and id (so notifications say "nanoflow" and keep their own permission), stays out
# of the Dock (LSUIElement), and records <stamp> so nanoflow rebuilds it when the source changes. Signed ad hoc
# again after the edits, as an edited bundle no longer matches its signature.
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
/usr/bin/plutil -replace CFBundleIdentifier -string ai.nanosite.nanoflow.notifier "$plist"
/usr/bin/plutil -replace CFBundleName -string nanoflow "$plist"
/usr/bin/plutil -replace LSUIElement -bool true "$plist"
/usr/bin/plutil -replace NanoflowNotifier -string "$stamp" "$plist"
/usr/bin/codesign --force --sign - "$building" >/dev/null 2>&1 || true
rm -rf "$app"
mv "$building" "$app"
