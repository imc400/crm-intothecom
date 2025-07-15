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
        tags TEXT[] DEFAULT '{}',
        notes TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    // Check if tags column exists, if not add it
    try {
      await pool.query(`
        SELECT tags FROM contacts LIMIT 1
      `);
    } catch (columnError) {
      if (columnError.code === '42703') { // Column does not exist
        console.log('Adding tags column to contacts table...');
        await pool.query(`
          ALTER TABLE contacts ADD COLUMN tags TEXT[] DEFAULT '{}'
        `);
        console.log('Tags column added successfully');
      }
    }
    
    // Check if notes column exists, if not add it
    try {
      await pool.query(`
        SELECT notes FROM contacts LIMIT 1
      `);
    } catch (columnError) {
      if (columnError.code === '42703') { // Column does not exist
        console.log('Adding notes column to contacts table...');
        await pool.query(`
          ALTER TABLE contacts ADD COLUMN notes TEXT
        `);
        console.log('Notes column added successfully');
      }
    }
    
    // Check if created_at column exists, if not add it
    try {
      await pool.query(`
        SELECT created_at FROM contacts LIMIT 1
      `);
    } catch (columnError) {
      if (columnError.code === '42703') { // Column does not exist
        console.log('Adding created_at column to contacts table...');
        await pool.query(`
          ALTER TABLE contacts ADD COLUMN created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        `);
        console.log('Created_at column added successfully');
      }
    }
    
    // Check if updated_at column exists, if not add it
    try {
      await pool.query(`
        SELECT updated_at FROM contacts LIMIT 1
      `);
    } catch (columnError) {
      if (columnError.code === '42703') { // Column does not exist
        console.log('Adding updated_at column to contacts table...');
        await pool.query(`
          ALTER TABLE contacts ADD COLUMN updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        `);
        console.log('Updated_at column added successfully');
      }
    }
    
    // Create trigger to update updated_at timestamp
    await pool.query(`
      CREATE OR REPLACE FUNCTION update_updated_at_column()
      RETURNS TRIGGER AS $$
      BEGIN
        NEW.updated_at = CURRENT_TIMESTAMP;
        RETURN NEW;
      END;
      $$ language 'plpgsql';
    `);
    
    await pool.query(`
      DROP TRIGGER IF EXISTS update_contacts_updated_at ON contacts;
      CREATE TRIGGER update_contacts_updated_at
        BEFORE UPDATE ON contacts
        FOR EACH ROW
        EXECUTE FUNCTION update_updated_at_column();
    `);
    
    await pool.query(`
      CREATE TABLE IF NOT EXISTS events (
        id SERIAL PRIMARY KEY,
        google_event_id VARCHAR(255) UNIQUE NOT NULL,
        summary TEXT,
        description TEXT,
        start_time TIMESTAMP,
        end_time TIMESTAMP,
        attendees_count INTEGER DEFAULT 0,
        attendees_emails TEXT,
        hangout_link TEXT,
        notes TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    // Check if notes column exists in events table, if not add it
    try {
      await pool.query(`
        SELECT notes FROM events LIMIT 1
      `);
    } catch (columnError) {
      if (columnError.code === '42703') { // Column does not exist
        console.log('Adding notes column to events table...');
        await pool.query(`
          ALTER TABLE events ADD COLUMN notes TEXT
        `);
        console.log('Notes column added to events table successfully');
      }
    }
    
    console.log('Database initialized successfully');
    
    // Log current table schemas for debugging
    try {
      const contactsSchemaResult = await pool.query(`
        SELECT column_name, data_type 
        FROM information_schema.columns 
        WHERE table_name = 'contacts'
        ORDER BY ordinal_position
      `);
      console.log('Current contacts table schema:', contactsSchemaResult.rows);
      
      const eventsSchemaResult = await pool.query(`
        SELECT column_name, data_type 
        FROM information_schema.columns 
        WHERE table_name = 'events'
        ORDER BY ordinal_position
      `);
      console.log('Current events table schema:', eventsSchemaResult.rows);
    } catch (schemaError) {
      console.error('Error checking table schemas:', schemaError);
    }
    
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
    // First check if contacts table exists
    const result = await pool.query('SELECT * FROM contacts ORDER BY created_at DESC');
    res.json({
      success: true,
      data: result.rows || [],
      count: result.rows ? result.rows.length : 0
    });
  } catch (error) {
    console.error('Error fetching contacts:', error);
    // Return empty array instead of error to prevent frontend issues
    res.json({
      success: true,
      data: [],
      count: 0
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

// Create new contact
app.post('/api/contacts', async (req, res) => {
  const { email, name, tags, notes } = req.body;
  
  try {
    // Validate required fields
    if (!email) {
      return res.status(400).json({
        success: false,
        error: 'Email is required'
      });
    }
    
    // Ensure tags is an array
    let tagsArray = [];
    if (Array.isArray(tags)) {
      tagsArray = tags;
    } else if (typeof tags === 'string') {
      tagsArray = [tags];
    }
    
    const result = await pool.query(
      'INSERT INTO contacts (email, name, first_seen, last_seen, tags, notes) VALUES ($1, $2, CURRENT_DATE, CURRENT_DATE, $3, $4) RETURNING *',
      [email, name || email.split('@')[0], tagsArray, notes || '']
    );
    
    res.json({
      success: true,
      data: result.rows[0],
      message: 'Contact created successfully'
    });
  } catch (error) {
    console.error('Error creating contact:', error);
    if (error.code === '23505') { // Unique constraint violation
      // Try to get the existing contact and return it
      try {
        const existingResult = await pool.query(
          'SELECT * FROM contacts WHERE email = $1',
          [email]
        );
        if (existingResult.rows.length > 0) {
          res.status(409).json({
            success: false,
            error: 'Contact with this email already exists',
            data: existingResult.rows[0]
          });
        } else {
          res.status(409).json({
            success: false,
            error: 'Contact with this email already exists'
          });
        }
      } catch (getError) {
        res.status(409).json({
          success: false,
          error: 'Contact with this email already exists'
        });
      }
    } else {
      res.status(500).json({
        success: false,
        error: 'Failed to create contact: ' + error.message
      });
    }
  }
});

// Update contact tags
app.post('/api/contacts/:contactId/tags', async (req, res) => {
  const { contactId } = req.params;
  const { tags, notes } = req.body;
  
  try {
    // Validate tags array
    if (!Array.isArray(tags)) {
      return res.status(400).json({
        success: false,
        error: 'Tags must be an array'
      });
    }
    
    // Validate that intothecom emails don't get lead tags
    const contact = await pool.query('SELECT email FROM contacts WHERE id = $1', [contactId]);
    if (contact.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Contact not found'
      });
    }
    
    const email = contact.rows[0].email;
    const isIntothecomEmail = email.includes('@intothecom.com') || email.includes('@intothecom');
    
    if (isIntothecomEmail && tags.includes('New Lead')) {
      return res.status(400).json({
        success: false,
        error: 'Cannot mark IntoTheCom emails as leads'
      });
    }
    
    const result = await pool.query(
      'UPDATE contacts SET tags = $1, notes = $2 WHERE id = $3 RETURNING *',
      [tags, notes || '', contactId]
    );
    
    res.json({
      success: true,
      data: result.rows[0],
      message: 'Contact tags updated successfully'
    });
  } catch (error) {
    console.error('Error updating contact tags:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to update contact tags'
    });
  }
});

// Get contacts by tag
app.get('/api/contacts/tag/:tag', async (req, res) => {
  const { tag } = req.params;
  
  try {
    const result = await pool.query(
      'SELECT * FROM contacts WHERE $1 = ANY(tags) ORDER BY updated_at DESC',
      [tag]
    );
    
    res.json({
      success: true,
      data: result.rows,
      count: result.rows.length,
      tag: tag
    });
  } catch (error) {
    console.error('Error fetching contacts by tag:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch contacts by tag'
    });
  }
});

// Get available tags
app.get('/api/tags', async (req, res) => {
  try {
    // Start with predefined tags
    const predefinedTags = [
      { tag: 'New Lead', count: 0 }
    ];
    
    // Try to get existing tags from database
    let existingTags = [];
    try {
      // First check if contacts table exists and has data
      const tableCheck = await pool.query(`
        SELECT COUNT(*) as count FROM contacts
      `);
      
      if (tableCheck.rows[0].count > 0) {
        const result = await pool.query(`
          SELECT DISTINCT unnest(tags) as tag, COUNT(*) as count
          FROM contacts 
          WHERE tags IS NOT NULL AND array_length(tags, 1) > 0
          GROUP BY tag
          ORDER BY count DESC, tag ASC
        `);
        existingTags = result.rows || [];
      }
    } catch (dbError) {
      console.log('Database query for existing tags failed, using predefined tags only:', dbError.message);
      existingTags = [];
    }
    
    // Merge with existing tags
    const existingTagNames = existingTags.map(row => row.tag);
    const allTags = [...existingTags];
    
    for (const predefined of predefinedTags) {
      if (!existingTagNames.includes(predefined.tag)) {
        allTags.push(predefined);
      }
    }
    
    res.json({
      success: true,
      data: allTags.sort((a, b) => b.count - a.count)
    });
  } catch (error) {
    console.error('Error fetching tags:', error);
    
    // Fallback to predefined tags if everything fails
    res.json({
      success: true,
      data: [
        { tag: 'New Lead', count: 0 }
      ]
    });
  }
});

// Get event details
app.get('/api/events/:eventId', async (req, res) => {
  const { eventId } = req.params;
  
  try {
    if (!oAuth2Client) {
      return res.status(500).json({
        success: false,
        error: 'Google Calendar client not configured'
      });
    }
    
    if (!storedTokens) {
      return res.status(401).json({
        success: false,
        error: 'Google Calendar not authenticated'
      });
    }
    
    // Set credentials to ensure they're current
    oAuth2Client.setCredentials(storedTokens);
    
    const calendar = google.calendar({ version: 'v3', auth: oAuth2Client });
    const response = await calendar.events.get({
      calendarId: 'primary',
      eventId: eventId
    });
    
    const event = response.data;
    
    // Get notes from local database with fallback
    try {
      const dbResult = await pool.query('SELECT notes FROM events WHERE google_event_id = $1', [eventId]);
      if (dbResult.rows.length > 0) {
        event.notes = dbResult.rows[0].notes;
      } else {
        event.notes = '';
      }
    } catch (dbError) {
      console.log('Could not fetch notes from database:', dbError.message);
      event.notes = '';
    }
    
    res.json({
      success: true,
      data: event
    });
  } catch (error) {
    console.error('Error fetching event details:', error);
    if (error.code === 401 || error.code === 403) {
      // Clear expired tokens
      storedTokens = null;
      if (oAuth2Client) {
        oAuth2Client.setCredentials({});
      }
      res.status(401).json({
        success: false,
        error: 'Google Calendar authentication expired'
      });
    } else {
      res.status(500).json({
        success: false,
        error: 'Failed to fetch event details: ' + error.message
      });
    }
  }
});

// Update event
app.post('/api/events/:eventId', async (req, res) => {
  const { eventId } = req.params;
  const { summary, description, attendees, notes, start, end } = req.body;
  
  try {
    if (!oAuth2Client) {
      return res.status(500).json({
        success: false,
        error: 'Google Calendar client not configured'
      });
    }
    
    if (!storedTokens) {
      return res.status(401).json({
        success: false,
        error: 'Google Calendar not authenticated'
      });
    }
    
    // Set credentials to ensure they're current
    oAuth2Client.setCredentials(storedTokens);
    
    const calendar = google.calendar({ version: 'v3', auth: oAuth2Client });
    
    // Get current event
    const currentEvent = await calendar.events.get({
      calendarId: 'primary',
      eventId: eventId
    });
    
    // Build update data
    const updateData = {
      summary: summary || currentEvent.data.summary,
      description: description || currentEvent.data.description,
      attendees: attendees || currentEvent.data.attendees
    };
    
    // Add date/time if provided
    if (start) {
      updateData.start = start;
    }
    if (end) {
      updateData.end = end;
    }
    
    console.log('Updating event with data:', JSON.stringify(updateData, null, 2));
    
    const response = await calendar.events.update({
      calendarId: 'primary',
      eventId: eventId,
      requestBody: updateData
    });
    
    // Update local database
    try {
      await pool.query(
        'UPDATE events SET notes = $1, summary = $2, description = $3, start_time = $4, end_time = $5 WHERE google_event_id = $6',
        [
          notes || '', 
          summary || '', 
          description || '',
          start && start.dateTime ? start.dateTime : start?.date,
          end && end.dateTime ? end.dateTime : end?.date,
          eventId
        ]
      );
    } catch (dbError) {
      console.error('Error updating local database:', dbError);
      // Don't fail the entire request if database update fails
    }
    
    res.json({
      success: true,
      data: response.data,
      message: 'Event updated successfully'
    });
  } catch (error) {
    console.error('Error updating event:', error);
    console.error('Error details:', error.response?.data || error.message);
    
    if (error.code === 401 || error.code === 403) {
      // Clear expired tokens
      storedTokens = null;
      if (oAuth2Client) {
        oAuth2Client.setCredentials({});
      }
      res.status(401).json({
        success: false,
        error: 'Google Calendar authentication expired'
      });
    } else {
      res.status(500).json({
        success: false,
        error: 'Failed to update event: ' + (error.response?.data?.error?.message || error.message)
      });
    }
  }
});

// Real sync endpoint with Google Calendar
app.post('/api/sync', async (req, res) => {
  try {
    console.log('Real sync requested with Google Calendar');
    
    if (!oAuth2Client || !storedTokens) {
      return res.status(401).json({
        success: false,
        error: 'Google Calendar not authenticated'
      });
    }
    
    const calendar = google.calendar({ version: 'v3', auth: oAuth2Client });
    
    // Get events from the last 30 days
    const timeMin = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const timeMax = new Date();
    
    const response = await calendar.events.list({
      calendarId: 'primary',
      timeMin: timeMin.toISOString(),
      timeMax: timeMax.toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: 1000
    });
    
    const events = response.data.items || [];
    console.log(`Processing ${events.length} events for contact sync`);
    
    const result = {
      newContacts: [],
      totalContacts: 0,
      eventsProcessed: events.length,
      errors: []
    };
    
    // Process each event
    for (const event of events) {
      try {
        if (event.attendees && event.attendees.length > 0) {
          for (const attendee of event.attendees) {
            if (attendee.email && attendee.email.includes('@')) {
              await processContactFromEvent(attendee, event, result);
            }
          }
        }
        
        // Store event in database
        await storeEventInDatabase(event);
        
      } catch (eventError) {
        console.error('Error processing event:', event.id, eventError);
        result.errors.push(`Event ${event.id}: ${eventError.message}`);
      }
    }
    
    // Get total contacts count
    const contacts = await pool.query('SELECT COUNT(*) FROM contacts');
    result.totalContacts = parseInt(contacts.rows[0].count);
    
    res.json({
      success: true,
      data: result,
      message: `Sync completed: ${result.newContacts.length} new contacts, ${result.eventsProcessed} events processed`
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

// Helper function to process contacts from events
async function processContactFromEvent(attendee, event, result) {
  const email = attendee.email.toLowerCase();
  const name = attendee.displayName || attendee.email.split('@')[0];
  const eventDate = new Date(event.start.dateTime || event.start.date);
  
  try {
    // Check if contact already exists
    const existingContact = await pool.query(
      'SELECT * FROM contacts WHERE email = $1',
      [email]
    );
    
    if (existingContact.rows.length > 0) {
      // Update existing contact
      await pool.query(
        'UPDATE contacts SET last_seen = $1, meeting_count = meeting_count + 1, name = COALESCE(NULLIF($2, \'\'), name) WHERE email = $3',
        [eventDate.toISOString().split('T')[0], name, email]
      );
    } else {
      // Create new contact
      await pool.query(
        'INSERT INTO contacts (email, name, first_seen, last_seen, meeting_count) VALUES ($1, $2, $3, $4, 1)',
        [email, name, eventDate.toISOString().split('T')[0], eventDate.toISOString().split('T')[0]]
      );
      
      result.newContacts.push({
        email: email,
        name: name,
        first_seen: eventDate.toISOString().split('T')[0]
      });
    }
  } catch (error) {
    console.error('Error processing contact:', email, error);
    throw error;
  }
}

// Helper function to store events in database
async function storeEventInDatabase(event) {
  const eventId = event.id;
  const summary = event.summary || '';
  const description = event.description || '';
  const startTime = event.start.dateTime || event.start.date;
  const endTime = event.end.dateTime || event.end.date;
  const attendeesCount = event.attendees ? event.attendees.length : 0;
  const attendeesEmails = event.attendees ? event.attendees.map(a => a.email).join(', ') : '';
  const hangoutLink = event.hangoutLink || '';
  
  try {
    await pool.query(
      `INSERT INTO events (google_event_id, summary, description, start_time, end_time, attendees_count, attendees_emails, hangout_link) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (google_event_id) DO UPDATE SET
       summary = EXCLUDED.summary,
       description = EXCLUDED.description,
       start_time = EXCLUDED.start_time,
       end_time = EXCLUDED.end_time,
       attendees_count = EXCLUDED.attendees_count,
       attendees_emails = EXCLUDED.attendees_emails,
       hangout_link = EXCLUDED.hangout_link`,
      [eventId, summary, description, startTime, endTime, attendeesCount, attendeesEmails, hangoutLink]
    );
  } catch (error) {
    console.error('Error storing event in database:', eventId, error);
    throw error;
  }
}

// Google Calendar Authentication
const SCOPES = ['https://www.googleapis.com/auth/calendar'];
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
app.get('/api/auth/status', async (req, res) => {
  try {
    const isAuthenticated = !!(oAuth2Client && storedTokens);
    
    if (isAuthenticated) {
      // Verify tokens are still valid by making a test request
      const calendar = google.calendar({ version: 'v3', auth: oAuth2Client });
      await calendar.calendarList.list({ maxResults: 1 });
    }
    
    res.json({
      success: true,
      authenticated: isAuthenticated,
      message: isAuthenticated ? 'Google Calendar conectado' : 'Google Calendar desconectado'
    });
  } catch (error) {
    // Tokens are invalid or expired
    console.error('Auth verification failed:', error);
    storedTokens = null;
    if (oAuth2Client) {
      oAuth2Client.setCredentials({});
    }
    
    res.json({
      success: true,
      authenticated: false,
      message: 'Google Calendar desconectado'
    });
  }
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
    const view = req.query.view || 'week';
    const dateParam = req.query.date;
    
    const now = dateParam ? new Date(dateParam) : new Date();
    let timeMin, timeMax;
    
    switch (view) {
      case 'day':
        timeMin = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
        timeMax = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59);
        break;
      case 'week':
        const startOfWeek = new Date(now.getTime() - (now.getDay() * 24 * 60 * 60 * 1000));
        timeMin = new Date(startOfWeek.getFullYear(), startOfWeek.getMonth(), startOfWeek.getDate(), 0, 0, 0);
        timeMax = new Date(startOfWeek.getFullYear(), startOfWeek.getMonth(), startOfWeek.getDate() + 6, 23, 59, 59);
        break;
      case 'month':
      default:
        // For month view, we need to include days from adjacent weeks
        const firstDayOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
        const lastDayOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0);
        
        // Start from the first day of the week containing the first day of the month
        const startOfMonthView = new Date(firstDayOfMonth);
        startOfMonthView.setDate(startOfMonthView.getDate() - firstDayOfMonth.getDay());
        startOfMonthView.setHours(0, 0, 0, 0);
        
        // End on the last day of the week containing the last day of the month
        const endOfMonthView = new Date(lastDayOfMonth);
        endOfMonthView.setDate(endOfMonthView.getDate() + (6 - lastDayOfMonth.getDay()));
        endOfMonthView.setHours(23, 59, 59, 999);
        
        timeMin = startOfMonthView;
        timeMax = endOfMonthView;
        
        console.log('Month view range:', {
          requestedDate: dateParam || 'current',
          firstDay: firstDayOfMonth.toDateString(),
          lastDay: lastDayOfMonth.toDateString(),
          startView: startOfMonthView.toDateString(),
          endView: endOfMonthView.toDateString(),
          timeMin: timeMin.toISOString(),
          timeMax: timeMax.toISOString()
        });
        break;
    }
    
    const response = await calendar.events.list({
      calendarId: 'primary',
      timeMin: timeMin.toISOString(),
      timeMax: timeMax.toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
    });

    const events = response.data.items || [];
    console.log('Events fetched for ' + view + ' view:', {
      count: events.length,
      firstEvent: events[0] ? {
        summary: events[0].summary,
        start: events[0].start?.dateTime || events[0].start?.date
      } : null,
      lastEvent: events[events.length - 1] ? {
        summary: events[events.length - 1].summary,
        start: events[events.length - 1].start?.dateTime || events[events.length - 1].start?.date
      } : null
    });

    res.json({
      success: true,
      data: events,
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
      <script>
        // CRITICAL: This script must load FIRST to avoid SyntaxError cascade
        console.log('=== CRITICAL AUTH SCRIPT LOADING ===');
        
        window.startGoogleAuth = function() {
          console.log('startGoogleAuth called');
          fetch('/api/auth/google')
            .then(response => response.json())
            .then(result => {
              console.log('Auth result:', result);
              if (result.success && result.authUrl) {
                console.log('Opening auth window...');
                window.open(result.authUrl, '_blank');
              } else {
                alert('Error: ' + (result.error || 'Unknown error'));
              }
            })
            .catch(error => {
              console.error('Auth error:', error);
              alert('Error de conexión');
            });
        };
        
        // Also define as backup
        window.authenticateGoogle = window.startGoogleAuth;
        
        console.log('=== AUTH FUNCTIONS DEFINED ===');
      </script>
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
        
        .calendar-date-nav {
          display: flex;
          align-items: center;
          gap: 15px;
        }
        
        .nav-btn {
          background: #FF6B00;
          color: white;
          border: none;
          border-radius: 50%;
          width: 32px;
          height: 32px;
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 18px;
          font-weight: bold;
          transition: background 0.2s;
        }
        
        .nav-btn:hover {
          background: #E55A00;
        }
        
        .today-btn {
          background: #4CAF50;
          color: white;
          border: none;
          border-radius: 6px;
          padding: 8px 16px;
          cursor: pointer;
          font-size: 14px;
          font-weight: 500;
          margin-left: 10px;
        }
        
        .today-btn:hover {
          background: #45a049;
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
          cursor: pointer;
          padding: 4px;
          border-radius: 4px;
          transition: background-color 0.2s;
        }
        
        .month-day-number:hover {
          background: #FF6B00;
          color: white;
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
        
        /* Modal styles */
        .modal {
          display: none;
          position: fixed;
          z-index: 1000;
          left: 0;
          top: 0;
          width: 100%;
          height: 100%;
          background-color: rgba(0,0,0,0.5);
        }
        
        .modal-content {
          background-color: #fff;
          margin: 5% auto;
          padding: 0;
          border-radius: 12px;
          width: 90%;
          max-width: 600px;
          max-height: 90vh;
          overflow-y: auto;
          box-shadow: 0 10px 30px rgba(0,0,0,0.3);
        }
        
        .modal-header {
          background: #f7fafc;
          padding: 20px 30px;
          border-bottom: 1px solid #e2e8f0;
          border-radius: 12px 12px 0 0;
          display: flex;
          justify-content: space-between;
          align-items: center;
        }
        
        .modal-title {
          font-size: 24px;
          font-weight: 600;
          color: #1a202c;
          margin: 0;
        }
        
        .close-btn {
          background: none;
          border: none;
          font-size: 24px;
          cursor: pointer;
          color: #718096;
          padding: 0;
          width: 30px;
          height: 30px;
          display: flex;
          align-items: center;
          justify-content: center;
          border-radius: 50%;
          transition: all 0.2s;
        }
        
        .close-btn:hover {
          background: #e2e8f0;
          color: #2d3748;
        }
        
        .modal-body {
          padding: 30px;
        }
        
        .form-group {
          margin-bottom: 20px;
        }
        
        .form-label {
          display: block;
          margin-bottom: 8px;
          font-weight: 500;
          color: #2d3748;
        }
        
        .form-input {
          width: 100%;
          padding: 12px;
          border: 1px solid #e2e8f0;
          border-radius: 6px;
          font-size: 14px;
          color: #2d3748;
        }
        
        .form-input:focus {
          outline: none;
          border-color: #FF6B00;
          box-shadow: 0 0 0 3px rgba(255, 107, 0, 0.1);
        }
        
        .form-textarea {
          width: 100%;
          padding: 12px;
          border: 1px solid #e2e8f0;
          border-radius: 6px;
          font-size: 14px;
          color: #2d3748;
          min-height: 100px;
          resize: vertical;
        }
        
        .form-textarea:focus {
          outline: none;
          border-color: #FF6B00;
          box-shadow: 0 0 0 3px rgba(255, 107, 0, 0.1);
        }
        
        .attendees-list {
          background: #f7fafc;
          border: 1px solid #e2e8f0;
          border-radius: 6px;
          padding: 15px;
          margin-bottom: 15px;
        }
        
        .attendee-item {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 8px 0;
          border-bottom: 1px solid #e2e8f0;
        }
        
        .attendee-item:last-child {
          border-bottom: none;
        }
        
        .attendee-email {
          font-weight: 500;
          color: #2d3748;
        }
        
        .attendee-name {
          color: #718096;
          font-size: 14px;
        }
        
        .lead-badge {
          background: #FF6B00;
          color: white;
          padding: 2px 8px;
          border-radius: 4px;
          font-size: 12px;
          font-weight: 500;
        }
        
        .domain-badge {
          background: #e2e8f0;
          color: #4a5568;
          padding: 2px 8px;
          border-radius: 4px;
          font-size: 12px;
          font-weight: 500;
        }
        
        .tags-container {
          margin-top: 10px;
          display: flex;
          flex-direction: column;
          gap: 8px;
        }
        
        .tag-selector {
          position: relative;
          display: inline-block;
        }
        
        .tag-dropdown {
          border: 1px solid #e2e8f0;
          border-radius: 6px;
          padding: 8px;
          background: white;
          cursor: pointer;
          min-width: 120px;
          font-size: 14px;
        }
        
        .tag-dropdown:hover {
          border-color: #FF6B00;
        }
        
        .tag-dropdown-content {
          display: none;
          position: absolute;
          background-color: white;
          min-width: 160px;
          box-shadow: 0px 8px 16px rgba(0,0,0,0.2);
          z-index: 1;
          border-radius: 6px;
          border: 1px solid #e2e8f0;
          max-height: 200px;
          overflow-y: auto;
        }
        
        .tag-dropdown-content.show {
          display: block;
        }
        
        .tag-option {
          padding: 8px 12px;
          cursor: pointer;
          border-bottom: 1px solid #f7fafc;
          font-size: 14px;
        }
        
        .tag-option:hover {
          background-color: #f7fafc;
        }
        
        .tag-option:last-child {
          border-bottom: none;
        }
        
        .tag-option.selected {
          background-color: #FF6B00;
          color: white;
        }
        
        .contact-tags {
          display: flex;
          gap: 6px;
          flex-wrap: wrap;
          margin-top: 8px;
        }
        
        .tag-badge {
          background: #FF6B00;
          color: white;
          padding: 2px 8px;
          border-radius: 4px;
          font-size: 12px;
          font-weight: 500;
          position: relative;
          display: inline-flex;
          align-items: center;
          gap: 4px;
        }
        
        .tag-badge.hot-lead {
          background: #e53e3e;
        }
        
        .tag-badge.cold-lead {
          background: #4299e1;
        }
        
        .tag-badge.client {
          background: #38a169;
        }
        
        .tag-badge.partner {
          background: #805ad5;
        }
        
        .tag-badge.prospect {
          background: #d69e2e;
        }
        
        .tag-remove {
          cursor: pointer;
          margin-left: 4px;
          font-size: 12px;
          opacity: 0.7;
        }
        
        .tag-remove:hover {
          opacity: 1;
        }
        
        .modal-footer {
          background: #f7fafc;
          padding: 20px 30px;
          border-top: 1px solid #e2e8f0;
          border-radius: 0 0 12px 12px;
          display: flex;
          justify-content: flex-end;
          gap: 12px;
        }
        
        .btn-cancel {
          background: #e2e8f0;
          color: #4a5568;
          border: none;
          padding: 10px 20px;
          border-radius: 6px;
          cursor: pointer;
          font-weight: 500;
        }
        
        .btn-cancel:hover {
          background: #cbd5e0;
        }
        
        .btn-save {
          background: #FF6B00;
          color: white;
          border: none;
          padding: 10px 20px;
          border-radius: 6px;
          cursor: pointer;
          font-weight: 500;
        }
        
        .btn-save:hover {
          background: #E55A00;
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
                  <div class="calendar-date-nav">
                    <button onclick="navigateDate('prev')" class="nav-btn">‹</button>
                    <div class="calendar-title" id="calendarTitle">Mis Eventos</div>
                    <button onclick="navigateDate('next')" class="nav-btn">›</button>
                    <button onclick="goToToday()" class="today-btn">Hoy</button>
                  </div>
                  <div class="calendar-nav">
                    <button onclick="showDayView()" class="view-btn" data-view="day">Día</button>
                    <button onclick="showWeekView()" class="view-btn active" data-view="week">Semana</button>
                    <button onclick="showMonthView()" class="view-btn" data-view="month">Mes</button>
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

      <!-- Contact Details Modal -->
      <div id="contactModal" class="modal">
        <div class="modal-content">
          <div class="modal-header">
            <h2>Detalles del Contacto</h2>
            <span class="close-btn" onclick="closeContactModal()">&times;</span>
          </div>
          
          <div class="modal-body">
            <div class="form-group">
              <label>Email</label>
              <input type="email" id="contactEmail" class="form-input" readonly style="background: #f7fafc;">
            </div>
            
            <div class="form-group">
              <label>Nombre</label>
              <input type="text" id="contactName" class="form-input" placeholder="Nombre del contacto">
            </div>
            
            <div class="form-group">
              <label>Número de reuniones</label>
              <input type="number" id="contactMeetingCount" class="form-input" placeholder="0">
            </div>
            
            <div class="form-group">
              <label>Primera reunión</label>
              <input type="date" id="contactFirstSeen" class="form-input">
            </div>
            
            <div class="form-group">
              <label>Última reunión</label>
              <input type="date" id="contactLastSeen" class="form-input">
            </div>
            
            <div class="form-group">
              <label>Etiquetas</label>
              <div id="contactTagsContainer" class="contact-tags"></div>
              <div class="tag-selector" style="margin-top: 10px;">
                <div class="tag-dropdown" onclick="toggleContactTagDropdown()">
                  Agregar etiqueta ▼
                </div>
                <div class="tag-dropdown-content" id="contactTagDropdown"></div>
              </div>
            </div>
            
            <div class="form-group">
              <label>Notas</label>
              <textarea id="contactNotes" class="form-textarea" placeholder="Notas sobre este contacto..."></textarea>
            </div>
          </div>
          
          <div class="modal-footer">
            <button class="btn-cancel" onclick="closeContactModal()">Cancelar</button>
            <button class="btn-save" onclick="saveContactDetails()">Guardar Cambios</button>
          </div>
        </div>
      </div>
      
      <!-- Event Details Modal -->
      <div id="eventModal" class="modal">
        <div class="modal-content">
          <div class="modal-header">
            <h3 class="modal-title">Detalles del Evento</h3>
            <button class="close-btn" onclick="closeEventModal()">&times;</button>
          </div>
          <div class="modal-body">
            <div class="form-group">
              <label class="form-label">Título del Evento</label>
              <input type="text" id="eventTitle" class="form-input" placeholder="Título del evento">
            </div>
            
            <div class="form-group">
              <label class="form-label">Descripción</label>
              <textarea id="eventDescription" class="form-textarea" placeholder="Descripción del evento"></textarea>
            </div>
            
            <div class="form-group">
              <label class="form-label">Fecha y Hora</label>
              <div style="display: flex; gap: 10px; align-items: center;">
                <input type="date" id="eventStartDate" class="form-input" style="width: 150px;">
                <input type="time" id="eventStartTime" class="form-input" style="width: 100px;">
                <span>hasta</span>
                <input type="time" id="eventEndTime" class="form-input" style="width: 100px;">
              </div>
              <label style="margin-top: 10px; display: flex; align-items: center; gap: 8px;">
                <input type="checkbox" id="eventAllDay"> Todo el día
              </label>
            </div>
            
            <div class="form-group">
              <label class="form-label">Asistentes</label>
              <div id="attendeesList" class="attendees-list"></div>
              <div style="margin-top: 10px;">
                <input type="email" id="newAttendeeEmail" class="form-input" placeholder="email@ejemplo.com" style="margin-bottom: 10px;">
                <button class="btn btn-secondary" onclick="addAttendee()">Agregar Asistente</button>
              </div>
            </div>
            
            <div class="form-group">
              <label class="form-label">Notas Internas</label>
              <textarea id="eventNotes" class="form-textarea" placeholder="Notas sobre esta reunión..."></textarea>
            </div>
            
            <div class="form-group">
              <label class="form-label">Enlace de Reunión</label>
              <div id="meetingLink" style="padding: 10px; background: #f7fafc; border: 1px solid #e2e8f0; border-radius: 6px;"></div>
            </div>
          </div>
          <div class="modal-footer">
            <button class="btn-cancel" onclick="closeEventModal()">Cancelar</button>
            <button class="btn-save" onclick="saveEventChanges()">Guardar Cambios</button>
          </div>
        </div>
      </div>

      <script>
        // Auth function already defined in head
        
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

        // Simple status function defined first
        function showStatus(message, type) {
          console.log('Status:', message, type);
          const statusDiv = document.getElementById('status') || document.getElementById('syncStatus');
          if (statusDiv) {
            statusDiv.innerHTML = '<div class="status ' + type + '">' + message + '</div>';
          } else {
            const calendarGrid = document.querySelector('.calendar-grid');
            if (calendarGrid && type !== 'loading') {
              calendarGrid.innerHTML = '<div class="status ' + type + '">' + message + '</div>';
            }
          }
        }

        // authenticateGoogle already defined in head

        // Listen for authentication success message
        window.addEventListener('message', (event) => {
          if (event.data && event.data.type === 'google-auth-success') {
            showStatus('Autenticación completada exitosamente', 'success');
            updateAuthButton(true);
            setTimeout(() => {
              loadCalendarEvents('week');
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
              // Load calendar events automatically if authenticated
              const activeTab = document.querySelector('.nav-item.active')?.getAttribute('data-tab');
              if (activeTab === 'calendar' || !activeTab) {
                loadCalendarEvents('week');
              }
            } else {
              updateAuthButton(false);
            }
          } catch (error) {
            console.error('Error checking auth status:', error);
            updateAuthButton(false);
          }
        }

        // Check only auth status without reloading events
        async function checkAuthStatusOnly() {
          try {
            const response = await fetch('/api/auth/status');
            const result = await response.json();
            
            if (result.success && result.authenticated) {
              updateAuthButton(true);
            } else {
              updateAuthButton(false);
              // Clear cache if not authenticated
              cachedEvents = null;
              lastFetchTime = null;
            }
          } catch (error) {
            console.error('Error checking auth status:', error);
            updateAuthButton(false);
          }
        }

        // Update authentication button based on status
        function updateAuthButton(isAuthenticated) {
          const authButton = document.getElementById('authButton');
          
          if (!authButton) {
            console.warn('Auth button not found in DOM');
            return;
          }
          
          if (isAuthenticated) {
            authButton.innerHTML = '<div class="connection-status connected">✓ Conectado</div>';
            startAutoSync();
          } else {
            authButton.innerHTML = '<button class="btn btn-primary" onclick="authenticateGoogle()">Conectar Google</button>';
            stopAutoSync();
            // Also update calendar grid to show connection prompt
            const calendarGrid = document.querySelector('.calendar-grid');
            const currentTab = document.querySelector('.nav-item.active')?.getAttribute('data-tab');
            
            if (calendarGrid && (currentTab === 'calendar' || !currentTab)) {
              calendarGrid.innerHTML = 
                '<div class="auth-prompt">' +
                  '<h3>Conecta tu Google Calendar</h3>' +
                  '<p>Autoriza el acceso a tu calendario para ver y gestionar eventos</p>' +
                  '<button class="btn btn-primary" onclick="authenticateGoogle()" style="margin-top: 20px;">' +
                    'Conectar Google Calendar' +
                  '</button>' +
                '</div>';
            }
          }
        }

        // Start automatic synchronization
        function startAutoSync() {
          if (autoSyncInterval) return; // Already running
          
          autoSyncInterval = setInterval(async () => {
            // Only sync if calendar tab is active
            const activeTab = document.querySelector('.nav-item.active')?.getAttribute('data-tab');
            if (activeTab === 'calendar') {
              await syncCalendarSilently();
            }
          }, AUTO_SYNC_INTERVAL);
        }

        // Stop automatic synchronization
        function stopAutoSync() {
          if (autoSyncInterval) {
            clearInterval(autoSyncInterval);
            autoSyncInterval = null;
          }
        }

        // Silent sync - updates without showing loading
        async function syncCalendarSilently() {
          try {
            const activeView = document.querySelector('.view-btn.active')?.getAttribute('data-view') || 'week';
            const dateParam = currentDate.toISOString().split('T')[0];
            const response = await fetch('/api/calendar/events?view=' + activeView + '&date=' + dateParam);
            const result = await response.json();
            
            if (result.success && result.data) {
              // Check if there are changes
              const hasChanges = !cachedEvents || JSON.stringify(cachedEvents) !== JSON.stringify(result.data);
              
              if (hasChanges) {
                cachedEvents = result.data;
                lastFetchTime = Date.now();
                renderCalendarView(result.data, activeView);
              }
            }
          } catch (error) {
            console.error('Silent sync error:', error);
          }
        }

        // Cache system for events
        let cachedEvents = null;
        let lastFetchTime = null;
        const CACHE_DURATION = 60000; // 1 minuto
        let autoSyncInterval = null;
        const AUTO_SYNC_INTERVAL = 120000; // 2 minutos
        
        // Current date state for navigation
        let currentDate = new Date();
        let currentView = 'week';
        
        // Check auth status on page load
        document.addEventListener('DOMContentLoaded', () => {
          updateCalendarTitle();
          // Add a small delay to ensure DOM is fully rendered
          setTimeout(() => {
            checkAuthStatus();
          }, 100);
        });
        
        // Check auth status when tab becomes visible, but don't reload events unnecessarily
        document.addEventListener('visibilitychange', () => {
          if (!document.hidden) {
            checkAuthStatusOnly();
          }
        });

        // Clean up on page unload
        window.addEventListener('beforeunload', () => {
          stopAutoSync();
        });

        async function loadCalendarEvents(view = 'week', forceRefresh = false) {
          const calendarGrid = document.querySelector('.calendar-grid');
          
          // Check if we can use cached data
          const now = Date.now();
          if (!forceRefresh && cachedEvents && lastFetchTime && (now - lastFetchTime) < CACHE_DURATION) {
            renderCalendarView(cachedEvents, view);
            return;
          }
          
          calendarGrid.innerHTML = '<div class="status loading">Cargando eventos...</div>';
          
          try {
            const dateParam = getLocalDateString(currentDate);
            console.log('Loading events:', {
              view: view,
              date: dateParam,
              currentDate: currentDate.toDateString(),
              actualDay: currentDate.getDate(),
              forceRefresh: forceRefresh
            });
            const response = await fetch('/api/calendar/events?view=' + view + '&date=' + dateParam);
            const result = await response.json();
            
            // Cache the results
            if (result.success) {
              cachedEvents = result.data;
              lastFetchTime = now;
            }
            
            if (result.success) {
              renderCalendarView(result.data, view);
            } else {
              calendarGrid.innerHTML = '<div class="status error">Error: ' + result.error + '</div>';
              // If authentication error, update button status
              if (result.error.includes('Authentication')) {
                updateAuthButton(false);
              }
            }
          } catch (error) {
            calendarGrid.innerHTML = '<div class="status error">Error de conexión: ' + error.message + '</div>';
            // Check if it's an auth error and update button
            if (error.message.includes('401') || error.message.includes('Authentication')) {
              updateAuthButton(false);
            }
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
          currentView = 'day';
          updateViewButtons('day');
          updateCalendarTitle();
          loadCalendarEventsForDate();
        }

        function showWeekView() {
          currentView = 'week';
          updateViewButtons('week');
          updateCalendarTitle();
          loadCalendarEventsForDate();
        }

        function showMonthView() {
          currentView = 'month';
          updateViewButtons('month');
          updateCalendarTitle();
          loadCalendarEventsForDate();
        }

        function updateViewButtons(activeView) {
          document.querySelectorAll('.view-btn').forEach(btn => {
            btn.classList.remove('active');
            if (btn.getAttribute('data-view') === activeView) {
              btn.classList.add('active');
            }
          });
        }

        let currentEventId = null;
        let currentEventData = null;

        async function showEventDetails(eventId) {
          try {
            currentEventId = eventId;
            
            // Show loading state
            const modal = document.getElementById('eventModal');
            modal.style.display = 'block';
            
            // Fetch event details
            const response = await fetch('/api/events/' + eventId);
            const result = await response.json();
            
            if (result.success) {
              currentEventData = result.data;
              populateEventModal(result.data);
            } else {
              alert('Error al cargar detalles del evento: ' + result.error);
              closeEventModal();
            }
          } catch (error) {
            console.error('Error loading event details:', error);
            alert('Error de conexión al cargar detalles del evento');
            closeEventModal();
          }
        }

        let availableTags = [{ tag: 'New Lead', count: 0 }];
        let contactsData = {};

        async function populateEventModal(event) {
          document.getElementById('eventTitle').value = event.summary || '';
          document.getElementById('eventDescription').value = event.description || '';
          document.getElementById('eventNotes').value = event.notes || '';
          
          // Format date and time for editing
          const startDate = new Date(event.start.dateTime || event.start.date);
          const endDate = new Date(event.end.dateTime || event.end.date);
          
          // Set date field
          document.getElementById('eventStartDate').value = startDate.toISOString().split('T')[0];
          
          // Check if it's all day event
          const isAllDay = !event.start.dateTime;
          document.getElementById('eventAllDay').checked = isAllDay;
          
          if (isAllDay) {
            document.getElementById('eventStartTime').value = '';
            document.getElementById('eventEndTime').value = '';
            document.getElementById('eventStartTime').disabled = true;
            document.getElementById('eventEndTime').disabled = true;
          } else {
            document.getElementById('eventStartTime').value = startDate.toTimeString().slice(0, 5);
            document.getElementById('eventEndTime').value = endDate.toTimeString().slice(0, 5);
            document.getElementById('eventStartTime').disabled = false;
            document.getElementById('eventEndTime').disabled = false;
          }
          
          // Add event listener for all day checkbox
          document.getElementById('eventAllDay').addEventListener('change', function() {
            const isAllDay = this.checked;
            document.getElementById('eventStartTime').disabled = isAllDay;
            document.getElementById('eventEndTime').disabled = isAllDay;
            if (isAllDay) {
              document.getElementById('eventStartTime').value = '';
              document.getElementById('eventEndTime').value = '';
            } else {
              document.getElementById('eventStartTime').value = '09:00';
              document.getElementById('eventEndTime').value = '10:00';
            }
          });
          
          // Load available tags and contacts data FIRST
          await loadTagsAndContacts();
          
          // Populate attendees AFTER tags are loaded
          const attendeesList = document.getElementById('attendeesList');
          attendeesList.innerHTML = '';
          
          console.log('Event attendees:', event.attendees);
          console.log('Available tags loaded:', availableTags);
          
          if (event.attendees && event.attendees.length > 0) {
            for (const attendee of event.attendees) {
              const attendeeDiv = document.createElement('div');
              attendeeDiv.className = 'attendee-item';
              
              const email = attendee.email || '';
              const domain = email.includes('@') ? email.split('@')[1] : '';
              const isIntothecomEmail = email.includes('@intothecom.com') || email.includes('@intothecom');
              
              // Get contact data for this email (create if doesn't exist)
              let contactData = contactsData[email];
              if (!contactData) {
                contactData = { tags: [], notes: '', id: null };
                contactsData[email] = contactData;
              }
              
              attendeeDiv.innerHTML = 
                '<div>' +
                  '<div class="attendee-email">' + email + '</div>' +
                  '<div class="attendee-name">' + (attendee.displayName || attendee.email.split('@')[0]) + '</div>' +
                  '<div class="contact-tags" id="tags-' + email.replace(/[^a-zA-Z0-9]/g, '') + '">' +
                    renderContactTags(contactData.tags) +
                  '</div>' +
                '</div>' +
                '<div>' +
                  (!isIntothecomEmail ? '<span class="domain-badge">Externo</span>' : '<span class="domain-badge" style="background: #38a169;">IntoTheCom</span>') +
                  (!isIntothecomEmail ? '<div class="tags-container">' +
                    '<div class="tag-selector">' +
                      '<div class="tag-dropdown" onclick="toggleTagDropdown(\'' + email.replace(/'/g, '&#39;') + '\')">' +
                        'Agregar etiqueta ▼' +
                      '</div>' +
                      '<div class="tag-dropdown-content" id="dropdown-' + email.replace(/[^a-zA-Z0-9]/g, '') + '">' +
                        renderTagOptions(email, contactData.tags) +
                      '</div>' +
                    '</div>' +
                  '</div>' : '') +
                '</div>';
              
              attendeesList.appendChild(attendeeDiv);
            }
          } else {
            attendeesList.innerHTML = '<div style="text-align: center; color: #718096; padding: 20px;">No hay asistentes registrados</div>';
          }
          
          // Meeting link
          const meetingLink = document.getElementById('meetingLink');
          if (event.hangoutLink) {
            meetingLink.innerHTML = '<a href="' + event.hangoutLink + '" target="_blank" style="color: #FF6B00; text-decoration: none;">🔗 Unirse a la reunión</a>';
          } else {
            meetingLink.innerHTML = '<span style="color: #718096;">No hay enlace de reunión</span>';
          }
        }

        async function loadTagsAndContacts() {
          try {
            // Load available tags with fallback
            try {
              const tagsResponse = await fetch('/api/tags');
              const tagsResult = await tagsResponse.json();
              if (tagsResult.success) {
                availableTags = tagsResult.data;
              } else {
                // Fallback to predefined tags
                availableTags = [
                  { tag: 'New Lead', count: 0 }
                ];
              }
            } catch (tagError) {
              console.error('Error loading tags, using fallback:', tagError);
              // Fallback to predefined tags
              availableTags = [
                { tag: 'New Lead', count: 0 }
              ];
            }
            
            // Load all contacts to get their current tags
            try {
              const contactsResponse = await fetch('/api/contacts');
              const contactsResult = await contactsResponse.json();
              if (contactsResult.success) {
                contactsData = {};
                contactsResult.data.forEach(contact => {
                  contactsData[contact.email] = {
                    id: contact.id,
                    tags: contact.tags || [],
                    notes: contact.notes || ''
                  };
                });
              }
            } catch (contactError) {
              console.error('Error loading contacts:', contactError);
              contactsData = {};
            }
          } catch (error) {
            console.error('Error loading tags and contacts:', error);
          }
        }

        function renderContactTags(tags) {
          if (!tags || tags.length === 0) return '';
          
          return tags.map(tag => {
            const tagClass = tag.toLowerCase().replace(/\s+/g, '-');
            const escapedTag = tag.replace(/'/g, '&#39;').replace(/"/g, '&quot;');
            return '<span class="tag-badge ' + tagClass + '">' + tag + 
                   '<span class="tag-remove" onclick="removeTag(\'' + escapedTag + '\', this)">×</span></span>';
          }).join('');
        }

        function renderTagOptions(email, currentTags) {
          if (!availableTags || !Array.isArray(availableTags) || availableTags.length === 0) {
            console.warn('availableTags is not available or empty, using fallback');
            return '<div class="tag-option-error">Cargando etiquetas...</div>';
          }
          
          return availableTags.map(tagInfo => {
            if (!tagInfo || !tagInfo.tag) {
              console.warn('Invalid tag info:', tagInfo);
              return '';
            }
            
            const tag = tagInfo.tag;
            const isSelected = currentTags.includes(tag);
            const escapedEmail = email.replace(/'/g, '&#39;').replace(/"/g, '&quot;');
            const escapedTag = tag.replace(/'/g, '&#39;').replace(/"/g, '&quot;');
            
            return '<div class="tag-option ' + (isSelected ? 'selected' : '') + '" ' +
                   'onclick="toggleTag(\'' + escapedEmail + '\', \'' + escapedTag + '\', this)">' +
                   tag + (isSelected ? ' ✓' : '') +
                   '</div>';
          }).join('');
        }

        function toggleTagDropdown(email) {
          const dropdownId = 'dropdown-' + email.replace(/[^a-zA-Z0-9]/g, '');
          const dropdown = document.getElementById(dropdownId);
          
          if (!dropdown) {
            console.error('Dropdown not found for email:', email, 'ID:', dropdownId);
            return;
          }
          
          // Close all other dropdowns
          document.querySelectorAll('.tag-dropdown-content').forEach(d => {
            if (d.id !== dropdownId) {
              d.classList.remove('show');
            }
          });
          
          dropdown.classList.toggle('show');
        }

        async function toggleTag(email, tag, element) {
          let contactData = contactsData[email] || { tags: [], notes: '' };
          
          const isSelected = element.classList.contains('selected');
          let newTags;
          
          if (isSelected) {
            // Remove tag
            newTags = contactData.tags.filter(t => t !== tag);
            element.classList.remove('selected');
            element.textContent = tag;
          } else {
            // Add tag
            newTags = [...contactData.tags, tag];
            element.classList.add('selected');
            element.textContent = tag + ' ✓';
          }
          
          // Always try to create or update contact with simplified approach
          try {
            let contactId = contactData.id;
            
            // If no ID, try to create contact
            if (!contactId) {
              try {
                const createResponse = await fetch('/api/contacts', {
                  method: 'POST',
                  headers: {
                    'Content-Type': 'application/json'
                  },
                  body: JSON.stringify({
                    email: email,
                    name: email.split('@')[0],
                    tags: newTags,
                    notes: contactData.notes || ''
                  })
                });
                
                const createResult = await createResponse.json();
                if (createResult.success) {
                  contactId = createResult.data.id;
                  contactData.id = contactId;
                  contactData.tags = newTags;
                  contactsData[email] = contactData;
                  
                  // Update UI
                  const tagsContainer = document.getElementById('tags-' + email.replace(/[^a-zA-Z0-9]/g, ''));
                  if (tagsContainer) {
                    tagsContainer.innerHTML = renderContactTags(newTags);
                  } else {
                    console.warn('Tags container not found for email:', email);
                  }
                  
                  console.log('Contact created and tag added successfully');
                  return;
                } else if (createResponse.status === 409) {
                  // Contact exists, check if the response includes the existing contact data
                  if (createResult.data && createResult.data.id) {
                    contactId = createResult.data.id;
                    contactData.id = contactId;
                    contactData.tags = createResult.data.tags || [];
                    contactsData[email] = contactData;
                    // Continue to update tags below
                  } else {
                    // If no data in response, try to get it from the full contacts list
                    try {
                      const getResponse = await fetch('/api/contacts');
                      const getResult = await getResponse.json();
                      if (getResult.success) {
                        const existingContact = getResult.data.find(c => c.email === email);
                        if (existingContact) {
                          contactId = existingContact.id;
                          contactData.id = contactId;
                          contactData.tags = existingContact.tags || [];
                          contactsData[email] = contactData;
                          // Continue to update tags below
                        }
                      }
                    } catch (getError) {
                      console.error('Error getting existing contact:', getError);
                      alert('Error: El contacto ya existe pero no se pudo obtener su información');
                      return;
                    }
                  }
                } else {
                  console.error('Error creating contact:', createResult.error);
                  console.error('Response status:', createResponse.status);
                  console.error('Full response:', createResult);
                  alert('Error: ' + (createResult.error || 'Unknown error'));
                  // Revert UI changes
                  if (isSelected) {
                    element.classList.add('selected');
                    element.textContent = tag + ' ✓';
                  } else {
                    element.classList.remove('selected');
                    element.textContent = tag;
                  }
                  return;
                }
              } catch (createError) {
                console.error('Error in contact creation:', createError);
                alert('Error de conexión: ' + createError.message);
                // Revert UI changes
                if (isSelected) {
                  element.classList.add('selected');
                  element.textContent = tag + ' ✓';
                } else {
                  element.classList.remove('selected');
                  element.textContent = tag;
                }
                return;
              }
            }
            
            // Update tags for existing contact
            if (contactId) {
              const updateResponse = await fetch('/api/contacts/' + contactId + '/tags', {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                  tags: newTags,
                  notes: contactData.notes || ''
                })
              });
              
              const updateResult = await updateResponse.json();
              if (updateResult.success) {
                contactData.tags = newTags;
                contactsData[email] = contactData;
                
                // Update UI
                const tagsContainer = document.getElementById('tags-' + email.replace(/[^a-zA-Z0-9]/g, ''));
                if (tagsContainer) {
                  tagsContainer.innerHTML = renderContactTags(newTags);
                } else {
                  console.warn('Tags container not found for email:', email);
                }
                
                console.log('Tag updated successfully');
              } else {
                console.error('Error updating tag:', updateResult.error);
                alert('Error al actualizar etiqueta: ' + updateResult.error);
              }
            }
          } catch (error) {
            console.error('Error in toggleTag:', error);
            alert('Error de conexión');
          }
        }

        function removeTag(tagToRemove, element) {
          const attendeeItem = element.closest('.attendee-item');
          const email = attendeeItem.querySelector('.attendee-email').textContent;
          const contactData = contactsData[email];
          
          if (!contactData) return;
          
          const newTags = contactData.tags.filter(tag => tag !== tagToRemove);
          
          // Update in backend
          fetch('/api/contacts/' + contactData.id + '/tags', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              tags: newTags,
              notes: contactData.notes
            })
          }).then(response => response.json())
          .then(result => {
            if (result.success) {
              // Update local data
              contactData.tags = newTags;
              
              // Update UI
              const tagsContainer = document.getElementById('tags-' + email.replace(/[^a-zA-Z0-9]/g, ''));
              if (tagsContainer) {
                tagsContainer.innerHTML = renderContactTags(newTags);
              } else {
                console.warn('Tags container not found for email:', email);
              }
              
              // Update dropdown
              const dropdown = document.getElementById('dropdown-' + email.replace(/[^a-zA-Z0-9]/g, ''));
              dropdown.innerHTML = renderTagOptions(email, newTags);
            } else {
              alert('Error al eliminar etiqueta: ' + result.error);
            }
          }).catch(error => {
            console.error('Error removing tag:', error);
            alert('Error de conexión al eliminar etiqueta');
          });
        }

        function closeEventModal() {
          document.getElementById('eventModal').style.display = 'none';
          currentEventId = null;
          currentEventData = null;
        }
        
        // Contact Details Modal Functions
        let currentContactEmail = null;
        let currentContactData = null;
        
        async function showContactDetails(email) {
          try {
            currentContactEmail = email;
            
            // Show modal
            const modal = document.getElementById('contactModal');
            modal.style.display = 'block';
            
            // Load contact data
            const response = await fetch('/api/contacts');
            const result = await response.json();
            
            if (result.success) {
              const contact = result.data.find(c => c.email === email);
              if (contact) {
                currentContactData = contact;
                populateContactModal(contact);
              } else {
                alert('Contacto no encontrado');
                closeContactModal();
              }
            } else {
              alert('Error al cargar contacto: ' + result.error);
              closeContactModal();
            }
          } catch (error) {
            console.error('Error loading contact details:', error);
            alert('Error de conexión al cargar contacto');
            closeContactModal();
          }
        }
        
        function populateContactModal(contact) {
          document.getElementById('contactEmail').value = contact.email || '';
          document.getElementById('contactName').value = contact.name || '';
          document.getElementById('contactMeetingCount').value = contact.meeting_count || 0;
          document.getElementById('contactFirstSeen').value = contact.first_seen || '';
          document.getElementById('contactLastSeen').value = contact.last_seen || '';
          document.getElementById('contactNotes').value = contact.notes || '';
          
          // Populate tags
          const tagsContainer = document.getElementById('contactTagsContainer');
          tagsContainer.innerHTML = renderContactTags(contact.tags || []);
          
          // Populate tag dropdown
          const dropdown = document.getElementById('contactTagDropdown');
          dropdown.innerHTML = availableTags.map(tagInfo => {
            const tag = tagInfo.tag;
            const isSelected = (contact.tags || []).includes(tag);
            return '<div class="tag-option ' + (isSelected ? 'selected' : '') + '" onclick="toggleContactTag(\'' + tag + '\')">' +
                   tag + (isSelected ? ' ✓' : '') +
                   '</div>';
          }).join('');
        }
        
        function toggleContactTagDropdown() {
          const dropdown = document.getElementById('contactTagDropdown');
          dropdown.classList.toggle('show');
        }
        
        function toggleContactTag(tag) {
          if (!currentContactData) return;
          
          const currentTags = currentContactData.tags || [];
          let newTags;
          
          if (currentTags.includes(tag)) {
            newTags = currentTags.filter(t => t !== tag);
          } else {
            newTags = [...currentTags, tag];
          }
          
          // Update local data
          currentContactData.tags = newTags;
          
          // Update UI
          const tagsContainer = document.getElementById('contactTagsContainer');
          tagsContainer.innerHTML = renderContactTags(newTags);
          
          // Update dropdown
          const dropdown = document.getElementById('contactTagDropdown');
          dropdown.innerHTML = availableTags.map(tagInfo => {
            const tagName = tagInfo.tag;
            const isSelected = newTags.includes(tagName);
            return '<div class="tag-option ' + (isSelected ? 'selected' : '') + '" onclick="toggleContactTag(\'' + tagName + '\')">' +
                   tagName + (isSelected ? ' ✓' : '') +
                   '</div>';
          }).join('');
        }
        
        function closeContactModal() {
          document.getElementById('contactModal').style.display = 'none';
          currentContactEmail = null;
          currentContactData = null;
        }
        
        async function saveContactDetails() {
          if (!currentContactData) return;
          
          const name = document.getElementById('contactName').value;
          const notes = document.getElementById('contactNotes').value;
          const tags = currentContactData.tags || [];
          
          try {
            const response = await fetch('/api/contacts/' + currentContactData.id + '/tags', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json'
              },
              body: JSON.stringify({
                tags: tags,
                notes: notes
              })
            });
            
            const result = await response.json();
            
            if (result.success) {
              alert('Contacto actualizado exitosamente');
              closeContactModal();
              // Refresh contacts view if we're on contacts tab
              const activeTab = document.querySelector('.nav-item.active')?.getAttribute('data-tab');
              if (activeTab === 'contacts') {
                loadContacts();
              }
            } else {
              alert('Error al actualizar contacto: ' + result.error);
            }
          } catch (error) {
            console.error('Error saving contact:', error);
            alert('Error de conexión al guardar contacto');
          }
        }

        async function saveEventChanges() {
          if (!currentEventId) return;
          
          const title = document.getElementById('eventTitle').value;
          const description = document.getElementById('eventDescription').value;
          const notes = document.getElementById('eventNotes').value;
          
          // Get date and time values
          const startDate = document.getElementById('eventStartDate').value;
          const startTime = document.getElementById('eventStartTime').value;
          const endTime = document.getElementById('eventEndTime').value;
          const isAllDay = document.getElementById('eventAllDay').checked;
          
          // Collect attendees
          const attendeeEmails = [];
          const attendeeElements = document.querySelectorAll('.attendee-item');
          attendeeElements.forEach(element => {
            const emailElement = element.querySelector('.attendee-email');
            if (emailElement) {
              const email = emailElement.textContent;
              if (email) attendeeEmails.push({ email: email });
            }
          });
          
          // Build start and end times
          let start, end;
          if (isAllDay) {
            start = { date: startDate };
            end = { date: startDate };
          } else {
            if (!startTime || !endTime) {
              alert('Por favor ingresa las horas de inicio y fin');
              return;
            }
            // Add timezone to avoid Google Calendar API error
            const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
            start = { 
              dateTime: startDate + 'T' + startTime + ':00',
              timeZone: timezone
            };
            end = { 
              dateTime: startDate + 'T' + endTime + ':00',
              timeZone: timezone
            };
          }
          
          try {
            const response = await fetch('/api/events/' + currentEventId, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json'
              },
              body: JSON.stringify({
                summary: title,
                description: description,
                attendees: attendeeEmails,
                notes: notes,
                start: start,
                end: end
              })
            });
            
            const result = await response.json();
            
            if (result.success) {
              alert('Evento actualizado exitosamente');
              closeEventModal();
              // Refresh calendar view
              refreshData();
            } else {
              alert('Error al actualizar evento: ' + result.error);
            }
          } catch (error) {
            console.error('Error saving event:', error);
            alert('Error de conexión al guardar cambios');
          }
        }

        function addAttendee() {
          const email = document.getElementById('newAttendeeEmail').value.trim();
          if (!email) return;
          
          // Validate email
          const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
          if (!emailRegex.test(email)) {
            alert('Por favor ingresa un email válido');
            return;
          }
          
          // Check if already exists
          const existingAttendees = document.querySelectorAll('.attendee-email');
          for (let attendee of existingAttendees) {
            if (attendee.textContent === email) {
              alert('Este asistente ya está en la lista');
              return;
            }
          }
          
          // Add to current event data
          if (!currentEventData.attendees) {
            currentEventData.attendees = [];
          }
          currentEventData.attendees.push({ email: email });
          
          // Clear input
          document.getElementById('newAttendeeEmail').value = '';
          
          // Re-populate modal
          populateEventModal(currentEventData);
        }


        // Close modal when clicking outside
        window.onclick = function(event) {
          const modal = document.getElementById('eventModal');
          if (event.target === modal) {
            closeEventModal();
          }
        }

        // Navigation functions
        function navigateDate(direction) {
          const prevDate = new Date(currentDate);
          
          if (currentView === 'day') {
            currentDate.setDate(currentDate.getDate() + (direction === 'next' ? 1 : -1));
          } else if (currentView === 'week') {
            currentDate.setDate(currentDate.getDate() + (direction === 'next' ? 7 : -7));
          } else if (currentView === 'month') {
            currentDate.setMonth(currentDate.getMonth() + (direction === 'next' ? 1 : -1));
          }
          
          console.log('Navigation - Previous date:', prevDate.toDateString(), 'New date:', currentDate.toDateString(), 'View:', currentView);
          
          updateCalendarTitle();
          loadCalendarEventsForDate();
        }

        function goToToday() {
          currentDate = new Date();
          currentView = 'day';
          updateViewButtons('day');
          console.log('Going to today (day view):', currentDate.toDateString());
          updateCalendarTitle();
          loadCalendarEventsForDate();
        }

        function getLocalDateString(date) {
          const year = date.getFullYear();
          const month = String(date.getMonth() + 1).padStart(2, '0');
          const day = String(date.getDate()).padStart(2, '0');
          return year + '-' + month + '-' + day;
        }

        function selectDayFromMonth(dateString) {
          // Create date from local string to avoid timezone issues
          const parts = dateString.split('-');
          currentDate = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
          currentView = 'day';
          updateViewButtons('day');
          console.log('Selected day from month view:', {
            dateString: dateString,
            selectedDate: currentDate.toDateString(),
            view: currentView,
            actualDay: currentDate.getDate()
          });
          updateCalendarTitle();
          loadCalendarEventsForDate();
        }

        function updateCalendarTitle() {
          const titleElement = document.getElementById('calendarTitle');
          if (!titleElement) return;
          
          const options = { year: 'numeric', month: 'long', day: 'numeric' };
          
          if (currentView === 'day') {
            titleElement.textContent = currentDate.toLocaleDateString('es-ES', options);
          } else if (currentView === 'week') {
            const startOfWeek = new Date(currentDate.getTime() - (currentDate.getDay() * 24 * 60 * 60 * 1000));
            const endOfWeek = new Date(startOfWeek.getTime() + (6 * 24 * 60 * 60 * 1000));
            titleElement.textContent = startOfWeek.toLocaleDateString('es-ES', { day: 'numeric', month: 'short' }) + 
                                     ' - ' + endOfWeek.toLocaleDateString('es-ES', { day: 'numeric', month: 'short', year: 'numeric' });
          } else if (currentView === 'month') {
            titleElement.textContent = currentDate.toLocaleDateString('es-ES', { year: 'numeric', month: 'long' });
          }
        }

        function loadCalendarEventsForDate() {
          // Clear cache when navigating to different dates
          cachedEvents = null;
          lastFetchTime = null;
          loadCalendarEvents(currentView, true);
        }

        function renderCalendarView(events, view) {
          const calendarGrid = document.querySelector('.calendar-grid');
          
          console.log('Rendering ' + view + ' view with ' + events.length + ' events:', events.map(e => ({
            summary: e.summary,
            start: e.start?.dateTime || e.start?.date,
            date: new Date(e.start?.dateTime || e.start?.date).toDateString()
          })));
          
          if (events.length === 0) {
            calendarGrid.innerHTML = '<div class="auth-prompt"><h3>No hay eventos</h3><p>No se encontraron eventos en tu calendario</p></div>';
            return;
          }
          
          if (view === 'week') {
            calendarGrid.innerHTML = renderWeekView(events);
          } else if (view === 'month') {
            calendarGrid.innerHTML = renderMonthView(events);
          } else {
            // Day view - filter events for selected date only
            const selectedDateStr = currentDate.toDateString();
            
            console.log('Day view filtering:', {
              selectedDate: selectedDateStr,
              selectedDay: currentDate.getDate(),
              totalEvents: events.length,
              eventsData: events.map(e => ({
                summary: e.summary,
                start: e.start?.dateTime || e.start?.date,
                eventDateStr: new Date(e.start?.dateTime || e.start?.date).toDateString()
              }))
            });
            
            const dayEvents = events.filter(event => {
              const eventDate = new Date(event.start.dateTime || event.start.date);
              const matches = eventDate.toDateString() === selectedDateStr;
              if (matches) {
                console.log('Event matches selected day:', {
                  eventSummary: event.summary,
                  eventDate: eventDate.toDateString(),
                  selectedDate: selectedDateStr
                });
              }
              return matches;
            });
            
            console.log('Filtered day events:', dayEvents.length);
            
            if (dayEvents.length === 0) {
              calendarGrid.innerHTML = '<div class="auth-prompt"><h3>No hay eventos</h3><p>No tienes eventos programados para este día (' + selectedDateStr + ')</p></div>';
              return;
            }
            
            calendarGrid.innerHTML = dayEvents.map(event => 
              '<div class="event-item">' +
                '<div class="event-time">' + formatEventTime(event.start) + '</div>' +
                '<div class="event-title">' + (event.summary || 'Sin título') + '</div>' +
                '<div class="event-attendees">' + formatAttendees(event.attendees) + '</div>' +
                '<div class="event-actions">' +
                  (event.hangoutLink ? '<a href="' + event.hangoutLink + '" target="_blank" class="event-join-btn">Unirse</a>' : '') +
                  '<button class="event-details-btn" onclick="showEventDetails(\'' + event.id + '\')">' + 'Detalles</button>' +
                '</div>' +
              '</div>'
            ).join('');
          }
        }

        function renderWeekView(events) {
          const weekDays = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
          
          // Get selected week boundaries
          const selectedDate = new Date(currentDate);
          const startOfWeek = new Date(selectedDate.getTime() - (selectedDate.getDay() * 24 * 60 * 60 * 1000));
          startOfWeek.setHours(0, 0, 0, 0);
          const endOfWeek = new Date(startOfWeek.getTime() + (7 * 24 * 60 * 60 * 1000));
          
          // Filter events for selected week only
          const weekEvents = events.filter(event => {
            const eventDate = new Date(event.start.dateTime || event.start.date);
            return eventDate >= startOfWeek && eventDate < endOfWeek;
          });
          
          // Find the earliest event to determine starting hour
          let earliestHour = 24;
          if (weekEvents.length > 0) {
            earliestHour = Math.min(...weekEvents.map(event => {
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
              const dayEvents = weekEvents.filter(event => {
                const eventDate = new Date(event.start.dateTime || event.start.date);
                const eventHour = eventDate.getHours();
                const eventDay = eventDate.getDay();
                return eventDay === day && eventHour === parseInt(time);
              });
              
              dayEvents.forEach(event => {
                html += '<div class="event-block" onclick="showEventDetails(\'' + event.id + '\')">';
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
          const now = currentDate;
          const year = now.getFullYear();
          const month = now.getMonth();
          
          console.log('Rendering month view for ' + year + '-' + (month + 1) + ':', {
            totalEvents: events.length,
            currentDate: currentDate.toDateString(),
            firstDay: new Date(year, month, 1).toDateString(),
            lastDay: new Date(year, month + 1, 0).toDateString()
          });
          
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
            html += '<div class="month-day-number" onclick="selectDayFromMonth(\'' + getLocalDateString(date) + '\')">' + date.getDate() + '</div>';
            
            // Find events for this day
            const dayEvents = events.filter(event => {
              const eventDate = new Date(event.start.dateTime || event.start.date);
              return eventDate.toDateString() === date.toDateString();
            });
            
            if (dayEvents.length > 0) {
              console.log('Day ' + date.toDateString() + ' has ' + dayEvents.length + ' events:', dayEvents.map(e => e.summary));
            }
            
            dayEvents.forEach(event => {
              html += '<div class="month-event" onclick="showEventDetails(\'' + event.id + '\')">';
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
            // Check which view is active and load accordingly
            const activeView = document.querySelector('.view-btn.active')?.getAttribute('data-view') || 'week';
            loadCalendarEvents(activeView, true); // Force refresh
          } else if (activeTab === 'contacts') {
            loadContacts();
          }
        }

        // showStatus function moved to top of script

        async function syncContacts() {
          const statusDiv = document.getElementById('syncStatus');
          statusDiv.innerHTML = '<div class="status loading">Sincronizando contactos con Google Calendar...</div>';
          
          try {
            const response = await fetch('/api/sync', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' }
            });
            
            const result = await response.json();
            
            if (result.success) {
              const data = result.data;
              let message = result.message;
              
              if (data.errors && data.errors.length > 0) {
                message += '<br><br><strong>Errores:</strong><br>' + data.errors.slice(0, 5).join('<br>');
                if (data.errors.length > 5) {
                  message += '<br>... y ' + (data.errors.length - 5) + ' más';
                }
              }
              
              statusDiv.innerHTML = '<div class="status success">' + message + '</div>';
              
              // Refresh contacts list if we're on the contacts tab
              const activeTab = document.querySelector('.nav-item.active')?.getAttribute('data-tab');
              if (activeTab === 'contacts') {
                setTimeout(() => {
                  loadContacts();
                }, 1000);
              }
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
                // Organize contacts by tags
                const contactsByTag = {
                  'New Lead': [],
                  'Untagged': []
                };
                
                result.data.forEach(contact => {
                  if (!contact.tags || contact.tags.length === 0) {
                    contactsByTag['Untagged'].push(contact);
                  } else {
                    contact.tags.forEach(tag => {
                      if (contactsByTag[tag]) {
                        contactsByTag[tag].push(contact);
                      } else {
                        // Create new category for custom tags
                        if (!contactsByTag[tag]) {
                          contactsByTag[tag] = [];
                        }
                        contactsByTag[tag].push(contact);
                      }
                    });
                  }
                });
                
                let html = '';
                
                // Show each category
                Object.keys(contactsByTag).forEach(tag => {
                  const contacts = contactsByTag[tag];
                  if (contacts.length > 0) {
                    const tagIcons = {
                      'New Lead': '🎯',
                      'Untagged': '📝'
                    };
                    
                    const tagColors = {
                      'New Lead': '#FF6B00',
                      'Untagged': '#718096'
                    };
                    
                    const icon = tagIcons[tag] || '🏷️';
                    const color = tagColors[tag] || '#718096';
                    
                    html += '<div style="margin-bottom: 25px;">';
                    html += '<h3 style="color: ' + color + '; margin-bottom: 15px; font-size: 18px;">' + icon + ' ' + tag + ' (' + contacts.length + ')</h3>';
                    
                    html += contacts.map(contact => {
                      const borderColor = tag === 'Untagged' ? '#e2e8f0' : color;
                      return '<div class="event-item contact-item" style="border-left: 4px solid ' + borderColor + '; cursor: pointer;" onclick="showContactDetails(\'' + contact.email + '\')">' +
                        '<div class="event-title">' + contact.email + '</div>' +
                        '<div class="event-attendees">' + (contact.name || 'Sin nombre') + ' • ' + (contact.meeting_count || 0) + ' reuniones</div>' +
                        (contact.tags && contact.tags.length > 0 ? 
                          '<div class="contact-tags" style="margin-top: 8px;">' + 
                            contact.tags.map(t => '<span class="tag-badge ' + t.toLowerCase().replace(/\s+/g, '-') + '">' + t + '</span>').join('') +
                          '</div>' : '') +
                        (contact.notes ? '<div style="margin-top: 8px; color: #718096; font-size: 14px;">' + contact.notes.substring(0, 100) + (contact.notes.length > 100 ? '...' : '') + '</div>' : '') +
                        '<div style="margin-top: 8px; color: #718096; font-size: 12px;">Click para ver detalles</div>' +
                      '</div>';
                    }).join('');
                    
                    html += '</div>';
                  }
                });
                
                contactsList.innerHTML = html;
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