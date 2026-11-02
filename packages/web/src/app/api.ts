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

export interface Agent {
  id: string;
  description: string;
  status: string;
  last_active: string;
  session?: string;
  host?: string;
  machine?: string;
  directory?: string;
  registered_at?: string;
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
}
