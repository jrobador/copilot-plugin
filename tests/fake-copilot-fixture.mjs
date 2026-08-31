/**
 * Fake @github/copilot-sdk for tests.
 *
 * Two ways to use it:
 *
 * 1. In-process: construct FakeCopilotClient / FakeCopilotSession directly and
 *    script them with setSessionConfig(), as the unit tests do.
 * 2. As the SDK itself: point COPILOT_PLUGIN_SDK_MODULE at this file and the
 *    plugin's loadSdk() imports it instead of the real package, so the whole
 *    CLI runs end to end without a Copilot login. Behaviour is scripted through
 *    COPILOT_FAKE_CONFIG (JSON) and every call is appended to COPILOT_FAKE_LOG
 *    (JSON lines) so a spawned process can be asserted on afterwards.
 *
 * The surface mirrors what the plugin touches: CopilotClient.start/stop/
 * createSession/resumeSession/getAuthStatus/listModels/getLastSessionId and
 * CopilotSession.on/send/sendAndWait/abort/disconnect. Nothing else.
 */

import fs from "node:fs";

function readEnvConfig() {
  const raw = process.env.COPILOT_FAKE_CONFIG;
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`COPILOT_FAKE_CONFIG is not valid JSON: ${error.message}`);
  }
}

function appendLog(entry) {
  const file = process.env.COPILOT_FAKE_LOG;
  if (!file) return;
  fs.appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, "utf8");
}

/** Read the JSON-lines log a spawned fake wrote. Test helper. */
export function readFakeLog(file) {
  if (!file || !fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

export class FakeCopilotSession {
  constructor(config = {}) {
    this.config = config;
    this.listeners = [];
    this.aborted = false;
    this.disconnected = false;
    this.messages = [];
    this.permissionDecisions = [];
    // The real session exposes the id as a property, not under config.
    this.sessionId = config.sessionId ?? "fake-session";
    this._cannedResponse = config._cannedResponse ?? { data: { content: "Mock response" } };
    this._cannedEvents = config._cannedEvents ?? [];
    // SDK-shaped permission requests to push through onPermissionRequest
    // during sendAndWait, so the policy and the run loop see real traffic.
    this._permissionRequests = config._permissionRequests ?? [];
  }

  /** Mirrors the SDK: returns an unsubscribe function. */
  on(handler) {
    this.listeners.push(handler);
    return () => {
      const index = this.listeners.indexOf(handler);
      if (index !== -1) this.listeners.splice(index, 1);
    };
  }

  _emit(event) {
    for (const handler of this.listeners) {
      handler(event);
    }
  }

  /** Ask the host's permission handler, the way the CLI would mid-turn. */
  requestPermission(request) {
    const handler = this.config.onPermissionRequest;
    const decision = typeof handler === "function" ? handler(request) : { kind: "approve-once" };
    this.permissionDecisions.push({ request, decision });
    appendLog({ call: "permission", sessionId: this.sessionId, request, decision });
    return decision;
  }

  _runTurn(options) {
    this.messages.push(options);
    const prompt = typeof options === "string" ? options : options?.prompt;
    appendLog({ call: "send", sessionId: this.sessionId, prompt, agentMode: options?.agentMode ?? null });
    for (const event of this._cannedEvents) {
      this._emit(event);
    }
    for (const request of this._permissionRequests) {
      this.requestPermission(request);
    }
  }

  async send(options) {
    this._runTurn(options);
  }

  async sendAndWait(options, timeout) {
    this._runTurn(options);
    this.lastTimeout = timeout ?? null;
    return this._cannedResponse;
  }

  async abort() {
    this.aborted = true;
  }

  async disconnect() {
    this.disconnected = true;
  }
}

export class FakeCopilotClient {
  /**
   * Scripting shared by every client in this process, applied at
   * createSession/resumeSession time. Lets a test script the next turn without
   * knowing which cwd key the code under test will use for its client.
   */
  static defaultSessionConfig = {};

  constructor(options = {}) {
    const env = readEnvConfig();
    this.options = options;
    this.started = false;
    this.stopped = false;
    this.sessions = [];
    this.calls = [];
    this.auth = env.auth ?? { isAuthenticated: true, login: "fake-user", authType: "fake", host: "github.com" };
    this.models = env.models ?? [{ id: "gpt-5.4" }, { id: "claude-sonnet-5" }, { id: "claude-opus-5" }, { id: "gpt-5.3-codex" }, { id: "gemini-3.1-pro-preview" }];
    // Session ids the "CLI" still has state for. createSession adds to it;
    // resumeSession of anything else throws, like the real client.
    this.knownSessions = new Set(env.knownSessions ?? []);
    this._sessionConfig = env.session ? translateEnvSession(env.session) : {};
    this.lastSessionId = env.lastSessionId ?? null;
    appendLog({ call: "construct", options });
  }

  /** Script the next sessions: _cannedResponse, _cannedEvents, _permissionRequests, sessionId. */
  setSessionConfig(config) {
    this._sessionConfig = config;
  }

  /** Pretend these sessions exist on disk, so resumeSession(id) succeeds. */
  seedSessions(ids) {
    for (const id of ids) this.knownSessions.add(id);
  }

  async start() {
    this.started = true;
    this.calls.push({ call: "start" });
    appendLog({ call: "start" });
  }

  async stop() {
    this.stopped = true;
    this.calls.push({ call: "stop" });
    appendLog({ call: "stop" });
    return [];
  }

  async forceStop() {
    this.stopped = true;
  }

  async getAuthStatus() {
    this.calls.push({ call: "getAuthStatus" });
    return this.auth;
  }

  async listModels() {
    this.calls.push({ call: "listModels" });
    return this.models;
  }

  async getLastSessionId() {
    return this.lastSessionId ?? this.sessions.at(-1)?.sessionId;
  }

  async createSession(config) {
    const session = new FakeCopilotSession({ ...config, ...FakeCopilotClient.defaultSessionConfig, ...this._sessionConfig });
    if (config?.sessionId) session.sessionId = config.sessionId;
    this.sessions.push(session);
    this.knownSessions.add(session.sessionId);
    this.calls.push({ call: "createSession", sessionId: session.sessionId });
    appendLog({ call: "createSession", sessionId: session.sessionId, config: summarizeConfig(config) });
    return session;
  }

  async resumeSession(sessionId, config) {
    this.calls.push({ call: "resumeSession", sessionId });
    appendLog({ call: "resumeSession", sessionId, known: this.knownSessions.has(sessionId), config: summarizeConfig(config) });
    if (!this.knownSessions.has(sessionId)) {
      throw new Error(`Session ${sessionId} does not exist`);
    }
    const session = new FakeCopilotSession({
      ...config,
      ...FakeCopilotClient.defaultSessionConfig,
      ...this._sessionConfig,
      sessionId
    });
    session.sessionId = sessionId;
    session.resumed = true;
    this.sessions.push(session);
    return session;
  }
}

/** Script the next sessions of every client in this process (see defaultSessionConfig). */
export function scriptFakeSessions(config = {}) {
  FakeCopilotClient.defaultSessionConfig = config;
}

/** COPILOT_FAKE_CONFIG.session uses plain names; map them onto the scripted fields. */
function translateEnvSession(session) {
  const config = {};
  if (session.response !== undefined) {
    config._cannedResponse = typeof session.response === "string" ? { data: { content: session.response } } : session.response;
  }
  if (Array.isArray(session.events)) config._cannedEvents = session.events;
  if (Array.isArray(session.permissionRequests)) config._permissionRequests = session.permissionRequests;
  return config;
}

/** Only what tests assert on; functions and tool objects are reduced to names. */
function summarizeConfig(config) {
  if (!config || typeof config !== "object") return null;
  return {
    sessionId: config.sessionId ?? null,
    model: config.model ?? null,
    reasoningEffort: config.reasoningEffort ?? null,
    systemMessage: config.systemMessage ?? null,
    excludedTools: Array.isArray(config.excludedTools) ? config.excludedTools : [],
    tools: Array.isArray(config.tools) ? config.tools.map((tool) => tool?.name ?? "?") : [],
    hasPermissionHandler: typeof config.onPermissionRequest === "function",
    enableFileChangeTracking: Boolean(config.enableFileChangeTracking)
  };
}

// The name the plugin's loadSdk() destructures from the module.
export { FakeCopilotClient as CopilotClient };
