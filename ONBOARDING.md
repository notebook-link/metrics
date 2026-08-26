# Onboarding Guide

This package is infrastructure for metrics collection in JupyterLab and
JupyterLite. It is not a complete analytics product by itself.

If you are new to the project, the most important thing to know is this:

1. Installing the package is not enough to observe data.
2. The default frontend collector is a no-op.
3. The dispatcher settings default to a state that blocks the built-in events.

To see useful metrics, you need two things at the same time:

1. Emissions enabled.
2. A consumer for those emissions.

For JupyterLab, the consumer can live in the frontend as a custom collector
plugin, or on the backend as a Jupyter Server event listener. For JupyterLite,
only the frontend path applies.

## Mental Model

The package has four moving parts.

1. The Python server extension `notebook_metrics` registers the event
   schemas with Jupyter Server. It can also inject a `PageConfig` override from
   a YAML file pointed to by `NOTEBOOK_METRICS_OVERRIDE`.
2. The frontend broadcasts plugin wires JupyterLab signals and browser events
   into metrics emissions.
3. The frontend dispatcher plugin listens to the Jupyter events stream,
   applies filtering, and forwards accepted events to a collector.
4. The default frontend collector plugin intentionally does nothing. It exists
   so the package can load cleanly before you replace it.

That means there are two valid integration styles:

1. Frontend collection: provide your own `IMetrics.ICollector` plugin.
2. Backend collection: listen to the registered schema events on
   `app.event_logger`.

The working examples in this repository follow both patterns:

1. Frontend filtering and dispatch are covered in
   [src/**tests**/notebook_metrics.spec.ts](./src/__tests__/notebook_metrics.spec.ts).
2. Backend listener collection is demonstrated in
   [notebook_metrics/tests/test_pass.py](./notebook_metrics/tests/test_pass.py)
   and [ui-tests/event_capture_extension.py](./ui-tests/event_capture_extension.py).

## What Ships In The Box

The package emits four schema'd events.

1. `https://schema.notebook.link/metrics/command-executed/v1`
   Fired when the JupyterLab command registry executes a command.
2. `https://schema.notebook.link/metrics/current-changed/v1`
   Fired when the shell emits a non-null `currentChanged` value.
3. `https://schema.notebook.link/metrics/jupyter-error/v1`
   Fired when notebook cell execution fails with a Jupyter error.
4. `https://schema.notebook.link/metrics/runtime-error/v1`
   Fired for window-level `error` and `unhandledpromiserejection` events.

Today, all four built-in events are marked the same way:

1. `anonymous: false`
2. `sensitivity: high`

That has an important consequence for onboarding: if you leave the defaults in
place, none of the built-in events will pass the filter.

## First Successful Setup

This is the shortest path to a real signal in JupyterLab.

### 1. Install The Package

Install it with:

```bash
python -m pip install notebook-metrics
```

Use `notebook-metrics` for installation, but `notebook_metrics` for Python
imports and the server extension name.

### 2. Enable Emissions

You can enable emissions either through JupyterLab user settings or through a
server-side page-config override.

For first-time evaluation, the override file is the clearest option because it
is explicit and wins over user settings.

Create a YAML file like this:

```yaml
anonymous: false
disabled: false
excluded:
  'https://schema.notebook.link/metrics/command-executed/v1': false
  'https://schema.notebook.link/metrics/current-changed/v1': false
  'https://schema.notebook.link/metrics/jupyter-error/v1': false
  'https://schema.notebook.link/metrics/runtime-error/v1': false
sensitivity: high
```

Then point `NOTEBOOK_METRICS_OVERRIDE` at it before starting JupyterLab.

Why this exact file matters:

1. `disabled: false` turns the dispatcher on.
2. `anonymous: false` allows the shipped non-anonymous events through.
3. `sensitivity: high` allows the shipped high-sensitivity events through.
4. `excluded` keeps each built-in schema enabled.

### 3. Choose A Consumer Path

At this point the package is allowed to emit, but you still need something to
observe or store the events.

Choose one of these paths:

1. If you want browser-side handling, add a custom frontend collector plugin.
2. If you want server-side handling, add a Jupyter Server listener.

## Path A: Frontend Collector

Use this when you want to forward metrics from the JupyterLab frontend to your
own service, local storage, or application-specific telemetry pipeline.

The collector contract is intentionally small:

```ts
interface ICollector {
  collect: (schema: string, event: IMetrics.Event<unknown>) => Promise<void>;
}
```

Your custom plugin needs to provide `IMetrics.ICollector`.

```ts
import type { JupyterFrontEndPlugin } from '@jupyterlab/application';
import { IMetrics } from 'notebook-metrics';

const collector: JupyterFrontEndPlugin<IMetrics.ICollector> = {
  id: 'acme-metrics:collector',
  autoStart: true,
  provides: IMetrics.ICollector,
  activate: () => ({
    collect: async (schema, event) => {
      console.log('metric', schema, event.metrics);
      // Replace this with your real sink.
    }
  })
};

export default collector;
```

Production note: disable the built-in no-op collector plugin
`notebook-metrics:collector` when your application ships a real one.
You can do that with:

```
jupyter labextension disable notebook-metrics:collector
```

more details about plugin management are available
[here](https://jupyterlab.readthedocs.io/en/stable/user/extensions.html#managing-extensions-with-jupyter-labextension)

Good first smoke test:

1. Start JupyterLab with the permissive override shown above.
2. Load your collector plugin.
3. Execute a known command such as changing the JupyterLab theme.
4. Confirm your collector receives
   `https://schema.notebook.link/metrics/command-executed/v1`.

## Path B: Backend Listener

Use this when you want to keep collection on the Jupyter Server side, or when
you want the server to fan out metrics to another system.

The server extension already registers the schemas. Your job is to attach a
listener to the server event logger.

This minimal server extension mirrors the test-only capture extension in this
repository.

```python
from notebook_metrics import schemas

PREFIX = 'https://schema.notebook.link/metrics'


def _jupyter_server_extension_points():
    return [{'module': 'acme_metrics_listener'}]


def _load_jupyter_server_extension(app):
    async def listener(logger, schema_id, data):
        app.log.info('metric %s %s', schema_id, data.get('metrics', {}))

    for schema in schemas:
        app.event_logger.add_listener(
            listener=listener,
            schema_id=f'{PREFIX}/{schema}/v1',
        )
```

You can see the same pattern in
[ui-tests/event_capture_extension.py](./ui-tests/event_capture_extension.py).

Good first smoke test:

1. Enable `notebook_metrics`.
2. Enable your listener extension.
3. Start JupyterLab with the permissive override.
4. Trigger a known event, such as a theme change.
5. Confirm your server logs or sink receive the matching schema URL.

## Configuration In Practice

The frontend dispatcher filter lives in the settings schema in
[schema/dispatcher.json](./schema/dispatcher.json). The useful keys are:

1. `disabled`: master switch. If this is `true`, nothing is forwarded.
2. `anonymous`: if this is `true`, only anonymous events are allowed.
3. `sensitivity`: allowed ceiling for event sensitivity.
4. `excluded`: per-schema booleans.

Configuration precedence is:

1. Built-in defaults.
2. JupyterLab user settings.
3. Page-config override from `NOTEBOOK_METRICS_OVERRIDE`.

The override wins. That is intentional. It lets a deployment operator lock the
policy down at the server layer.

One subtle point matters here: the built-in events are all currently
non-anonymous and high-sensitivity. If you leave `anonymous: true` or set
`sensitivity` below `high`, you will suppress the shipped events even when
`disabled` is `false`.

## Common Mistakes

These are the failures most likely to make a first integration feel broken.

1. Installing the package and expecting the default collector to save data.
2. Forgetting that the effective startup policy needs `disabled: false`.
3. Leaving `anonymous: true`, which filters out the shipped events.
4. Leaving `sensitivity` below `high`, which filters out the shipped events.
5. Expecting user settings to beat the server-side override file.
6. Forgetting to disable `notebook-metrics:collector` after shipping a
   real frontend collector.
7. Expecting the backend listener path to work in JupyterLite.

## Where To Read Next

If you want the next layer of detail, these files are the most useful starting
points.

1. [README.md](./README.md) for installation and development workflows.
2. [src/plugins.ts](./src/plugins.ts) for the runtime wiring.
3. [src/metrics.ts](./src/metrics.ts) for the public TypeScript contract.
4. [schema/dispatcher.json](./schema/dispatcher.json) for the settings model.
5. [notebook_metrics/**init**.py](./notebook_metrics/__init__.py)
   for server extension behavior and override loading.
6. [ui-tests/tests/notebook_metrics.spec.ts](./ui-tests/tests/notebook_metrics.spec.ts)
   for an end-to-end backend collection example.

## A Good First Goal

If you are integrating this package for the first time, aim for this before you
do anything more ambitious:

1. Start JupyterLab with a permissive override.
2. Trigger one known event.
3. See one matching schema URL in your chosen sink.

Once that works, you can tighten the policy, narrow the `excluded` map, or swap
in a production collector.
