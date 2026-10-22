import { randomUUID } from 'node:crypto';
import type { AuditLog } from './audit';
import type { EventBus } from './events';
import type { Decision, PermissionPolicy, Scope } from './permissions';

export type ParamType = 'string' | 'number' | 'integer' | 'boolean';

export interface ParamSchema {
  type: ParamType;
  description: string;
  enum?: string[];
}

export interface ToolParameters {
  type: 'object';
  properties: Record<string, ParamSchema>;
  required: string[];
}

/** Native tool definition in the shape Ollama's /api/chat `tools` field expects. */
export interface ToolSpec {
  type: 'function';
  function: { name: string; description: string; parameters: ToolParameters };
}

export interface ToolOutput {
  summary: string;
  data?: unknown;
}

export interface ToolDef {
  name: string;
  description: string;
  scope: Scope;
  parameters: ToolParameters;
  run(args: Record<string, unknown>): Promise<ToolOutput> | ToolOutput;
}

export type ToolInfo = Pick<ToolDef, 'name' | 'description' | 'scope' | 'parameters'>;

export interface Approval {
  id: string;
  tool: string;
  args: Record<string, unknown>;
  description: string;
  requestedAt: string;
}

export type InvokeResult =
  | { status: 'done'; output: ToolOutput }
  | { status: 'pending'; approval: Approval }
  | { status: 'denied'; reason: string }
  | { status: 'error'; message: string };

/** Small helpers for declaring tool parameters. */
export const textParam = (description: string): ParamSchema => ({ type: 'string', description });
export const wholeParam = (description: string): ParamSchema => ({ type: 'integer', description });
export function objectSchema(properties: Record<string, ParamSchema>, required: string[] = []): ToolParameters {
  return { type: 'object', properties, required };
}

const BLANK_WORDS = new Set(['', 'null', 'none', 'n/a', 'undefined']);

/** Models fill unused optional fields with "", "null", "none", or "N/A". */
export function isBlank(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  return typeof value === 'string' && BLANK_WORDS.has(value.trim().toLowerCase());
}

/**
 * Checks model-supplied arguments against a tool's schema.
 * Returns a message the model can act on, or null when the arguments are valid.
 */
export function validateArgs(schema: ToolParameters, args: Record<string, unknown>): string | null {
  for (const key of schema.required) {
    const value = args[key];
    if (value === undefined || value === null || (typeof value === 'string' && !value.trim())) {
      return `"${key}" is required`;
    }
  }
  for (const [key, spec] of Object.entries(schema.properties)) {
    const value = args[key];
    if (!schema.required.includes(key) && isBlank(value)) continue;
    if (spec.type === 'string' && typeof value !== 'string') return `"${key}" must be text`;
    if (spec.type === 'boolean' && typeof value !== 'boolean') return `"${key}" must be true or false`;
    if (spec.type === 'number' || spec.type === 'integer') {
      const numeric = typeof value === 'string' && value.trim() ? Number(value) : value;
      const optional = !schema.required.includes(key);
      // An optional number the model filled with words ("N/A") means the user gave no value.
      if (optional && (typeof numeric !== 'number' || !Number.isFinite(numeric))) continue;
      if (typeof numeric !== 'number' || !Number.isFinite(numeric)) return `"${key}" must be a number`;
      if (spec.type === 'integer' && !Number.isInteger(numeric)) return `"${key}" must be a whole number`;
    }
    if (spec.enum && !spec.enum.includes(String(value))) {
      return `"${key}" must be one of: ${spec.enum.join(', ')}`;
    }
  }
  return null;
}

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDef>();
  private readonly approvals = new Map<string, Approval>();

  constructor(
    private readonly policy: PermissionPolicy,
    private readonly audit: AuditLog,
    private readonly bus: EventBus,
    private readonly now: () => Date = () => new Date(),
  ) {}

  register(tool: ToolDef): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool already registered: ${tool.name}`);
    }
    this.tools.set(tool.name, tool);
  }

  list(): ToolInfo[] {
    return [...this.tools.values()].map(({ name, description, scope, parameters }) => ({
      name,
      description,
      scope,
      parameters,
    }));
  }

  /** Tool definitions in Ollama's native tool-calling format. */
  specs(): ToolSpec[] {
    return [...this.tools.values()].map((tool) => ({
      type: 'function',
      function: { name: tool.name, description: tool.description, parameters: tool.parameters },
    }));
  }

  pendingApprovals(): Approval[] {
    return [...this.approvals.values()];
  }

  async invoke(name: string, args: Record<string, unknown> = {}): Promise<InvokeResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      this.audit.record(name, 'unknown', 'error', 'unknown tool');
      return { status: 'error', message: `Unknown tool: ${name}` };
    }

    // Validate before the permission gate so a malformed call never reaches the user as an approval.
    const problem = validateArgs(tool.parameters, args);
    if (problem) {
      this.audit.record(tool.name, tool.scope, 'error', `invalid arguments: ${problem}`);
      return { status: 'error', message: `Invalid arguments for ${tool.name}: ${problem}` };
    }

    const decision: Decision = this.policy.decide(tool.scope);
    if (decision === 'deny') {
      const reason = this.policy.isPaused()
        ? 'Assistant is paused (kill switch is on)'
        : `Policy denies ${tool.scope} actions`;
      this.audit.record(tool.name, tool.scope, 'denied', reason);
      return { status: 'denied', reason };
    }
    if (decision === 'ask') {
      return this.requestApproval(tool, args);
    }
    return this.execute(tool, args);
  }

  async approve(id: string): Promise<InvokeResult> {
    const approval = this.approvals.get(id);
    if (!approval) {
      return { status: 'error', message: `No pending approval: ${id}` };
    }
    this.approvals.delete(id);
    const tool = this.tools.get(approval.tool);
    if (!tool) {
      return { status: 'error', message: `Tool no longer exists: ${approval.tool}` };
    }
    this.bus.publish('approval.resolved', { id, outcome: 'approved' });
    if (this.policy.isPaused()) {
      const reason = 'Assistant is paused (kill switch is on)';
      this.audit.record(tool.name, tool.scope, 'denied', reason);
      return { status: 'denied', reason };
    }
    return this.execute(tool, approval.args);
  }

  deny(id: string): InvokeResult {
    const approval = this.approvals.get(id);
    if (!approval) {
      return { status: 'error', message: `No pending approval: ${id}` };
    }
    this.approvals.delete(id);
    this.audit.record(approval.tool, 'approval', 'denied', 'declined by user');
    this.bus.publish('approval.resolved', { id, outcome: 'denied' });
    return { status: 'denied', reason: 'Declined by user' };
  }

  private requestApproval(tool: ToolDef, args: Record<string, unknown>): InvokeResult {
    const approval: Approval = {
      id: randomUUID(),
      tool: tool.name,
      args,
      description: `${tool.description} ${JSON.stringify(args)}`,
      requestedAt: this.now().toISOString(),
    };
    this.approvals.set(approval.id, approval);
    this.audit.record(tool.name, tool.scope, 'pending', approval.id);
    this.bus.publish('approval.requested', approval);
    return { status: 'pending', approval };
  }

  private async execute(tool: ToolDef, args: Record<string, unknown>): Promise<InvokeResult> {
    try {
      const output = await tool.run(args);
      this.audit.record(tool.name, tool.scope, 'done', output.summary);
      return { status: 'done', output };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.audit.record(tool.name, tool.scope, 'error', message);
      return { status: 'error', message };
    }
  }
}
