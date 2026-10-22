import type { DatabaseSync } from 'node:sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Assistant } from './assistant';
import { registerBriefingTool } from './briefing';
import { registerBuiltinTools } from './builtin-tools';
import { Calendar } from './calendar';
import { registerCodeTools } from './code-tools';
import { AuditLog } from './audit';
import { openDatabase } from './db';
import { EventBus } from './events';
import type { ModelAdapter } from './model';
import { MemoryStore } from './memory';
import { PermissionPolicy } from './permissions';
import { Tasks } from './tasks';
import { ToolRegistry } from './tools';
import { registerWidgetTools } from './widget-tools';
import { WidgetStore, type WidgetHost } from './widgets';

export interface Services {
  db: DatabaseSync;
  bus: EventBus;
  audit: AuditLog;
  policy: PermissionPolicy;
  tools: ToolRegistry;
  memory: MemoryStore;
  calendar: Calendar;
  tasks: Tasks;
  widgets: WidgetStore;
  model: ModelAdapter;
  assistant: Assistant;
  close(): void;
}

export interface ServiceOptions {
  /** Path to the SQLite file, or ':memory:' for tests. */
  dbPath: string;
  /** Folder where widgets are saved. Defaults to a temporary folder for ':memory:'. */
  widgetsDir?: string;
  /** Draws widgets on screen. Defaults to a no-op, which tests and headless runs use. */
  widgetHost?: WidgetHost;
  /** Folder the coding agent may read and edit. Leave out to disable the code tools. */
  projectRoot?: string;
  model: ModelAdapter;
  now?: () => Date;
}

const NO_DISPLAY: WidgetHost = { show: () => undefined, hide: () => undefined };

export function createServices(options: ServiceOptions): Services {
  const now = options.now ?? (() => new Date());
  const db = openDatabase(options.dbPath);
  const bus = new EventBus();
  const audit = new AuditLog(db, bus, now);
  const policy = new PermissionPolicy();
  const tools = new ToolRegistry(policy, audit, bus, now);
  const memory = new MemoryStore(db, bus, now);
  const calendar = new Calendar(db, bus, now);
  const tasks = new Tasks(db, bus, now);
  const widgetsDir =
    options.widgetsDir ?? (options.dbPath === ':memory:' ? mkdtempSync(path.join(tmpdir(), 'buffy-widgets-')) : undefined);
  if (!widgetsDir) throw new Error('widgetsDir is required for a file-backed database');
  const widgets = new WidgetStore(widgetsDir, now);

  registerBuiltinTools(tools, { calendar, tasks, memory, now });
  registerBriefingTool(tools, { calendar, tasks, now });
  registerWidgetTools(tools, { store: widgets, host: options.widgetHost ?? NO_DISPLAY, bus });
  if (options.projectRoot) registerCodeTools(tools, { projectRoot: options.projectRoot });

  const assistant = new Assistant({
    model: options.model,
    db,
    tools,
    memory,
    calendar,
    tasks,
    bus,
    now,
  });

  return {
    db,
    bus,
    audit,
    policy,
    tools,
    memory,
    calendar,
    tasks,
    widgets,
    model: options.model,
    assistant,
    close: () => db.close(),
  };
}
