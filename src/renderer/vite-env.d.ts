/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_APP_TITLE: string
  readonly VITE_LOBSTER_WEB_API_BASE?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
} 
