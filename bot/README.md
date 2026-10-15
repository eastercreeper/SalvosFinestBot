# Salvo's Finest Discord Bot & Role Synchronization Service

This service automatically synchronizes Apex Custom Lobby teams generated on the website with your Discord server, managing team roles (`Team 1`, `Team 2`, `Team 3`, etc.) seamlessly and idempotently.

---

## 🏗 Architecture & Security Overview

```
┌─────────────────────────────────┐
│     Salvo's Finest Admin UI     │  (Static Web App / GitHub Pages)
└────────────────┬────────────────┘
                 │ 1. Admin generates teams & saves to Supabase
                 │ 2. Triggers role sync with Supabase JWT Authorization
                 ▼
┌─────────────────────────────────┐
│     Discord Bot Node.js API     │  (Private Backend Service: Express + discord.js)
│   • Validates Admin JWT token   │
│   • Reads authoritative teams   │
│   • Never exposes Bot Secrets   │
└────────────────┬────────────────┘
                 │ 3. Automated Role Management
                 ▼
┌─────────────────────────────────┐
│         Discord Server          │
│   • Ensures Team 1..N exist     │
│   • Matches members by ID/name  │
│   • Swaps outdated team roles   │
└─────────────────────────────────┘
```

- **Zero Secret Exposure**: The Discord Bot Token and Supabase Service Role Key remain strictly inside backend environment variables. The client frontend never handles privileged Discord credentials.
- **Authorization**: The `/api/sync-teams` endpoint verifies the caller's Supabase Admin JWT or an optional `BOT_API_SECRET` header.
- **Fault-Tolerant & Idempotent**: Failed Discord synchronizations do not affect or wipe saved teams on the website. Re-spinning or re-running synchronization is idempotent and cleans up obsolete team roles without touching community or moderator roles.

---

## 🚀 Setup & Configuration Guide

### Step 1: Create a Discord Bot Application

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications).
2. Click **New Application** and name it (e.g., `Salvo's Finest Bot`).
3. In the left sidebar, navigate to **Bot**:
   - Click **Add Bot** / **Reset Token** to copy your **Bot Token**.
   - Under **Privileged Gateway Intents**, enable:
     - ✅ **Server Members Intent** *(Mandatory: allows the bot to search members and inspect their roles)*.
4. In the left sidebar, navigate to **OAuth2 > URL Generator**:
   - Under **Scopes**, select: `bot`.
   - Under **Bot Permissions**, select:
     - `Manage Roles` *(Mandatory: to create and assign Team roles)*
     - `View Channels`
     - `Send Messages`
5. Copy the generated URL and open it in your browser to invite the bot to your Discord server.

> **CRITICAL ROLE HIERARCHY NOTE**:
> In your Discord Server Settings > **Roles**, drag the **Bot's role** ABOVE all `Team 1`, `Team 2`, etc. roles. Discord forbids bots from managing roles positioned higher than the bot's highest role.

---

### Step 2: Configure Environment Variables

In the `bot/` folder, copy `.env.example` to `.env`:

```bash
cp .env.example .env
```

Fill in your configuration values:

```env
# Discord Configuration
DISCORD_BOT_TOKEN=your_discord_bot_token_here
DISCORD_GUILD_ID=your_discord_server_id_here

# Supabase Configuration
SUPABASE_URL=https://byrgpygkirkjdcnmicbm.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your_supabase_service_role_key_here

# Server & Security
PORT=3001
CORS_ORIGIN=*
# Optional additional secret header
BOT_API_SECRET=
```

#### How to get your `DISCORD_GUILD_ID` (Server ID):
1. In Discord, go to **User Settings > Advanced** and turn ON **Developer Mode**.
2. Right-click your Discord server's icon in the server list and select **Copy Server ID**.

---

### Step 3: Run Database Migration (Recommended)

Run the SQL script located at `database_migration.sql` in your Supabase SQL Editor:

```sql
ALTER TABLE IF EXISTS public.players
ADD COLUMN IF NOT EXISTS discord_id TEXT;

CREATE INDEX IF NOT EXISTS idx_players_discord_name ON public.players (LOWER(discord_name));
CREATE INDEX IF NOT EXISTS idx_players_discord_id ON public.players (discord_id);
```

*Note: The matching algorithm automatically handles Discord usernames, tags (`user#1234`), display names, and server nicknames. Adding `discord_id` provides future-proof, 100% deterministic matching.*

---

### Step 4: Install Dependencies & Run

```bash
cd bot
npm install
npm run test    # Run unit & integration test suite
npm start       # Start the bot and API server
```

You should see:
```
[Server] Salvo's Finest Discord Sync API running on port 3001
[Discord Bot] Logged in as Salvo's Finest Bot#1234
[Discord Bot] Target Guild: "Salvo's Finest" (ID: 123456789012345678) - 45 members
```

---

## 🌐 Connecting the Website to the Bot

1. Open your admin dashboard on the website (`admin.html`).
2. Log in with your admin credentials.
3. In the **Discord Bot > Role Synchronization** panel:
   - Enter your bot server's URL (e.g. `http://localhost:3001` for local testing or your deployed HTTPS URL on Railway/Render).
   - Click **Save & Test Connection**.
   - The indicator will show **● Discord Bot Online** along with your server name and member count.
4. When you click **↻ Spin Teams**:
   - The teams are generated and saved to Supabase.
   - The Discord bot automatically creates missing `Team N` roles, reuses existing ones, and assigns them to the players.
   - Any unmatched usernames are reported in the status banner without breaking team generation.
5. You can also click **↻ Sync Discord Roles** to resynchronize existing teams at any time.

---

## ☁️ Deployment Guide

Since the frontend is a static site (e.g. GitHub Pages), the bot should run on a lightweight Node.js host.

### Option A: Railway (Recommended - 2 Minutes Setup)
1. Fork or push this repository to GitHub.
2. In [Railway.app](https://railway.app), create a **New Project > Deploy from GitHub repo**.
3. Set the Root Directory to `/bot` (or use the root repo with start command `cd bot && npm start`).
4. Add the Environment Variables (`DISCORD_BOT_TOKEN`, `DISCORD_GUILD_ID`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`).
5. Generate a public domain in Railway settings and paste that URL into the Admin Dashboard on the website.

### Option B: Render / Fly.io / VPS / Docker
1. Create a Web Service with runtime `Node.js`.
2. Build command: `cd bot && npm install`
3. Start command: `cd bot && npm start`
4. Add environment variables.

---

## 🧪 Verification & Acceptance Testing

Run automated tests anytime via:
```bash
cd bot && npm test
```

### Acceptance Checklist:
- [x] Dynamic sequential role creation (`Team 1`, `Team 2`, ... `Team N`).
- [x] Existing roles are reused without duplicate creation.
- [x] Discord members matched via ID, username, tag, or display name.
- [x] Regenerating teams strips previous team roles and assigns new ones.
- [x] Unrelated roles (Admin, Moderator, Community) are never touched.
- [x] Unmatched players are reported gracefully without crashing.
- [x] Idempotent operations across multiple sync runs.
- [x] Bot failure leaves website and database teams intact.
