import { PageConfig } from '@jupyterlab/coreutils';
import { Event as JupyterEvent } from '@jupyterlab/services';
import { ISettingRegistry } from '@jupyterlab/settingregistry';
import { CommandRegistry } from '@lumino/commands';
import { Signal } from '@lumino/signaling';
import { Widget } from '@lumino/widgets';
import { CommandExecuted } from '../emissions/command-executed';
import { CurrentChanged } from '../emissions/current-changed';
import { JupyterError } from '../emissions/jupyter-error';
import { IMetrics } from '../metrics';

jest.mock('@jupyterlab/notebook', () => {
  const { Signal } = jest.requireActual(
    '@lumino/signaling'
  ) as typeof import('@lumino/signaling');
  return {
    NotebookActions: {
      executed: new Signal({})
    }
  };
});

const { dispatcher } = jest.requireActual(
  '../plugins'
) as typeof import('../plugins');

const { NotebookActions } = jest.requireMock('@jupyterlab/notebook') as {
  NotebookActions: {
    executed: Signal<
      unknown,
      {
        notebook: unknown;
        cell: unknown;
        success: boolean;
        error?: {
          errorName: string;
          errorValue: string;
          traceback: string[];
        } | null;
      }
    >;
  };
};

const executed = NotebookActions.executed;

const flush = async (count = 5) => {
  for (let index = 0; index < count; index++) {
    await Promise.resolve();
  }
};

const create = (): JupyterEvent.Emission =>
  ({
    level: { anonymous: false, sensitivity: 'high' },
    metrics: { command: 'metrics:test' },
    schema_id: CommandExecuted.SCHEMA,
    timestamp: new Date().toISOString(),
    version: CommandExecuted.VERSION
  }) as unknown as JupyterEvent.Emission;

const reset = (composite: Partial<IMetrics.Filter>) => {
  const sender = {};
  const changed = new Signal<
    typeof sender,
    ISettingRegistry.ISettings<Partial<IMetrics.Filter>>
  >(sender);
  const settings = {
    changed,
    composite
  } as unknown as ISettingRegistry.ISettings<Partial<IMetrics.Filter>>;
  return { settings };
};

const enqueue = <T>() => {
  const values: T[] = [];
  const resolvers: Array<(result: IteratorResult<T>) => void> = [];
  let done = false;

  const next = () => {
    if (values.length > 0) {
      return Promise.resolve({ value: values.shift()!, done: false });
    }
    if (done) {
      return Promise.resolve({ done: true, value: undefined as T });
    }
    return new Promise<IteratorResult<T>>(resolve => {
      resolvers.push(resolve);
    });
  };

  return {
    close: () => {
      done = true;
      for (const resolve of resolvers.splice(0)) {
        resolve({ done: true, value: undefined as T });
      }
    },
    push: (value: T) => {
      const resolve = resolvers.shift();
      if (resolve) {
        resolve({ done: false, value });
        return;
      }
      values.push(value);
    },
    stream: {
      [Symbol.asyncIterator]: () => ({ next })
    } as AsyncIterable<T>
  };
};

const activate = async (
  collector: IMetrics.ICollector,
  settings: ISettingRegistry.ISettings<Partial<IMetrics.Filter>>,
  stream: AsyncIterable<JupyterEvent.Emission>
) => {
  const plugin = dispatcher;
  const registry = {
    load: async () => settings
  } as unknown as ISettingRegistry;
  const events = {
    emit: jest.fn().mockResolvedValue(undefined),
    stream
  };
  const app = { serviceManager: { events } };
  const api = await plugin.activate(app as never, collector, registry);
  return { api };
};

describe('notebook-metrics', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('broadcasts command executions as schema events', async () => {
    const emitted: JupyterEvent.Request[] = [];
    const commands = new CommandRegistry();
    commands.addCommand('metrics:test', {
      execute: () => undefined,
      label: 'Metrics Test'
    });

    const registration = CommandExecuted.broadcast(
      { emit: async event => void emitted.push(event) },
      commands
    );

    await commands.execute('metrics:test', { source: 'jest' });

    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      data: {
        level: { anonymous: false, sensitivity: 'high' },
        metrics: {
          args: { source: 'jest' },
          command: 'metrics:test',
          label: 'Metrics Test'
        }
      },
      schema_id: CommandExecuted.SCHEMA,
      version: CommandExecuted.VERSION
    });

    registration.dispose();
    await commands.execute('metrics:test');

    expect(emitted).toHaveLength(1);
  });

  it('broadcasts notebook execution failures as jupyter errors', () => {
    const emitted: JupyterEvent.Request[] = [];
    const traceback = [
      'Traceback (most recent call last):',
      "NameError: name 'foo' is not defined"
    ];

    const registration = JupyterError.broadcast({
      emit: async event => void emitted.push(event)
    });

    executed.emit({
      notebook: {},
      cell: {},
      success: true,
      error: null
    });
    executed.emit({
      notebook: {},
      cell: {
        model: {
          id: '32',
          metadata: { editable: 'false' }
        }
      },
      success: false,
      error: {
        errorName: 'NameError',
        errorValue: "name 'foo' is not defined",
        traceback
      }
    });

    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      data: {
        level: { anonymous: false, sensitivity: 'high' },
        metrics: {
          output_type: 'error',
          ename: 'NameError',
          evalue: "name 'foo' is not defined",
          traceback
        }
      },
      schema_id: JupyterError.SCHEMA,
      version: JupyterError.VERSION
    });

    registration.dispose();
    executed.emit({
      notebook: {},
      cell: {},
      success: false,
      error: {
        errorName: 'NameError',
        errorValue: 'second failure',
        traceback: ['Traceback']
      }
    });

    expect(emitted).toHaveLength(1);
  });

  it('ignores null current-changed notifications', () => {
    const emitted: JupyterEvent.Request[] = [];
    const sender = {};
    const currentChanged = new Signal<
      typeof sender,
      { newValue: Widget | null; oldValue: Widget | null }
    >(sender);

    const registration = CurrentChanged.broadcast(
      { emit: async event => void emitted.push(event) },
      { currentChanged } as never
    );

    currentChanged.emit({ newValue: null, oldValue: null });

    expect(emitted).toHaveLength(0);

    const widget = new Widget();
    widget.title.label = 'Notebook';
    currentChanged.emit({ newValue: widget, oldValue: null });

    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      data: { metrics: { label: 'Notebook' } },
      schema_id: CurrentChanged.SCHEMA
    });

    registration.dispose();
  });

  it('does not dispatch excluded schemas from settings', async () => {
    jest.spyOn(PageConfig, 'getOption').mockReturnValue('');
    const collector = { collect: jest.fn().mockResolvedValue(undefined) };
    const { settings } = reset({
      anonymous: false,
      disabled: false,
      excluded: { [CommandExecuted.SCHEMA]: true },
      sensitivity: 'high'
    });
    const queue = enqueue<JupyterEvent.Emission>();
    const { api } = await activate(collector, settings, queue.stream);

    api.register(CommandExecuted.SCHEMA);
    queue.push(create());
    await flush(20);
    queue.close();

    expect(collector.collect).toHaveBeenCalledTimes(0);
  });

  it('lets page config overrides exclude schemas before dispatch', async () => {
    jest
      .spyOn(PageConfig, 'getOption')
      .mockReturnValue(
        JSON.stringify({ excluded: { [CommandExecuted.SCHEMA]: true } })
      );
    const collector = { collect: jest.fn().mockResolvedValue(undefined) };
    const { settings } = reset({
      anonymous: false,
      disabled: false,
      excluded: { [CommandExecuted.SCHEMA]: false },
      sensitivity: 'high'
    });
    const queue = enqueue<JupyterEvent.Emission>();
    const { api } = await activate(collector, settings, queue.stream);

    api.register(CommandExecuted.SCHEMA);
    queue.push(create());
    await flush(20);
    queue.close();

    expect(collector.collect).toHaveBeenCalledTimes(0);
  });

  it('catches collector failures and continues dispatching', async () => {
    jest.spyOn(PageConfig, 'getOption').mockReturnValue('');
    const warning = jest
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined);
    const collector = {
      collect: jest
        .fn()
        .mockRejectedValueOnce(new Error('collector failed'))
        .mockResolvedValueOnce(undefined)
    };
    const { settings } = reset({
      anonymous: false,
      disabled: false,
      excluded: { [CommandExecuted.SCHEMA]: false },
      sensitivity: 'high'
    });
    const queue = enqueue<JupyterEvent.Emission>();
    const { api } = await activate(collector, settings, queue.stream);
    api.register(CommandExecuted.SCHEMA);
    queue.push(create());
    queue.push(create());
    await flush(20);
    queue.close();
    expect(collector.collect).toHaveBeenCalledTimes(2);
    expect(warning).toHaveBeenCalledTimes(1);
    expect(warning).toHaveBeenCalledWith(
      'metrics collector failed',
      expect.objectContaining({ message: 'collector failed' })
    );
  });
});
