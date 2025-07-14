const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 8080;

// Middleware
app.use(cors());
app.use(express.json());

// Database connection
console.log('Environment:', process.env.NODE_ENV);
console.log('Database URL exists:', !!process.env.DATABASE_URL);
console.log('Port:', PORT);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

// Initialize database
async function initDatabase() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS contacts (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) UNIQUE NOT NULL,
        name VARCHAR(255),
        first_seen DATE NOT NULL,
        last_seen DATE NOT NULL,
        meeting_count INTEGER DEFAULT 1,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    await pool.query(`
      CREATE TABLE IF NOT EXISTS events (
        id SERIAL PRIMARY KEY,
        google_event_id VARCHAR(255) UNIQUE NOT NULL,
        summary TEXT,
        start_time TIMESTAMP,
        end_time TIMESTAMP,
        attendees_count INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    console.log('Database initialized successfully');
  } catch (error) {
    console.error('Database initialization error:', error);
  }
}

// Initialize database on startup
initDatabase();

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    version: '1.0.0',
    environment: process.env.NODE_ENV || 'development'
  });
});

// Get all contacts
app.get('/api/contacts', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM contacts ORDER BY created_at DESC');
    res.json({
      success: true,
      data: result.rows,
      count: result.rows.length
    });
  } catch (error) {
    console.error('Error fetching contacts:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch contacts'
    });
  }
});

// Get new contacts (from last N days)
app.get('/api/contacts/new', async (req, res) => {
  const days = parseInt(req.query.days) || 7;
  
  try {
    const result = await pool.query(
      'SELECT * FROM contacts WHERE created_at >= NOW() - INTERVAL \'$1 days\' ORDER BY created_at DESC',
      [days]
    );
    res.json({
      success: true,
      data: result.rows,
      count: result.rows.length,
      days
    });
  } catch (error) {
    console.error('Error fetching new contacts:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch new contacts'
    });
  }
});

// Manual sync endpoint (mock for now)
app.post('/api/sync', async (req, res) => {
  try {
    console.log('Manual sync requested (mock implementation)');
    
    const result = {
      newContacts: [],
      totalContacts: 0,
      eventsProcessed: 0
    };
    
    // Get total contacts count
    const contacts = await pool.query('SELECT COUNT(*) FROM contacts');
    result.totalContacts = parseInt(contacts.rows[0].count);
    
    res.json({
      success: true,
      data: result,
      message: `Sync completed: ${result.newContacts.length} new contacts found`
    });
  } catch (error) {
    console.error('Sync error:', error);
    res.status(500).json({
      success: false,
      error: 'Sync failed',
      details: error.message
    });
  }
});

// Google Calendar Authentication
const SCOPES = ['https://www.googleapis.com/auth/calendar.readonly'];
let oAuth2Client = null;
let storedTokens = null;

// Initialize Google OAuth2 client
function initializeGoogleAuth() {
  if (process.env.NODE_ENV === 'production') {
    // In production, we need to configure OAuth2 with environment variables
    if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
      oAuth2Client = new google.auth.OAuth2(
        process.env.GOOGLE_CLIENT_ID,
        process.env.GOOGLE_CLIENT_SECRET,
        process.env.GOOGLE_REDIRECT_URI || 'https://crm-intothecom-production.up.railway.app/api/auth/google/callback'
      );
    }
  } else {
    // In development, use the credentials file
    const CREDENTIALS_PATH = path.join(__dirname, 'client_secret_419586581117-g9jfcu1hk0sr757gkp9cukbu148b90d8.apps.googleusercontent.com.json');
    if (fs.existsSync(CREDENTIALS_PATH)) {
      const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'));
      const { client_secret, client_id, redirect_uris } = credentials.installed;
      
      oAuth2Client = new google.auth.OAuth2(
        client_id,
        client_secret,
        redirect_uris[0]
      );
    }
  }
}

// Initialize Google Auth on startup
initializeGoogleAuth();

// Restore tokens if they exist
if (storedTokens && oAuth2Client) {
  oAuth2Client.setCredentials(storedTokens);
}

// Google Authentication endpoints
app.get('/api/auth/google', (req, res) => {
  if (!oAuth2Client) {
    return res.status(500).json({
      success: false,
      error: 'Google authentication not configured'
    });
  }

  const authUrl = oAuth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
  });

  res.json({
    success: true,
    authUrl: authUrl
  });
});

app.get('/api/auth/google/callback', async (req, res) => {
  const { code } = req.query;
  
  if (!code) {
    return res.status(400).json({
      success: false,
      error: 'Authorization code missing'
    });
  }

  try {
    const { tokens } = await oAuth2Client.getToken(code);
    oAuth2Client.setCredentials(tokens);
    storedTokens = tokens;
    
    console.log('Google Calendar authentication successful');
    
    res.send(`
      <html>
        <body>
          <h2>✅ Authentication Successful!</h2>
          <p>You can now close this window and return to your CRM.</p>
          <script>
            // Notify parent window and close
            if (window.opener) {
              window.opener.postMessage({type: 'google-auth-success'}, '*');
              window.close();
            }
          </script>
        </body>
      </html>
    `);
  } catch (error) {
    console.error('Google auth error:', error);
    res.status(500).json({
      success: false,
      error: 'Authentication failed'
    });
  }
});

// Check authentication status
app.get('/api/auth/status', (req, res) => {
  const isAuthenticated = !!(oAuth2Client && storedTokens);
  res.json({
    success: true,
    authenticated: isAuthenticated,
    message: isAuthenticated ? 'Google Calendar conectado' : 'Google Calendar desconectado'
  });
});

// Google Calendar Events endpoint
app.get('/api/calendar/events', async (req, res) => {
  if (!oAuth2Client) {
    return res.status(500).json({
      success: false,
      error: 'Google authentication not configured'
    });
  }

  try {
    const calendar = google.calendar({ version: 'v3', auth: oAuth2Client });
    const view = req.query.view || 'month';
    
    const now = new Date();
    let timeMin, timeMax;
    
    switch (view) {
      case 'day':
        timeMin = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        timeMax = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
        break;
      case 'week':
        const startOfWeek = new Date(now.getTime() - (now.getDay() * 24 * 60 * 60 * 1000));
        timeMin = new Date(startOfWeek.getFullYear(), startOfWeek.getMonth(), startOfWeek.getDate());
        timeMax = new Date(timeMin.getTime() + (7 * 24 * 60 * 60 * 1000));
        break;
      case 'month':
      default:
        timeMin = new Date(now.getFullYear(), now.getMonth(), 1);
        timeMax = new Date(now.getFullYear(), now.getMonth() + 1, 0);
        break;
    }
    
    const response = await calendar.events.list({
      calendarId: 'primary',
      timeMin: timeMin.toISOString(),
      timeMax: timeMax.toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
    });

    res.json({
      success: true,
      data: response.data.items || [],
      view: view,
      timeRange: {
        start: timeMin.toISOString(),
        end: timeMax.toISOString()
      }
    });
  } catch (error) {
    console.error('Calendar events error:', error);
    
    if (error.code === 401) {
      res.status(401).json({
        success: false,
        error: 'Authentication required. Please connect to Google Calendar first.'
      });
    } else {
      res.status(500).json({
        success: false,
        error: 'Failed to fetch calendar events'
      });
    }
  }
});

// Serve static files
app.use(express.static('public'));

// Main app route
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="es">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>IntoTheCom CRM</title>
      <style>
        * {
          margin: 0;
          padding: 0;
          box-sizing: border-box;
        }
        
        body {
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
          background: #f8fafc;
          color: #2d3748;
        }
        
        .app-container {
          display: flex;
          min-height: 100vh;
        }
        
        .sidebar {
          width: 260px;
          background: #1a1a1a;
          padding: 20px 0;
          position: fixed;
          height: 100vh;
          left: 0;
          top: 0;
          overflow-y: auto;
        }
        
        .sidebar-header {
          padding: 0 20px 30px;
          border-bottom: 1px solid #2d3748;
        }
        
        .logo {
          color: #fff;
          font-size: 24px;
          font-weight: 700;
          display: flex;
          align-items: center;
          gap: 10px;
        }
        
        .logo img {
          height: 48px;
          width: auto;
        }
        
        .nav-menu {
          padding: 30px 0;
        }
        
        .nav-item {
          display: flex;
          align-items: center;
          gap: 12px;
          padding: 12px 20px;
          color: #a0aec0;
          text-decoration: none;
          transition: all 0.2s;
          border-left: 3px solid transparent;
        }
        
        .nav-item:hover {
          background: #2d3748;
          color: #fff;
        }
        
        .nav-item.active {
          background: #2d3748;
          color: #FF6B00;
          border-left-color: #FF6B00;
        }
        
        .nav-icon {
          font-size: 18px;
          width: 20px;
          text-align: center;
        }
        
        .main-content {
          flex: 1;
          margin-left: 260px;
          padding: 30px;
        }
        
        .header {
          background: #fff;
          padding: 20px 30px;
          border-radius: 12px;
          box-shadow: 0 2px 10px rgba(0,0,0,0.1);
          margin-bottom: 30px;
          display: flex;
          justify-content: space-between;
          align-items: center;
        }
        
        .header h1 {
          font-size: 28px;
          color: #1a202c;
          margin: 0;
        }
        
        .header-actions {
          display: flex;
          gap: 15px;
        }
        
        .btn {
          padding: 10px 20px;
          border: none;
          border-radius: 8px;
          cursor: pointer;
          font-weight: 500;
          transition: all 0.2s;
          text-decoration: none;
          display: inline-flex;
          align-items: center;
          gap: 8px;
        }
        
        .btn-primary {
          background: #FF6B00;
          color: white;
        }
        
        .btn-primary:hover {
          background: #E55A00;
        }
        
        .btn-secondary {
          background: #e2e8f0;
          color: #4a5568;
        }
        
        .btn-secondary:hover {
          background: #cbd5e0;
        }
        
        .btn-success {
          background: #48bb78;
          color: white;
        }
        
        .btn-success:hover {
          background: #38a169;
        }
        
        .connection-status {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 10px 20px;
          border-radius: 8px;
          font-weight: 500;
        }
        
        .connection-status.connected {
          background: #f0fff4;
          color: #22543d;
          border: 1px solid #68d391;
        }
        
        .content-area {
          background: #fff;
          border-radius: 12px;
          box-shadow: 0 2px 10px rgba(0,0,0,0.1);
          min-height: 600px;
        }
        
        .tab-content {
          padding: 30px;
        }
        
        .calendar-container {
          height: 600px;
          border: 1px solid #e2e8f0;
          border-radius: 8px;
          position: relative;
          overflow: hidden;
        }
        
        .calendar-header {
          background: #f7fafc;
          padding: 20px;
          border-bottom: 1px solid #e2e8f0;
          display: flex;
          justify-content: space-between;
          align-items: center;
        }
        
        .calendar-title {
          font-size: 18px;
          font-weight: 600;
          color: #2d3748;
        }
        
        .calendar-nav {
          display: flex;
          gap: 10px;
        }
        
        .calendar-nav button {
          padding: 8px 12px;
          border: 1px solid #e2e8f0;
          background: white;
          border-radius: 6px;
          cursor: pointer;
          color: #4a5568;
          margin-right: 8px;
        }
        
        .calendar-nav button:hover {
          background: #f7fafc;
        }
        
        .view-btn.active {
          background: #FF6B00;
          color: white;
          border-color: #FF6B00;
        }
        
        .view-btn.active:hover {
          background: #E55A00;
        }
        
        .calendar-grid {
          padding: 20px;
          height: calc(100% - 80px);
          overflow-y: auto;
        }
        
        .week-view {
          display: flex;
          flex-direction: column;
          background: #e2e8f0;
          border: 1px solid #e2e8f0;
          height: 100%;
        }
        
        .week-header {
          display: grid;
          grid-template-columns: 60px repeat(7, 1fr);
          gap: 1px;
          background: #e2e8f0;
          position: sticky;
          top: 0;
          z-index: 10;
        }
        
        .week-body {
          display: grid;
          grid-template-columns: 60px repeat(7, 1fr);
          gap: 1px;
          background: #e2e8f0;
          flex: 1;
          overflow-y: auto;
        }
        
        .time-slot {
          background: #f8fafc;
          padding: 8px;
          font-size: 12px;
          color: #718096;
          border-right: 1px solid #e2e8f0;
          text-align: center;
        }
        
        .day-column {
          background: white;
          min-height: 60px;
          position: relative;
          border-right: 1px solid #e2e8f0;
        }
        
        .day-header {
          background: #f7fafc;
          padding: 8px;
          font-weight: 600;
          text-align: center;
          border-bottom: 1px solid #e2e8f0;
          font-size: 14px;
        }
        
        .event-block {
          background: #FF6B00;
          color: white;
          padding: 4px 8px;
          margin: 2px;
          border-radius: 4px;
          font-size: 12px;
          cursor: pointer;
          position: relative;
        }
        
        .event-block:hover {
          background: #E55A00;
        }
        
        .month-view {
          display: grid;
          grid-template-columns: repeat(7, 1fr);
          gap: 1px;
          background: #e2e8f0;
          border: 1px solid #e2e8f0;
        }
        
        .month-day {
          background: white;
          min-height: 80px;
          padding: 8px;
          position: relative;
          border: 1px solid #e2e8f0;
        }
        
        .month-day-number {
          font-weight: 600;
          color: #2d3748;
          margin-bottom: 4px;
        }
        
        .month-day.other-month {
          background: #f8fafc;
          color: #a0aec0;
        }
        
        .month-event {
          background: #FF6B00;
          color: white;
          padding: 2px 4px;
          margin: 1px 0;
          border-radius: 2px;
          font-size: 10px;
          cursor: pointer;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        
        .month-event:hover {
          background: #E55A00;
        }
        
        .auth-prompt {
          text-align: center;
          padding: 60px 20px;
          color: #718096;
        }
        
        .auth-prompt h3 {
          margin-bottom: 15px;
          font-size: 20px;
          color: #2d3748;
        }
        
        .status {
          margin: 20px 0;
          padding: 15px;
          border-radius: 8px;
          text-align: center;
        }
        
        .status.loading {
          background: #e6fffa;
          color: #00a3c4;
          border: 1px solid #b8f5ff;
        }
        
        .status.success {
          background: #f0fff4;
          color: #22543d;
          border: 1px solid #68d391;
        }
        
        .status.error {
          background: #fed7d7;
          color: #822727;
          border: 1px solid #feb2b2;
        }
        
        .event-item {
          background: #f7fafc;
          border: 1px solid #e2e8f0;
          border-radius: 8px;
          padding: 15px;
          margin-bottom: 10px;
          transition: all 0.2s;
        }
        
        .event-item:hover {
          background: #edf2f7;
          border-color: #cbd5e0;
        }
        
        .event-time {
          color: #FF6B00;
          font-weight: 500;
          font-size: 14px;
          margin-bottom: 5px;
        }
        
        .event-title {
          font-weight: 600;
          color: #2d3748;
          margin-bottom: 5px;
        }
        
        .event-attendees {
          color: #718096;
          font-size: 14px;
        }
        
        .event-actions {
          margin-top: 10px;
          display: flex;
          gap: 8px;
        }
        
        .event-join-btn {
          background: #FF6B00;
          color: white;
          border: none;
          padding: 6px 12px;
          border-radius: 4px;
          font-size: 12px;
          cursor: pointer;
          text-decoration: none;
        }
        
        .event-join-btn:hover {
          background: #E55A00;
        }
        
        .event-details-btn {
          background: #e2e8f0;
          color: #4a5568;
          border: none;
          padding: 6px 12px;
          border-radius: 4px;
          font-size: 12px;
          cursor: pointer;
        }
        
        .event-details-btn:hover {
          background: #cbd5e0;
        }
        
        @media (max-width: 768px) {
          .sidebar {
            width: 100%;
            position: relative;
            height: auto;
          }
          
          .main-content {
            margin-left: 0;
          }
          
          .header {
            flex-direction: column;
            gap: 15px;
            text-align: center;
          }
        }
      </style>
    </head>
    <body>
      <div class="app-container">
        <div class="sidebar">
          <div class="sidebar-header">
            <div class="logo">
              <img src="/Blanco sin fondo 72ppi.png" alt="IntoTheCom" onerror="this.style.display='none'">
            </div>
          </div>
          <nav class="nav-menu">
            <a href="#" class="nav-item active" data-tab="calendar">
              <span>Calendario</span>
            </a>
            <a href="#" class="nav-item" data-tab="contacts">
              <span>Contactos</span>
            </a>
            <a href="#" class="nav-item" data-tab="sync">
              <span>Sincronización</span>
            </a>
          </nav>
        </div>
        
        <div class="main-content">
          <div class="header">
            <h1 id="pageTitle">Calendario</h1>
            <div class="header-actions">
              <button class="btn btn-secondary" onclick="refreshData()">
                Actualizar
              </button>
              <div id="authButton">
                <button class="btn btn-primary" onclick="authenticateGoogle()">
                  Conectar Google
                </button>
              </div>
            </div>
          </div>
          
          <div class="content-area">
            <div id="calendar-tab" class="tab-content">
              <div class="calendar-container">
                <div class="calendar-header">
                  <div class="calendar-title">Mis Eventos</div>
                  <div class="calendar-nav">
                    <button onclick="showDayView()" class="view-btn" data-view="day">Día</button>
                    <button onclick="showWeekView()" class="view-btn" data-view="week">Semana</button>
                    <button onclick="showMonthView()" class="view-btn active" data-view="month">Mes</button>
                    <button onclick="loadCalendarEvents()" class="btn-primary">Cargar Eventos</button>
                  </div>
                </div>
                <div class="calendar-grid">
                  <div class="auth-prompt">
                    <h3>Conecta tu Google Calendar</h3>
                    <p>Autoriza el acceso a tu calendario para ver y gestionar eventos</p>
                    <button class="btn btn-primary" onclick="authenticateGoogle()" style="margin-top: 20px;">
                      Conectar Google Calendar
                    </button>
                  </div>
                </div>
              </div>
            </div>
            
            <div id="contacts-tab" class="tab-content" style="display: none;">
              <div id="status"></div>
              <div id="contactsList"></div>
            </div>
            
            <div id="sync-tab" class="tab-content" style="display: none;">
              <h3>Sincronización con Google Calendar</h3>
              <div id="syncStatus"></div>
              <button class="btn btn-primary" onclick="syncContacts()">
                Sincronizar Ahora
              </button>
            </div>
          </div>
        </div>
      </div>

      <script>
        // Tab switching
        document.querySelectorAll('.nav-item').forEach(item => {
          item.addEventListener('click', (e) => {
            e.preventDefault();
            
            // Update active nav item
            document.querySelectorAll('.nav-item').forEach(nav => nav.classList.remove('active'));
            item.classList.add('active');
            
            // Show/hide tabs
            const tabId = item.getAttribute('data-tab');
            document.querySelectorAll('.tab-content').forEach(tab => tab.style.display = 'none');
            document.getElementById(tabId + '-tab').style.display = 'block';
            
            // Update page title
            const titles = {
              'calendar': 'Calendario',
              'contacts': 'Contactos',
              'sync': 'Sincronización'
            };
            document.getElementById('pageTitle').textContent = titles[tabId];
          });
        });

        async function authenticateGoogle() {
          showStatus('Iniciando autenticación con Google...', 'loading');
          
          try {
            const response = await fetch('/api/auth/google');
            const result = await response.json();
            
            if (result.success) {
              if (result.authUrl) {
                window.open(result.authUrl, '_blank');
                showStatus('Completa la autenticación en la ventana emergente', 'loading');
              } else {
                showStatus('Ya estás autenticado', 'success');
                loadCalendarEvents();
              }
            } else {
              showStatus('Error: ' + result.error, 'error');
            }
          } catch (error) {
            showStatus('Error de conexión: ' + error.message, 'error');
          }
        }

        // Listen for authentication success message
        window.addEventListener('message', (event) => {
          if (event.data && event.data.type === 'google-auth-success') {
            showStatus('Autenticación completada exitosamente', 'success');
            updateAuthButton(true);
            setTimeout(() => {
              loadCalendarEvents();
            }, 1000);
          }
        });

        // Check authentication status on page load
        async function checkAuthStatus() {
          try {
            const response = await fetch('/api/auth/status');
            const result = await response.json();
            
            if (result.success && result.authenticated) {
              updateAuthButton(true);
            } else {
              updateAuthButton(false);
            }
          } catch (error) {
            console.error('Error checking auth status:', error);
            updateAuthButton(false);
          }
        }

        // Update authentication button based on status
        function updateAuthButton(isAuthenticated) {
          const authButton = document.getElementById('authButton');
          
          if (isAuthenticated) {
            authButton.innerHTML = '<div class="connection-status connected">✓ Conectado</div>';
          } else {
            authButton.innerHTML = '<button class="btn btn-primary" onclick="authenticateGoogle()">Conectar Google</button>';
          }
        }

        // Check auth status on page load
        document.addEventListener('DOMContentLoaded', checkAuthStatus);

        async function loadCalendarEvents(view = 'month') {
          const calendarGrid = document.querySelector('.calendar-grid');
          calendarGrid.innerHTML = '<div class="status loading">Cargando eventos...</div>';
          
          try {
            const response = await fetch('/api/calendar/events?view=' + view);
            const result = await response.json();
            
            if (result.success) {
              if (result.data.length === 0) {
                calendarGrid.innerHTML = '<div class="auth-prompt"><h3>No hay eventos</h3><p>No se encontraron eventos en tu calendario</p></div>';
              } else {
                if (view === 'week') {
                  calendarGrid.innerHTML = renderWeekView(result.data);
                } else if (view === 'month') {
                  calendarGrid.innerHTML = renderMonthView(result.data);
                } else {
                  // Day view (default)
                  calendarGrid.innerHTML = result.data.map(event => 
                    '<div class="event-item">' +
                      '<div class="event-time">' + formatEventTime(event.start) + '</div>' +
                      '<div class="event-title">' + (event.summary || 'Sin título') + '</div>' +
                      '<div class="event-attendees">' + formatAttendees(event.attendees) + '</div>' +
                      '<div class="event-actions">' +
                        (event.hangoutLink ? '<a href="' + event.hangoutLink + '" target="_blank" class="event-join-btn">Unirse</a>' : '') +
                        '<button class="event-details-btn" onclick="showEventDetails(&quot;' + event.id + '&quot;)">Detalles</button>' +
                      '</div>' +
                    '</div>'
                  ).join('');
                }
              }
            } else {
              calendarGrid.innerHTML = '<div class="status error">Error: ' + result.error + '</div>';
            }
          } catch (error) {
            calendarGrid.innerHTML = '<div class="status error">Error de conexión: ' + error.message + '</div>';
          }
        }

        function formatEventTime(start) {
          if (!start) return 'Hora no especificada';
          const date = new Date(start.dateTime || start.date);
          return date.toLocaleString('es-ES', {
            weekday: 'short',
            month: 'short',
            day: 'numeric',
            hour: start.dateTime ? '2-digit' : undefined,
            minute: start.dateTime ? '2-digit' : undefined
          });
        }

        function formatAttendees(attendees) {
          if (!attendees || attendees.length === 0) return 'Sin asistentes';
          const names = attendees.map(a => a.displayName || a.email).slice(0, 3);
          return names.join(', ') + (attendees.length > 3 ? ' y ' + (attendees.length - 3) + ' más' : '');
        }

        function showDayView() {
          updateViewButtons('day');
          loadCalendarEvents('day');
        }

        function showWeekView() {
          updateViewButtons('week');
          loadCalendarEvents('week');
        }

        function showMonthView() {
          updateViewButtons('month');
          loadCalendarEvents('month');
        }

        function updateViewButtons(activeView) {
          document.querySelectorAll('.view-btn').forEach(btn => {
            btn.classList.remove('active');
            if (btn.getAttribute('data-view') === activeView) {
              btn.classList.add('active');
            }
          });
        }

        function showEventDetails(eventId) {
          alert('Detalles del evento: ' + eventId);
        }

        function renderWeekView(events) {
          const weekDays = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
          
          // Find the earliest event to determine starting hour
          let earliestHour = 24;
          if (events.length > 0) {
            earliestHour = Math.min(...events.map(event => {
              const eventDate = new Date(event.start.dateTime || event.start.date);
              return eventDate.getHours();
            }));
            // Start one hour before the earliest event, but not before 6 AM
            earliestHour = Math.max(6, earliestHour - 1);
          } else {
            earliestHour = 8; // Default to 8 AM if no events
          }
          
          const timeSlots = Array.from({length: 24 - earliestHour}, (_, i) => (earliestHour + i) + ':00');
          
          let html = '<div class="week-view">';
          
          // Fixed header with days
          html += '<div class="week-header">';
          html += '<div class="time-slot"></div>';
          weekDays.forEach(day => {
            html += '<div class="day-header">' + day + '</div>';
          });
          html += '</div>';
          
          // Scrollable body with time slots and events
          html += '<div class="week-body">';
          timeSlots.forEach(time => {
            html += '<div class="time-slot">' + time + '</div>';
            for (let day = 0; day < 7; day++) {
              html += '<div class="day-column">';
              
              // Find events for this day and time
              const dayEvents = events.filter(event => {
                const eventDate = new Date(event.start.dateTime || event.start.date);
                const eventHour = eventDate.getHours();
                const eventDay = eventDate.getDay();
                return eventDay === day && eventHour === parseInt(time);
              });
              
              dayEvents.forEach(event => {
                html += '<div class="event-block" onclick="showEventDetails(&quot;' + event.id + '&quot;)">';
                html += (event.summary || 'Sin título').substring(0, 20);
                if (event.hangoutLink) {
                  html += '<br><a href="' + event.hangoutLink + '" target="_blank" style="color: white; text-decoration: underline;">Unirse</a>';
                }
                html += '</div>';
              });
              
              html += '</div>';
            }
          });
          html += '</div>';
          
          html += '</div>';
          return html;
        }

        function renderMonthView(events) {
          const now = new Date();
          const year = now.getFullYear();
          const month = now.getMonth();
          
          const firstDay = new Date(year, month, 1);
          const lastDay = new Date(year, month + 1, 0);
          const startDate = new Date(firstDay);
          startDate.setDate(startDate.getDate() - firstDay.getDay());
          
          const weekDays = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
          
          let html = '<div class="month-view">';
          
          // Header row
          weekDays.forEach(day => {
            html += '<div class="day-header">' + day + '</div>';
          });
          
          // Calendar grid
          for (let i = 0; i < 42; i++) {
            const date = new Date(startDate);
            date.setDate(startDate.getDate() + i);
            
            const isCurrentMonth = date.getMonth() === month;
            const dayClass = isCurrentMonth ? 'month-day' : 'month-day other-month';
            
            html += '<div class="' + dayClass + '">';
            html += '<div class="month-day-number">' + date.getDate() + '</div>';
            
            // Find events for this day
            const dayEvents = events.filter(event => {
              const eventDate = new Date(event.start.dateTime || event.start.date);
              return eventDate.toDateString() === date.toDateString();
            });
            
            dayEvents.forEach(event => {
              html += '<div class="month-event" onclick="showEventDetails(&quot;' + event.id + '&quot;)">';
              html += (event.summary || 'Sin título').substring(0, 15);
              html += '</div>';
            });
            
            html += '</div>';
          }
          
          html += '</div>';
          return html;
        }

        function refreshData() {
          const activeTab = document.querySelector('.nav-item.active').getAttribute('data-tab');
          if (activeTab === 'calendar') {
            loadCalendarEvents();
          } else if (activeTab === 'contacts') {
            loadContacts();
          }
        }

        function showStatus(message, type) {
          const statusDiv = document.getElementById('status') || document.getElementById('syncStatus');
          if (statusDiv) {
            statusDiv.innerHTML = '<div class="status ' + type + '">' + message + '</div>';
          } else {
            // Show status in calendar grid if no status div found
            const calendarGrid = document.querySelector('.calendar-grid');
            if (calendarGrid) {
              calendarGrid.innerHTML = '<div class="status ' + type + '">' + message + '</div>';
            }
          }
        }

        async function syncContacts() {
          const statusDiv = document.getElementById('syncStatus');
          statusDiv.innerHTML = '<div class="status loading">Sincronizando contactos...</div>';
          
          try {
            const response = await fetch('/api/sync', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ days: 7 })
            });
            
            const result = await response.json();
            
            if (result.success) {
              statusDiv.innerHTML = '<div class="status success">Sincronización completada: ' + result.message + '</div>';
            } else {
              statusDiv.innerHTML = '<div class="status error">Error: ' + result.error + '</div>';
            }
          } catch (error) {
            statusDiv.innerHTML = '<div class="status error">Error: ' + error.message + '</div>';
          }
        }
        
        async function loadContacts() {
          const contactsList = document.getElementById('contactsList');
          contactsList.innerHTML = '<div class="status loading">Cargando contactos...</div>';
          
          try {
            const response = await fetch('/api/contacts');
            const result = await response.json();
            
            if (result.success) {
              if (result.data.length === 0) {
                contactsList.innerHTML = '<div class="auth-prompt"><h3>No hay contactos</h3><p>Sincroniza con Google Calendar para ver contactos</p></div>';
              } else {
                contactsList.innerHTML = result.data.map(contact => 
                  '<div class="event-item">' +
                    '<div class="event-title">' + contact.email + '</div>' +
                    '<div class="event-attendees">' + (contact.name || 'Sin nombre') + ' • ' + contact.meeting_count + ' reuniones</div>' +
                  '</div>'
                ).join('');
              }
            } else {
              contactsList.innerHTML = '<div class="status error">Error: ' + result.error + '</div>';
            }
          } catch (error) {
            contactsList.innerHTML = '<div class="status error">Error: ' + error.message + '</div>';
          }
        }
      </script>
    </body>
    </html>
  `);
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 CRM Server running on port ${PORT}`);
  console.log(`📱 Web interface: http://localhost:${PORT}`);
  console.log(`🔗 API endpoints:`);
  console.log(`   GET  /api/contacts - Get all contacts`);
  console.log(`   GET  /api/contacts/new - Get new contacts`);
  console.log(`   POST /api/sync - Manual sync`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  process.exit(0);
});

module.exports = app;