/**
 * Scopes describe what a tool can touch.
 * - read: no side effects (auto-allowed)
 * - local_write: changes the assistant's own data (auto-allowed: "approved areas")
 * - destructive: deletes or overwrites user data (asks by default)
 * - external: leaves the machine (email, applications, posts). Always asks.
 * - system: runs commands or controls the computer (asks by default)
 */
export type Scope = 'read' | 'local_write' | 'destructive' | 'external' | 'system';
export type Decision = 'allow' | 'ask' | 'deny';

export const SCOPES: readonly Scope[] = ['read', 'local_write', 'destructive', 'external', 'system'];

const DEFAULT_RULES: Record<Scope, Decision> = {
  read: 'allow',
  local_write: 'allow',
  destructive: 'ask',
  external: 'ask',
  system: 'ask',
};

export class PermissionPolicy {
  private rules: Record<Scope, Decision> = { ...DEFAULT_RULES };
  private paused = false;

  isPaused(): boolean {
    return this.paused;
  }

  /** Kill switch: every tool call is denied until resume(). */
  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
  }

  decide(scope: Scope): Decision {
    if (this.paused) return 'deny';
    return this.rules[scope];
  }

  setRule(scope: Scope, decision: Decision): void {
    if (scope === 'external' && decision === 'allow') {
      throw new Error('External actions always require approval and cannot be auto-allowed');
    }
    this.rules[scope] = decision;
  }

  snapshot(): { paused: boolean; rules: Record<Scope, Decision> } {
    return { paused: this.paused, rules: { ...this.rules } };
  }
}
