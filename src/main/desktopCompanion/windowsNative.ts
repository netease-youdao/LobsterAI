/**
 * The only FFI surface of the desktop companion. Windows exposes neither the
 * foreground application nor an in-flight shell drag to Electron, so these few
 * Win32 calls go through koffi. Every caller must treat a null result as
 * "capability unavailable" rather than an error.
 */

const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
const VK_LBUTTON = 0x01;
const KEY_DOWN_MASK = 0x8000;
const MAX_PATH_CHARS = 1024;
// IDC_* system cursor ids and CURSORINFO.flags from WinUser.h.
const IDC_IBEAM = 32513;
const IDC_NON_TEXT = [
  32512, // IDC_ARROW
  32514, // IDC_WAIT
  32515, // IDC_CROSS
  32516, // IDC_UPARROW
  32642, 32643, 32644, 32645, 32646, // IDC_SIZENWSE, IDC_SIZENESW, IDC_SIZEWE, IDC_SIZENS, IDC_SIZEALL
  32648, // IDC_NO
  32649, // IDC_HAND
  32650, // IDC_APPSTARTING
  32651, // IDC_HELP
];
const CURSOR_SHOWING = 0x1;

/** What the pointer looks like: the system I-beam, another system cursor, or one an app drew itself. */
export const WindowsCursorKind = { Text: 'text', System: 'system', Custom: 'custom' } as const;
export type WindowsCursorKind = typeof WindowsCursorKind[keyof typeof WindowsCursorKind];

// SHQueryUserNotificationState results that mean "do not interrupt".
const QUNS_BUSY = 2;
const QUNS_RUNNING_D3D_FULL_SCREEN = 3;
const QUNS_PRESENTATION_MODE = 4;
const QUNS_QUIET_TIME = 6;

export interface WindowsNative {
  /** Lower-case executable name of the foreground window's process, e.g. `winword.exe`. */
  foregroundProcessName(): string | null;
  isLeftButtonDown(): boolean;
  /** Explorer shows a `SysDragImage` window while a shell drag is in flight. */
  isShellDragVisible(): boolean;
  /** Fullscreen app, presentation mode, or Focus quiet hours. */
  isUserBusy(): boolean;
  /** The pointer's current shape; null while it is hidden or cannot be read. */
  cursorKind(): WindowsCursorKind | null;
}

type NativeFunction = (...args: unknown[]) => unknown;

let cached: WindowsNative | null | undefined;

export function loadWindowsNative(): WindowsNative | null {
  if (cached !== undefined) return cached;
  cached = null;
  if (process.platform !== 'win32') return cached;
  try {
    const koffi = require('koffi');
    const user32 = koffi.load('user32.dll');
    const kernel32 = koffi.load('kernel32.dll');
    const shell32 = koffi.load('shell32.dll');
    koffi.alias('LOBSTER_DWORD', 'uint32_t');
    const handle = koffi.pointer('LOBSTER_HANDLE', koffi.opaque());
    koffi.alias('LOBSTER_HWND', handle);

    const getForegroundWindow: NativeFunction = user32.func('LOBSTER_HWND __stdcall GetForegroundWindow()');
    const getWindowThreadProcessId: NativeFunction = user32.func(
      'LOBSTER_DWORD __stdcall GetWindowThreadProcessId(LOBSTER_HWND hWnd, _Out_ LOBSTER_DWORD *lpdwProcessId)',
    );
    const getAsyncKeyState: NativeFunction = user32.func('int16_t __stdcall GetAsyncKeyState(int vKey)');
    const findWindow: NativeFunction = user32.func(
      'LOBSTER_HWND __stdcall FindWindowW(const char16_t *lpClassName, const char16_t *lpWindowName)',
    );
    const isWindowVisible: NativeFunction = user32.func('int __stdcall IsWindowVisible(LOBSTER_HWND hWnd)');
    const openProcess: NativeFunction = kernel32.func(
      'LOBSTER_HANDLE __stdcall OpenProcess(LOBSTER_DWORD dwDesiredAccess, int bInheritHandle, LOBSTER_DWORD dwProcessId)',
    );
    const queryFullProcessImageName: NativeFunction = kernel32.func(
      'int __stdcall QueryFullProcessImageNameW(LOBSTER_HANDLE hProcess, LOBSTER_DWORD dwFlags, _Out_ uint16_t *lpExeName, _Inout_ LOBSTER_DWORD *lpdwSize)',
    );
    // CURSORINFO with its POINT flattened: the same layout, and the handle comes back as a plain integer.
    const cursorInfo = koffi.struct('LOBSTER_CURSORINFO', {
      cbSize: 'uint32_t', flags: 'uint32_t', hCursor: 'uintptr_t', x: 'int32_t', y: 'int32_t',
    });
    const getCursorInfo: NativeFunction = user32.func('int __stdcall GetCursorInfo(_Inout_ LOBSTER_CURSORINFO *pci)');
    const loadCursor: NativeFunction = user32.func('uintptr_t __stdcall LoadCursorW(void *hInstance, uintptr_t lpCursorName)');
    // Shared system cursors: every app that shows the standard I-beam shows this same handle.
    const systemCursor = (id: number) => BigInt(loadCursor(null, id) as number | bigint);
    const textCursor = systemCursor(IDC_IBEAM);
    const nonTextCursors = new Set(IDC_NON_TEXT.map(systemCursor));
    const closeHandle: NativeFunction = kernel32.func('int __stdcall CloseHandle(LOBSTER_HANDLE hObject)');
    const queryNotificationState: NativeFunction = shell32.func(
      'int32_t __stdcall SHQueryUserNotificationState(_Out_ int *pquns)',
    );

    const processNameCache = new Map<number, string>();

    cached = {
      foregroundProcessName() {
        const hwnd = getForegroundWindow();
        if (!hwnd) return null;
        const pidOut: [number | null] = [null];
        if (!getWindowThreadProcessId(hwnd, pidOut) || !pidOut[0]) return null;
        const pid = pidOut[0];
        const known = processNameCache.get(pid);
        if (known) return known;
        const process = openProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if (!process) return null;
        try {
          const buffer = Buffer.alloc(MAX_PATH_CHARS * 2);
          const size: [number] = [MAX_PATH_CHARS];
          if (!queryFullProcessImageName(process, 0, buffer, size)) return null;
          const fullPath = buffer.toString('utf16le', 0, Math.min(size[0], MAX_PATH_CHARS) * 2);
          const name = fullPath.split('\\').pop()?.toLowerCase() || null;
          if (name) {
            if (processNameCache.size > 256) processNameCache.clear();
            processNameCache.set(pid, name);
          }
          return name;
        } finally {
          closeHandle(process);
        }
      },
      isLeftButtonDown() {
        return ((getAsyncKeyState(VK_LBUTTON) as number) & KEY_DOWN_MASK) !== 0;
      },
      isShellDragVisible() {
        const hwnd = findWindow('SysDragImage', null);
        return !!hwnd && !!isWindowVisible(hwnd);
      },
      isUserBusy() {
        const state: [number] = [0];
        if (queryNotificationState(state) !== 0) return false;
        return [QUNS_BUSY, QUNS_RUNNING_D3D_FULL_SCREEN, QUNS_PRESENTATION_MODE, QUNS_QUIET_TIME].includes(state[0]);
      },
      cursorKind() {
        if (!textCursor) return null;
        const info = { cbSize: koffi.sizeof(cursorInfo), flags: 0, hCursor: 0, x: 0, y: 0 };
        if (!getCursorInfo(info) || !(info.flags & CURSOR_SHOWING) || !info.hCursor) return null;
        const cursor = BigInt(info.hCursor);
        if (cursor === textCursor) return WindowsCursorKind.Text;
        return nonTextCursors.has(cursor) ? WindowsCursorKind.System : WindowsCursorKind.Custom;
      },
    };
  } catch (error) {
    console.warn('[DesktopCompanion] Windows native helpers are unavailable:', error);
    cached = null;
  }
  return cached;
}

/** A value from the native helpers; null off Windows, without koffi, or when the call fails. */
export function readWindowsNative<T>(read: (native: WindowsNative) => T | null): T | null {
  const native = loadWindowsNative();
  if (!native) return null;
  try {
    return read(native);
  } catch (error) {
    console.debug('[DesktopCompanion] Windows native read failed:', error);
    return null;
  }
}
