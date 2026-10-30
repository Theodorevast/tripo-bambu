// Tripo 中转地址：构建时在 .env 里设 VITE_TRIPO_PROXY=https://example.com/api/tripo；不设时用同源的 /api/tripo（api.ts 的 defaultTripoBase）
interface ImportMetaEnv {
  readonly VITE_TRIPO_PROXY?: string;
}
