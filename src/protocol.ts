// What the Arcade helper (Link's crates/arcade-helper, bridge.rs) answers. The extension knows no app's actions:
// every menu entry, form and result comes from these messages.

/** The native messaging host both browser families look up. */
export const HOST_NAME = 'dev.arcade.helper';
/** The extension's ID in Chromium browsers, fixed by CHROME_EXTENSION_KEY (the helper answers only this ID). */
export const CHROME_EXTENSION_ID = 'dbghmpdffbagedciechjkmcmjahcdmad';
/** The public key that goes into the Chromium manifest as `key` (Link's ids.rs). */
export const CHROME_EXTENSION_KEY =
  'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAlLor9dPJ2mBjMJesrDZ0ggDEh50Edz0kl/xEuLb4yLxNy5IFn1pD7xs0yaaUjFijeJDOA93T+eyfZjVCp1m8C6D8UUdLODZNz8FXd69gIdqnZ91Ctdqj+NP2l/vG7XOr9ceg8L/bPSpvMsFyolQTQ+e6FuR/Cr/KLmaBpNlvXBorZVlJT+8ZZW2frjbIutXqXAbgkCy7ejaqtO86hzVMFF68qOh4vPQQa5BvHbHNbgRjFy0/3dIGi6yDqEhIwMJLdG8jXTpI4AvUOeCmCo5b7UItAPfo+MKWr+5H+5qKuZtUj0AIVKwXejsIEf/v0jNA9qc5fbkSSkMB6TB/N7DoMwIDAQAB';
/** The add-on ID in Firefox-family browsers. */
export const FIREFOX_ADDON_ID = '{77b33901-3817-4946-8df0-1914a2850188}';
/** Where to get Arcade Tools, which installs the helper. */
export const TOOLS_RELEASES = 'https://github.com/qa-p1/Arcade-tools/releases';

/** The largest file the extension hands over as bytes (the helper's MAX_DATA). */
export const MAX_DATA = 48 * 1024 * 1024;
/** The longest the helper waits in one `jobs` call (resident.rs MAX_WAIT). */
export const MAX_WAIT_MS = 25_000;

export type Surface =
  | 'browser-image'
  | 'browser-link'
  | 'browser-video'
  | 'browser-audio'
  | 'browser-selection'
  | 'browser-page'
  | 'browser-pdf'
  | 'browser-download'
  | 'palette';

/** One thing the user picked, as `offers` takes it: its Link type and what else is known. */
export interface Item {
  type: string;
  size?: number;
  hints?: string[];
}

/** What `run` takes: text (links, pages, selections), a finished download's path, or bytes the extension fetched. */
export type BrowserItem =
  | { type: string; text: string; hints?: string[] }
  | { type: string; path: string }
  | { type: string; name: string; data: string };

export interface Offer {
  app: string;
  action: string;
  title: string;
  group?: string;
  rank: number;
  /** False: shown greyed out with `reason`, or as an install entry when `install` names an app. */
  enabled: boolean;
  reason?: string;
  /** What to install first: `engine:ffmpeg` or `app:arcade.box`. */
  install?: string;
  job?: string;
  preferred?: boolean;
  /** Another app's way of doing a job that has a default. */
  other?: boolean;
  choose?: boolean;
  pinned?: boolean;
  oneClick?: boolean;
  appName: string;
  /** `<app>/<action>`. */
  ref: string;
}

export interface Choice {
  value: string | number | boolean;
  label: string;
}

export interface Control {
  key: string;
  label: string;
  /** text, number, select, toggle, password, directory, file, color; unknown types are skipped. */
  type: string;
  default?: unknown;
  choices?: Choice[];
  minimum?: number;
  maximum?: number;
  step?: number;
  placeholder?: string;
  help?: string;
  showWhen?: { key: string; equals?: unknown; oneOf?: unknown[] };
  advanced?: boolean;
}

export interface OptionsForm {
  version: number;
  input?: { kind: string; label?: string; minItems?: number; maxItems?: number };
  controls: Control[];
}

export interface FormAnswer {
  title: string;
  app: string;
  options?: OptionsForm | null;
  oneClick: boolean;
}

export interface AppInfo {
  id: string;
  name: string;
  installed: boolean;
  releases?: string;
}

export interface Hello {
  helper: string;
  browser: string;
  apps: AppInfo[];
}

export type JobStatus = 'queued' | 'ask' | 'running' | 'done' | 'failed' | 'cancelled';

export interface Job {
  id: number;
  reference: string;
  title: string;
  app: string;
  status: JobStatus;
  fraction?: number;
  message?: string;
  inputs: number;
  files?: string[];
  texts?: string[];
  folder?: string;
  origin: string;
}

export interface JobsAnswer {
  revision: number;
  jobs: Job[];
}

export interface Prefs {
  defaults: Record<string, string>;
  hidden: string[];
  pinned: string[];
  outputFolder?: string;
  askWhere?: boolean;
}

export function isFinished(job: Pick<Job, 'status'>): boolean {
  return job.status === 'done' || job.status === 'failed' || job.status === 'cancelled';
}
