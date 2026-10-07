export const CompanionAppCategory = {
  Document: 'document',
  Spreadsheet: 'spreadsheet',
  Presentation: 'presentation',
  Mail: 'mail',
  Browser: 'browser',
  Chat: 'chat',
  Files: 'files',
  Pdf: 'pdf',
  Calendar: 'calendar',
  Notes: 'notes',
  Meeting: 'meeting',
  Code: 'code',
  Password: 'password',
  Self: 'self',
  Other: 'other',
} as const;
export type CompanionAppCategory = typeof CompanionAppCategory[keyof typeof CompanionAppCategory];

const C = CompanionAppCategory;

// macOS bundle identifiers, compared case-insensitively.
const MAC_APPS: Record<string, CompanionAppCategory> = {
  'com.microsoft.word': C.Document,
  'com.kingsoft.wpsoffice.mac': C.Document,
  'com.apple.iwork.pages': C.Document,
  'com.apple.textedit': C.Document,
  'com.microsoft.excel': C.Spreadsheet,
  'com.apple.iwork.numbers': C.Spreadsheet,
  'com.microsoft.powerpoint': C.Presentation,
  'com.apple.iwork.keynote': C.Presentation,
  'com.apple.mail': C.Mail,
  'com.microsoft.outlook': C.Mail,
  'com.netease.macmail': C.Mail,
  'com.tencent.foxmail': C.Mail,
  'com.readdle.smartemail-mac': C.Mail,
  'org.mozilla.thunderbird': C.Mail,
  'com.freron.mailmate': C.Mail,
  'com.google.chrome': C.Browser,
  'com.google.chrome.canary': C.Browser,
  'com.apple.safari': C.Browser,
  'com.apple.safaritechnologypreview': C.Browser,
  'com.microsoft.edgemac': C.Browser,
  'org.mozilla.firefox': C.Browser,
  'company.thebrowser.browser': C.Browser,
  'company.thebrowser.dia': C.Browser,
  'com.brave.browser': C.Browser,
  'com.operasoftware.opera': C.Browser,
  'com.vivaldi.vivaldi': C.Browser,
  'ai.perplexity.comet': C.Browser,
  'com.tencent.xinwechat': C.Chat,
  'com.tencent.weworkmac': C.Chat,
  'com.alibaba.dingtalkmac': C.Chat,
  'com.electron.lark': C.Chat,
  'com.bytedance.lark': C.Chat,
  'com.tencent.qq': C.Chat,
  'com.netease.game.popo': C.Chat,
  'com.tinyspeck.slackmacgap': C.Chat,
  'com.microsoft.teams': C.Chat,
  'com.microsoft.teams2': C.Chat,
  'ru.keepcoder.telegram': C.Chat,
  'org.telegram.desktop': C.Chat,
  'com.hnc.discord': C.Chat,
  'com.apple.mobilesms': C.Chat,
  'com.apple.finder': C.Files,
  'com.cocoatech.pathfinder': C.Files,
  'com.apple.preview': C.Pdf,
  'com.adobe.acrobat.pro': C.Pdf,
  'com.adobe.reader': C.Pdf,
  'com.readdle.pdfexpert-mac': C.Pdf,
  'com.apple.ical': C.Calendar,
  'com.flexibits.fantastical2.mac': C.Calendar,
  'com.apple.notes': C.Notes,
  'notion.id': C.Notes,
  'md.obsidian': C.Notes,
  'com.microsoft.onenote.mac': C.Notes,
  'com.evernote.evernote': C.Notes,
  'net.shinyfrog.bear': C.Notes,
  'com.youdao.note.youdaonotemac': C.Notes,
  'us.zoom.xos': C.Meeting,
  'com.tencent.meeting': C.Meeting,
  'com.netease.webmeeting.mac': C.Meeting,
  'com.cisco.webexmeetingsapp': C.Meeting,
  'cisco-systems.spark': C.Meeting,
  'com.apple.facetime': C.Meeting,
  'com.microsoft.vscode': C.Code,
  'com.todesktop.230313mzl4w4u92': C.Code,
  'com.apple.dt.xcode': C.Code,
  'com.apple.terminal': C.Code,
  'com.googlecode.iterm2': C.Code,
  'dev.warp.warp-stable': C.Code,
  'dev.zed.zed': C.Code,
  'com.sublimetext.4': C.Code,
  'com.apple.passwords': C.Password,
  'com.apple.keychainaccess': C.Password,
  'com.1password.1password': C.Password,
  'com.agilebits.onepassword7': C.Password,
  'com.bitwarden.desktop': C.Password,
  'org.keepassxc.keepassxc': C.Password,
  'com.lobsterai.app': C.Self,
  'com.github.electron': C.Self,
};

const MAC_PREFIXES: Array<[string, CompanionAppCategory]> = [
  ['com.jetbrains.', C.Code],
  ['com.microsoft.edgemac.', C.Browser],
];

// Windows executable names, compared case-insensitively.
const WINDOWS_APPS: Record<string, CompanionAppCategory> = {
  'winword.exe': C.Document,
  'wps.exe': C.Document,
  'wordpad.exe': C.Document,
  'excel.exe': C.Spreadsheet,
  'et.exe': C.Spreadsheet,
  'powerpnt.exe': C.Presentation,
  'wpp.exe': C.Presentation,
  'outlook.exe': C.Mail,
  'olk.exe': C.Mail,
  'hxoutlook.exe': C.Mail,
  'foxmail.exe': C.Mail,
  'mailmaster.exe': C.Mail,
  'thunderbird.exe': C.Mail,
  'chrome.exe': C.Browser,
  'msedge.exe': C.Browser,
  'firefox.exe': C.Browser,
  '360se.exe': C.Browser,
  '360chrome.exe': C.Browser,
  '360chromex.exe': C.Browser,
  'qqbrowser.exe': C.Browser,
  'sogouexplorer.exe': C.Browser,
  'quark.exe': C.Browser,
  '2345explorer.exe': C.Browser,
  'brave.exe': C.Browser,
  'opera.exe': C.Browser,
  'vivaldi.exe': C.Browser,
  'arc.exe': C.Browser,
  'wechat.exe': C.Chat,
  'weixin.exe': C.Chat,
  'wxwork.exe': C.Chat,
  'dingtalk.exe': C.Chat,
  'feishu.exe': C.Chat,
  'lark.exe': C.Chat,
  'qq.exe': C.Chat,
  'popo.exe': C.Chat,
  'slack.exe': C.Chat,
  'ms-teams.exe': C.Chat,
  'teams.exe': C.Chat,
  'telegram.exe': C.Chat,
  'discord.exe': C.Chat,
  'explorer.exe': C.Files,
  'totalcmd64.exe': C.Files,
  'acrobat.exe': C.Pdf,
  'acrord32.exe': C.Pdf,
  'foxitpdfreader.exe': C.Pdf,
  'foxitphantompdf.exe': C.Pdf,
  'foxitpdfeditor.exe': C.Pdf,
  'sumatrapdf.exe': C.Pdf,
  'onenote.exe': C.Notes,
  'notion.exe': C.Notes,
  'obsidian.exe': C.Notes,
  'evernote.exe': C.Notes,
  'yinxiang.exe': C.Notes,
  'youdaonote.exe': C.Notes,
  'zoom.exe': C.Meeting,
  'wemeetapp.exe': C.Meeting,
  'webexmta.exe': C.Meeting,
  'code.exe': C.Code,
  'cursor.exe': C.Code,
  'devenv.exe': C.Code,
  'windowsterminal.exe': C.Code,
  'idea64.exe': C.Code,
  'pycharm64.exe': C.Code,
  'webstorm64.exe': C.Code,
  '1password.exe': C.Password,
  'bitwarden.exe': C.Password,
  'keepass.exe': C.Password,
  'keepassxc.exe': C.Password,
  'lobsterai.exe': C.Self,
  'electron.exe': C.Self,
};

export function normalizeCompanionAppId(appId: string): string {
  const trimmed = appId.trim().toLowerCase();
  // Windows reports a full image path in some code paths; keep the file name.
  const parts = trimmed.split(/[\\/]/);
  return parts[parts.length - 1] ?? trimmed;
}

export function categorizeCompanionApp(appId: string | null | undefined): CompanionAppCategory {
  if (!appId) return C.Other;
  const id = normalizeCompanionAppId(appId);
  const direct = MAC_APPS[id] ?? WINDOWS_APPS[id];
  if (direct) return direct;
  const prefix = MAC_PREFIXES.find(([value]) => id.startsWith(value));
  return prefix ? prefix[1] : C.Other;
}

/** Apps where the selection toolbar stays off unless the user removes them explicitly. */
export const DEFAULT_SELECTION_EXCLUDED_APPS: readonly string[] = [
  // Youdao Dict has its own word lookup; do not stack two toolbars.
  'com.youdao.youdaodict',
  'youdaodict.exe',
  // Selecting file names or canvas objects is not reading text.
  'com.apple.finder',
  'explorer.exe',
  'com.figma.desktop',
  'figma.exe',
  // Remote desktops forward the selection of another machine.
  'com.microsoft.rdc.macos',
  'com.microsoft.rdc.osx.beta',
  'mstsc.exe',
];

export function isCompanionSelectionBlocked(appId: string, excluded: readonly string[]): boolean {
  const id = normalizeCompanionAppId(appId);
  const category = categorizeCompanionApp(id);
  if (category === C.Self || category === C.Password) return true;
  return [...DEFAULT_SELECTION_EXCLUDED_APPS, ...excluded].some(item => normalizeCompanionAppId(item) === id);
}

/** Categories where the companion should stay quiet (no hints, sleepy look). */
export function isCompanionQuietCategory(category: CompanionAppCategory): boolean {
  return category === C.Meeting;
}
