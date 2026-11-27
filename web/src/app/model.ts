/*
 * A model, the same wherever a table shows one (the owner, 2026-11-17: "i
 * want models/efforts tho be shown in the same way on agents and jobs tabs",
 * "i want it like so: provider-slug-in-grey/model-slug"): its ID as OpenCode
 * writes it, provider/model, with the provider (the ID's path up to its last
 * slash) in grey. A narrow cell breaks it after a slash or a hyphen. A model
 * of the claude-agent provider, whose ID has no version, shows the one in
 * its name after it, "claude-agent/fable (5.2)" (the owner, 2026-11-17).
 * The page puts the model's name, where OpenCode's model list has one
 * ("Fable 5.2"), in the cell's tooltip. For a claude-agent session the
 * server also knows which model answered and which was asked for
 * (1.1.0-rc7): when the two differ, a second line under the model says
 * "answered by ..." in amber; the tooltip says it either way.
 */

import { Component, computed, input } from '@angular/core';
import { Breaks } from './breaks';
import { modelParts } from './format';

// The providers whose model IDs carry no version ("fable", "opus").
const UNVERSIONED = ['claude-agent/'];

/*
 * The version to show after a model: the first number in its name ("5.2" of
 * "Fable 5.2"), for a provider whose IDs have none; '' otherwise.
 */
export function modelVersion(model: string, name?: string | null): string {
  if (!UNVERSIONED.includes(modelParts(model)[0])) return '';
  return name?.match(/\d+(?:\.\d+)*/)?.[0] ?? '';
}

@Component({
  selector: 'app-model',
  imports: [Breaks],
  template: `<code
    ><span
      class="provider muted"
      [appBreaks]="parts()[0]"
      breakAfter="/-"
    ></span
    ><wbr /><span class="slug" [appBreaks]="parts()[1]" breakAfter="-"></span
    >@if (version()) {
      &ngsp;<span class="version">({{ version() }})</span>
    }</code
    >@if (other()) {
      <span class="answered" role="note">answered by {{ answered() }}</span>
    }`,
})
export class ModelText {
  // provider/model, as OpenCode writes it
  readonly model = input.required<string>();
  // its name in OpenCode's model list, when one is known
  readonly name = input<string | null | undefined>(null);

  // the provider's path with its slash, and the model
  protected readonly parts = computed(() => modelParts(this.model()));
  protected readonly version = computed(() =>
    modelVersion(this.model(), this.name()),
  );
  // which model answered, and which was asked for, when the server knows
  readonly answered = input<string | null | undefined>(null);
  readonly requested = input<string | null | undefined>(null);
  // another model answered than the one asked for
  protected readonly other = computed(() =>
    answeredOther(this.answered(), this.requested()),
  );
}

// Whether another model answered than the one that was asked for.
export function answeredOther(
  answered?: string | null,
  requested?: string | null,
): boolean {
  return !!answered && !!requested && answered !== requested;
}

/*
 * A model cell's tooltip: the model's name where OpenCode's list has one,
 * then which model answered (and, when another was asked for, which);
 * null with nothing to say.
 */
export function modelTip(
  name?: string | null,
  answered?: string | null,
  requested?: string | null,
): string | null {
  const said = !answered
    ? ''
    : answeredOther(answered, requested)
      ? `answered by ${answered}, not by ${requested}, which was asked for`
      : `answered by ${answered}`;
  return [name, said].filter(Boolean).join('; ') || null;
}
