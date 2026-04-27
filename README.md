# ⛏️ MC Panel — Minecraft Bedrock Server Dashboard

A production-grade, self-hosted web panel for managing a **Minecraft Bedrock Dedicated Server** from your browser.

---

## ✨ Features

| Feature | Details |
|---|---|
| **Live Console** | Real-time server logs via WebSocket; send any command from the browser |
| **Server Control** | Start · Stop · Restart · Force Kill buttons |
| **File Manager** | Browse, edit, upload, download, rename, delete any file in `server/` |
| **Addon Manager** | Upload `.mcpack` / `.mcaddon` straight into behavior or resource packs |
| **Settings Editor** | Edit `server.properties` key-by-value from a clean form |
| **Player Manager** | Live online players + Allowlist editor + Permissions editor |
| **Playit.gg Tunnel** | One-click Docker-based tunnel to give friends a public address |
| **Auto Backups** | Full `server/` ZIP created on every panel-initiated stop |
| **Manual Backups** | On-demand backup + download at any time |
| **Secure Login** | Session-based auth; first-run setup wizard; no default credentials left active |

---

## 🧰 Prerequisites

- **Linux** (VPS, dedicated server, GitHub Codespace with Docker)
- **Node.js 18+** and **npm**
- **Docker** *(optional — needed for Playit tunnel from the panel)*
- A free [Playit.gg](https://playit.gg) account *(optional — for public tunnels)*

---

## 🚀 Quick Start

### 1. Clone / copy the panel files

```bash
git clone <your-repo> mc-panel
cd mc-panel
```

### 2. Install Node.js dependencies

```bash
npm install
```

### 3. Place Bedrock server files in `server/`

```bash
cd server

# Download the latest Bedrock dedicated server from Mojang
wget https://www.minecraft.net/bedrockdedicatedserver/bin-linux-preview/bedrock-server-1.26.20.28.zip

# Unzip and clean up
unzip bedrock-server-*.zip
rm   bedrock-server-*.zip

# Make the binary executable
chmod +x bedrock_server

cd ..
```

> **Stable vs Preview:** If you download the *stable* server, your players need the *stable* game client. If you download *preview*, they need the Minecraft Preview app.

### 4. Start the panel

```bash
node server.js
# or
npm start
```

The panel will:
- Accept the Mojang EULA automatically (`eula=true`)
- Start the Bedrock server
- Listen on **port 3000**

### 5. Open the panel

- **Same machine:** `http://localhost:3000`
- **GitHub Codespace:** Forward port 3000 and set it to **Public** in the PORTS tab
- **VPS:** `http://<your-ip>:3000`

You'll see the **Setup** page. Choose your admin username and password. Then log in.

---

## 🌐 Making the Server Public (Playit.gg Tunnel)

1. Sign up at [playit.gg](https://playit.gg) and create an **agent**.
2. Copy the **secret key** from the agent's connection page.
3. In the panel → **Tunnel** tab, paste the secret and click **Save**.
4. Click **Start Tunnel**. The panel launches a Docker container with the Playit agent.
5. On the Playit website, create a tunnel for your agent:
   - Protocol: **UDP** (Minecraft Bedrock)
   - Local host: `127.0.0.1`, port: `19132`
6. Share the public `ip:port` with your friends. 🎉

> **No Docker?** Download the `playit` binary from [Playit's GitHub releases](https://github.com/playit-cloud/playit-agent/releases), place it in the `mc-panel/` root folder, and the panel will use it as a fallback.

---

## 📁 Project Structure

```
mc-panel/
├── server.js              ← Backend (Express + WebSocket)
├── package.json
├── users.json             ← Created on first setup (admin credentials)
├── tunnel_secret.json     ← Created when you save a Playit secret
│
├── public/
│   ├── index.html         ← Main dashboard (single-page app)
│   ├── login.html         ← Login page
│   └── setup.html         ← First-run setup page
│
├── server/                ← Bedrock server files go here
│   ├── bedrock_server     ← The binary (you place this)
│   ├── server.properties
│   ├── allowlist.json
│   ├── permissions.json
│   └── …
│
└── backups/               ← ZIP backups stored here
    └── backup-2025-01-01T…zip
```

---

## ⚙️ Configuration

All configuration is at the top of `server.js`:

```js
const CONFIG = {
  PORT            : 3000,    // Web panel port
  CONSOLE_HISTORY : 500,     // Lines kept in memory per session
  STOP_TIMEOUT_MS : 12000,   // ms before force-kill after "stop"
  BACKUP_ON_STOP  : true,    // Auto-backup on panel-initiated stop
};
```

---

## 🔁 Day-to-Day Usage

| Action | How |
|---|---|
| Start / stop / restart server | Buttons in the Console tab |
| Send a command | Console tab → command input → Enter |
| Edit a world file | Files tab → navigate → click → inline editor |
| Install an addon | Addons tab → upload `.mcpack` → restart server |
| Change server settings | Settings tab → edit form → Save |
| Manage whitelist | Players tab → Allowlist section |
| Download a backup | Backups tab → Download |

---

## 🔒 Security Notes

- Change the default password on first run — the panel forces this.
- For public-facing deployments, put the panel behind **Nginx with HTTPS** and use the Codespace / Cloudflare Tunnel approach rather than exposing port 3000 directly.
- The file manager **cannot escape the `server/` directory** — path traversal is blocked server-side.

---

## 🛠️ Troubleshooting

| Problem | Fix |
|---|---|
| "bedrock_server binary not found" | Place Bedrock server files inside `server/` and `chmod +x bedrock_server` |
| Port 19132 already in use | The panel auto-kills old `bedrock_server` processes on start. If it persists, run `pkill -f bedrock_server` |
| Tunnel won't start | Ensure Docker is running (`docker info`), or place a `playit` binary in the panel root |
| Console shows "Connecting…" | The WebSocket URL is wrong — make sure you're accessing the correct host/port |
| Can't log in after setup | Delete `users.json` and restart — you'll be taken back to setup |

---

## 📄 License

MIT — use and modify freely.
