/**
 * STM32 Nucleo-L476RG + MPU6050 + Arduino Mega — Dual Serial Bridge Server
 * =========================================================================
 * Stack: Node.js · Express · SerialPort · ws (WebSocket)
 *
 * Supports TWO serial connections:
 *   1. STM32 port  — receives gesture/sensor data
 *   2. Arduino port — sends motor commands (optional, for dual-MCU setups)
 *
 * If both MCUs are chained (STM32 TX → Arduino RX), only connect the STM32
 * port and use write_serial to relay commands through it.
 *
 * Usage:
 *   npm install          (first time only)
 *   node server.js
 *
 * Open your dashboard at:
 *   http://localhost:3000
 *
 * WebSocket endpoint:
 *   ws://localhost:8080
 */

'use strict';

const express    = require('express');
const http       = require('http');
const path       = require('path');
const { WebSocketServer } = require('ws');
const { SerialPort }      = require('serialport');
const { ReadlineParser }  = require('@serialport/parser-readline');

// ─── Config ──────────────────────────────────────────────────────────────────
const HTTP_PORT = 3000;
const WS_PORT   = 8080;
const DEFAULT_BAUD = 115200;

// ─── State ───────────────────────────────────────────────────────────────────
// STM32 serial (input — gesture data)
let stm32Port      = null;
let stm32Parser    = null;
let stm32PortPath  = null;

// Arduino serial (output — motor commands)
let arduinoPort     = null;
let arduinoParser   = null;
let arduinoPortPath = null;

let clients = new Set(); // connected WebSocket clients

// ─── Express (serves the dashboard HTML) ─────────────────────────────────────
const app = express();
app.use(express.static(path.join(__dirname)));   // serves any file in this folder

app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

const httpServer = http.createServer(app);
httpServer.listen(HTTP_PORT, () => {
  console.log(`\n[HTTP]  Dashboard → http://localhost:${HTTP_PORT}`);
});

// ─── WebSocket Server ─────────────────────────────────────────────────────────
const wss = new WebSocketServer({ port: WS_PORT });
console.log(`[WS]    WebSocket  → ws://localhost:${WS_PORT}`);

wss.on('connection', (ws) => {
  clients.add(ws);
  console.log(`[WS]    Client connected  (total: ${clients.size})`);

  // Send current connection state to new client
  ws.send(JSON.stringify({
    type: 'connection_state',
    stm32:   { connected: !!(stm32Port && stm32Port.isOpen),   port: stm32PortPath },
    arduino: { connected: !!(arduinoPort && arduinoPort.isOpen), port: arduinoPortPath },
  }));

  ws.on('message', (raw) => {
    let cmd;
    try { cmd = JSON.parse(raw); } catch { return; }
    handleClientCommand(ws, cmd);
  });

  ws.on('close', () => {
    clients.delete(ws);
    console.log(`[WS]    Client disconnected (remaining: ${clients.size})`);
  });

  ws.on('error', (err) => {
    console.error('[WS]    Client error:', err.message);
  });
});

// ─── Broadcast to all WS clients ─────────────────────────────────────────────
function broadcast(obj) {
  const msg = JSON.stringify(obj);
  for (const client of clients) {
    if (client.readyState === 1 /* OPEN */) {
      client.send(msg);
    }
  }
}

// ─── Handle commands from dashboard ──────────────────────────────────────────
async function handleClientCommand(ws, cmd) {
  switch (cmd.action) {

    // ──────────────── Port enumeration ────────────────
    case 'list_ports': {
      try {
        const ports = await SerialPort.list();
        const usable = ports.filter(p =>
          p.path &&
          !p.path.includes('Bluetooth') &&
          !p.path.includes('tty.debug')
        );
        ws.send(JSON.stringify({ type: 'ports', ports: usable }));
        console.log(`[PORTS] Found ${usable.length} port(s):`, usable.map(p => p.path));
      } catch (err) {
        ws.send(JSON.stringify({ type: 'error', message: 'Failed to list ports: ' + err.message }));
      }
      break;
    }

    // ──────────────── STM32 connect ────────────────
    case 'connect_stm32': {
      const portPath = cmd.port;
      const baud     = parseInt(cmd.baud) || DEFAULT_BAUD;
      if (!portPath) {
        ws.send(JSON.stringify({ type: 'error', message: 'No STM32 port specified.' }));
        return;
      }
      if (stm32Port && stm32Port.isOpen) await closePort('stm32');
      console.log(`[STM32] Connecting → ${portPath} @ ${baud}`);
      openPort('stm32', portPath, baud);
      break;
    }

    // ──────────────── STM32 disconnect ────────────────
    case 'disconnect_stm32': {
      if (stm32Port && stm32Port.isOpen) {
        const p = stm32PortPath;
        await closePort('stm32');
        broadcast({ type: 'stm32_disconnected', port: p });
        console.log(`[STM32] Manually disconnected from ${p}`);
      } else {
        ws.send(JSON.stringify({ type: 'error', message: 'No active STM32 connection.' }));
      }
      break;
    }

    // ──────────────── Arduino connect ────────────────
    case 'connect_arduino': {
      const portPath = cmd.port;
      const baud     = parseInt(cmd.baud) || DEFAULT_BAUD;
      if (!portPath) {
        ws.send(JSON.stringify({ type: 'error', message: 'No Arduino port specified.' }));
        return;
      }
      if (arduinoPort && arduinoPort.isOpen) await closePort('arduino');
      console.log(`[ARDUINO] Connecting → ${portPath} @ ${baud}`);
      openPort('arduino', portPath, baud);
      break;
    }

    // ──────────────── Arduino disconnect ────────────────
    case 'disconnect_arduino': {
      if (arduinoPort && arduinoPort.isOpen) {
        const p = arduinoPortPath;
        await closePort('arduino');
        broadcast({ type: 'arduino_disconnected', port: p });
        console.log(`[ARDUINO] Manually disconnected from ${p}`);
      } else {
        ws.send(JSON.stringify({ type: 'error', message: 'No active Arduino connection.' }));
      }
      break;
    }

    // ──────────────── Write to STM32 serial ────────────────
    case 'write_stm32': {
      const data = cmd.data;
      if (!data) return;
      if (stm32Port && stm32Port.isOpen) {
        stm32Port.write(data, (err) => {
          if (err) {
            console.error('[STM32] Write error:', err.message);
            broadcast({ type: 'error', message: 'STM32 write error: ' + err.message });
          } else {
            console.log(`[STM32] TX → ${data.trim()}`);
            broadcast({ type: 'serial_tx', target: 'stm32', data: data.trim() });
          }
        });
      } else {
        ws.send(JSON.stringify({ type: 'error', message: 'STM32 port not connected.' }));
      }
      break;
    }

    // ──────────────── Write to Arduino serial ────────────────
    case 'write_arduino': {
      const data = cmd.data;
      if (!data) return;
      if (arduinoPort && arduinoPort.isOpen) {
        arduinoPort.write(data, (err) => {
          if (err) {
            console.error('[ARDUINO] Write error:', err.message);
            broadcast({ type: 'error', message: 'Arduino write error: ' + err.message });
          } else {
            console.log(`[ARDUINO] TX → ${data.trim()}`);
            broadcast({ type: 'serial_tx', target: 'arduino', data: data.trim() });
          }
        });
      } else {
        // Fallback: try writing through STM32 port (chained setup)
        if (stm32Port && stm32Port.isOpen) {
          stm32Port.write(data, (err) => {
            if (err) {
              broadcast({ type: 'error', message: 'Fallback write error: ' + err.message });
            } else {
              console.log(`[STM32→ARDUINO] TX (relay) → ${data.trim()}`);
              broadcast({ type: 'serial_tx', target: 'stm32_relay', data: data.trim() });
            }
          });
        } else {
          ws.send(JSON.stringify({ type: 'error', message: 'No Arduino or STM32 port connected.' }));
        }
      }
      break;
    }

    // ──────────────── Legacy: connect (maps to stm32) ────────────────
    case 'connect': {
      const portPath = cmd.port;
      const baud     = parseInt(cmd.baud) || DEFAULT_BAUD;
      if (!portPath) {
        ws.send(JSON.stringify({ type: 'error', message: 'No port specified.' }));
        return;
      }
      if (stm32Port && stm32Port.isOpen) await closePort('stm32');
      console.log(`[STM32] Connecting (legacy) → ${portPath} @ ${baud}`);
      openPort('stm32', portPath, baud);
      break;
    }

    case 'disconnect': {
      if (stm32Port && stm32Port.isOpen) {
        const p = stm32PortPath;
        await closePort('stm32');
        broadcast({ type: 'stm32_disconnected', port: p });
        broadcast({ type: 'disconnected', port: p }); // legacy compat
      }
      break;
    }

    default:
      console.warn('[WS]    Unknown command:', cmd.action);
  }
}

// ─── Open Serial Port ─────────────────────────────────────────────────────────
function openPort(target, portPath, baud) {
  const port = new SerialPort({
    path: portPath,
    baudRate: baud,
    autoOpen: false,
  });

  const parser = port.pipe(new ReadlineParser({ delimiter: '\n' }));

  port.open((err) => {
    if (err) {
      console.error(`[${target.toUpperCase()}] Open failed: ${err.message}`);
      broadcast({ type: 'error', message: `Cannot open ${portPath}: ${err.message}` });
      return;
    }

    if (target === 'stm32') {
      stm32Port = port;
      stm32Parser = parser;
      stm32PortPath = portPath;
      console.log(`[STM32] Opened ${portPath} @ ${baud} baud`);
      broadcast({ type: 'stm32_connected', port: portPath, baud });
      broadcast({ type: 'connected', port: portPath, baud }); // legacy compat
    } else {
      arduinoPort = port;
      arduinoParser = parser;
      arduinoPortPath = portPath;
      console.log(`[ARDUINO] Opened ${portPath} @ ${baud} baud`);
      broadcast({ type: 'arduino_connected', port: portPath, baud });
    }
  });

  // ── Incoming data ──
  parser.on('data', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    if (target === 'stm32') {
      console.log(`[STM32] ${trimmed}`);
      broadcast({ type: 'data', line: trimmed, source: 'stm32' });

      // Auto-relay gesture to Arduino if connected
      if (arduinoPort && arduinoPort.isOpen) {
        const upper = trimmed.toUpperCase();
        const gestures = ['IDLE', 'WALK', 'RUN', 'SHAKE', 'PICKPLACE'];
        for (const g of gestures) {
          if (upper.includes(g)) {
            arduinoPort.write(g + '\n', (err) => {
              if (err) console.error('[RELAY] Error:', err.message);
              else console.log(`[RELAY] STM32 → Arduino: ${g}`);
            });
            break;
          }
        }
      }
    } else {
      console.log(`[ARDUINO] ${trimmed}`);
      broadcast({ type: 'arduino_data', line: trimmed, source: 'arduino' });
    }
  });

  // ── Errors ──
  port.on('error', (err) => {
    console.error(`[${target.toUpperCase()}] Error: ${err.message}`);
    broadcast({ type: 'error', message: `${target} error: ${err.message}` });
  });

  // ── Port closed unexpectedly ──
  port.on('close', () => {
    console.warn(`[${target.toUpperCase()}] Port closed`);
    if (target === 'stm32') {
      broadcast({ type: 'stm32_disconnected', port: stm32PortPath });
      broadcast({ type: 'disconnected', port: stm32PortPath }); // legacy
      stm32PortPath = null;
      stm32Port = null;
    } else {
      broadcast({ type: 'arduino_disconnected', port: arduinoPortPath });
      arduinoPortPath = null;
      arduinoPort = null;
    }
  });
}

// ─── Close Serial Port ────────────────────────────────────────────────────────
function closePort(target) {
  return new Promise((resolve) => {
    const port = target === 'stm32' ? stm32Port : arduinoPort;
    if (!port) { resolve(); return; }
    port.close((err) => {
      if (err) console.error(`[${target.toUpperCase()}] Close error:`, err.message);
      if (target === 'stm32') {
        stm32Port = null;
        stm32Parser = null;
      } else {
        arduinoPort = null;
        arduinoParser = null;
      }
      resolve();
    });
  });
}

// ─── Graceful shutdown ────────────────────────────────────────────────────────
process.on('SIGINT', async () => {
  console.log('\n[SERVER] Shutting down...');
  await closePort('stm32');
  await closePort('arduino');
  process.exit(0);
});

console.log('[SERVER] Ready. Waiting for dashboard connections...\n');
