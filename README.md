# nr-call

## Node-RED-Flows wie Unix-Funktionen aufrufen

`nr-call` untersucht eine einfache, leistungsfähige Idee: Bestehende
Node-RED-Flows sollen sich aus einer CLI oder einem Node.js-Host wie normale
Funktionen verwenden lassen.

```bash
echo '{"payload":{"x":4,"y":5}}' | nr-call flows.json calculate
```

```json
{"payload":9}
```

Damit wird Node-RED vom visuellen Automatisierungswerkzeug zum wiederverwendbaren
Runtime-Baustein für Skripte, Services, Pipelines und Entwickler-Tools.

## Die Idee

Ein bestehender Flow wird zu einer klaren Input-/Output-Schnittstelle:

```text
stdin / CLI-Parameter
        |
        v
   Node-RED Runtime
        |
        v
   link in: calculate -> beliebiger Flow -> link out: return
        |
        v
stdout / Promise<Result>
```

Der Flow bleibt dabei unverändert. Keine zusätzlichen CLI-Nodes, kein manuelles
Kopieren von Logik und kein dauerhaftes Deployment einer speziellen Adapter-
Struktur.

## Warum nr-call?

- **Bestehende Flows wiederverwenden:** Die Geschäftslogik bleibt dort, wo sie
  bereits gepflegt wird: in Node-RED.
- **Die echte Node-RED-Runtime nutzen:** Core- und Contrib-Nodes müssen nicht
  nachgebaut werden.
- **CLI-freundliche Ein-/Ausgabe:** JSON hinein, JSON hinaus.
- **Asynchronität inklusive:** Node-RED-Flows können auf ihre normale Weise
  arbeiten.
- **Sicher begrenzte Aufrufe:** Timeouts verhindern, dass ein Prozess dauerhaft
  hängen bleibt.
- **Saubere Trennung:** Ergebnisse gehen über `stdout`, Logs und Fehler über
  `stderr`.
- **Keine Flow-Mutation:** Der PoC fügt keine temporären Nodes ein und deployt
  `flows.json` nicht neu.

## Aktueller PoC

Dieses Repository demonstriert einen Host-seitigen Adapter für Node-RED 5.0.4.
Der Adapter ruft einen vorhandenen `link in` auf und fängt die Antwort eines
`link out` im Return-Modus als Promise ab.

Der enthaltene Testflow berechnet `x + y`:

```text
link in: calculate -> Function -> link out: return
```

Der PoC verifiziert:

1. Einen erfolgreichen Aufruf mit dem Ergebnis `{ payload: 9 }`.
2. Die Preflight-Validierung eines unbekannten Ziels.
3. Einen Timeout bei einem nicht rechtzeitig antwortenden Flow.
4. Einen unveränderten SHA-256-Hash von `flows.json` vor und nach dem Aufruf.

## Schnellstart

```bash
npm install
npm test
```

Beispielausgabe:

```json
{"result":{"payload":9,"_msgid":"..."},"preflight":"verified","timeout":"verified","flowMutation":"none"}
```

Die `_msgid` wird von Node-RED erzeugt und ist bei jedem Lauf unterschiedlich.

## Host-API

Die zentrale Schnittstelle ist bewusst klein gehalten:

```js
const { createHostLinkCaller } = require("./host-link-call");

const caller = createHostLinkCaller(RED);

const result = await caller.call(
  "calculate",
  { payload: { x: 4, y: 5 } },
  { flow: "poc-tab", timeout: 5000 }
);

console.log(result.payload); // 9
caller.close();
```

Als Flow kann die Tab-ID oder das eindeutige Tab-Label verwendet werden. Ohne
Angabe wird der einzige vorhandene Workspace-Tab ausgewählt.

## Technischer Ansatz

Node-REDs Link-Call-Semantik verwendet `_linkSource`, um den Ursprung eines
Aufrufs für einen Return-Link verfügbar zu machen. Dieser PoC setzt den
notwendigen Stackeintrag host-seitig und registriert einen gezielten
`onReceive`-Hook. Die Return-Nachricht löst die Promise auf, bevor der
Link-out-Node den Caller über `RED.nodes.getNode(...)` auflösen muss.

Das ist eine schlanke Kompatibilitätsschicht für Node-RED 5.0.x, keine
öffentliche Runtime-API. Die interne Semantik wird deshalb hinter
`createHostLinkCaller(RED)` gekapselt und sollte für jede unterstützte
Node-RED-Version separat integriert getestet werden.

## Preflight und Grenzen

Vor dem Aufruf kann `validateTarget(RED, targetId)` prüfen:

- Ziel-ID und Zieltyp `link in`
- Instanziierung des Ziel-Nodes
- fehlende Wire-Ziele und doppelte IDs
- mindestens einen erreichbaren `link out` mit `mode: "return"`
- Instanziierung der erreichbaren Return-Nodes
- Verfügbarkeit der erforderlichen Runtime-Hooks

Die Validierung beweist nicht, dass ein Flow semantisch terminiert oder genau
eine Antwort liefert. Dafür bleibt ein Laufzeit-Timeout erforderlich.

## Ausblick

Das langfristige Ziel ist eine stabile, offizielle Host-API im Node-RED-Core:

```js
const result = await callNodeRedFlow({
  target: "calculate",
  msg,
  timeout: 5000
});
```

Oder als Runtime-Schnittstelle:

```js
const result = await RED.runtime.flows.call("calculate", msg, {
  timeout: 5000
});
```

Die Recherche konzentriert sich darauf, welche Teile der bestehenden
`node.linkcall()`-Implementierung verallgemeinert werden können und wie eine
kleine Upstream-API wie `RED.nodes.callLink()` oder
`RED.runtime.flows.call()` aussehen könnte.

## Status

**Proof of Concept:** Der Ansatz funktioniert für den enthaltenen Node-RED-
5.0.4-Testflow. Die verwendeten Link-Call-Interna sind nicht als öffentliche
Node-RED-API stabilisiert. Produktionsnutzung erfordert deshalb eine bewusste
Versionsbindung, Integrations-Tests und eine robuste Fehlerbehandlung für
mehrdeutige oder nicht terminierende Flows.
