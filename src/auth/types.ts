// The auth connector contract: the functions a connector answers, and the primitives it is given to
// answer them with. A connector written against these runs unchanged on another machine, another
// project and another agent (connectors/auth/README.md).
import type { Platform } from '../core/hold.ts';
import type { RunResult } from '../core/proc.ts';

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface AuthContext {
  // agent-browser in the persona's session, locked and restored. `web` hands back stdout and ends
  // vysu with the call's own exit code when it fails (a bash connector runs under `set -e`);
  // `webTry` never fails and says nothing: the caller reads the code.
  web(persona: string, ...args: string[]): Promise<string>;
  webTry(persona: string, ...args: string[]): Promise<RunResult>;
  // The first visible button among several names: a label differs by language and by version.
  webClickAny(persona: string, ...names: string[]): Promise<boolean>;
  // agent-device on the chosen simulator / emulator, locked; the same two forms.
  mob(platform: Platform, ...args: string[]): Promise<string>;
  mobTry(platform: Platform, ...args: string[]): Promise<RunResult>;
  mobPressIf(platform: Platform, label: string): Promise<boolean>;
  mobPressAny(platform: Platform, labels: string): Promise<boolean>;
  mobPressAll(platform: Platform, labels: string): Promise<void>;
  mobWaitText(platform: Platform, text: string, ms?: number): Promise<boolean>;
  // The text fields read from a capture, boxes in points, top to bottom — for a surface the
  // platform's accessibility cannot read (a login in SafariViewService on iOS 18).
  mobFields(platform: Platform): Promise<Box[]>;
  mobileApp(platform: Platform): string;
  // The app killed and started straight onto its bundle (this owner's Metro, no dev-client launcher),
  // its first screen up and the agent-device session open: where a login starts. From any screen,
  // sheet or viewer the app was left on, it is back on its root. Dies when the app cannot start.
  mobileRelaunch(platform: Platform): Promise<void>;
  // A dev-client sitting on Expo's launcher handed this owner's Metro, then waited for; a no-op
  // anywhere else. What a connector that opens the app itself calls after its `open`.
  mobileLoadBundle(platform: Platform): Promise<void>;
  // Before the app is opened: the device locked, and on Android Metro's port reversed onto it.
  mobilePrepare(platform: Platform): Promise<void>;
  mstateSet(platform: Platform, key: string, value: string): void;
  personaRequire(persona: string): { email: string; password: string };
  personaVar(persona: string, key: string): string;
  cfg(key: string, fallback?: string): string;
  // « Se connecter,Sign in » → the labels, as a human wrote them.
  labels(list: string): string[];
  die(message: string, next?: string): never;
  log(message: string): void;
  // One line under `vysu auth test`, silent the rest of the time.
  step(what: string): void;
  sleep(seconds: number): Promise<void>;
  // The last line of an answer, and the value an `eval` printed (a JSON string, unquoted).
  lastLine(text: string): string;
  value(text: string): string;
}

export interface AuthConnector {
  // One line for `vysu doctor`: which system, which options are set.
  describe(v: AuthContext): string | Promise<string>;
  // The session is open and is the persona's own; return with the page logged in on the url's
  // origin, having printed `logged in: <persona> (<e-mail>) → <url>`.
  webLogin(v: AuthContext, persona: string, url: string): Promise<void>;
  // The API access token of the session as it stands. `undefined` when the connector has none to
  // give — printing nothing is a valid answer, and never an error.
  webToken(v: AuthContext, persona: string): Promise<string | undefined>;
  // The app is installed and may be anywhere; return with it logged in as the persona, on its home,
  // having recorded `mstateSet(platform, 'persona', persona)`.
  mobileLogin(v: AuthContext, platform: Platform, persona: string): Promise<void>;
  // Optional: sign whoever is signed in out, for mlogin. True when it did.
  mobileLogout?(v: AuthContext, platform: Platform): Promise<boolean | void>;
  // Optional: whether someone is signed in on the screen the app is on, looked at in a second or two
  // without moving it (a control only a signed-in app draws). With vysu's record of the persona, it
  // lets `mlogin` skip a login the device already holds.
  mobileSignedIn?(v: AuthContext, platform: Platform): Promise<boolean>;
}
