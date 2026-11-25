import type {CodeArtsLoginSession} from './types';

export type LoginPhase = 'idle' | 'starting' | 'waiting' | 'submitting' | 'exchanging' | 'success' | 'failed';
export interface LoginState {
  phase: LoginPhase;
  login: CodeArtsLoginSession | null;
  error: string;
}
interface LoginApi {
  start: () => Promise<CodeArtsLoginSession>;
  poll: (id: string) => Promise<{done: boolean; success: boolean; error?: string}>;
  callback: (id: string, url: string) => Promise<{accepted: boolean}>;
  cancel: (id: string) => Promise<unknown>;
}

/** One authorization at a time; late responses belong only to their original session. */
export class CodeArtsLoginFlow {
  state: LoginState = {phase: 'idle', login: null, error: ''};
  private generation = 0;
  private opened = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private failures = 0;
  private exchangeDeadline = 0;
  private api: LoginApi;
  private changed: (state: LoginState) => void;
  private success: () => void;
  private errorText: (error: unknown) => string;
  private messages: {expired: string; rejected: string; failed: string};

  constructor(options: {api: LoginApi; changed: (state: LoginState) => void; success: () => void;
    errorText: (error: unknown) => string; messages: {expired: string; rejected: string; failed: string}}) {
    this.api = options.api;
    this.changed = options.changed;
    this.success = options.success;
    this.errorText = options.errorText;
    this.messages = options.messages;
  }

  open() {
    this.close();
    this.opened = true;
    this.publish({phase: 'idle', login: null, error: ''});
  }

  close() {
    if (!this.opened) return;
    this.generation += 1;
    this.opened = false;
    this.clearTimer();
    const login = this.state.login;
    if (login && this.state.phase !== 'success') void this.cancel(login.account_id);
  }

  private async cancel(id: string) {
    try {await this.api.cancel(id);} catch { /* The official flow also expires on its own. */ }
  }

  private publish(state: LoginState) {
    this.state = state;
    if (this.opened) this.changed(state);
  }

  private clearTimer() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private current(generation: number) {
    return this.opened && generation === this.generation;
  }

  private terminal() {
    return this.state.phase === 'success' || this.state.phase === 'failed';
  }

  async start() {
    if (!this.opened || !['idle', 'failed', 'success'].includes(this.state.phase)) return;
    const previous = this.state.login;
    const generation = ++this.generation;
    this.clearTimer();
    this.failures = 0;
    this.exchangeDeadline = 0;
    if (previous && this.state.phase !== 'success') void this.cancel(previous.account_id);
    this.publish({phase: 'starting', login: null, error: ''});
    try {
      const login = await this.api.start();
      if (!this.current(generation)) {void this.cancel(login.account_id); return;}
      this.publish({phase: 'waiting', login, error: ''});
      this.schedule(generation, 1000);
    } catch (error) {
      if (this.current(generation)) this.publish({phase: 'failed', login: null, error: this.errorText(error)});
    }
  }

  private schedule(generation: number, delay = 2500) {
    this.clearTimer();
    this.timer = setTimeout(() => void this.pollOnce(generation), delay);
  }

  // Exposed for behavior tests and a manual status check; polling never overlaps itself.
  private polling = new Set<number>();
  async pollOnce(generation = this.generation) {
    const login = this.state.login;
    if (!login || !this.current(generation) || this.terminal() || this.polling.has(generation)) return;
    const deadline = this.exchangeDeadline || login.expires_at * 1000;
    if (Date.now() >= deadline) {
      this.publish({...this.state, phase: 'failed', error: this.messages.expired});
      void this.cancel(login.account_id);
      return;
    }
    this.polling.add(generation);
    try {
      const result = await this.api.poll(login.account_id);
      if (!this.current(generation) || this.terminal()) return;
      this.failures = 0;
      if (result.done) {
        this.clearTimer();
        this.publish({...this.state, phase: result.success ? 'success' : 'failed',
          error: result.success ? '' : result.error || this.messages.failed});
        if (result.success) this.success();
        return;
      }
    } catch (error) {
      if (!this.current(generation) || this.terminal()) return;
      const status = (error as {response?: {status?: number}}).response?.status;
      this.failures += 1;
      this.publish({...this.state, phase: this.failures >= 3 || [401, 403, 404, 409].includes(status ?? 0)
        ? 'failed' : this.state.phase, error: this.errorText(error)});
    } finally {
      this.polling.delete(generation);
      if (this.current(generation) && !this.terminal()) this.schedule(generation);
    }
  }

  async submit(url: string) {
    if (!this.opened || this.state.phase !== 'waiting' || !this.state.login || !url.trim()) return;
    const login = this.state.login;
    const generation = this.generation;
    // The code may arrive just before link expiry; leave time for the official
    // exchange to finish rather than expiring a callback already in flight.
    this.exchangeDeadline = Math.max(login.expires_at * 1000, Date.now() + 60000);
    this.publish({...this.state, phase: 'submitting', error: ''});
    try {
      const result = await this.api.callback(login.account_id, url.trim());
      if (!this.current(generation) || this.terminal()) return;
      if (result.accepted) {
        this.exchangeDeadline = Date.now() + 60000;
        this.publish({...this.state, phase: 'exchanging', error: ''});
      } else {
        this.exchangeDeadline = 0;
        this.publish({...this.state, phase: 'waiting', error: this.messages.rejected});
      }
    } catch (error) {
      if (!this.current(generation) || this.terminal()) return;
      this.exchangeDeadline = 0;
      const status = (error as {response?: {status?: number}}).response?.status;
      this.publish({...this.state, phase: [401, 403, 404, 409].includes(status ?? 0) ? 'failed' : 'waiting',
        error: this.errorText(error)});
    }
  }
}

/** Only local browser feedback; the official receiver validates and exchanges the callback. */
export function callbackIssue(text: string): 'invalid' | 'missing' | null {
  try {
    const url = new URL(text.trim());
    if (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
        || !url.port || url.username || url.password || url.hash) return 'invalid';
    if (!url.searchParams.get('code')?.trim() && !url.searchParams.get('secret')?.trim()) return 'missing';
    return null;
  } catch {return 'invalid';}
}
