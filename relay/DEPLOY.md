# Relay propio para PulpHeart VTT (WebSocket en Render, gratis)

Reemplaza al broker PeerJS de la carpeta `broker/`. Ese servía para que los jugadores
**encontraran** la sala, pero la conexión seguía siendo WebRTC — y WebRTC es justamente
lo que fallaba desde el celular.

## Por qué esto arregla el celular

En redes móviles el operador te pone detrás de un **CGNAT**: no tienes IP pública propia,
así que la conexión directa entre navegadores casi nunca se establece y WebRTC se ve
obligado a pasar por un servidor **TURN**. El VTT usaba TURN públicos gratuitos
(Open Relay), que están saturados y a veces bloqueados — de ahí que a veces conectara
y a veces no, sin patrón claro.

Este relay borra todo ese problema: el celular abre **un WebSocket saliente hacia un
host público**, que a efectos de la red es tráfico HTTPS normal. No hay NAT que
atravesar, ni STUN, ni TURN.

Lo que **no** cambia: el navegador del GM sigue siendo la única fuente de verdad del
estado. El relay es un bus tonto que reparte mensajes y no guarda ni entiende la partida.

## Pasos (una sola vez, ~10 min)

1. **GitHub** → github.com/new → nombre `pulpheart-relay` → público → crear.
   Sube los dos archivos de esta carpeta: `package.json` y `server.js`.

2. **Render** → render.com → entrar con tu cuenta de GitHub
   (si ya desplegaste el broker antes, ya la tienes).

3. En Render: **New + → Web Service** → conecta el repo `pulpheart-relay`.
   - Runtime: **Node**
   - Build command: `npm install`
   - Start command: `npm start`
   - Instance type: **Free**
   - Create Web Service.

4. Espera a que diga **Live** (2-3 min). Te da una URL tipo
   `https://pulpheart-relay.onrender.com`.
   **Verifica antes de seguir:** ábrela en el navegador. Debe responder
   `{"ok":true,"service":"pulpheart-relay","rooms":0}`. Si no responde eso, el resto
   no va a funcionar — arréglalo aquí.

5. **En el VTT** (tú Y cada jugador, una sola vez):
   modal de Campañas → **"config. de red (relay propio)"** →
   pegar `pulpheart-relay.onrender.com` (sin `https://`) → OK → recargar la página.

6. Tú entras como GM → botón **🧪** para confirmar que la sala responde desde
   internet → los jugadores entran normal.

## Letra chica del plan gratis de Render

- El servicio **se duerme tras ~15 min sin uso**. La primera conexión de la noche tarda
  ~1 minuto en despertarlo. El cliente reintenta 3 veces solo, lo que normalmente basta.
- Truco de GM: entra a tu campaña 2 minutos antes y el relay ya está despierto cuando
  lleguen los jugadores.
- Mientras haya alguien conectado el servicio **no** se duerme, así que a mitad de
  sesión no se cae por inactividad.

## Detalles que importan si algún día hay que tocarlo

- **El GM tiene un secreto por campaña** (`campHostSecret`, generado la primera vez y
  guardado en el estado). Sin él nadie puede reclamar tu sala: el código de 6 letras es
  corto y adivinable, y sin secreto cualquiera podría entrar como GM y suplantarte.
  Reconectar con el mismo secreto sí se permite — es lo que pasa cuando al GM se le
  cae el wifi.
- **Latido cada 30s.** Un socket móvil puede morir sin cerrar (pantalla apagada, cambio
  de wifi a datos) y quedaría colgado para siempre; el ping lo detecta y lo limpia.
- **Límite de mensaje: 8 MB.** El estado completo viaja en cada broadcast y ahora incluye
  los retratos de los personajes. Con 5 jugadores son ~235 KB, así que hay margen de
  sobra, pero si algún día se agregan imágenes grandes al mapa hay que subir este número
  **y** revisar cuánto pesa el estado.
- El relay **no guarda nada**. Si se reinicia, las salas se rehacen solas cuando el GM
  y los jugadores reconectan.
