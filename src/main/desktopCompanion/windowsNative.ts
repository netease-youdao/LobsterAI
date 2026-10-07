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
    };
  } catch (error) {
    console.warn('[DesktopCompanion] Windows native helpers are unavailable:', error);
    cached = null;
  }
  return cached;
}
