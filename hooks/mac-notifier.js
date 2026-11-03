// nanoflow.app: macOS notifications that open the session on a click, with nothing to install.
// mac-notifier.sh compiles this with osacompile (built into macOS) into ~/.claude/nanoflow/nanoflow.app.
//
// Why an app: macOS sends a click to the app that posted the notification, and osascript's are Script
// Editor's. Posted from this app, a click launches this app again, and it opens the session.
//
//   open -n -g nanoflow.app --args post   post every ~/.claude/nanoflow/pending-*.json (oldest first), then quit;
//                                          the last one posted is what a click opens (last-click.json)
//   (launched by a click: no "post")        run open-session.js on last-click.json's link, then quit
//
// The limit: an applet cannot tell which notification was clicked, so a click opens the newest one's session.
ObjC.import('Foundation')

function run() {
  const me = Application.currentApplication()
  me.includeStandardAdditions = true
  const files = $.NSFileManager.defaultManager
  const dir = `${ObjC.unwrap($.NSHomeDirectory())}/.claude/nanoflow`
  const args = ObjC.deepUnwrap($.NSProcessInfo.processInfo.arguments) || []

  const readJson = path => {
    const text = $.NSString.stringWithContentsOfFileEncodingError(path, $.NSUTF8StringEncoding, null)
    if (text.isNil()) return null
    try { return JSON.parse(ObjC.unwrap(text)) } catch (e) { return null }
  }
  const writeText = (path, text) => $(text).writeToFileAtomicallyEncodingError(path, true, $.NSUTF8StringEncoding, null)
  const quote = text => `'${String(text).replace(/'/g, `'\\''`)}'`
  const isLink = link => /^nanoflow:\/\/open\/[0-9a-f]{16}$/.test(link || '')

  if (args.includes('post')) {
    const names = (ObjC.deepUnwrap(files.contentsOfDirectoryAtPathError(dir, null)) || [])
      .filter(name => /^pending-\d+-[0-9a-f]{16}\.json$/.test(name))
      .sort()
    for (const name of names) {
      // Claimed by a rename: two copies of the app started together never post one twice.
      const claimed = `${dir}/${name}.posting`
      if (!files.moveItemAtPathToPathError(`${dir}/${name}`, claimed, null)) continue
      const note = readJson(claimed)
      files.removeItemAtPathError(claimed, null)
      if (!note || typeof note.title !== 'string' || typeof note.body !== 'string') continue
      me.displayNotification(note.body, { withTitle: note.title })
      if (isLink(note.launch) && typeof note.root === 'string') writeText(`${dir}/last-click.json`, JSON.stringify({ launch: note.launch, root: note.root }))
    }
    // A moment for Notification Center to take it before the app quits.
    delay(0.3)
    return
  }

  const last = readJson(`${dir}/last-click.json`)
  if (!last || !isLink(last.launch) || typeof last.root !== 'string') return
  try {
    me.doShellScript(`/usr/bin/osascript -l JavaScript ${quote(`${last.root}/hooks/open-session.js`)} ${quote(last.launch)}`)
  } catch (e) {
    // Nothing to show it to: the person clicked, the session did not come up.
  }
}
