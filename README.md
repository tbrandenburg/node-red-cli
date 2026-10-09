# node-red-cli

[![Checks](https://github.com/tbrandenburg/node-red-cli/actions/workflows/checks.yml/badge.svg)](https://github.com/tbrandenburg/node-red-cli/actions/workflows/checks.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Call existing Node-RED flows from a CLI or Node.js host, like ordinary
functions, using the real embedded Node-RED runtime without flow mutation or
temporary nodes.

```bash
node-red-cli run test/fixtures/flows.json calculate --set x=4 --set y=5 < /dev/null
```

```text
9
```

## Install

```bash
npm install -g @tbrandenburg/node-red-cli
```

For a repository checkout, run `make install` and `make ci`. `make install`
also configures the pre-push hook to run the CI checks.

## CLI usage

```text
node-red-cli run [flow-file] [entry] [options]
node-red-cli serve [flow-file] [options]
```

`run` invokes a flow and `inspect` describes its static topology. A
**flow-file** is the local Node-RED flow JSON file, a **tab** is a Node-RED
workspace, and an **entry** is a callable Link In node selected by ID or unique
name. For `run`, an omitted entry is inferred when the flow has only one Link In
node; `inspect` without an entry always shows inventory.

```bash
echo '{"payload":{"x":4,"y":5}}' | node-red-cli run test/fixtures/flows.json calculate
node-red-cli run test/fixtures/flows.json calculate --tab "Calculator Example" --set x=4 --set y=5 < /dev/null
node-red-cli run test/fixtures/single-link-in.flows.json --set x=4 --set y=5 < /dev/null
```

### Static inspection

```bash
node-red-cli inspect
node-red-cli inspect plan.json
node-red-cli inspect plan.json --tab planner
node-red-cli inspect plan.json calculate
node-red-cli inspect plan.json calculate --depth 3
node-red-cli inspect plan.json calculate --depth 3 --json
node-red-cli inspect --flow-json '[{"id":"tab","type":"tab","label":"Demo"}]'
node-red-cli inspect calculate --flow-json - --depth 2 --json < flows.json
```

`inspect --flow-json <json|->` inspects inline Node-RED flow JSON or reads the
flow definition from stdin with `--flow-json -`; it never starts the runtime or
writes a temporary flow file. When `--flow-json` is used, the first positional
is the optional entry (there is no flow-file positional), and `--flow-dir` is
not applicable. Stdin is consumed only as the flow definition, not as a message.

Without an entry, `inspect` inventories tabs, workspace Link In entries, and
Link Out(return) nodes. With an entry, it reports a bounded declared-topology
graph. `--depth` defaults to 1 and `--tab` selects a tab by ID or unique label.
**Inspect reports declared static topology. It does not execute Node-RED and
does not guarantee which runtime path a message will take or whether a call
will return.** Dynamic Link Calls (`msg.target`) and `node.linkcall` calls
inside Function source cannot be resolved statically.

### Native Node-RED server

```bash
node-red-cli serve myflow.json
node-red-cli serve myflow.json --port 1881
node-red-cli serve plan.json --flow-dir ./workflows --user-dir ~/.node-red
```

`serve` is a foreground convenience wrapper for the locally installed native
`node-red myflow.json` command. It serves the Node-RED editor at
`http://127.0.0.1:1880/` and native HTTP In endpoints. It does not expose Link
In/Link Out nodes as HTTP endpoints. The default port is `1880`; the wrapper
forces Node-RED to bind to `127.0.0.1` even if `settings.js` requests another
host. Use trusted flows and configuration: native Node-RED settings and flow
code retain their normal capabilities.

Without `--user-dir`, Node-RED uses its normal persistent user directory
(`~/.node-red` by default), including settings, credentials, runtime state and
installed nodes. An explicit `--user-dir <dir>` selects another persistent
directory. The editor can save deployments back to the supplied flow file, so
keep a copy or use version control if needed. Stop the foreground server with
Ctrl-C or SIGTERM. For advanced native Node-RED CLI options, invoke `node-red`
directly.

### Flow-file resolution

- A flow-file path that is absolute or contains `/` or `\` is resolved exactly
  relative to the current directory when not absolute.
- A bare flow-file name resolves in the current directory, or exactly in
  `--flow-dir` when supplied.
- With no flow-file, the name is `flows.json` in the current directory or in
  `--flow-dir`.
- There is no search of conventional directories or fallback to another path.
  `--flow-dir` must exist and be a directory; the selected flow-file must be a
  regular file.

```bash
node-red-cli run plan.json --flow-dir ~/.workflows
```

### Options

| Option                            | Description                                                                                                                                 |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `--tab <id\|label>`               | Scope entry selection to a workspace tab ID or unique label.                                                                                |
| `--flow-dir <dir>`                | Directory for a bare flow-file name and the default `flows.json`.                                                                           |
| `--flow-json <json\|->`           | Use inline flow JSON, or `-` to read the flow definition from stdin. Mutually exclusive with a flow-file positional.                        |
| `--set <key=value>`               | Set `msg.payload.<key>`. Repeatable; JSON values are parsed, otherwise treated as strings.                                                  |
| `--timeout <ms>`                  | Link-call timeout in milliseconds (default: `5000`).                                                                                        |
| `--output <payload\|message>`     | Print only the payload (default) or the full returned message as JSON.                                                                      |
| `--user-dir [dir]`                | Persistent Node-RED userDir. A supplied directory is used directly; bare option uses the stable cache; omission uses a temporary directory. |
| `--node-modules <name[@version]>` | Install missing Node-RED node packages. Repeatable/comma-separated; requires persistent `--user-dir`.                                       |
| `--docker [image]`                | Execute the invocation in a disposable Docker container; bare option uses the cached default image.                                         |
| `--docker-user-dir <dir>`         | In Docker mode, select the userDir inside the container.                                                                                    |
| `--network`                       | Enable Docker network access (Docker otherwise defaults to no network, except when package installation requires it).                       |

Payload output prints strings as-is and JSON-stringifies other values. Message
output includes Node-RED message properties such as `_msgid`.

`--flow-json -` consumes stdin for the flow definition. In this form, construct
the invocation message with `--set` rather than stdin:

```bash
node-red-cli run --flow-json - calculate --set x=4 --set y=5 < test/fixtures/flows.json
```

`--node-modules` runs `npm install` and therefore executes package code from the
configured registry. Use trusted packages only. Docker mode uses a read-only
root filesystem, drops capabilities, and disables networking by default.

## Host API

```js
const { createHostLinkCaller } = require("./src/link-call");
const caller = createHostLinkCaller(RED);
const result = await caller.call("calculate", { payload: { x: 4, y: 5 } }, { flow: "calculator" });
console.log(result.payload);
caller.close();
```

The host API's `flow` selector accepts a tab ID or unique label. Explicit Link
In IDs resolve across tabs; a supplied flow selector scopes entry selection.
Link In names must be unique in the applicable scope. With no entry, a sole
Link In is inferred; inference across tabs can report a warning using the
optional `onWarning` callback.

Node-RED executes native Links and subflows. A flow that does not return
rejects when the configured timeout expires. The runtime adapter is tested
against supported Node-RED versions because it relies on runtime internals.

## Development

```bash
make install
make test
make ci
```

## License

MIT — see [LICENSE](LICENSE).
