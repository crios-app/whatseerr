<div align="center">
  <img src="logo.png" alt="Whatseerr Logo" width="200"/>

  # Whatseerr

  WhatsApp bot for Seerr that allows users to search and request media via WhatsApp messages.

  [![Buy Me A Coffee](https://www.buymeacoffee.com/assets/img/custom_images/orange_img.png)](https://buymeacoffee.com/sufx)
</div>

## Features

- 🔍 Search movies and TV shows from WhatsApp
- 📺 Request media directly via chat messages
- 🔔 Receive webhook notifications from Seerr
- 📌 **Follow / unfollow** titles you don't want to request right now — get a DM the moment they're available
- 📅 **Calendar** of upcoming episodes and releases for everything you follow
- 🎬 **Library webhook** for Plex / Sonarr / Radarr — per-episode and per-movie notifications
- 👥 User mapping (WhatsApp phone numbers to Seerr user IDs)
- ⚡ Rate limiting and message queuing
- 🎯 Support for 4K requests (optional)

## Screenshots

📸 [View Screenshots](SCREENSHOTS.md)

## Quick Start (Docker - Recommended)

### Prerequisites

- [WAHA](https://github.com/devlikeapro/waha) (WhatsApp HTTP API) running and configured
- Seerr instance
- Docker installed

### 1. Pull the Image and Run

```bash
docker pull ghcr.io/sufxgit/whatseerr:latest
```

#### Environment Variables

| Variable | Description | Required | Default |
|----------|-------------|----------|---------|
| `TZ` | Timezone (e.g., `Asia/Kuwait`, `America/New_York`) | No | `UTC` |

#### Docker Compose Example

```yaml
services:
  whatseerr:
    image: ghcr.io/sufxgit/whatseerr:latest
    container_name: whatseerr-bot
    restart: unless-stopped
    ports:
      - "3006:3006"
    volumes:
      - /path/to/config:/config
    environment:
      - TZ=Asia/Kuwait
```

**Configuration Notes:**
- On first run, a `config.example.json` will be created in your config directory
- Rename it to `config.json` and update with your settings:
  - `host`: The hostname/IP where Seerr, WAHA, and the bot can reach each other
  - `jellyseerr.apiKey`: Get from Seerr → Settings → General
  - `waha.apiKey`: Your WAHA API key
  - `userIdMappings`: Map WhatsApp phone numbers (without @c.us) to Seerr user IDs
    ```json
    "1234567890": {
      "userId": 1,
      "username": "",
      "admin": true
    }
    ```
    - `"1234567890"`: WhatsApp phone number including country code (without @c.us suffix)
    - `userId`: The user ID from your Seerr instance - each user has their own unique ID (found in Seerr → Users)
    - `username`: Optional custom display name (leave empty to use Seerr username)
    - `admin`: Add `"admin": true` if the user is an admin (omit or set to false otherwise)

**Unraid:**
- Repository: `ghcr.io/sufxgit/whatseerr:latest`
- Port: `3006:3006` (TCP)
- Volume: `/mnt/user/appdata/whatseerr/config` → `/config` (Read/Write)
- Variable: `TZ=Your/Timezone`

### 2. Configure WAHA Webhook

Point your WAHA session webhook to:
```
http://YOUR_HOST_IP:3006/requests
```

Enable these events:
- `session.status`
- `message`
- `message.reactions`

### 3. Configure Seerr Webhook (Optional)

For receiving notifications (approved/available/declined), add webhook in Seerr:

**Webhook URL:**
```
http://YOUR_HOST_IP:3006/seerr
```

**Types:** Select notification types you want to receive

### 4. Configure Library Webhook (Optional, for episode-level notifications)

`/library` accepts Plex, Sonarr and Radarr webhook payloads so users who
`follow` a title get a per-episode (TV) or per-movie (movie) DM the moment
the file lands in your library — independently of Seerr's "available" event.

**Webhook URL:**
```
http://YOUR_HOST_IP:3006/library
```

**Sonarr / Radarr** (Settings → Connect → Webhook):
- **URL**: `http://YOUR_HOST_IP:3006/library`
- **Method**: `POST`
- **Triggers**: enable *On Import* / *On Upgrade* (both fire `Download` events). Leave *On Grab* off — it fires before the file is actually available.

**Plex** (Settings → Webhooks; requires Plex Pass):
- **URL**: `http://YOUR_HOST_IP:3006/library`

**Authentication (recommended when exposing to the internet):**
Set `webhook.library.token` in `config.json` (or the `WHATSEERR_LIBRARY_TOKEN` env var) and append `?token=YOUR_TOKEN` to the URL above. Whatseerr will reject unauthenticated requests once the token is configured.

## Usage

Send a WhatsApp message to your WAHA-connected number:

```
r The Matrix
```

The bot will:
1. Search Seerr for "The Matrix"
2. Return numbered results
3. Wait for you to reply with a number (e.g., "1")
4. Submit the request to Seerr

**Available Commands:**
- `r <title>` or `request <title>` - Search and request media
- `r4k <title>` or `request4k <title>` - Request in 4K quality (if enabled)
- `follow <title>` (or `f <title>`) - Follow a movie or show without requesting it; you'll be notified when it / new episodes become available
- `unfollow [<title>]` (or `uf`) - Stop following. Without an argument, lists everything you follow so you can pick one
- `calendar` (or `cal`) - Shows upcoming episodes / releases for everything you follow
- `subs` or `subscriptions` - List your active notifications
- `help` - Show available commands

> `request` and `follow` are independent: requesting only queues the title in Seerr and does **not** subscribe you to availability notifications. Use `follow` (or `f`) to receive a DM when the title (or new episodes) drop. The original requester still gets Seerr's own notifications via the Seerr webhook.

## Configuration Options

### System
- `protocol`: `http` or `https`
- `host`: Shared hostname/IP for all services
- `logging.level`: `info` or `debug`

### Services
- `jellyseerr.port`: Seerr port (default: 5055)
- `jellyseerr.apiKey`: Your Seerr API key
- `jellyseerr.defaultUserId`: Default user ID for requests
- `waha.port`: WAHA port (default: 8584)
- `waha.apiKey`: WAHA API key
- `waha.session`: WAHA session name (default: "default")

### Webhooks
- `webhook.requests.path`: Path for WAHA webhook (default: `/requests`)
- `webhook.requests.port`: Webhook server port (default: 3006)
- `webhook.seerr.path`: Path for Seerr webhook (default: `/seerr`)
- `webhook.library.path`: Path for Plex/Sonarr/Radarr webhook (default: `/library`)
- `webhook.library.token`: Optional shared secret. When set, callers must include `?token=...` (or env `WHATSEERR_LIBRARY_TOKEN`).

### Mappings
- `userIdMappings`: Map phone numbers to Seerr user IDs
- `emailMappings`: Auto-populated from webhook notifications
- `lidMappings`: Auto-populated for WhatsApp LID format support

### Commands
- `command`: Comma-separated list of request command aliases
- `command4k`: Comma-separated list of 4K request command aliases
- `help4k`: Show 4K commands in help message (default: false)
- `followCommand`: Aliases for `follow` (default: `follow,f`)
- `unfollowCommand`: Aliases for `unfollow` (default: `unfollow,uf`)
- `calendarCommand`: Aliases for `calendar` (default: `calendar,cal`)

## Viewing Logs

```bash
docker logs -f whatseerr-bot
```

## Building from Source

```bash
git clone https://github.com/sufxgit/whatseerr.git
cd whatseerr
docker build -t whatseerr .
```

## Development

For local development without Docker:

1. **Clone the repository**
   ```bash
   git clone https://github.com/sufxgit/whatseerr.git
   cd whatseerr
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Create config**
   ```bash
   cp config/config.example.json config/config.json
   nano config/config.json
   ```

4. **Run the bot**
   ```bash
   npm run bot
   ```

## License

MIT
