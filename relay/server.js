/* PulpHeart VTT — relay de mesa
 *
 * Un bus de mensajes tonto. NO tiene lógica de juego y NO guarda el estado de la
 * partida: el navegador del GM sigue siendo la única fuente de verdad, igual que
 * cuando esto era P2P. El relay sólo reparte.
 *
 * Por qué existe: la versión P2P usaba WebRTC, que en redes móviles choca con el
 * CGNAT del operador y obliga a pasar por un TURN. Con TURN públicos gratuitos eso
 * fallaba constantemente desde el celular. Un WebSocket saliente hacia un host
 * público es sólo HTTPS y pasa por cualquier red, que es justamente el punto.
 *
 * Protocolo (lo habla el cliente en el VTT):
 *   conectar  ->  /room/<CODIGO>?role=host|player&id=<ID>&name=<NOMBRE>[&secret=<SECRETO>]
 *   jugador   ->  {t:'action', action:{...}}      el relay se lo pasa al GM
 *   GM        ->  {t:'state',  state:{...}}       el relay se lo pasa a los jugadores
 *   relay     ->  {t:'sys', kind:'join'|'leave'|'roster'|'no-host'|'replaced', ...}
 *
 * GET /ping responde para comprobar que el servidor está vivo antes de abrir el socket.
 */
const http = require('http');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8787;
const MAX_MSG = 8 * 1024 * 1024;   // el estado completo con retratos puede pesar
const rooms = new Map();           // code -> { host, hostSecret, players:Map<id,ws> }

const send = (ws, obj) => {
  if (ws && ws.readyState === ws.OPEN) {
    try { ws.send(JSON.stringify(obj)); } catch (e) { /* socket muerto */ }
  }
};
const roster = (room) => ({
  t: 'sys', kind: 'roster',
  players: [...room.players.entries()].map(([id, s]) => ({ id, name: s.__name || 'Player' }))
});

const server = http.createServer((req, res) => {
  if (req.url === '/ping' || req.url === '/') {
    res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
    res.end(JSON.stringify({ ok: true, service: 'pulpheart-relay', rooms: rooms.size }));
    return;
  }
  res.writeHead(404); res.end();
});

const wss = new WebSocketServer({ server, maxPayload: MAX_MSG });

wss.on('connection', (ws, req) => {
  let url;
  try { url = new URL(req.url, 'http://x'); } catch (e) { ws.close(1008, 'bad url'); return; }
  const m = url.pathname.match(/^\/room\/([^/]+)$/);
  if (!m) { ws.close(1008, 'bad path'); return; }

  const code   = decodeURIComponent(m[1]).toUpperCase();
  const role   = url.searchParams.get('role') === 'host' ? 'host' : 'player';
  const id     = url.searchParams.get('id') || Math.random().toString(36).slice(2);
  const name   = (url.searchParams.get('name') || '').slice(0, 40);
  const secret = url.searchParams.get('secret') || '';

  let room = rooms.get(code);
  if (!room) { room = { host: null, hostSecret: null, players: new Map() }; rooms.set(code, room); }

  ws.__role = role; ws.__id = id; ws.__name = name; ws.__code = code; ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  if (role === 'host') {
    /* El primer GM que entra fija el secreto de la sala. A partir de ahí sólo quien
       lo conoce puede reclamarla — si no, cualquiera que adivine el código de 6
       letras podría echar al GM y suplantarlo. Reconectar con el mismo secreto sí
       está permitido: es el caso normal cuando al GM se le cae el wifi. */
    if (room.hostSecret && secret !== room.hostSecret) {
      /* Avisar antes de cerrar. Medido contra el despliegue real: el cierre del
         socket puede tardar ~10s en llegarle al cliente a través del proxy, y sin
         este mensaje el impostor vería "hosting" todo ese rato aunque su conexión
         esté inerte. El mensaje sí llega al instante. */
      send(ws, { t: 'sys', kind: 'denied', reason: 'esta sala ya tiene GM' });
      setTimeout(() => { try { ws.close(4003, 'room already hosted'); } catch (e) {} }, 250);
      return;
    }
    if (!room.hostSecret) room.hostSecret = secret || null;
    if (room.host && room.host !== ws) {
      send(room.host, { t: 'sys', kind: 'replaced' });
      try { room.host.close(4000, 'replaced by a new host connection'); } catch (e) {}
    }
    room.host = ws;
    send(ws, roster(room));
    room.players.forEach(p => send(p, { t: 'sys', kind: 'host-back' }));
  } else {
    room.players.set(id, ws);
    if (!room.host) send(ws, { t: 'sys', kind: 'no-host' });
    else {
      send(room.host, { t: 'sys', kind: 'join', id, name });
      send(room.host, roster(room));
    }
  }

  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data); } catch (e) { return; }   // basura: ignorar
    if (!msg || typeof msg.t !== 'string') return;
    /* Salida explícita. Sin esto la baja tarda ~10s: el cierre del socket viaja
       lento a través del proxy y el servidor no se entera hasta el latido. Con el
       aviso, el resto de la mesa lo ve al instante. */
    if (msg.t === 'bye') { try { ws.close(1000, 'bye'); } catch (e) {} return; }
    if (ws.__role === 'host') {
      // el GM difunde a todos los jugadores; se reenvía tal cual, sin interpretarlo
      room.players.forEach(p => { if (p !== ws) send(p, msg); });
    } else {
      if (!room.host) { send(ws, { t: 'sys', kind: 'no-host' }); return; }
      msg.from = ws.__id;                                   // el GM sabe quién lo mandó
      send(room.host, msg);
    }
  });

  ws.on('close', () => {
    const r = rooms.get(ws.__code); if (!r) return;
    if (ws.__role === 'host') {
      if (r.host === ws) {
        r.host = null;
        r.players.forEach(p => send(p, { t: 'sys', kind: 'no-host' }));
      }
    } else {
      r.players.delete(ws.__id);
      if (r.host) { send(r.host, { t: 'sys', kind: 'leave', id: ws.__id }); send(r.host, roster(r)); }
    }
    // sala vacía: soltarla para no acumular memoria en un proceso de larga vida
    if (!r.host && r.players.size === 0) rooms.delete(ws.__code);
  });

  ws.on('error', () => {});
});

/* Un socket móvil que se muere sin cerrar (túnel, pantalla apagada, cambio de red)
   quedaría colgado para siempre. Este latido los limpia. 15s y no 30s porque, medido
   contra el despliegue real, el proxy tarda en propagar los cierres y este latido
   acaba siendo lo que de verdad detecta las bajas. */
const beat = setInterval(() => {
  wss.clients.forEach(ws => {
    if (ws.isAlive === false) { try { ws.terminate(); } catch (e) {} return; }
    ws.isAlive = false;
    try { ws.ping(); } catch (e) {}
  });
}, 15000);
wss.on('close', () => clearInterval(beat));

server.listen(PORT, () => console.log('pulpheart-relay escuchando en :' + PORT));
