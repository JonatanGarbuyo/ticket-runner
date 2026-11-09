# TicketRunner — OpenCode V2 + Herdr

Prototipo técnico de orquestación económica: **un implementer (modelo gratuito A) y un reviewer independiente (modelo gratuito B)**, visibles en Herdr, con correcciones automáticas y aprobación humana al final. El planner no gasta tokens coordinando panes.

**Estado:** v0.1; seis pruebas automatizadas con simulación de agentes, **sin prueba end-to-end con binarios reales de OpenCode/Herdr**. Usar primero en un repositorio de prueba.

## Migración a OpenCode V2

Antes de probar este prototipo, seguí [docs/MIGRATION.md](docs/MIGRATION.md) para instalar V2 y verificar tu entorno sin consumir tokens.

## Prerrequisitos

- Node.js >=20, Git, GitHub CLI (`gh`), OpenCode **V2**, Herdr instalado y ejecutándose.
- `gh auth login` y acceso a Issues del repositorio.
- Modelos configurados/conectados en OpenCode. Ver la lista real con `opencode models`.
- Skills de Matt Pocock, en particular `code-review` disponible para OpenCode.
- Repositorio Git con un issue abierto y HEAD comprometido; no se modifica el checkout principal (se crea un **worktree**).

## Preparación

```bash
# En el directorio DESCOMPRIMIDO de TicketRunner:
npm install
npm test

# Desde cualquier ubicación:
node /ruta/ticket-runner-opencode-v2/bin/ticket-runner.mjs init --cwd /ruta/tu-repo
```

El comando `init` crea (sin sobrescribir) tres archivos en el repo destino:

- `ticket-runner.config.json`
- `.opencode/agents/ticket-implementer.md`
- `.opencode/agents/ticket-reviewer.md`

Editá `ticket-runner.config.json` con los **IDs exactos de modelos gratuitos** que veas en `opencode models` y los comandos de verificación de tu proyecto. Los placeholders hacen que TicketRunner se niegue a correr. Una entrada en la lista no indica automáticamente que sea gratuita: **vos aprobás cuáles son free para tu cuenta**. El implementer y reviewer no pueden usar el mismo modelo.

Guardá los archivos de agentes en Git: el nuevo worktree tiene que poder encontrarlos.

## Activar el plugin en OpenCode V2

En el `opencode.jsonc` del repo (respetando las otras opciones existentes), añadí la ruta absoluta al directorio descomprimido:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["/ruta/absoluta/ticket-runner-opencode-v2"]
}
```

Si ya tenés un campo `plugins`, agregá esta entrada a su lista; no lo reemplaces. Reiniciá OpenCode para cargarlo.

El comando registrado por el plugin es:

```text
/ticket-run 42
/ticket-run 42 --impl-model provider/model-a --review-model provider/model-b
```

**El comando no llama a un modelo para coordinar**: lanza un proceso Node.js independiente y agrega un mensaje sintético en la sesión. No abre un selector interactivo porque la ejecución es desatendida; utiliza los primeros modelos gratuitos elegibles de la configuración, salvo overrides explícitos.

El log del launcher se guarda en `~/.local/state/ticket-runner/launcher.log`.

## Uso alternativo desde una terminal (con selector y timeout)

```bash
cd /ruta/tu-repo
TR=/ruta/ticket-runner-opencode-v2/bin/ticket-runner.mjs

node "$TR" doctor
node "$TR" preview 42
node "$TR" run 42 --select-models
```

`--select-models` muestra la allowlist conectada, espera hasta 15 segundos por cada rol y, si no recibe respuesta, elige el primer modelo autorizado. En modo no interactivo utiliza el primero automáticamente. No existe fallback implícito a modelos caros.

## Qué hace al ejecutar

1. Lee el issue con `gh issue view`.
2. Crea una rama `agent/ticket-...` en un **Git worktree aislado**.
3. Crea un workspace de Herdr y dos panes; no necesitás identificar IDs.
4. Inicia OpenCode V2 en cada pane, pasando `--agent` y `--model` explícitos.
5. Implementer hace commit y escribe `.ticket-runner/implementation.json`.
6. Los checks configurados corren con logs completos guardados en disco. El implementer solo recibe extractos de fallos.
7. Reviewer, en otro modelo, ejecuta `code-review` y escribe `.ticket-runner/review.json`.
8. Si hay fallos, se devuelve feedback a la misma sesión del implementer y se repite la revisión.
9. Si aprueba, el estado pasa a `AWAITING_HUMAN`. **No cierra issue, no hace merge**.

Un `agent prompt --wait` solo significa que Herdr observó fin de actividad; TicketRunner requiere JSON válido, commit real, checks y veredicto.

## Aprobación humana y correcciones visuales

Al terminar, el comando imprime un identificador `42-<run-id>` y la rama creada. También podés usar simplemente `42` para seleccionar la ejecución más reciente de ese issue. Revisá el resultado en Herdr y tu aplicación. Para un problema visual o de UX:

```bash
node "$TR" status 42
node "$TR" feedback 42 "El modal se desborda en 375px"
```

Esto reutiliza **las mismas dos sesiones visibles** (no se utiliza `--continue`). Cuando estés satisfecho:

```bash
node "$TR" approve 42           # Estado local DONE
node "$TR" approve 42 --close-issue  # Además cierra el issue en GitHub
```

Tras aprobar, la rama y el worktree se conservan para revisión, push y eventual PR/merge manual. No se eliminan automáticamente.

## Alcance y limitaciones importantes

- Este prototipo usa **Herdr como canal de transporte y observación**, no la API de sesiones de OpenCode directamente; Herdr conoce los panes, pero v0.1 todavía no persiste el ID interno de OpenCode. Si cerrás los panes, no puede recuperarlos automáticamente.
- **No detecta aún agotamiento de cuota para rotar modelos en caliente**. Ante un fallo de proveedor o timeout se marca `BLOCKED`. La rotación explícita es un incremento posterior.
- Los permisos del reviewer y sus subagentes **deben verificarse con las versiones concretas instaladas**. Las instrucciones del agente por sí solas no garantizan aislamiento de escritura. El prototipo no afirma que los dos subagentes de `code-review` estén confinados a lectura.
- No hay notificaciones push. Se inspecciona con `status`, Herdr o leyendo el archivo de estado.
- No se comprueba todavía que el issue esté libre de dependencias pendientes. Es una precondición operativa del usuario.
- El runner está pensado para **una ejecución por issue**, no correr varios tickets simultáneamente. No hay lock distribuido; evitá lanzar el mismo issue en paralelo.
- En `AWAITING_HUMAN` el orquestador no sigue enviando prompts, pero el `ticket-runner run` puede seguir siendo un proceso ocupado hasta completar una vuelta; el comando plugin lo lanza detached.
- Al usar herramientas externas, los permisos de acceso a red y repositorio siguen siendo responsabilidad de tu instalación y del sistema de roles.

Especificación y próximas fases: [docs/SPEC.md](docs/SPEC.md).

## Fuentes técnicas

- https://opencode.ai/docs/build/plugins/
- https://opencode.ai/docs/build/plugins/server/
- https://opencode.ai/docs/agents/
- https://opencode.ai/docs/cli/commands/
- https://herdr.dev/tui/docs/agent-automation/
- https://herdr.dev/tui/docs/socket-api/
- https://github.com/mattpocock/skills/tree/main/skills/engineering/code-review
