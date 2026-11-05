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
  description: string;
  // idle, working, paused, offline or error
  status: string;
  last_active: string;
  session?: string;
  host?: string;
  machine?: string;
  directory?: string;
  registered_at?: string;
  // Who paused its injections: '' (nobody), 'owner' or 'stop-all'.
  paused?: string;
  idle_since?: string | null;
  last_outcome?: string | null;
  // While its turns fail (also when paused or offline).
  error?: AgentError | null;
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
  end: string | null;
  next: string | null;
  set_by: string;
  created_at: string;
  updated_at: string;
  last_fired_at: string | null;
  check_failures: number;
}

export interface WakeInput {
  text: string;
  trigger: string;
  check?: string;
  end?: string;
}

export interface Message {
  id: string;
  send_id: string;
  from: string;
  to: string;
  subject: string;
  reply_to: string | null;
  kind: 'text' | 'binary';
  mime: string | null;
  size: number;
  // A text message's first 100 characters (the owner's list only).
  preview?: string;
  state: 'queued' | 'delivered' | 'read';
  created_at: string;
  delivered_at: string | null;
  read_at: string | null;
}

// A message whole, as the owner reads it: its text, or a file's base64 data.
export interface FullMessage extends Message {
  text?: string;
  data?: string;
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

export interface InboxItem {
  id: string;
  kind: 'message' | 'alert';
  agent: string | null;
  message_id: string | null;
  title: string;
  body: string;
  created_at: string;
  closed_at: string | null;
  answer: string | null;
}

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

  async agents(match?: string): Promise<Agent[]> {
    const params = match?.trim()
      ? new HttpParams().set('match', match.trim())
      : undefined;
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

  async closeItem(id: string): Promise<InboxItem> {
    return (
      await this.call(
        this.http.post<{ item: InboxItem }>(`/v1/inbox/${path(id)}/close`, {}),
      )
    ).item;
  }
}
