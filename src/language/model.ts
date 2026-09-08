// USL language model. Declarations describe meaning; observations do not prove it.
import { Data } from "effect"
import type { EndpointKind, Locator, KgLocator } from "../domain.js"

export class LanguageError extends Data.TaggedError("LanguageError")<{
  readonly phase: "parse" | "compile" | "project"
  readonly detail: string
  readonly line?: number
  readonly column?: number
}> { get message() { return `${this.phase}${this.line ? ` ${this.line}:${this.column}` : ""}: ${this.detail}` } }

export type RoleKind = EndpointKind | "any"
export interface Role { readonly name: string; readonly kind: RoleKind }
export interface Participant { readonly role: string; readonly resource: string }
export interface MeaningCheck {
  readonly name: string
  readonly description: string
  readonly evidenceRoles: ReadonlyArray<string>
}
/** Declares when a meaning applies and how its supporting evidence can be inspected.
 * It is a declaration contract; it does not evaluate or prove the meaning. */
export interface MeaningContract {
  readonly scope: string
  readonly checks: ReadonlyArray<MeaningCheck>
}
export type Declaration =
  | { readonly tag: "resource"; readonly name: string; readonly locator: string }
  | { readonly tag: "meaning"; readonly name: string; readonly roles: ReadonlyArray<Role>; readonly description: string; readonly grounded?: string; readonly contract?: MeaningContract }
  | { readonly tag: "link"; readonly name: string; readonly meaning: string; readonly participants: ReadonlyArray<Participant> }
export interface Program {
  readonly languageVersion: string
  readonly namespace: string
  readonly declarations: ReadonlyArray<Declaration>
}
export interface SemanticPlan {
  readonly schema: "usl-semantic-plan/v1"
  readonly languageVersion: "0.1"
  readonly namespace: string
  readonly resources: ReadonlyArray<{ readonly name: string; readonly locator: Locator }>
  readonly meanings: ReadonlyArray<{ readonly name: string; readonly roles: ReadonlyArray<Role>; readonly description: string; readonly grounded?: KgLocator; readonly contract?: MeaningContract }>
  readonly links: ReadonlyArray<{ readonly name: string; readonly meaning: string; readonly participants: ReadonlyArray<Participant> }>
  readonly declarationStatus: "DECLARED"
}
