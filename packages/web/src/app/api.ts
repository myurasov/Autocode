/*
 * The web UI's typed client for the Autocode REST API: the shapes of its
 * answers, one method per call, and every failure (a 15 s timeout included)
 * turned into an ApiError that carries the server's message when it sent one.
 */

import {
  HttpClient,
  HttpErrorResponse,
  HttpHeaders,
  HttpParams,
} from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom, type Observable, TimeoutError, timeout } from 'rxjs';

export type TokenKind = 'admin' | 'consumer' | 'session';
export type SettingValue = string | number | boolean;

export interface Info {
  id: string;
  version: string;
}

export interface WhoAmI {
  kind: TokenKind;
  session?: string;
}

// An agent's error state: its last turn failed (tier 0b3).
export interface AgentError {
  // OpenCode's error type, like provider.internal, or "failed"
  type: string;
  // when the streak of failures started, and the last failure
  since: string;
  at: string;
  // the retries sent so far, and when the next one comes
  retries: number;
  next_retry: string | null;
  // false for failures that come back the same way: not retried
  retryable: boolean;
}

export interface Agent {
  id: string;
  // false for an unregistered agent (its spend kept), listed on request
  registered?: boolean;
  description: string;
  // idle, working, paused, offline or error
  status: string;
  last_active: string;
  session?: string;
  host?: string;
  machine?: string;
  directory?: string;
  registered_at?: string;
  // Who paused its injections: '' (nobody), 'owner', 'stop-all' or 'cap'.
  paused?: string;
  idle_since?: string | null;
  last_outcome?: string | null;
  // While its turns fail (also when paused or offline).
  error?: AgentError | null;
  // Its spend and context (tier 0g; the owner's view only), and its last
  // step's provider/model.
  cost?: CostNumbers;
  model?: string | null;
}

/*
 * An agent's spend and context (tier 0g): today and in total, the daily cap
 * and what is left of it today, the last step's context, the model's window,
 * the compaction threshold in tokens and the context's share of it (a
 * percentage); null where there is none.
 */
export interface CostNumbers {
  today_usd: number;
  total_usd: number;
  daily_usd: number | 'off';
  left_usd: number | null;
  context: number | null;
  context_limit: number | null;
  compact_at: number | null;
  context_share: number | null;
}

// One agent on the Costs page: registered, or gone with its spend kept.
export interface AgentCost extends CostNumbers {
  agent: string;
  registered: boolean;
  // its status, or unregistered
  status: string;
  machine?: string;
  model?: string | null;
  // its last 7 days, oldest first, today last (up to 7: from its first day;
  // none if it never spent)
  week: CostDay[];
}

// One day's spend.
export interface CostDay {
  day: string;
  usd: number;
}

// Every agent's spend, today's date, the zone days are counted in, and the
// totals of what is listed.
export interface CostsView {
  day: string;
  // the server's time when it answered
  time: string;
  timezone: string;
  // the days Total counts back (null: all time)
  days: number | null;
  agents: AgentCost[];
  totals: { agents: number; today_usd: number; total_usd: number };
}

// One agent's spend per day, newest first.
export interface CostDays {
  agent: string;
  registered: boolean;
  day: string;
  timezone: string;
  cost: CostNumbers;
  days: { day: string; usd: number; steps: number }[];
}

/*
 * A job (tier 0f): a fresh agent run on a host (an OpenCode folder of a
 * machine) with a model and a prompt, on a trigger or when asked; its result
 * goes to `to` (owner, an agent or a pattern).
 */
export interface Job {
  name: string;
  description: string;
  host: string;
  machine: string | null;
  directory: string | null;
  online: boolean;
  model: string;
  variant?: string;
  agent?: string;
  prompt: string;
  // every 30m, at <ISO>, cron "..." zone, fire-only
  trigger: string;
  next: string | null;
  to: string;
  // a run's time limit, like 1h
  timeout: string;
  // a run's cap in dollars, or off
  run_usd: number | 'off';
  delete_session: boolean;
  last_run: { id: string; state: string; started: string } | null;
  created_at: string;
  updated_at: string;
}

// A job as the owner sets it.
export interface JobInput {
  host: string;
  model: string;
  prompt: string;
  trigger: string;
  to?: string;
  description?: string;
  variant?: string;
  agent?: string;
  timeout?: string;
  run_usd?: number | 'off';
  delete_session?: boolean;
}

// A run of a job, newest first.
export interface Run {
  id: string;
  job: string;
  // owner, schedule, ask, or the agent that started it
  by: string;
  // the text the starter added to the prompt
  text?: string;
  session: string | null;
  state: 'starting' | 'running' | 'succeeded' | 'failed' | 'skipped';
  // why it failed or was skipped
  reason: string | null;
  result: string | null;
  cost: number;
  started: string;
  ended: string | null;
  // a failed run's session, kept until the owner deletes it
  session_kept: boolean;
  ask?: string;
}

// A lock or semaphore (tier 0c): its capacity (1: a mutex), the agents that
// hold it (until when) and the ones in its queue, in order.
export interface LockHolder {
  agent: string;
  since: string;
  expires: string;
  ttl: string;
}

export interface LockWaiter {
  agent: string;
  // 1: the next to hold it
  position: number;
  since: string;
  ttl: string;
}

export interface Lock {
  name: string;
  max: number;
  created_at: string;
  holders: LockHolder[];
  queue: LockWaiter[];
}

// A history entry: a server event, newest first by time, then ID.
export interface HistoryEntry {
  id: number;
  at: string;
  kind: string;
  agent?: string;
  host?: string;
  session?: string;
  data: Record<string, unknown>;
}

export interface HistoryKind {
  kind: string;
  count: number;
}

// A page of the history: an agent pattern, a kind (or a prefix like wake.*),
// only entries older than before (an entry's ID), at most limit of them.
export interface HistoryQuery {
  match?: string;
  kind?: string;
  before?: number;
  limit?: number;
}

export interface Host {
  id: string;
  machine: string;
  directory: string;
  online: boolean;
  instance: string;
  opencode_version: string;
  plugin_version: string;
  // The OpenCode process it runs in: service, serve, run, tui, ... ('' when
  // its plugin did not say).
  process_kind: string;
  process_pid: number | null;
  // Whether the plugin can set its sessions' shell values (null when its
  // plugin did not say).
  shell_values: boolean | null;
  first_seen: string;
  last_seen: string;
}

export interface Wake {
  agent: string;
  name: string;
  text: string;
  trigger: string;
  check: string | null;
  next: string | null;
  // when it falls due: `next` for timed wakes, for an idle one when it does
  // if the session stays idle (the review of 0b2)
  due?: string | null;
  set_by: string;
  created_at: string;
  updated_at: string;
  last_fired_at: string | null;
  check_failures: number;
}

// A wake as set: it has no end (the owner, 2026-11-07).
export interface WakeInput {
  text: string;
  trigger: string;
  check?: string;
}

// A message: always text (the owner, 2026-11-07).
export interface Message {
  id: string;
  send_id: string;
  from: string;
  to: string;
  subject: string;
  reply_to: string | null;
  size: number;
  // A text message's first 100 characters (the owner's list only).
  preview?: string;
  // queued, then read (the owner, 2026-11-09: one state, however it got
  // there), or dropped: its agent unregistered first
  state: 'queued' | 'read' | 'dropped';
  created_at: string;
  read_at: string | null;
  // how it was read: in a prompt, into a running turn, by the agent's read or
  // wait, or (the owner's) when its Inbox item was answered or closed
  read_via: 'prompt' | 'steer' | 'read' | 'wait' | 'inbox' | null;
}

// A message whole, as the owner reads it: its text.
export interface FullMessage extends Message {
  text: string;
}

export interface Outgoing {
  to: string | string[];
  subject?: string;
  text: string;
}

export interface Sent {
  send_id: string;
  recipients: string[];
  messages: { id: string; to: string }[];
}

// What an agent's turn waits for (tier 0d): an "ask".
export type AskKind = 'question' | 'permission' | 'approval';

export interface AskQuestion {
  question: string;
  options: string[];
  // more than one option may be chosen
  multiple: boolean;
}

/*
 * An item of the owner's inbox: a message to the owner, an alert, or an ask
 * (a question, a permission prompt or an approval), oldest first.
 */
export interface InboxItem {
  id: string;
  kind: 'message' | 'alert' | AskKind;
  agent: string | null;
  message_id?: string | null;
  title: string;
  body?: string;
  created_at: string;
  closed_at?: string | null;
  // a message's answer (its text); an ask's (its decision, option, text...)
  answer?: unknown;
  // An ask's: who it went to (owner, agent:<id>; auto or approve when it was
  // answered at once), notes (an agent could not answer), state, expiry.
  routed?: string;
  notes?: string[];
  state?: string;
  expires?: string | null;
  // a question's questions
  questions?: AskQuestion[];
  // a permission's action, resources and message
  action?: string;
  resources?: string[];
  message?: string | null;
  decisions?: string[];
  // an approval's text and options
  text?: string;
  options?: string[];
  // who answered a closed ask
  by?: string | null;
}

// An ask's answer: a question's text (one question) or answers (one per
// question), a permission's decision (and a reason to reject), an approval's
// decision (and an option, a note).
export type AskAnswer =
  | { text: string }
  | { answers: string[] }
  | { decision: 'once' | 'always' | 'reject'; text?: string }
  | { decision: 'approve' | 'reject'; option?: string; text?: string };

export interface SettingDef {
  kind: string;
  scope: 'agent' | 'server';
  default: SettingValue;
  values?: string[];
  help: string;
}

export interface Rule {
  match: string;
  settings: Record<string, SettingValue>;
}

export interface SettingsView {
  defaults: Record<string, SettingValue>;
  server: Record<string, SettingValue>;
  rules: Rule[];
  agents: Record<string, Record<string, SettingValue>>;
  schema: Record<string, SettingDef>;
}

export interface ResolvedSettings {
  agent: string;
  values: Record<string, SettingValue>;
  sources: Record<string, string>;
}

export interface SettingsChange {
  server?: Record<string, SettingValue | null>;
  rules?: Rule[];
  agents?: Record<string, Record<string, SettingValue | null> | null>;
}

// An API failure, with the server's own message when it sent one.
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

// Every call gives up after this long.
export const API_TIMEOUT_MS = 15_000;

export function toApiError(err: unknown): ApiError {
  if (err instanceof ApiError) return err;
  if (err instanceof TimeoutError)
    return new ApiError(
      0,
      'timeout',
      `The server did not answer within ${API_TIMEOUT_MS / 1000} s.`,
    );
  if (err instanceof HttpErrorResponse) {
    const body = err.error?.error;
    if (body && typeof body.message === 'string')
      return new ApiError(
        err.status,
        String(body.code ?? 'error'),
        body.message,
      );
    if (err.status === 0)
      return new ApiError(0, 'unreachable', 'The server did not answer.');
    return new ApiError(
      err.status,
      'http',
      `The server answered ${err.status} ${err.statusText ?? ''}`.trim(),
    );
  }
  return new ApiError(
    0,
    'error',
    err instanceof Error ? err.message : String(err),
  );
}

export function errorText(err: unknown): string {
  return toApiError(err).message;
}

const path = (id: string) => encodeURIComponent(id);

// The Autocode REST API, at /v1 on the server that serves this app.
// authInterceptor adds the token.
@Injectable({ providedIn: 'root' })
export class Api {
  private readonly http = inject(HttpClient);

  private async call<T>(request: Observable<T>): Promise<T> {
    try {
      return await firstValueFrom(request.pipe(timeout(API_TIMEOUT_MS)));
    } catch (err) {
      throw toApiError(err);
    }
  }

  info(): Promise<Info> {
    return this.call(this.http.get<Info>('/v1/info'));
  }

  // With a token, checks that token instead of the signed-in one.
  whoami(token?: string): Promise<WhoAmI> {
    const headers = token
      ? new HttpHeaders({ Authorization: `Bearer ${token}` })
      : undefined;
    return this.call(this.http.get<WhoAmI>('/v1/whoami', { headers }));
  }

  // Registered agents; with `unregistered` the gone ones (with spend) too.
  async agents(match?: string, unregistered = false): Promise<Agent[]> {
    let params = new HttpParams();
    if (match?.trim()) params = params.set('match', match.trim());
    if (unregistered) params = params.set('unregistered', '1');
    return (
      await this.call(
        this.http.get<{ agents: Agent[] }>('/v1/agents', { params }),
      )
    ).agents;
  }

  async setDescription(id: string, description: string): Promise<Agent> {
    return (
      await this.call(
        this.http.patch<{ agent: Agent }>(`/v1/agents/${path(id)}`, {
          description,
        }),
      )
    ).agent;
  }

  unregister(id: string): Promise<{ unregistered: string }> {
    return this.call(
      this.http.delete<{ unregistered: string }>(`/v1/agents/${path(id)}`),
    );
  }

  rotateToken(
    id: string,
  ): Promise<{ rotated: boolean; agent: string; session: string }> {
    return this.call(
      this.http.post<{ rotated: boolean; agent: string; session: string }>(
        `/v1/agents/${path(id)}/token/rotate`,
        {},
      ),
    );
  }

  // A retry of an agent's failed turn now (tier 0b3).
  async retry(id: string): Promise<Agent> {
    return (
      await this.call(
        this.http.post<{ agent: Agent }>(`/v1/agents/${path(id)}/retry`, {}),
      )
    ).agent;
  }

  // The jobs (tier 0f), by name.
  async jobs(): Promise<Job[]> {
    return (await this.call(this.http.get<{ jobs: Job[] }>('/v1/jobs'))).jobs;
  }

  // Sets a job, or replaces the one of that name.
  async setJob(name: string, job: JobInput): Promise<Job> {
    return (
      await this.call(
        this.http.put<{ job: Job }>(`/v1/jobs/${path(name)}`, job),
      )
    ).job;
  }

  // Deletes a job; its runs' history stays.
  deleteJob(name: string): Promise<{ deleted: string }> {
    return this.call(
      this.http.delete<{ deleted: string }>(`/v1/jobs/${path(name)}`),
    );
  }

  // Starts a run now, with text added to its prompt; refused while one runs.
  async runJob(name: string, text?: string): Promise<Run> {
    return (
      await this.call(
        this.http.post<{ run: Run }>(
          `/v1/jobs/${path(name)}/run`,
          text ? { text } : {},
        ),
      )
    ).run;
  }

  // The runs, newest first: every job's, or one job's.
  async runs(job?: string): Promise<Run[]> {
    const params = job ? new HttpParams().set('job', job) : undefined;
    return (
      await this.call(this.http.get<{ runs: Run[] }>('/v1/runs', { params }))
    ).runs;
  }

  // Deletes a failed run's kept session.
  deleteRunSession(id: string): Promise<{ deleted: string }> {
    return this.call(
      this.http.delete<{ deleted: string }>(`/v1/runs/${path(id)}/session`),
    );
  }

  // Every lock, or those whose names match a pattern (gpu-*, a,b:*).
  // Every agent's spend and context (tier 0g), filtered by an ID pattern;
  // with `days`, the total over the last so many days.
  costs(match?: string, days?: string): Promise<CostsView> {
    let params = new HttpParams();
    if (match?.trim()) params = params.set('match', match.trim());
    if (days?.trim()) params = params.set('days', days.trim());
    return this.call(this.http.get<CostsView>('/v1/costs', { params }));
  }

  // One agent's spend per day (tier 0g).
  costDays(agent: string): Promise<CostDays> {
    return this.call(
      this.http.get<CostDays>(`/v1/costs/${encodeURIComponent(agent)}`),
    );
  }

  async locks(match?: string): Promise<Lock[]> {
    const params = match?.trim()
      ? new HttpParams().set('match', match.trim())
      : undefined;
    return (
      await this.call(this.http.get<{ locks: Lock[] }>('/v1/locks', { params }))
    ).locks;
  }

  // The owner frees an agent's hold on a lock (or takes it out of the queue).
  releaseLock(
    name: string,
    agent: string,
  ): Promise<{ released: 'held' | 'queued' }> {
    return this.call(
      this.http.post<{ released: 'held' | 'queued' }>(
        `/v1/locks/${path(name)}/release`,
        { agent },
      ),
    );
  }

  // A page of the history, newest first (see HistoryQuery).
  async history(query: HistoryQuery = {}): Promise<HistoryEntry[]> {
    let params = new HttpParams();
    if (query.match?.trim()) params = params.set('match', query.match.trim());
    if (query.kind) params = params.set('kind', query.kind);
    if (query.before !== undefined)
      params = params.set('before', String(query.before));
    if (query.limit !== undefined)
      params = params.set('limit', String(query.limit));
    return (
      await this.call(
        this.http.get<{ history: HistoryEntry[] }>('/v1/history', { params }),
      )
    ).history;
  }

  // The kinds of entries there are, with how many of each, most first.
  async historyKinds(): Promise<HistoryKind[]> {
    return (
      await this.call(
        this.http.get<{ kinds: HistoryKind[] }>('/v1/history/kinds'),
      )
    ).kinds;
  }

  async hosts(): Promise<Host[]> {
    return (await this.call(this.http.get<{ hosts: Host[] }>('/v1/hosts')))
      .hosts;
  }

  settings(): Promise<SettingsView> {
    return this.call(this.http.get<SettingsView>('/v1/settings'));
  }

  resolved(agent: string): Promise<ResolvedSettings> {
    const params = new HttpParams().set('agent', agent);
    return this.call(
      this.http.get<ResolvedSettings>('/v1/settings', { params }),
    );
  }

  changeSettings(change: SettingsChange): Promise<SettingsView> {
    return this.call(this.http.patch<SettingsView>('/v1/settings', change));
  }

  async pause(id: string): Promise<Agent> {
    return (
      await this.call(
        this.http.post<{ agent: Agent }>(`/v1/agents/${path(id)}/pause`, {}),
      )
    ).agent;
  }

  async resume(id: string): Promise<Agent> {
    return (
      await this.call(
        this.http.post<{ agent: Agent }>(`/v1/agents/${path(id)}/resume`, {}),
      )
    ).agent;
  }

  // Pauses every agent and interrupts every running turn.
  stopAll(): Promise<{ paused: string[]; interrupted: string[] }> {
    return this.call(
      this.http.post<{ paused: string[]; interrupted: string[] }>(
        '/v1/stop-all',
        {},
      ),
    );
  }

  // Resumes the agents that Stop All paused.
  resumeAll(): Promise<{ resumed: string[] }> {
    return this.call(
      this.http.post<{ resumed: string[] }>('/v1/resume-all', {}),
    );
  }

  async wakes(): Promise<Wake[]> {
    return (await this.call(this.http.get<{ wakes: Wake[] }>('/v1/wakes')))
      .wakes;
  }

  async setWake(agent: string, name: string, wake: WakeInput): Promise<Wake> {
    return (
      await this.call(
        this.http.put<{ wake: Wake }>(
          `/v1/agents/${path(agent)}/wakes/${path(name)}`,
          wake,
        ),
      )
    ).wake;
  }

  fireWake(
    agent: string,
    name: string,
  ): Promise<{ fired: string; agent: string }> {
    return this.call(
      this.http.post<{ fired: string; agent: string }>(
        `/v1/agents/${path(agent)}/wakes/${path(name)}/fire`,
        {},
      ),
    );
  }

  cancelWake(agent: string, name: string): Promise<{ cancelled: string }> {
    return this.call(
      this.http.delete<{ cancelled: string }>(
        `/v1/agents/${path(agent)}/wakes/${path(name)}`,
      ),
    );
  }

  // Every message, newest first.
  async messages(): Promise<Message[]> {
    return (
      await this.call(this.http.get<{ messages: Message[] }>('/v1/messages'))
    ).messages;
  }

  // Any message whole; the owner's read leaves its state as it was.
  async message(id: string): Promise<FullMessage> {
    return (
      await this.call(
        this.http.get<{ message: FullMessage }>(`/v1/messages/${path(id)}`),
      )
    ).message;
  }

  // Sends a message as the owner.
  send(message: Outgoing): Promise<Sent> {
    return this.call(this.http.post<Sent>('/v1/messages', message));
  }

  // The open items, or with all every item.
  async inbox(all = false): Promise<InboxItem[]> {
    const params = all ? new HttpParams().set('all', '1') : undefined;
    return (
      await this.call(
        this.http.get<{ items: InboxItem[] }>('/v1/inbox', { params }),
      )
    ).items;
  }

  // Answers a message to the owner: the answer goes back to its agent.
  async answer(id: string, text: string): Promise<InboxItem> {
    return (
      await this.call(
        this.http.post<{ item: InboxItem }>(`/v1/inbox/${path(id)}/answer`, {
          text,
        }),
      )
    ).item;
  }

  // Answers an ask (a question, a permission or an approval); the first
  // answer counts, a later one is refused (ask_closed).
  async answerAsk(id: string, answer: AskAnswer): Promise<InboxItem> {
    return (
      await this.call(
        this.http.post<{ ask: InboxItem }>(
          `/v1/asks/${path(id)}/answer`,
          answer,
        ),
      )
    ).ask;
  }

  async closeItem(id: string): Promise<InboxItem> {
    return (
      await this.call(
        this.http.post<{ item: InboxItem }>(`/v1/inbox/${path(id)}/close`, {}),
      )
    ).item;
  }
}
