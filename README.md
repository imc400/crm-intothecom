# CRM Calendar Sync

A professional CRM tool that automatically syncs with Google Calendar to detect new contacts and manage your business relationships.

## Features

- 🔄 **Automatic Google Calendar Sync**: Detects new meetings and extracts contact information
- 📧 **Contact Management**: Tracks all contacts with meeting history and statistics
- 🌐 **Web Interface**: Clean, responsive web UI to manage contacts
- 📊 **Analytics**: View contact frequency, meeting patterns, and growth metrics
- 🚀 **Cloud Ready**: Designed for Railway deployment with PostgreSQL

## Local Development

### Prerequisites

- Node.js 18+
- PostgreSQL 14+
- Google Cloud Console project with Calendar API enabled

### Setup

1. **Install dependencies**:
   ```bash
   npm install
   ```

2. **Set up PostgreSQL**:
   ```bash
   createdb crm_db
   ```

3. **Configure environment**:
   ```bash
   cp .env.example .env
   # Edit .env with your database URL
   ```

4. **Add Google credentials**:
   - Download OAuth2 credentials from Google Cloud Console
   - Place the JSON file in the project root

### Running locally

1. **Start the web server**:
   ```bash
   npm run dev
   ```

2. **Manual sync**:
   ```bash
   npm run sync
   ```

3. **Access the web interface**:
   Open `http://localhost:3000` in your browser

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/health` | Health check |
| `GET` | `/api/contacts` | Get all contacts |
| `GET` | `/api/contacts/new?days=7` | Get new contacts from last N days |
| `POST` | `/api/sync` | Manual calendar sync |

## Railway Deployment

This project is configured for Railway deployment with:

- **PostgreSQL database** (automatically provisioned)
- **Environment variables** for configuration
- **Health checks** and auto-restart
- **Build optimization** with caching

### Deploy to Railway

1. **Connect to Railway**:
   ```bash
   railway login
   railway init
   ```

2. **Add PostgreSQL service**:
   ```bash
   railway add postgresql
   ```

3. **Deploy**:
   ```bash
   railway up
   ```

4. **Configure environment variables** in Railway dashboard:
   - `DATABASE_URL` (auto-configured)
   - `PORT` (auto-configured)
   - `NODE_ENV=production`

## Architecture

```
src/
├── config/
│   └── database.ts          # PostgreSQL connection & models
├── services/
│   ├── googleCalendar.ts    # Google Calendar API integration
│   └── syncService.ts       # Contact sync logic
├── server.ts                # Express web server & API
└── sync.ts                  # Manual sync script
```

## Security

- OAuth2 authentication with Google
- Environment-based configuration
- SQL injection protection with parameterized queries
- CORS configuration for web security

## License

Private - IntoTheCom Agency