# TicketRunner — Especificación técnica v0.1

Fecha: 2026-11-09. Estado: prototipo, **sin validación contra Herdr/OpenCode reales**.

## Problema

El planner (modelo frontier) debe dejar de gastar tokens en coordinar panes, consultar estados y retransmitir conversaciones. Los trabajadores gratuitos de distintos modelos implementan y revisan hasta lograr una entrega técnica aceptable. La aprobación humana es la única que marca `DONE`.

## Fuera de alcance inicial

- No se requiere Wayfinder para tareas pequeñas: basta un issue creado después de `grill-me`.
- No se implementa otro engine de issues: GitHub es la fuente de verdad del trabajo.
- No hay Playwright, inspección visual automática ni Codex.
- No hay integración automática con ChatGPT web ni automatización de su interfaz.
- No hay cuantificación exhaustiva de tokens, sistema de cuotas ni fallback automático de modelo ante error de proveedor en v0.1.
- No hay PR/merge automático; se trabaja sobre un worktree y una rama dedicada.

## Arquitectura

```text
OpenCode V2 planner (smart) -- /ticket-run 42 --> plugin / ticket-runner CLI
                                                       |
                                                 GitHub issue
                                                       |
                                          modelo elegido de allowlist
                                                       |
                                       Herdr: workspace + dos panes
                                                       |
                      +--------------------------------+------------------+
                      |                                                   |
                Implementer A                                    Reviewer B
           OpenCode V2, sesión nueva                      OpenCode V2, sesión nueva
           commit + implementation.json                   code-review + review.json
                      |                                                   |
                      +--> checks deterministas --------->+<--------------+
                           ^                               |
                           +---------- cambios pedidos ---+
                                                       |
                                               AWAITING_HUMAN
                                                       |
                                 feedback -> mismo contexto / approve -> DONE
```

## Contrato de roles

- **Planner:** elige el trabajo y delega; no crea panes ni revisa a cada paso.
- **Coordinador:** código Node.js. No invoca un modelo. Decide transiciones a partir de estados y artefactos.
- **Implementer:** modelo A explícito, rama/worktree aislado, ejecuta código, tests y commits. No llama `code-review` para evitar autocorrección y doble revisión.
- **Reviewer:** modelo B diferente, lee issue + diff de base...HEAD, usa `code-review` (con sus dos ejes) y devuelve findings. No corrige código.
- **Humano:** acepta o reporta bugs (incluyendo visuales). El ticket sigue abierto hasta aceptación.

## Modelo de estados

`PREPARING → READY → IMPLEMENTING → VERIFYING → REVIEWING → AWAITING_HUMAN → DONE`.

Salidas:
- `VERIFYING` con error: implementer corrige dentro de la misma sesión.
- `REVIEWING` con findings bloqueantes: implementer corrige dentro de la misma sesión.
- `AWAITING_HUMAN` con feedback: implementer corrige dentro de la misma sesión; se repite review.
- JSON ausente, error de cuota, sesión colgada, error de transporte, falta de progreso: `BLOCKED` con intervención manual; **nunca interpretar `idle` como trabajo aprobado**.
- `maxReviewCycles` es límite a ciclos infructuosos, no límite arbitrario de tokens.

## Persistencia

- Fuente de verdad: GitHub Issues (spec, relaciones, estado de aceptación).
- Estado operativo: `~/.local/state/ticket-runner/<repo-hash>/<issue>-<run-id>/state.json`.
- Archivos de protocolo en `<worktree>/.ticket-runner/`, excluidos del control de versiones local.
- El estado registra roles, modelos, panes, base SHA, worktree, ronda y veredicto.
- Pane y sesión son conceptos distintos; no se usa `--continue`.

## Costos

- Listas permitidas de modelos gratuitos por rol. Nunca heredar el modelo del planner.
- Selector humano opcional con 15 s de timeout y selección gratuita predeterminada.
- Verificar que el modelo figura entre los conectados (`opencode models`). **No deducir gratuidad del nombre**; los modelos deben ser aprobados previamente por el usuario.
- El reviewer hace dos análisis (spec y estándares) usando modelo B, sin necesidad de un nuevo agente permanente.
- El verificador guarda logs completos y solo transmite extractos de fallos.

## Decisiones técnicas validadas en documentación

- Herdr: `workspace create` devuelve root pane; `pane split` devuelve segundo pane; `agent start --kind opencode` acepta argumentos para OpenCode; `agent prompt --wait` observa fin de actividad, no éxito semántico.
- OpenCode V2: paquete `@opencode/plugin`, `Plugin.define`, `ctx.command.transform`; `session.synthetic` permite informar sin prompt a modelo; el launcher CLI admite `--model` y `--agent`.

## Riesgos / próximos incrementos

1. Probar flags concretos en la versión instalada de Herdr y OpenCode V2.
2. Validar permisos efectivos del reviewer y de sus subagentes en el proyecto real; no asumir herencia de restricciones.
3. Manejar error de cuota con rotación controlada entre modelos permitidos y recuperación de sesión concreta.
4. Mejorar detección de falta de progreso y bloqueo de permisos que requieren aprobación humana.
5. Registrar IDs reales de OpenCode Session mediante eventos/plugin (v0.1 registra el pane/alias y mantiene la TUI del agente durante el ticket).
6. Retomar en el mismo agente tras reinicio de proceso mediante ID persistente, no mediante `--continue`.
7. Agregar integración opcional con PR de GitHub y `ChatGPT web` mediante entrega manual, sin automatizar la UI.
8. Evaluar subagentes independientes y control de sus modelos antes de afirmar aislamiento completo.

## Criterios de aceptación del prototipo

- Cero llamadas al planner después de `/ticket-run 42`.
- Herdr muestra dos panes con modelos A/B distintos configurados explícitamente.
- Implementer no invoca subagentes de revisión; reviewer evalúa specs y estándares.
- Un cambio pedido genera una nueva vuelta al MISMO pane/sesión del implementer.
- Tests exitosos se resumen en estado; logs detallados se consultan solo ante fallo.
- Un agent `idle` sin JSON válido no hace avanzar el ticket.
- El ticket llega a `AWAITING_HUMAN`, nunca a `DONE` sin acto humano.
