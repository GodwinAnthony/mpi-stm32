# STM32 Nucleo-L476RG + MPU6050 — Gesture Dashboard
## Real-Time Serial Bridge Setup Guide

---

## Architecture

```
STM32 Nucleo-L476RG
      │  UART → USB (ST-Link VCP)
      ▼
USB COM Port  (e.g. COM5 / /dev/ttyACM0)
      │
      ▼
Node.js Server  (server.js)
  ├── Express  → http://localhost:3000  (serves the dashboard)
  └── WebSocket → ws://localhost:8080   (real-time data stream)
      │
      ▼
Dashboard (stm32_mpu6050_gesture_dashboard.html)
```

---

## Prerequisites

| Tool | Version | Download |
|------|---------|----------|
| Node.js | ≥ 16.x | https://nodejs.org |
| npm | bundled with Node | — |
| STM32 drivers | ST-Link VCP | https://www.st.com/en/development-tools/stsw-link009.html |

---

## 1. Install Dependencies

```bash
npm install
```

This installs: `express`, `serialport`, `@serialport/parser-readline`, `ws`

---

## 2. Start the Server

```bash
node server.js
```

Expected output:
```
[HTTP]  Dashboard → http://localhost:3000
[WS]    WebSocket  → ws://localhost:8080
[SERVER] Ready. Waiting for dashboard connections...
```

---

## 3. Open the Dashboard

Open your browser and go to:
```
http://localhost:3000
```

Or open `stm32_mpu6050_gesture_dashboard.html` directly in a browser —
it will auto-connect to the WebSocket at `ws://localhost:8080`.

---

## 4. Connect to STM32

1. Plug in your STM32 Nucleo-L476RG via USB.
2. In the dashboard, click the **⚙ SERIAL** button (top-right).
3. Click **↺ Refresh** to scan for available COM ports.
4. Select your port from the dropdown (e.g. `COM5` on Windows, `/dev/ttyACM0` on Linux).
5. Set baud rate to match your STM32 UART config (default: **115200**).
6. Click **▶ Connect**.

The status bar will show:
```
COM5  Connected   STM32 Online   Stream Active
```

---

## 5. STM32 Firmware — Expected UART Output

### Simple Mode (plain text)

Your STM32 should send newline-terminated strings over UART:

```c
// Walking detected
HAL_UART_Transmit(&huart2, (uint8_t*)"WALKING\n", 8, HAL_MAX_DELAY);

// Idle / no motion
HAL_UART_Transmit(&huart2, (uint8_t*)"IDLE\n", 5, HAL_MAX_DELAY);
```

### Advanced Mode (JSON with sensor values)

For live accelerometer/gyroscope graphs, send JSON:

```c
char buf[96];
snprintf(buf, sizeof(buf),
  "{\"state\":\"WALKING\",\"ax\":%.2f,\"ay\":%.2f,\"az\":%.2f,\"gx\":%.1f,\"gy\":%.1f,\"gz\":%.1f}\n",
  ax, ay, az, gx, gy, gz);
HAL_UART_Transmit(&huart2, (uint8_t*)buf, strlen(buf), HAL_MAX_DELAY);
```

The dashboard auto-detects the format.

---

## 6. STM32 UART Configuration (CubeMX)

| Parameter | Value |
|-----------|-------|
| USART | USART2 (connected to ST-Link VCP on Nucleo) |
| Baud Rate | 115200 |
| Word Length | 8 bits |
| Stop Bits | 1 |
| Parity | None |
| Mode | TX only (or TX/RX) |

> On the Nucleo-L476RG, **USART2** is routed to the ST-Link USB Virtual COM Port automatically. No extra USB-TTL adapter needed.

---

## 7. Dashboard Status Indicators

| Indicator | Green | Amber | Red/Gray |
|-----------|-------|-------|----------|
| COM Port | Connected | — | Disconnected |
| STM32 | Online | — | Offline |
| Stream | Active (data flowing) | — | Waiting |
| WS | Server connected | Reconnecting | — |

---

## 8. Activity Log

The **STM32 Activity Log** panel (bottom center) shows:
- All incoming WALKING / IDLE events with timestamps
- Connection/disconnection events
- Errors

Last **50 events** are kept. Click **CLEAR** to reset.

---

## 9. Offline Mode

If the COM port disconnects unexpectedly:
- A red banner appears at the top of the dashboard
- The dashboard preserves the last known state
- The WebSocket client automatically retries every **3 seconds**

---

## 10. File Structure

```
project/
├── stm32_mpu6050_gesture_dashboard.html   ← Dashboard (open in browser)
├── server.js                              ← Node.js serial bridge
├── package.json                           ← Dependencies
└── README.md                              ← This file
```

---

## Troubleshooting

**Port not appearing in dropdown**
- Check Device Manager (Windows) or `ls /dev/tty*` (Linux/Mac)
- Install ST-Link VCP drivers from ST website
- Try a different USB cable

**"Cannot open COMx" error**
- Another app (STM32CubeIDE, PuTTY, etc.) may have the port open — close it
- On Linux, add your user to the `dialout` group: `sudo usermod -a -G dialout $USER`

**No data after connecting**
- Verify baud rate matches your firmware
- Check that your STM32 is transmitting (LED activity on the board)
- Test with a serial terminal (PuTTY / CoolTerm) to verify UART output

**Dashboard shows "Cannot reach server"**
- Make sure `node server.js` is running
- Check that nothing else is using ports 3000 or 8080
