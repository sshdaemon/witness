import type { McpServer } from '@modelcontextprotocol/server';
import type { BrowserContext, Page } from 'playwright';

/**
 * Filled in by the app through module augmentation (`declare module`), so its tools keep literal
 * env, app and actor names without the engine taking type parameters everywhere.
 */
// oxlint-disable-next-line typescript/no-empty-interface, typescript/no-empty-object-type
export interface Register {}

type Registered<K extends string, Fallback> = Register extends Record<K, infer T> ? T : Fallback;

export type EnvName = Registered<'env', string>;
export type AppName = Registered<'app', string>;
export type ActorName = Registered<'actor', string>;
/** What a session can create, keyed by kind, with what each record must remember to remove it. */
export type Kinds = Registered<'kinds', Record<string, object>>;
export type Kind = keyof Kinds & string;
/** What the app keeps per session beyond what the engine keeps. */
export type SessionState = Registered<'state', Record<string, unknown>>;

export type PageInfo = { kind: string; url: string; params?: Record<string, string> };
export type Identity = { email: string | null; uid: string | null };
/** The git build an app of the stack serves, recorded with the run. */
export type Build = { branch: string | null; sha: string; dirty: boolean };
export type Builds = Partial<Record<string, Build>>;

/** One *_cleanup tool and the kinds whose records must be gone before it runs. */
export type CleanupStep = { kind: Kind; tool: string; what: string; after: Kind[] };

/** Calls a tool the way the runner does. */
export type ToolCaller = (
  name: string,
  args: Record<string, unknown>,
) => Promise<{ isError: boolean; out: { data?: Record<string, unknown> } }>;

/** What a hook sees of the session. */
export type AppSession = {
  readonly env: EnvName;
  readonly state: SessionState;
  handle(actor: ActorName, app: AppName): { page: Page };
};

export type AppDefinition = {
  /** The MCP server's name, also the prefix of its log lines. */
  name: string;
  /** The app's checkout: saved sign-ins live under it, and its worker and runner run there. */
  root: string;
  instructions: string;
  envs: readonly [EnvName, ...EnvName[]];
  apps: readonly [AppName, ...AppName[]];
  actors: readonly [ActorName, ...ActorName[]];
  /** The app login, goto and viewport_set open when none is given. */
  defaultApp: AppName;
  /** Ticket or pull request ids as the app's team writes them, for tool descriptions. */
  ticketExamples: readonly [string, ...string[]];
  /** Wording for the engine's own tools. */
  describe: { actor: string; app: string; env: string; cleanupAll: string };
  defaultEnv(): EnvName;
  /** The origin of an app in an environment; throws when it is not a host of that environment. */
  origin(env: EnvName, app: AppName): string;
  /** The test account an actor must be signed in as, when one is configured. */
  actorEmail(actor: ActorName, env: EnvName): string | undefined;
  /** The app's own hosts: their data requests are logged, and outside env they are refused. */
  isOwnHost(host: string): boolean;
  isEnvHost(env: EnvName, host: string): boolean;
  recognise(app: AppName, url: string): PageInfo;
  /** The page kind a rejected saved session lands on. */
  loginPageKind: string;
  gotoAllowed: Record<AppName, RegExp[]>;
  readIdentity(page: Page): Promise<Identity | null>;
  /** The one-time command a person runs to save a sign-in, and where. */
  bootstrap: { command(actor: ActorName, app: AppName, env: EnvName): string; runIn: string };
  /** The signed-out visitor: the app it opens and what its context needs first (gate cookies). */
  visitor: {
    app: AppName;
    prepare?(context: BrowserContext, env: EnvName): Promise<void>;
    /** Why a visitor may land on another host, and what to do. */
    redirectHint(env: EnvName): string;
  };
  newState(): SessionState;
  cleanupOrder: readonly CleanupStep[];
  registerTools(server: McpServer): void;
  hooks?: {
    /** Run when a session starts: the builds to record and anything the caller should know. */
    sessionStart?(env: EnvName): Promise<{ builds: Builds; notices: string[] }>;
    /** Run before every tool; throws to refuse the call. */
    beforeTool?(session: AppSession | undefined, args: unknown): void;
    /** Run before an actor's context closes; throws to refuse. */
    beforeLogout?(session: AppSession, actor: ActorName, app: AppName): void;
    /** Run before the browsers close; what it returns is added to session_end's answer. */
    beforeSessionEnd?(
      session: AppSession,
    ): Promise<{ data?: Record<string, unknown>; notices?: string[] } | void>;
  };
  runner?: {
    /** Case file calls the runner handles by waiting: how many milliseconds, given the args. */
    waits?: Record<string, (args: Record<string, unknown>, now: Date) => number>;
    /**
     * What a tool's result leaves for later calls: {{NAME}} holds the last value, and a list's
     * {{NAME1}}, {{NAME2}} and so on each value in turn.
     */
    capture?: Record<string, { name: string; field: string; list?: boolean }[]>;
    /**
     * Tools that change state every lane shares, with the `uses` value a case calling them must
     * declare so no other lane runs beside it.
     */
    sharedState?: Record<string, string>;
    /**
     * The builds the stack serves now, asked through the tools, so cases passed on other builds
     * run again; undefined where builds are not known.
     */
    currentBuilds?(env: EnvName, call: ToolCaller): Promise<Builds | undefined>;
  };
};

let current: AppDefinition | undefined;

export function setApp(definition: AppDefinition) {
  current = definition;
}

export function app(): AppDefinition {
  if (!current) throw new Error('No app is set: call setApp with the app definition first.');
  return current;
}
