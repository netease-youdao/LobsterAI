/**
 * Search result types
 */

export const SearchEngine = {
  Google: 'google',
  Bing: 'bing',
  Parallel: 'parallel',
  Auto: 'auto',
} as const;
export type SearchEngine = Exclude<typeof SearchEngine[keyof typeof SearchEngine], 'auto'>;
export type SearchEnginePreference = SearchEngine | typeof SearchEngine.Auto;

export interface SearchResult {
  /** Result title */
  title: string;
  /** Result URL */
  url: string;
  /** Text snippet/description */
  snippet: string;
  /** Source engine */
  source: SearchEngine;
  /** Position in results (1-based) */
  position: number;
}

export interface SearchResponse {
  /** Search query */
  query: string;
  /** Engine used for this response */
  engine: SearchEngine;
  /** Search results */
  results: SearchResult[];
  /** Total results found */
  totalResults: number;
  /** Search timestamp */
  timestamp: number;
  /** Time taken in milliseconds */
  duration: number;
  /** Service warnings and local output truncation notices */
  warnings?: string[];
}
