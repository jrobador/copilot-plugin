/**
 * Mock CopilotClient and CopilotSession for testing.
 * Replaces the real @github/copilot-sdk in tests.
 */

export class FakeCopilotSession {
  constructor(config = {}) {
    this.config = config;
    this.listeners = [];
    this.aborted = false;
    this.disconnected = false;
    this.messages = [];
    this._cannedResponse = config._cannedResponse ?? { data: { content: "Mock response" } };
    this._cannedEvents = config._cannedEvents ?? [];
  }

  on(handler) {
    this.listeners.push(handler);
  }

  _emit(event) {
    for (const handler of this.listeners) {
      handler(event);
    }
  }

  async send(options) {
    this.messages.push(options);
    for (const event of this._cannedEvents) {
      this._emit(event);
    }
  }

  async sendAndWait(options) {
    this.messages.push(options);
    for (const event of this._cannedEvents) {
      this._emit(event);
    }
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
  constructor() {
    this.started = false;
    this.stopped = false;
    this.sessions = [];
    this._sessionConfig = {};
  }

  setSessionConfig(config) {
    this._sessionConfig = config;
  }

  async start() {
    this.started = true;
  }

  async stop() {
    this.stopped = true;
  }

  async createSession(config) {
    const session = new FakeCopilotSession({ ...config, ...this._sessionConfig });
    this.sessions.push(session);
    return session;
  }
}
