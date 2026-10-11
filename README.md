# node-red-cli

[![Checks](https://github.com/tbrandenburg/node-red-cli/actions/workflows/checks.yml/badge.svg)](https://github.com/tbrandenburg/node-red-cli/actions/workflows/checks.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Call existing Node-RED flows from a CLI or Node.js host like ordinary functions,
using the real embedded runtime without flow mutation or temporary nodes. Use
`serve` to run the native editor/runtime and `edit` for revision-safe changes to
a running instance.

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
node-red-cli inspect [flow-file] [entry] [options]
node-red-cli serve [flow-file] [options]
node-red-cli edit <list|get|preview|apply> [options]
```

`run` invokes a flow and `inspect` describes its static topology. A
**flow-file** is a local Node-RED flow JSON file or a direct HTTP(S) URL
returning a Complete Flow JSON array. Raw GitHub/GitLab/Gist URLs work;
browser repository pages such as GitHub `blob` URLs return HTML and do not.
A remote flow is fetched into memory and is not written to disk. A **tab** is a Node-RED
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
Direct flow URLs are also accepted by `run` and `inspect`; URL + `--flow-dir` is
rejected. `run URL` still reads its message from stdin. `serve` remains
local-file-only.

Remote acquisition uses anonymous GET requests with a 15-second total timeout,
a 10 MiB decoded-body limit, and at most five validated redirects. HTTPS is
recommended; HTTP is unencrypted. There is no authentication, caching, or
provider-specific URL conversion. The operator must trust a supplied URL: this
CLI is not an SSRF-safe fetch service for URLs from untrusted users or agents.
URL parsing and redirect checks do not prevent DNS rebinding or access to
internal addresses; use external host allowlists and network egress controls if
accepting URLs from others. `run URL` executes the flow's Node-RED code; use
only trusted flows. `run --docker` can sandbox one-shot execution, but the
source download still happens on the host; Docker `--network none` only applies
to the flow runtime.

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

### Live flow editing

`edit` connects to a running native Node-RED Admin API to inspect and edit flows.
It defaults to `http://127.0.0.1:1880`; `--admin-url` accepts an Admin API base path such as
`https://node-red.example/admin`, and `NODE_RED_TOKEN` is sent as a bearer
token. Cleartext HTTP is restricted to loopback. The account needs
`flows.read` for list/get/preview and `flows.write` for apply. Treat the chosen
instance and flows as trusted; tokens and raw Admin API error bodies are never
printed. The account needs `nodes.read` for `add` plans and `credentials.read`
for credential plans.

```bash
node-red-cli edit list --json
node-red-cli edit list --tab "Calculator Example" --search function
node-red-cli edit list --kind config --json
node-red-cli edit get add --json
node-red-cli edit preview plan.json --json
node-red-cli edit apply plan.json --json
```

Plans use the opaque revision returned by list/get and an ordered operation
array. Operations are transformed sequentially on a deep copy. `set` changes
non-structural fields; `add` requires an explicit ID, ordinary node type (the
caller must ensure it is installed), tab ID, coordinates and wires. The CLI
checks installed palette types via `GET /nodes` and refuses a type already
represented as a config node in the current flow; Node-RED's Admin API does not
expose complete node-category schemas, so review unfamiliar contrib types before
using `add`. If the flow has no ordinary-node example of that type, the plan
must set `"assumeOrdinary": true`; this explicitly acknowledges that the type
category is unverified and does not validate runtime semantics. Node-specific
defaults and behavior remain the caller's responsibility. `connect`/`disconnect`
name exact IDs and an existing zero-based output port; `delete` removes an
ordinary node and cleans its ordinary wires and group membership. Adds can be
connected by later operations in the same plan. No IDs, layouts, or output ports
are generated.

```json
{
  "rev": "opaque-revision-from-edit-list",
  "ops": [
    {
      "op": "add",
      "assumeOrdinary": true,
      "node": { "id": "debug-new", "type": "debug", "z": "tab-id", "x": 520, "y": 180, "wires": [] }
    },
    { "op": "connect", "from": "existing-source-id", "port": 0, "to": "debug-new" }
  ]
}
```

The transformer conservatively rejects tab/group/subflow and Link types for
these ordinary operations. Delete refuses any exact nested reference outside
owned wires and group membership; it never cascades or bypasses. Custom node
configuration remains the caller's responsibility. New operation families
should register a focused handler in `src/edit-plan.js` and reuse this same
pure preview/apply transformer.

Structural plan operations are also supported: `tab` uses `add|set|reorder|delete`
(`reorder` lists every tab ID and moves only tab slots; `delete` requires an
empty tab); `group` uses `add|set|members|delete` and maintains both `nodes` and
member `g`. Groups require explicit rectangles; there is no auto-layout or
pixel-precise collision solver, so inspect the native editor and adjust the
provided bounds as needed. `config` uses `add|set|delete`, keeps credentials out
of plans, and only allows adding a type when an existing config-node example
proves its shape. Config deletion scans exact nested references and refuses
referenced objects. `link` uses `add|connect|disconnect|delete`; its `links`
metadata stays separate from ordinary `wires`, and only Link Out(mode=link)
reciprocity and static single-target Link Call relationships can be edited.
Disconnect relationships and ordinary wires before deleting Link nodes.
Dynamic/return misuse is refused.
`subflow` supports `add-definition|set-definition|ports|add-instance|delete-instance|delete-definition`.
Port arrays use native `{x,y,wires:[{id,port?}]}` descriptors; cyclic
definitions, port-count mismatches, and nonempty/referenced definition deletion
are refused. Definitions with config/internal ownership features beyond these
validated native forms should be edited only after a supported plan can prove
their references safe.

Credential edits use environment-variable references, never literal plan values:

```json
{
  "rev": "opaque-revision-from-edit-list",
  "ops": [
    {
      "op": "credential",
      "action": "set",
      "id": "auth-node",
      "values": { "username": { "env": "NR_EDIT_USERNAME" } }
    },
    { "op": "credential", "action": "clear", "id": "auth-node", "keys": ["password"] }
  ]
}
```

Preview validates environment-variable names without emitting secret values;
apply resolves them for the deployment. Node-RED's inline credential update
merges supplied keys, and an empty string clears only the specified key.
Unrelated full deployments retain credentials for node IDs that remain in the
flow. Credential schema is obtained from Node-RED's safe per-node credentials
endpoint; credential operations therefore also require `credentials.read`.
The endpoint may not expose schema for a node with no stored credentials, in
which case edits fail closed. Process environments may be visible to other
local processes, so use a trusted machine and protect the Node-RED Admin API
identity.

`preview` performs a fresh v2 GET and reports a redacted diff without POSTing.
Human-readable previews omit Function source bodies and point reviewers to the
plan file; JSON previews include source changes with an explicit warning.
`apply` repeats that validation against a fresh GET and makes at most one
revision-checked `POST /flows` v2 request. It never forces or retries a deploy;
a stale plan or HTTP 409 must be reviewed and regenerated. A successful apply
uses a full deployment, which stops and restarts all nodes and can cause
side-effects. A successful deployment confirms configuration acceptance, not
that every runtime node behaved correctly. No live flow file is edited by the
CLI; Node-RED owns persistence.

The `edit list` default shows workspace nodes; `--kind config` lists config
nodes (including global nodes, whose `tabId` and `tabLabel` are `null` and
empty). The `src/edit-api.js` module is the shared v2 transport seam. Query and
plan transformation logic are isolated in `src/edit-query.js` and
`src/edit-plan.js`; operation families reuse the same revision-checked client.

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
