'use strict';

// Read the picked directory without koffi.view(), which aborts under Electron.
//
// After the user confirms the folder dialog, dsh reads the path that
// IShellItem::GetDisplayName hands back by mapping 32 KB of native memory:
//
//   const bytes = Buffer.from(koffi.view(address, 32768));
//
// koffi.view() builds an external ArrayBuffer over memory outside V8's heap.
// Stock Node allows that; Electron builds V8 with the sandbox enabled, where a
// backing store must live inside the sandbox cage, so koffi's attempt to raise
// an error there ends in `FATAL ERROR: Error::New napi_get_last_error_info` and
// the process aborts (exit 134). Every LobsterAI dsh child runs as
// ELECTRON_RUN_AS_NODE, so the dialog worker died the moment a user actually
// picked a folder — the driver then reported the empty-handed child as
// "win32 folder dialog worker exited before reporting a result". Cancelling
// never touched this path, which is why the dialog itself always looked fine.
//
// koffi marshals an `_Out_ str16 *` out-parameter into a JS string itself,
// stopping at the NUL terminator (no fixed-size read past the allocation) and
// copying into the JS heap (no external view). The shell's buffer is then no
// longer ours to free, but the worker is a single-use process that exits within
// milliseconds of reporting the path, so the few bytes go with it.
//
// Written as a transform rather than a diff: the published bundle's filename
// carries a content hash, and `git apply` silently skips paths under a
// gitignored vendor directory.

const fs = require('fs');
const path = require('path');

const TARGET = ['node_modules', '@deepseek-ai', 'dsh-host-directory-picker-native', 'lib', 'worker.cjs'];

const PROTO_FROM = 'int32 __stdcall DshItemGetDisplayName(void *self, int32 form, _Out_ void **name)';
const PROTO_TO = 'int32 __stdcall DshItemGetDisplayName(void *self, int32 form, _Out_ str16 *name)';

// koffi fills nameOut[0] with the decoded string, so the view helper and the
// free of a pointer we no longer hold both go away.
const READ_FROM = '\t\t\t\t\t\tconst path = readUtf16(koffi, nameOut[0]);\n\t\t\t\t\t\tcoTaskMemFree(nameOut[0]);\n';
const READ_TO = '\t\t\t\t\t\tconst path = nameOut[0];\n';

module.exports = {
  description: 'Directory picker: read the chosen path via koffi string marshalling, not koffi.view (aborts under Electron)',
  apply(runtimeRoot) {
    const filePath = path.join(runtimeRoot, ...TARGET);
    if (!fs.existsSync(filePath)) {
      throw new Error(`dsh-host-directory-picker-native worker is not installed at ${filePath}`);
    }
    const contents = fs.readFileSync(filePath, 'utf8');
    const protoSites = contents.split(PROTO_FROM).length - 1;
    const readSites = contents.split(READ_FROM).length - 1;
    if (protoSites !== 1 || readSites !== 1) {
      throw new Error(
        `worker.cjs: expected one GetDisplayName prototype and one path read, found ${protoSites} and ${readSites}`
      );
    }
    fs.writeFileSync(filePath, contents.split(PROTO_FROM).join(PROTO_TO).split(READ_FROM).join(READ_TO));
    return 'worker.cjs (GetDisplayName out-param + path read)';
  },
};
