import { McpRegistryEntry } from '../types/mcp';

/**
 * Built-in MCP server registry.
 * These are popular, mainstream MCP servers that users can install with one click.
 * Each entry is a template — the user fills in required config (API keys, paths)
 * before it is saved to the database.
 */
export const mcpRegistry: McpRegistryEntry[] = [
  // ── Search ──────────────────────────────────────────────
  {
    id: 'tavily',
    name: 'Tavily',
    descriptionKey: 'mcpDesc_tavily',
    category: 'search',
    categoryKey: 'mcpCategorySearch',
    transportType: 'stdio',
    command: 'npx',
    defaultArgs: ['-y', 'tavily-mcp@latest'],
    requiredEnvKeys: ['TAVILY_API_KEY'],
  },

  // ── Developer Tools ─────────────────────────────────────
  {
    id: 'github',
    name: 'GitHub',
    descriptionKey: 'mcpDesc_github',
    category: 'developer',
    categoryKey: 'mcpCategoryDeveloper',
    transportType: 'stdio',
    command: 'npx',
    defaultArgs: ['-y', '@modelcontextprotocol/server-github'],
    requiredEnvKeys: ['GITHUB_PERSONAL_ACCESS_TOKEN'],
  },
  {
    id: 'gitlab',
    name: 'GitLab',
    descriptionKey: 'mcpDesc_gitlab',
    category: 'developer',
    categoryKey: 'mcpCategoryDeveloper',
    transportType: 'stdio',
    command: 'npx',
    defaultArgs: ['-y', '@modelcontextprotocol/server-gitlab'],
    requiredEnvKeys: ['GITLAB_PERSONAL_ACCESS_TOKEN'],
    optionalEnvKeys: ['GITLAB_API_URL'],
  },
  {
    id: 'context7',
    name: 'Context7',
    descriptionKey: 'mcpDesc_context7',
    category: 'developer',
    categoryKey: 'mcpCategoryDeveloper',
    transportType: 'stdio',
    command: 'npx',
    defaultArgs: ['-y', '@upstash/context7-mcp@latest'],
  },

  // ── Productivity ────────────────────────────────────────
  {
    id: 'google-drive',
    name: 'Google Drive',
    descriptionKey: 'mcpDesc_google_drive',
    category: 'productivity',
    categoryKey: 'mcpCategoryProductivity',
    transportType: 'stdio',
    command: 'npx',
    defaultArgs: ['-y', '@modelcontextprotocol/server-gdrive'],
    optionalEnvKeys: ['GDRIVE_CREDENTIALS_PATH'],
  },
  {
    id: 'gmail',
    name: 'Gmail',
    descriptionKey: 'mcpDesc_gmail',
    category: 'productivity',
    categoryKey: 'mcpCategoryProductivity',
    transportType: 'stdio',
    command: 'npx',
    defaultArgs: ['-y', '@gongrzhe/server-gmail-autoauth-mcp'],
    requiredEnvKeys: ['GMAIL_CLIENT_ID', 'GMAIL_CLIENT_SECRET', 'GMAIL_REDIRECT_URI'],
  },
  {
    id: 'google-calendar',
    name: 'Google Calendar',
    descriptionKey: 'mcpDesc_google_calendar',
    category: 'productivity',
    categoryKey: 'mcpCategoryProductivity',
    transportType: 'stdio',
    command: 'npx',
    defaultArgs: ['-y', '@cocal/google-calendar-mcp'],
    requiredEnvKeys: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REDIRECT_URI'],
  },
  {
    id: 'notion',
    name: 'Notion',
    descriptionKey: 'mcpDesc_notion',
    category: 'productivity',
    categoryKey: 'mcpCategoryProductivity',
    transportType: 'stdio',
    command: 'npx',
    defaultArgs: ['-y', '@notionhq/notion-mcp-server'],
    requiredEnvKeys: ['OPENAPI_MCP_HEADERS'],
  },
  {
    id: 'slack',
    name: 'Slack',
    descriptionKey: 'mcpDesc_slack',
    category: 'productivity',
    categoryKey: 'mcpCategoryProductivity',
    transportType: 'stdio',
    command: 'npx',
    defaultArgs: ['-y', '@modelcontextprotocol/server-slack'],
    requiredEnvKeys: ['SLACK_BOT_TOKEN', 'SLACK_TEAM_ID'],
  },
  {
    id: 'todoist',
    name: 'TodoList',
    descriptionKey: 'mcpDesc_todoist',
    category: 'productivity',
    categoryKey: 'mcpCategoryProductivity',
    transportType: 'stdio',
    command: 'npx',
    defaultArgs: ['-y', 'todoist-mcp@latest'],
    requiredEnvKeys: ['TODOIST_API_TOKEN'],
  },

  // ── Browser ─────────────────────────────────────────────
  {
    id: 'playwright',
    name: 'Playwright',
    descriptionKey: 'mcpDesc_playwright',
    category: 'browser',
    categoryKey: 'mcpCategoryBrowser',
    transportType: 'stdio',
    command: 'npx',
    defaultArgs: ['-y', '@executeautomation/playwright-mcp-server'],
  },

  // ── Design ──────────────────────────────────────────────
  {
    id: 'canva',
    name: 'Canva',
    descriptionKey: 'mcpDesc_canva',
    category: 'design',
    categoryKey: 'mcpCategoryDesign',
    transportType: 'stdio',
    command: 'npx',
    defaultArgs: ['-y', '@iflow-mcp/mattcoatsworth-canva-mcp-server'],
    requiredEnvKeys: ['CANVA_API_KEY'],
  },

  // ── Data & API ──────────────────────────────────────────
  {
    id: 'firecrawl',
    name: 'Firecrawl',
    descriptionKey: 'mcpDesc_firecrawl',
    category: 'data-api',
    categoryKey: 'mcpCategoryDataApi',
    transportType: 'stdio',
    command: 'npx',
    defaultArgs: ['-y', 'firecrawl-mcp@latest'],
    requiredEnvKeys: ['FIRECRAWL_API_KEY'],
  },
  {
    id: 'fetch',
    name: 'Fetch',
    descriptionKey: 'mcpDesc_fetch',
    category: 'data-api',
    categoryKey: 'mcpCategoryDataApi',
    transportType: 'stdio',
    command: 'npx',
    defaultArgs: ['-y', '@modelcontextprotocol/server-fetch'],
  },
];

/**
 * All available categories with their i18n keys.
 */
export const mcpCategories = [
  { id: 'all', key: 'mcpCategoryAll' },
  { id: 'search', key: 'mcpCategorySearch' },
  { id: 'developer', key: 'mcpCategoryDeveloper' },
  { id: 'productivity', key: 'mcpCategoryProductivity' },
  { id: 'browser', key: 'mcpCategoryBrowser' },
  { id: 'design', key: 'mcpCategoryDesign' },
  { id: 'data-api', key: 'mcpCategoryDataApi' },
] as const;
