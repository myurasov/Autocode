/*
 * The Settings page's shared state: the server's view of the settings, sending
 * a change and keeping its outcome for the section that made it, and draftOf,
 * which turns a value into what an input holds.
 */

import { Injectable, computed, inject, signal } from '@angular/core';
import {
  Api,
  errorText,
  type SettingDef,
  type SettingsChange,
  type SettingsView,
  type SettingValue,
} from '../api';

export type Section = 'server' | 'rules' | 'agents';
export type Draft = string | boolean;

// What an input holds for a value: switches stay true/false, everything else is
// text.
export function draftOf(value: SettingValue | undefined): Draft {
  return typeof value === 'boolean'
    ? value
    : value === undefined
      ? ''
      : String(value);
}

const TEXT: SettingDef = {
  kind: 'text',
  scope: 'agent',
  default: '',
  help: '',
};

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((item, i) => item === b[i]);
}

// The Settings page's data, shared by its sections: the server's view and the
// outcome of the last change.
@Injectable()
export class SettingsState {
  private readonly api = inject(Api);

  readonly view = signal<SettingsView | null>(null);
  readonly loadError = signal('');
  readonly error = signal('');
  readonly notice = signal('');
  // The section whose change the error or notice is about.
  readonly where = signal<Section | null>(null);
  readonly busy = signal(false);

  // Equal lists count as no change, so forms that depend on them keep what the
  // owner picked.
  readonly keys = computed(() => Object.keys(this.view()?.schema ?? {}), {
    equal: sameList,
  });
  readonly agentKeys = computed(
    () => this.keys().filter((key) => this.def(key).scope === 'agent'),
    {
      equal: sameList,
    },
  );

  def(key: string): SettingDef {
    return this.view()?.schema[key] ?? TEXT;
  }

  // The server-wide value: the built-in default or the server's own.
  serverValue(key: string): SettingValue | undefined {
    return this.view()?.defaults[key];
  }

  async load(): Promise<void> {
    try {
      this.view.set(await this.api.settings());
      this.loadError.set('');
    } catch (err) {
      this.loadError.set(errorText(err));
    }
  }

  // A change that was not sent: says why in the section.
  refuse(where: Section, message: string): void {
    this.where.set(where);
    this.notice.set('');
    this.error.set(message);
  }

  /*
   * Sends one change. On success the page shows the server's new view and
   * `done`; when the server refuses it, its message (which names the bad key)
   * and nothing changes.
   */
  async change(
    change: SettingsChange,
    done: string,
    where: Section,
  ): Promise<boolean> {
    this.busy.set(true);
    this.where.set(where);
    this.notice.set('');
    this.error.set('');
    try {
      this.view.set(await this.api.changeSettings(change));
      this.notice.set(done);
      return true;
    } catch (err) {
      this.error.set(errorText(err));
      return false;
    } finally {
      this.busy.set(false);
    }
  }
}
