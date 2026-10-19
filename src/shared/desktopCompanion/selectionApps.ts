export interface CompanionSelectionApp {
  id: string;
  name: string;
  icon?: string;
}

/** An app may have been uninstalled; keep its exclusion readable and removable. */
export function companionSelectionAppFallback(id: string): CompanionSelectionApp {
  const filename = id.split(/[\\/]/).pop() || id;
  const name = /\.(exe|app)$/i.test(filename)
    ? filename.replace(/\.(exe|app)$/i, '')
    : filename.split('.').pop() || filename;
  return { id, name: name ? name.charAt(0).toUpperCase() + name.slice(1) : id };
}
