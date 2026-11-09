# Preparar OpenCode V2 para TicketRunner

TicketRunner es experimental. Antes de ejecutar tickets, probá la instalación y la integración en un repositorio descartable.

## 1. Migrar OpenCode

La instalación oficial actual para Unix/Linux/macOS es:

```bash
curl -fsSL https://opencode.ai/v2/install | bash
```

Alternativa mediante npm (según tu instalación):

```bash
npm install -g @opencode/cli
```

Verificá la versión y que OpenCode funcione:

```bash
opencode --version
opencode models
```

Estos comandos pueden actualizar o reemplazar la instalación V1; el proyecto **no requiere mantener V1**. Antes de actualizar, guardá una copia de tus configuraciones y plugins para poder revisar las incompatibilidades.

Documentación: https://opencode.ai/docs y https://opencode.ai/docs/migrate-v1

## 2. Verificar Herdr

```bash
herdr --version
herdr
```

Consultar la instalación de la integración de OpenCode en la versión concreta de Herdr que tengas: https://herdr.dev/tui/docs/integrations/

## 3. Preparar modelos

Listá los modelos con `opencode models`. Configurá dos modelos **realmente gratuitos para tu cuenta** en `ticket-runner.config.json` (uno por rol como mínimo). TicketRunner no selecciona modelos pagos automáticamente y no hereda el modelo del planner.

## 4. Probar sin tokens

```bash
node --test
node bin/ticket-runner.mjs doctor --cwd /ruta/al/repo-de-prueba
node bin/ticket-runner.mjs preview 42 --cwd /ruta/al/repo-de-prueba
```

`doctor` comprueba herramientas y modelos; `preview` consulta un issue y muestra la configuración. El primer ensayo real debería hacerse con un issue trivial, en un repositorio descartable. El prototipo todavía **no ha sido validado end-to-end** con binarios reales de OpenCode V2 y Herdr.
