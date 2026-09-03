# zai-proxy

Usa tu cuenta web de [chat.z.ai](https://chat.z.ai) como modelo para [grok-build](https://github.com/xai-org/grok-build). Expone un endpoint compatible con OpenAI en `http://127.0.0.1:8787/v1` y por cada petición escribe en la web con tu navegador.

> Ojo: automatizar la web probablemente va contra los términos de uso de Z.ai. Úsalo bajo tu responsabilidad.

## Requisitos

- Node 20+ y pnpm
- Un navegador Chromium: Brave, Chrome, Edge, Vivaldi, Arc o Chromium (Firefox y Safari no sirven)
- Cuenta en chat.z.ai
- grok-build instalado: `curl -fsSL https://x.ai/cli/install.sh | bash`

## Instalación

```sh
pnpm install
pnpm start
```

Se abre una ventana del navegador con un perfil propio. Inicia sesión en chat.z.ai una sola vez.
En el menú **Deep Think** (junto al botón de enviar) apaga el interruptor: con razonamiento encendido cada respuesta tarda mucho más.

## Configurar grok-build

Agrega a `~/.grok/config.toml`:

```toml
[models]
default = "zai-web"

[model.zai-web]
model = "zai-web"
base_url = "http://127.0.0.1:8787/v1"
name = "Z.ai (web)"
api_key = "x"
context_window = 128000
stream_tool_calls = false
```

Deja el proxy corriendo y usa `grok` normal.

## Variables opcionales

| Variable | Default | Qué hace |
|---|---|---|
| `PORT` | `8787` | Puerto del proxy |
| `ZAI_BROWSER` | el primero que encuentre | Canal (`msedge`, `chrome`) o ruta al binario |
| `ZAI_PROFILE` | `~/.zai-proxy-profile` | Carpeta del perfil del navegador |
| `ZAI_MAX_TURNS` | `50` | Turnos por chat antes de abrir uno nuevo con el historial |
| `ZAI_THINKING` | apagado | `1` si quieres Deep Think encendido |

## Comprobar

```sh
pnpm test   # self-check de la lógica, sin navegador
curl -s http://127.0.0.1:8787/v1/chat/completions -H 'content-type: application/json' \
  -d '{"messages":[{"role":"user","content":"Di solo: ok"}]}'
```

Si sale un captcha en la ventana, resuélvelo a mano; el proxy espera.
