/**
 * STM32 Nucleo-L476RG + MPU6050 — Serial Bridge Server
 * =====================================================
 * Stack: Node.js · Express · SerialPort · ws (WebSocket)
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
let serialPort   = null;   // active SerialPort instance
let parser       = null;   // readline parser
let activePortPath = null;
let clients      = new Set(); // connected WebSocket clients

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

    case 'list_ports': {
      try {
        const ports = await SerialPort.list();
        // Filter out internal/virtual ports that aren't real hardware
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

    case 'connect': {
      const portPath = cmd.port;
      const baud     = parseInt(cmd.baud) || DEFAULT_BAUD;

      if (!portPath) {
        ws.send(JSON.stringify({ type: 'error', message: 'No port specified.' }));
        return;
      }

      // Close existing connection first
      if (serialPort && serialPort.isOpen) {
        await closeSerial();
      }

      console.log(`[SERIAL] Connecting → ${portPath} @ ${baud}`);
      openSerial(portPath, baud);
      break;
    }

    case 'disconnect': {
      if (serialPort && serialPort.isOpen) {
        await closeSerial();
        broadcast({ type: 'disconnected', port: activePortPath });
        console.log(`[SERIAL] Manually disconnected from ${activePortPath}`);
        activePortPath = null;
      } else {
        ws.send(JSON.stringify({ type: 'error', message: 'No active connection.' }));
      }
      break;
    }

    default:
      console.warn('[WS]    Unknown command:', cmd.action);
  }
}

// ─── Open Serial Port ─────────────────────────────────────────────────────────
function openSerial(portPath, baud) {
  serialPort = new SerialPort({
    path: portPath,
    baudRate: baud,
    autoOpen: false,
  });

  parser = serialPort.pipe(new ReadlineParser({ delimiter: '\n' }));

  serialPort.open((err) => {
    if (err) {
      console.error(`[SERIAL] Open failed: ${err.message}`);
      broadcast({ type: 'error', message: `Cannot open ${portPath}: ${err.message}` });
      return;
    }

    activePortPath = portPath;
    console.log(`[SERIAL] Opened ${portPath} @ ${baud} baud`);
    broadcast({ type: 'connected', port: portPath, baud: baud });
  });

  // ── Incoming data from STM32 ──
  parser.on('data', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    console.log(`[STM32] ${trimmed}`);

    // Forward raw line to all dashboard clients
    broadcast({ type: 'data', line: trimmed });
  });

  // ── Serial port errors ──
  serialPort.on('error', (err) => {
    console.error(`[SERIAL] Error: ${err.message}`);
    broadcast({ type: 'error', message: err.message });
  });

  // ── Port closed unexpectedly ──
  serialPort.on('close', () => {
    console.warn(`[SERIAL] Port closed: ${activePortPath}`);
    broadcast({ type: 'disconnected', port: activePortPath });
    activePortPath = null;
    serialPort = null;
  });
}

// ─── Close Serial Port ────────────────────────────────────────────────────────
function closeSerial() {
  return new Promise((resolve) => {
    if (!serialPort) { resolve(); return; }
    serialPort.close((err) => {
      if (err) console.error('[SERIAL] Close error:', err.message);
      serialPort = null;
      parser     = null;
      resolve();
    });
  });
}

// ─── Graceful shutdown ────────────────────────────────────────────────────────
process.on('SIGINT', async () => {
  console.log('\n[SERVER] Shutting down...');
  await closeSerial();
  process.exit(0);
});

console.log('[SERVER] Ready. Waiting for dashboard connections...\n');
