import { invoke, isTauri } from '@tauri-apps/api/core';

/** Mirrors `AppInfo` in src-tauri/src/lib.rs (serde camelCase). */
export interface AppInfo {
  name: string;
  version: string;
  os: string;
  arch: string;
  /** "tauri" when running in the desktop shell, "browser" in `vite dev` / tests. */
  runtime: 'tauri' | 'browser';
}

const BROWSER_APP_INFO: AppInfo = {
  name: 'MeetOps AI',
  version: '0.0.0',
  os: 'unknown',
  arch: 'unknown',
  runtime: 'browser',
};

/**
 * Calls the Rust `app_info` command inside Tauri. Outside Tauri (plain `vite dev`, vitest) it returns a
 * static fallback so the UI can be developed and tested without the Rust toolchain.
 */
export async function getAppInfo(): Promise<AppInfo> {
  if (!isTauri()) return BROWSER_APP_INFO;
  const info = await invoke<Omit<AppInfo, 'runtime'>>('app_info');
  return { ...info, runtime: 'tauri' };
}
