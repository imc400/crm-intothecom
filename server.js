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
    
    // Add new CRM fields
    const newColumns = [
      { name: 'phone', type: 'VARCHAR(50)', description: 'Phone number' },
      { name: 'company', type: 'VARCHAR(255)', description: 'Company name' },
      { name: 'position', type: 'VARCHAR(255)', description: 'Job position' },
      { name: 'website', type: 'VARCHAR(255)', description: 'Company website' },
      { name: 'industry', type: 'VARCHAR(100)', description: 'Industry' },
      { name: 'status', type: 'VARCHAR(50) DEFAULT \'New Lead\'', description: 'Lead status' },
      { name: 'priority', type: 'VARCHAR(20) DEFAULT \'Medium\'', description: 'Lead priority' }
    ];
    
    for (const column of newColumns) {
      try {
        await pool.query(`SELECT ${column.name} FROM contacts LIMIT 1`);
      } catch (columnError) {
        if (columnError.code === '42703') { // Column does not exist
          console.log(`Adding ${column.name} column to contacts table...`);
          await pool.query(`ALTER TABLE contacts ADD COLUMN ${column.name} ${column.type}`);
          console.log(`${column.name} column added successfully`);
        }
      }
    }
    
    // Create tags table for dynamic tag management
    await pool.query(`
      CREATE TABLE IF NOT EXISTS tags (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) UNIQUE NOT NULL,
        color VARCHAR(7) DEFAULT '#FF6B00',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    // Insert default "New Lead" tag if it doesn't exist
    await pool.query(`
      INSERT INTO tags (name, color) 
      VALUES ('New Lead', '#FF6B00')
      ON CONFLICT (name) DO NOTHING
    `);
    
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

// Update contact with full CRM information
app.post('/api/contacts/:contactId/update', async (req, res) => {
  const { contactId } = req.params;
  const { 
    name, 
    phone, 
    company, 
    position, 
    website, 
    industry, 
    status, 
    priority, 
    notes, 
    tags 
  } = req.body;
  
  try {
    // Validate tags array
    if (tags && !Array.isArray(tags)) {
      return res.status(400).json({
        success: false,
        error: 'Tags must be an array'
      });
    }
    
    // Update contact in database
    const updateQuery = `
      UPDATE contacts 
      SET name = $1, 
          phone = $2, 
          company = $3, 
          position = $4, 
          website = $5, 
          industry = $6, 
          status = $7, 
          priority = $8, 
          notes = $9, 
          tags = $10,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $11
      RETURNING *
    `;
    
    const values = [
      name || null,
      phone || null,
      company || null,
      position || null,
      website || null,
      industry || null,
      status || 'New Lead',
      priority || 'Medium',
      notes || null,
      tags || [],
      contactId
    ];
    
    const result = await pool.query(updateQuery, values);
    
    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Contact not found'
      });
    }
    
    res.json({
      success: true,
      data: result.rows[0],
      message: 'Contact updated successfully'
    });
    
  } catch (error) {
    console.error('Error updating contact:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to update contact: ' + error.message
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

// Sync event attendee tags with contact tags
app.post('/api/sync-attendee-tags', async (req, res) => {
  const { eventId, attendeeEmail, tags } = req.body;
  
  try {
    // Validate input
    if (!eventId || !attendeeEmail || !Array.isArray(tags)) {
      return res.status(400).json({
        success: false,
        error: 'Missing required parameters: eventId, attendeeEmail, tags'
      });
    }
    
    // Check if the email is an IntoTheCom email
    const isIntothecomEmail = attendeeEmail.includes('@intothecom.com') || attendeeEmail.includes('@intothecom');
    
    if (isIntothecomEmail && tags.includes('New Lead')) {
      return res.status(400).json({
        success: false,
        error: 'Cannot mark IntoTheCom emails as leads'
      });
    }
    
    // Find or create contact
    let contact = await pool.query('SELECT * FROM contacts WHERE email = $1', [attendeeEmail]);
    
    if (contact.rows.length === 0) {
      // Create new contact if doesn't exist
      const name = attendeeEmail.split('@')[0];
      const insertResult = await pool.query(
        'INSERT INTO contacts (email, name, first_seen, last_seen, tags) VALUES ($1, $2, CURRENT_DATE, CURRENT_DATE, $3) RETURNING *',
        [attendeeEmail, name, tags]
      );
      contact = insertResult;
    } else {
      // Update existing contact with new tags
      const updateResult = await pool.query(
        'UPDATE contacts SET tags = $1, updated_at = CURRENT_TIMESTAMP WHERE email = $2 RETURNING *',
        [tags, attendeeEmail]
      );
      contact = updateResult;
    }
    
    res.json({
      success: true,
      data: contact.rows[0],
      message: 'Attendee tags synchronized successfully'
    });
    
  } catch (error) {
    console.error('Error syncing attendee tags:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to sync attendee tags: ' + error.message
    });
  }
});

// Get available tags
app.get('/api/tags', async (req, res) => {
  try {
    // Get all tags from tags table with usage count
    const result = await pool.query(`
      SELECT 
        t.name as tag,
        t.color,
        t.id,
        COALESCE(contact_counts.count, 0) as count
      FROM tags t
      LEFT JOIN (
        SELECT 
          tag,
          COUNT(*) as count
        FROM (
          SELECT UNNEST(tags) as tag
          FROM contacts
          WHERE tags IS NOT NULL AND array_length(tags, 1) > 0
        ) as all_tags
        GROUP BY tag
      ) contact_counts ON t.name = contact_counts.tag
      ORDER BY count DESC, t.name ASC
    `);
    
    const tags = result.rows.map(row => ({
      id: row.id,
      tag: row.tag,
      color: row.color,
      count: parseInt(row.count) || 0
    }));
    
    res.json({
      success: true,
      data: tags
    });
  } catch (error) {
    console.error('Error fetching tags:', error);
    
    // Fallback response
    res.json({
      success: true,
      data: [
        { id: 1, tag: 'New Lead', color: '#FF6B00', count: 0 }
      ]
    });
  }
});

// Create new tag
app.post('/api/tags', async (req, res) => {
  const { name, color } = req.body;
  
  if (!name || !name.trim()) {
    return res.status(400).json({
      success: false,
      error: 'Tag name is required'
    });
  }
  
  try {
    const result = await pool.query(`
      INSERT INTO tags (name, color) 
      VALUES ($1, $2) 
      RETURNING *
    `, [name.trim(), color || '#FF6B00']);
    
    res.json({
      success: true,
      data: {
        id: result.rows[0].id,
        tag: result.rows[0].name,
        color: result.rows[0].color,
        count: 0
      },
      message: 'Tag created successfully'
    });
  } catch (error) {
    console.error('Error creating tag:', error);
    
    if (error.code === '23505') { // Unique constraint violation
      return res.status(400).json({
        success: false,
        error: 'Tag already exists'
      });
    }
    
    res.status(500).json({
      success: false,
      error: 'Failed to create tag'
    });
  }
});

// Delete tag
app.delete('/api/tags/:tagId', async (req, res) => {
  const { tagId } = req.params;
  
  try {
    // First, get the tag name to remove it from contacts
    const tagResult = await pool.query('SELECT name FROM tags WHERE id = $1', [tagId]);
    
    if (tagResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Tag not found'
      });
    }
    
    const tagName = tagResult.rows[0].name;
    
    // Don't allow deleting "New Lead" tag
    if (tagName === 'New Lead') {
      return res.status(400).json({
        success: false,
        error: 'Cannot delete the default "New Lead" tag'
      });
    }
    
    // Remove tag from all contacts
    await pool.query(`
      UPDATE contacts 
      SET tags = array_remove(tags, $1),
          updated_at = CURRENT_TIMESTAMP
      WHERE tags @> ARRAY[$1]
    `, [tagName]);
    
    // Delete the tag
    await pool.query('DELETE FROM tags WHERE id = $1', [tagId]);
    
    res.json({
      success: true,
      message: 'Tag deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting tag:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to delete tag'
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
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&display=swap');
        
        :root {
          --primary-gradient: linear-gradient(135deg, #FF6B00 0%, #FF8533 100%);
          --secondary-gradient: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          --dark-gradient: linear-gradient(135deg, #0c0c0c 0%, #1a1a1a 100%);
          --glass-bg: rgba(255, 255, 255, 0.1);
          --glass-border: rgba(255, 255, 255, 0.2);
          --shadow-soft: 0 8px 32px rgba(0, 0, 0, 0.1);
          --shadow-medium: 0 12px 48px rgba(0, 0, 0, 0.15);
          --shadow-hard: 0 20px 60px rgba(0, 0, 0, 0.2);
          --text-primary: #1a202c;
          --text-secondary: #4a5568;
          --text-muted: #718096;
          --surface-primary: #ffffff;
          --surface-secondary: #f8fafc;
          --surface-elevated: #edf2f7;
          --border-light: #e2e8f0;
          --border-medium: #cbd5e0;
          --success: #48bb78;
          --warning: #ed8936;
          --error: #f56565;
          --info: #4299e1;
        }
        
        * {
          margin: 0;
          padding: 0;
          box-sizing: border-box;
        }
        
        body {
          font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
          font-weight: 400;
          line-height: 1.6;
          color: var(--text-primary);
          background: linear-gradient(135deg, #f5f7fa 0%, #c3cfe2 100%);
          min-height: 100vh;
          overflow-x: hidden;
        }
        
        .app-container {
          display: flex;
          min-height: 100vh;
        }
        
        .sidebar {
          width: 280px;
          background: var(--dark-gradient);
          position: fixed;
          height: 100vh;
          left: 0;
          top: 0;
          overflow-y: auto;
          border-right: 1px solid rgba(255, 255, 255, 0.1);
          box-shadow: var(--shadow-hard);
          z-index: 1000;
          backdrop-filter: blur(20px);
        }
        
        .sidebar::before {
          content: '';
          position: absolute;
          top: 0;
          left: 0;
          right: 0;
          bottom: 0;
          background: linear-gradient(180deg, 
            rgba(255, 107, 0, 0.1) 0%, 
            rgba(255, 107, 0, 0.05) 20%, 
            transparent 100%);
          pointer-events: none;
        }
        
        .sidebar-header {
          padding: 30px 25px;
          border-bottom: 1px solid rgba(255, 255, 255, 0.1);
          position: relative;
        }
        
        .logo {
          color: #fff;
          font-size: 28px;
          font-weight: 800;
          display: flex;
          align-items: center;
          gap: 12px;
          text-decoration: none;
          letter-spacing: -0.5px;
        }
        
        .logo::before {
          content: '';
          width: 12px;
          height: 12px;
          background: var(--primary-gradient);
          border-radius: 50%;
          box-shadow: 0 0 20px rgba(255, 107, 0, 0.5);
        }
        
        .logo img {
          height: 48px;
          width: auto;
        }
        
        .nav-menu {
          padding: 20px 0;
        }
        
        .nav-item {
          display: flex;
          align-items: center;
          gap: 15px;
          padding: 16px 25px;
          color: rgba(255, 255, 255, 0.7);
          text-decoration: none;
          transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
          border-left: 3px solid transparent;
          margin: 4px 0;
          position: relative;
          cursor: pointer;
          font-weight: 500;
        }
        
        .nav-item::before {
          content: '';
          position: absolute;
          left: 0;
          top: 0;
          width: 0;
          height: 100%;
          background: var(--primary-gradient);
          transition: width 0.3s cubic-bezier(0.4, 0, 0.2, 1);
          border-radius: 0 4px 4px 0;
        }
        
        .nav-item:hover::before {
          width: 4px;
        }
        
        .nav-item:hover {
          color: rgba(255, 255, 255, 0.9);
          background: rgba(255, 255, 255, 0.08);
          transform: translateX(4px);
        }
        
        .nav-item.active {
          color: #FF6B00;
          background: rgba(255, 107, 0, 0.15);
          border-left-color: #FF6B00;
          box-shadow: inset 0 0 0 1px rgba(255, 107, 0, 0.2);
        }
        
        .nav-item.active::before {
          width: 4px;
        }
        
        .nav-icon {
          font-size: 20px;
          width: 24px;
          text-align: center;
          opacity: 0.8;
        }
        
        .main-content {
          flex: 1;
          margin-left: 280px;
          padding: 40px;
          min-height: 100vh;
        }
        
        .header {
          background: var(--glass-bg);
          backdrop-filter: blur(20px);
          border: 1px solid var(--glass-border);
          padding: 24px 32px;
          border-radius: 20px;
          box-shadow: var(--shadow-soft);
          margin-bottom: 32px;
          display: flex;
          justify-content: space-between;
          align-items: center;
          position: relative;
          overflow: hidden;
        }
        
        .header::before {
          content: '';
          position: absolute;
          top: 0;
          left: 0;
          right: 0;
          bottom: 0;
          background: linear-gradient(135deg, 
            rgba(255, 255, 255, 0.2) 0%, 
            rgba(255, 255, 255, 0.1) 100%);
          pointer-events: none;
        }
        
        .header h1 {
          font-size: 32px;
          font-weight: 700;
          color: var(--text-primary);
          margin: 0;
          letter-spacing: -1px;
          position: relative;
        }
        
        .header-actions {
          display: flex;
          gap: 16px;
          position: relative;
        }
        
        .btn {
          background: var(--primary-gradient);
          color: white;
          border: none;
          padding: 14px 28px;
          border-radius: 12px;
          cursor: pointer;
          font-size: 14px;
          font-weight: 600;
          transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
          text-decoration: none;
          display: inline-flex;
          align-items: center;
          gap: 8px;
          position: relative;
          overflow: hidden;
          box-shadow: 0 4px 16px rgba(255, 107, 0, 0.3);
        }
        
        .btn::before {
          content: '';
          position: absolute;
          top: 0;
          left: -100%;
          width: 100%;
          height: 100%;
          background: linear-gradient(90deg, 
            transparent, 
            rgba(255, 255, 255, 0.3), 
            transparent);
          transition: left 0.5s;
        }
        
        .btn:hover::before {
          left: 100%;
        }
        
        .btn:hover {
          transform: translateY(-2px);
          box-shadow: 0 8px 24px rgba(255, 107, 0, 0.4);
        }
        
        .btn:active {
          transform: translateY(0);
        }
        
        .btn-primary {
          background: var(--primary-gradient);
          box-shadow: 0 4px 16px rgba(255, 107, 0, 0.3);
        }
        
        .btn-primary:hover {
          box-shadow: 0 8px 24px rgba(255, 107, 0, 0.4);
        }
        
        .btn-outline {
          background: transparent;
          color: #FF6B00;
          border: 2px solid #FF6B00;
          box-shadow: 0 4px 16px rgba(255, 107, 0, 0.15);
        }
        
        .btn-outline:hover {
          background: var(--primary-gradient);
          color: white;
          box-shadow: 0 8px 24px rgba(255, 107, 0, 0.3);
        }
        
        .btn-secondary {
          background: var(--secondary-gradient);
          box-shadow: 0 4px 16px rgba(102, 126, 234, 0.3);
        }
        
        .btn-secondary:hover {
          box-shadow: 0 8px 24px rgba(102, 126, 234, 0.4);
        }
        
        .btn-success {
          background: linear-gradient(135deg, var(--success) 0%, #38a169 100%);
          box-shadow: 0 4px 16px rgba(72, 187, 120, 0.3);
        }
        
        .btn-success:hover {
          box-shadow: 0 8px 24px rgba(72, 187, 120, 0.4);
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
          background: var(--glass-bg);
          backdrop-filter: blur(20px);
          border: 1px solid var(--glass-border);
          border-radius: 24px;
          padding: 40px;
          box-shadow: var(--shadow-medium);
          min-height: 600px;
          position: relative;
          overflow: hidden;
        }
        
        .tab-content::before {
          content: '';
          position: absolute;
          top: 0;
          left: 0;
          right: 0;
          bottom: 0;
          background: linear-gradient(135deg, 
            rgba(255, 255, 255, 0.1) 0%, 
            rgba(255, 255, 255, 0.05) 100%);
          pointer-events: none;
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
          transition: all 0.3s ease;
        }
        
        .day-column.current-day-column {
          background: linear-gradient(135deg, 
            rgba(255, 107, 0, 0.04) 0%, 
            rgba(255, 133, 51, 0.02) 100%);
          border-right: 1px solid rgba(255, 107, 0, 0.2);
          position: relative;
        }
        
        .day-column.current-day-column::before {
          content: '';
          position: absolute;
          left: 0;
          top: 0;
          bottom: 0;
          width: 2px;
          background: linear-gradient(180deg, 
            rgba(255, 107, 0, 0.6), 
            rgba(255, 133, 51, 0.4));
          z-index: 1;
        }
        
        .day-header {
          background: #f7fafc;
          padding: 8px;
          font-weight: 600;
          text-align: center;
          border-bottom: 1px solid #e2e8f0;
          font-size: 14px;
          transition: all 0.3s ease;
        }
        
        .day-header.current-day {
          background: linear-gradient(135deg, 
            rgba(255, 107, 0, 0.12) 0%, 
            rgba(255, 133, 51, 0.08) 100%);
          color: #FF6B00;
          font-weight: 700;
          position: relative;
          border: 1px solid rgba(255, 107, 0, 0.3);
          box-shadow: 0 2px 8px rgba(255, 107, 0, 0.15);
        }
        
        .day-header.current-day::after {
          content: '';
          position: absolute;
          bottom: -1px;
          left: 50%;
          transform: translateX(-50%);
          width: 20px;
          height: 2px;
          background: linear-gradient(90deg, #FF6B00, #FF8533);
          border-radius: 2px;
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
        
        .month-day.current-day-month {
          background: linear-gradient(135deg, 
            rgba(255, 107, 0, 0.06) 0%, 
            rgba(255, 133, 51, 0.03) 100%);
          border: 1px solid rgba(255, 107, 0, 0.2);
          position: relative;
          box-shadow: 0 2px 8px rgba(255, 107, 0, 0.1);
        }
        
        .month-day.current-day-month::before {
          content: '';
          position: absolute;
          top: 0;
          left: 0;
          right: 0;
          height: 2px;
          background: linear-gradient(90deg, #FF6B00, #FF8533);
          border-radius: 0 0 2px 2px;
        }
        
        .month-day-number.today-number {
          background: linear-gradient(135deg, #FF6B00, #FF8533);
          color: white;
          font-weight: 700;
          border-radius: 8px;
          box-shadow: 0 2px 8px rgba(255, 107, 0, 0.3);
          transform: scale(1.05);
        }
        
        .month-day-number.today-number:hover {
          background: linear-gradient(135deg, #FF8533, #FF6B00);
          color: white;
          transform: scale(1.1);
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
        
        .event-item.event-clickable {
          cursor: pointer;
          transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
          position: relative;
          overflow: hidden;
        }
        
        .event-item.event-clickable:hover {
          transform: translateY(-4px);
          box-shadow: 0 12px 32px rgba(255, 107, 0, 0.2);
          border-color: rgba(255, 107, 0, 0.3);
        }
        
        .event-item.event-clickable::before {
          content: '';
          position: absolute;
          left: 0;
          top: 0;
          bottom: 0;
          width: 4px;
          background: linear-gradient(180deg, #FF6B00, #FF8533);
          transform: scaleY(0);
          transform-origin: bottom;
          transition: transform 0.3s cubic-bezier(0.4, 0, 0.2, 1);
        }
        
        .event-item.event-clickable:hover::before {
          transform: scaleY(1);
        }
        
        /* CRM Modal Styles */
        .crm-modal {
          width: 95%;
          max-width: 1000px;
          max-height: 90vh;
          overflow-y: auto;
        }
        
        .crm-section {
          margin-bottom: 32px;
          padding: 24px;
          background: linear-gradient(135deg, 
            rgba(255, 255, 255, 0.1) 0%, 
            rgba(255, 255, 255, 0.05) 100%);
          border: 1px solid var(--border-light);
          border-radius: 16px;
          backdrop-filter: blur(20px);
        }
        
        .section-title {
          color: var(--primary-orange);
          font-size: 18px;
          font-weight: 700;
          margin-bottom: 20px;
          padding-bottom: 8px;
          border-bottom: 2px solid rgba(255, 107, 0, 0.1);
          display: flex;
          align-items: center;
        }
        
        .section-title::before {
          content: '';
          width: 4px;
          height: 20px;
          background: linear-gradient(135deg, #FF6B00, #FF8533);
          margin-right: 12px;
          border-radius: 2px;
        }
        
        .form-row {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 20px;
          margin-bottom: 16px;
        }
        
        .form-group {
          display: flex;
          flex-direction: column;
        }
        
        .form-label {
          font-weight: 600;
          color: var(--text-primary);
          margin-bottom: 8px;
          font-size: 14px;
        }
        
        .form-input, .form-select {
          padding: 12px 16px;
          border: 1px solid var(--border-light);
          border-radius: 10px;
          font-size: 14px;
          background: var(--surface-primary);
          color: var(--text-primary);
          transition: all 0.3s ease;
        }
        
        .form-input:focus, .form-select:focus {
          outline: none;
          border-color: var(--primary-orange);
          box-shadow: 0 0 0 3px rgba(255, 107, 0, 0.1);
        }
        
        .form-textarea {
          padding: 12px 16px;
          border: 1px solid var(--border-light);
          border-radius: 10px;
          font-size: 14px;
          background: var(--surface-primary);
          color: var(--text-primary);
          resize: vertical;
          min-height: 100px;
          transition: all 0.3s ease;
        }
        
        .form-textarea:focus {
          outline: none;
          border-color: var(--primary-orange);
          box-shadow: 0 0 0 3px rgba(255, 107, 0, 0.1);
        }
        
        .status-select {
          background: linear-gradient(135deg, 
            rgba(255, 107, 0, 0.05) 0%, 
            rgba(255, 133, 51, 0.02) 100%);
          font-weight: 600;
        }
        
        .priority-select {
          background: linear-gradient(135deg, 
            rgba(255, 107, 0, 0.05) 0%, 
            rgba(255, 133, 51, 0.02) 100%);
          font-weight: 600;
        }
        
        @media (max-width: 768px) {
          .form-row {
            grid-template-columns: 1fr;
            gap: 16px;
          }
          
          .crm-modal {
            width: 100%;
            margin: 10px;
          }
          
          .crm-section {
            padding: 16px;
          }
        }
        
        /* Tag Management Styles */
        .tag-filter-container {
          display: flex;
          gap: 8px;
          align-items: center;
        }
        
        .btn-create-tag {
          background: linear-gradient(135deg, #FF6B00, #FF8533);
          color: white;
          border: none;
          padding: 10px 16px;
          border-radius: 8px;
          font-size: 12px;
          font-weight: 600;
          cursor: pointer;
          transition: all 0.3s ease;
          white-space: nowrap;
        }
        
        .btn-create-tag:hover {
          background: linear-gradient(135deg, #FF8533, #FFB366);
          transform: translateY(-1px);
          box-shadow: 0 4px 12px rgba(255, 107, 0, 0.3);
        }
        
        .color-picker-container {
          display: flex;
          gap: 12px;
          align-items: center;
          margin-top: 8px;
        }
        
        .form-color-input {
          width: 50px;
          height: 40px;
          border: 2px solid var(--border-light);
          border-radius: 8px;
          cursor: pointer;
          transition: all 0.3s ease;
        }
        
        .form-color-input:hover {
          border-color: var(--primary-orange);
        }
        
        .color-preview {
          flex: 1;
          padding: 10px 16px;
          border: 1px solid var(--border-light);
          border-radius: 8px;
          background: var(--surface-primary);
          display: flex;
          align-items: center;
        }
        
        .tag-preview {
          margin-top: 8px;
          padding: 12px;
          border: 1px solid var(--border-light);
          border-radius: 8px;
          background: var(--surface-primary);
          display: flex;
          align-items: center;
        }
        
        .tag-badge {
          background: var(--primary-gradient);
          color: white;
          padding: 6px 14px;
          border-radius: 20px;
          font-size: 12px;
          font-weight: 600;
          box-shadow: 0 2px 8px rgba(255, 107, 0, 0.3);
          transition: all 0.3s ease;
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
        
        /* Enhanced Contact Components */
        .filter-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 24px;
          position: relative;
        }
        
        .filter-title {
          margin: 0;
          color: var(--text-primary);
          font-size: 22px;
          font-weight: 700;
          position: relative;
        }
        
        .btn-sm {
          padding: 8px 16px;
          font-size: 13px;
          border-radius: 8px;
        }
        
        .filter-input,
        .filter-select {
          padding: 14px 18px;
          border: 1px solid var(--border-light);
          border-radius: 14px;
          font-size: 14px;
          background: var(--surface-primary);
          transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
          box-shadow: 0 2px 8px rgba(0, 0, 0, 0.05);
          font-weight: 500;
        }
        
        .filter-input:focus,
        .filter-select:focus {
          outline: none;
          border-color: #FF6B00;
          box-shadow: 0 0 0 4px rgba(255, 107, 0, 0.12),
                      0 8px 20px rgba(255, 107, 0, 0.2);
          transform: translateY(-2px);
        }
        
        .filter-input {
          flex: 1;
          min-width: 280px;
        }
        
        .filter-select {
          min-width: 180px;
        }
        
        .active-filters {
          margin-top: 16px;
          padding: 12px 16px;
          background: rgba(255, 107, 0, 0.1);
          border-radius: 12px;
          border: 1px solid rgba(255, 107, 0, 0.2);
          font-size: 14px;
          color: var(--text-secondary);
          font-weight: 500;
        }
        
        /* Enhanced Calendar Components */
        .calendar-controls {
          background: var(--glass-bg);
          backdrop-filter: blur(20px);
          border: 1px solid var(--glass-border);
          border-radius: 18px;
          padding: 24px;
          margin-bottom: 32px;
          box-shadow: var(--shadow-soft);
          position: relative;
          overflow: hidden;
        }
        
        .calendar-controls::before {
          content: '';
          position: absolute;
          top: 0;
          left: 0;
          right: 0;
          bottom: 0;
          background: linear-gradient(135deg, 
            rgba(255, 255, 255, 0.15) 0%, 
            rgba(255, 255, 255, 0.05) 100%);
          pointer-events: none;
          border-radius: 18px;
        }
        
        .calendar-date {
          font-size: 28px;
          font-weight: 800;
          color: var(--text-primary);
          letter-spacing: -0.5px;
          position: relative;
        }
        
        .calendar-nav {
          display: flex;
          align-items: center;
          gap: 12px;
          position: relative;
        }
        
        .view-btn {
          background: var(--surface-primary);
          border: 1px solid var(--border-light);
          padding: 12px 20px;
          border-radius: 12px;
          cursor: pointer;
          transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
          font-weight: 600;
          font-size: 14px;
          box-shadow: 0 2px 8px rgba(0, 0, 0, 0.05);
        }
        
        .view-btn:hover {
          transform: translateY(-2px);
          box-shadow: 0 6px 20px rgba(0, 0, 0, 0.15);
          border-color: var(--primary-gradient);
        }
        
        .view-btn.active {
          background: var(--primary-gradient);
          color: white;
          box-shadow: 0 4px 16px rgba(255, 107, 0, 0.3);
          border-color: transparent;
        }
        
        /* Enhanced Event Items */
        .event-item {
          background: var(--surface-primary);
          border: 1px solid var(--border-light);
          border-radius: 14px;
          padding: 20px;
          margin-bottom: 12px;
          cursor: pointer;
          transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
          box-shadow: 0 4px 12px rgba(0, 0, 0, 0.05);
          position: relative;
          overflow: hidden;
        }
        
        .event-item::before {
          content: '';
          position: absolute;
          left: 0;
          top: 0;
          width: 4px;
          height: 100%;
          background: var(--primary-gradient);
          transform: scaleY(0);
          transform-origin: bottom;
          transition: transform 0.3s cubic-bezier(0.4, 0, 0.2, 1);
          pointer-events: none;
        }
        
        .event-item:hover::before {
          transform: scaleY(1);
        }
        
        .event-item:hover {
          transform: translateY(-4px);
          box-shadow: 0 12px 32px rgba(0, 0, 0, 0.15);
          border-color: rgba(255, 107, 0, 0.3);
        }
        
        .event-title {
          font-weight: 600;
          color: var(--text-primary);
          margin-bottom: 8px;
          font-size: 16px;
        }
        
        .event-time {
          color: var(--text-muted);
          font-size: 13px;
          margin-bottom: 6px;
          font-weight: 500;
        }
        
        .event-attendees {
          color: var(--text-secondary);
          font-size: 14px;
          margin-bottom: 8px;
        }
        
        /* Enhanced Authentication Section */
        .auth-prompt {
          text-align: center;
          padding: 80px 40px;
          background: var(--glass-bg);
          backdrop-filter: blur(20px);
          border: 1px solid var(--glass-border);
          border-radius: 20px;
          box-shadow: var(--shadow-soft);
          position: relative;
          overflow: hidden;
        }
        
        .auth-prompt::before {
          content: '';
          position: absolute;
          top: 0;
          left: 0;
          right: 0;
          bottom: 0;
          background: linear-gradient(135deg, 
            rgba(255, 255, 255, 0.1) 0%, 
            rgba(255, 255, 255, 0.05) 100%);
          pointer-events: none;
          border-radius: 20px;
        }
        
        .auth-prompt h3 {
          font-size: 32px;
          margin-bottom: 16px;
          color: var(--text-primary);
          font-weight: 700;
          position: relative;
        }
        
        .auth-prompt p {
          font-size: 16px;
          margin-bottom: 32px;
          color: var(--text-muted);
          position: relative;
        }
        
        /* Enhanced Calendar Grid */
        .calendar-grid {
          background: var(--glass-bg);
          backdrop-filter: blur(20px);
          border: 1px solid var(--glass-border);
          border-radius: 20px;
          padding: 24px;
          box-shadow: var(--shadow-soft);
          position: relative;
          height: calc(100% - 80px);
          overflow-y: auto;
        }
        
        .calendar-grid > * {
          position: relative;
          z-index: 2;
        }
        
        .calendar-grid::before {
          content: '';
          position: absolute;
          top: 0;
          left: 0;
          right: 0;
          bottom: 0;
          background: linear-gradient(135deg, 
            rgba(255, 255, 255, 0.08) 0%, 
            rgba(255, 255, 255, 0.03) 100%);
          pointer-events: none;
          border-radius: 20px;
          z-index: 1;
        }
        
        /* Enhanced Tag Badges */
        .tag-badge {
          background: var(--primary-gradient);
          color: white;
          padding: 6px 14px;
          border-radius: 20px;
          font-size: 12px;
          font-weight: 600;
          box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
          display: inline-block;
          margin-right: 8px;
          margin-bottom: 4px;
          transition: all 0.3s ease;
        }
        
        .tag-badge:hover {
          transform: translateY(-1px);
          box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
        }
        
        /* Section Header Styles */
        .section-header:hover {
          background: rgba(255, 255, 255, 0.08) !important;
          transform: translateY(-1px);
          box-shadow: 0 4px 16px rgba(0, 0, 0, 0.1);
        }
        
        .section-icon {
          font-size: 12px;
          transition: transform 0.3s ease;
          margin-right: 8px;
        }
        
        .section-content {
          transition: all 0.3s ease;
          overflow: hidden;
        }
        
        /* Enhanced Status Messages */
        .status {
          padding: 20px 24px;
          border-radius: 16px;
          margin-bottom: 24px;
          display: flex;
          align-items: center;
          gap: 12px;
          font-weight: 500;
          position: relative;
          overflow: hidden;
          backdrop-filter: blur(10px);
        }
        
        .status::before {
          content: '';
          position: absolute;
          left: 0;
          top: 0;
          width: 4px;
          height: 100%;
          background: currentColor;
        }
        
        .status.success {
          background: linear-gradient(135deg, 
            rgba(72, 187, 120, 0.15) 0%, 
            rgba(72, 187, 120, 0.08) 100%);
          color: #22543d;
          border: 1px solid rgba(72, 187, 120, 0.3);
        }
        
        .status.error {
          background: linear-gradient(135deg, 
            rgba(245, 101, 101, 0.15) 0%, 
            rgba(245, 101, 101, 0.08) 100%);
          color: #742a2a;
          border: 1px solid rgba(245, 101, 101, 0.3);
        }
        
        .status.loading {
          background: linear-gradient(135deg, 
            rgba(66, 153, 225, 0.15) 0%, 
            rgba(66, 153, 225, 0.08) 100%);
          color: #2c5282;
          border: 1px solid rgba(66, 153, 225, 0.3);
        }
        
        /* Enhanced Modal Components */
        .modal {
          display: none;
          position: fixed;
          z-index: 2000;
          left: 0;
          top: 0;
          width: 100%;
          height: 100%;
          background: rgba(0, 0, 0, 0.7);
          backdrop-filter: blur(12px);
          animation: fadeIn 0.3s ease-out;
        }
        
        .modal-content {
          background: var(--surface-primary);
          margin: 40px auto;
          border-radius: 24px;
          width: 90%;
          max-width: 700px;
          max-height: 90vh;
          overflow-y: auto;
          box-shadow: var(--shadow-hard);
          position: relative;
          animation: slideIn 0.3s ease-out;
        }
        
        .modal-header {
          padding: 32px 40px 24px;
          border-bottom: 1px solid var(--border-light);
          display: flex;
          justify-content: space-between;
          align-items: center;
          background: var(--glass-bg);
          backdrop-filter: blur(20px);
          border-radius: 24px 24px 0 0;
        }
        
        .modal-title {
          margin: 0;
          color: var(--text-primary);
          font-size: 26px;
          font-weight: 700;
          letter-spacing: -0.5px;
        }
        
        .close-btn {
          background: none;
          border: none;
          font-size: 32px;
          cursor: pointer;
          color: var(--text-muted);
          padding: 8px;
          border-radius: 12px;
          transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
          width: 48px;
          height: 48px;
          display: flex;
          align-items: center;
          justify-content: center;
        }
        
        .close-btn:hover {
          color: var(--text-primary);
          background: var(--surface-elevated);
          transform: scale(1.1);
        }
        
        .modal-body {
          padding: 32px 40px;
        }
        
        .form-group {
          margin-bottom: 28px;
        }
        
        .form-label {
          display: block;
          margin-bottom: 8px;
          font-weight: 600;
          color: var(--text-primary);
          font-size: 15px;
        }
        
        .form-input,
        .form-textarea {
          width: 100%;
          padding: 16px 20px;
          border: 1px solid var(--border-light);
          border-radius: 14px;
          font-size: 15px;
          background: var(--surface-primary);
          transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
          box-shadow: 0 2px 8px rgba(0, 0, 0, 0.05);
          font-family: inherit;
        }
        
        .form-input:focus,
        .form-textarea:focus {
          outline: none;
          border-color: #FF6B00;
          box-shadow: 0 0 0 4px rgba(255, 107, 0, 0.12),
                      0 8px 20px rgba(255, 107, 0, 0.2);
          transform: translateY(-2px);
        }
        
        .form-textarea {
          resize: vertical;
          min-height: 120px;
        }
        
        .form-row {
          display: flex;
          gap: 20px;
        }
        
        .form-row .form-group {
          flex: 1;
        }
        
        .form-checkbox {
          display: flex;
          align-items: center;
          gap: 12px;
          margin-bottom: 16px;
        }
        
        .form-checkbox input {
          width: 20px;
          height: 20px;
          cursor: pointer;
        }
        
        .form-checkbox label {
          cursor: pointer;
          margin-bottom: 0;
          font-weight: 500;
        }
        
        .modal-footer {
          padding: 24px 40px 32px;
          border-top: 1px solid var(--border-light);
          display: flex;
          justify-content: flex-end;
          gap: 16px;
          background: var(--surface-secondary);
          border-radius: 0 0 24px 24px;
        }
        
        /* Enhanced Attendee Components */
        .attendee-list {
          max-height: 300px;
          overflow-y: auto;
          border: 1px solid var(--border-light);
          border-radius: 14px;
          padding: 16px;
          background: var(--surface-secondary);
        }
        
        .attendee-item {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 16px 20px;
          border-bottom: 1px solid var(--border-light);
          border-radius: 12px;
          margin-bottom: 8px;
          background: var(--surface-primary);
          transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
        }
        
        .attendee-item:last-child {
          border-bottom: none;
          margin-bottom: 0;
        }
        
        .attendee-item:hover {
          transform: translateY(-2px);
          box-shadow: 0 4px 16px rgba(0, 0, 0, 0.1);
        }
        
        .attendee-email {
          font-weight: 600;
          color: var(--text-primary);
          font-size: 15px;
        }
        
        .attendee-actions {
          display: flex;
          gap: 12px;
        }
        
        .add-attendee-form {
          display: flex;
          gap: 12px;
          margin-top: 16px;
        }
        
        .add-attendee-form input {
          flex: 1;
          padding: 12px 16px;
          border: 1px solid var(--border-light);
          border-radius: 10px;
          font-size: 14px;
          background: var(--surface-primary);
          transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
        }
        
        .add-attendee-form input:focus {
          outline: none;
          border-color: #FF6B00;
          box-shadow: 0 0 0 3px rgba(255, 107, 0, 0.1);
        }
        
        .add-attendee-form button {
          padding: 12px 20px;
          background: var(--primary-gradient);
          color: white;
          border: none;
          border-radius: 10px;
          cursor: pointer;
          font-size: 14px;
          font-weight: 600;
          transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
          box-shadow: 0 2px 8px rgba(255, 107, 0, 0.3);
        }
        
        .add-attendee-form button:hover {
          transform: translateY(-2px);
          box-shadow: 0 4px 16px rgba(255, 107, 0, 0.4);
        }
        
        /* Enhanced Tag Components */
        .tag-section {
          margin-top: 16px;
          padding: 20px;
          background: var(--surface-secondary);
          border-radius: 16px;
          border: 1px solid var(--border-light);
        }
        
        .tag-section h4 {
          margin: 0 0 16px 0;
          color: var(--text-primary);
          font-size: 16px;
          font-weight: 600;
        }
        
        .tag-options {
          display: flex;
          flex-wrap: wrap;
          gap: 12px;
          margin-bottom: 16px;
        }
        
        .tag-option {
          background: var(--surface-primary);
          border: 1px solid var(--border-light);
          padding: 10px 16px;
          border-radius: 12px;
          cursor: pointer;
          font-size: 14px;
          font-weight: 500;
          transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
          box-shadow: 0 2px 8px rgba(0, 0, 0, 0.05);
        }
        
        .tag-option:hover {
          border-color: #FF6B00;
          background: rgba(255, 107, 0, 0.1);
          transform: translateY(-2px);
        }
        
        .tag-option.selected {
          background: var(--primary-gradient);
          color: white;
          border-color: #FF6B00;
          box-shadow: 0 4px 16px rgba(255, 107, 0, 0.3);
        }
        
        /* Animation keyframes */
        @keyframes fadeIn {
          from { opacity: 0; }
          to { opacity: 1; }
        }
        
        @keyframes slideIn {
          from { 
            transform: translateY(30px);
            opacity: 0;
          }
          to { 
            transform: translateY(0);
            opacity: 1;
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
              <span class="nav-icon">◉</span>
              <span>Calendario</span>
            </a>
            <a href="#" class="nav-item" data-tab="contacts">
              <span class="nav-icon">◎</span>
              <span>Contactos</span>
            </a>
            <a href="#" class="nav-item" data-tab="sync">
              <span class="nav-icon">⟲</span>
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
              
              <!-- Contacts Filter Section -->
              <div class="contacts-filter-section">
                <div class="filter-header">
                  <h3 class="filter-title">Filtros de Contactos</h3>
                  <button class="btn btn-outline btn-sm" onclick="clearContactFilters()">
                    Limpiar Filtros
                  </button>
                </div>
                
                <div class="filter-controls">
                  <input type="text" id="contactSearchInput" placeholder="Buscar por nombre o email..." 
                         class="filter-input" onkeyup="filterContacts()" />
                  
                  <div class="tag-filter-container">
                    <select id="contactTagFilter" class="filter-select" onchange="filterContacts()">
                      <option value="">Todas las etiquetas</option>
                      <option value="New Lead">● New Lead</option>
                      <option value="Untagged">○ Sin etiquetas</option>
                    </select>
                    <button class="btn-create-tag" onclick="showCreateTagModal()" title="Crear nueva etiqueta">
                      + Nueva Etiqueta
                    </button>
                  </div>
                  
                  <select id="contactSortFilter" class="filter-select" onchange="filterContacts()">
                    <option value="recent">Más recientes</option>
                    <option value="name">Por nombre</option>
                    <option value="meetings">Por reuniones</option>
                  </select>
                </div>
                
                <div id="contactFiltersActive" class="active-filters" style="display: none;">
                  <span>Filtros activos: </span>
                  <span id="activeFiltersText"></span>
                </div>
              </div>
              
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

      <!-- Contact CRM Modal -->
      <div id="contactModal" class="modal">
        <div class="modal-content crm-modal">
          <div class="modal-header">
            <h2>Gestión de Contacto CRM</h2>
            <span class="close-btn" onclick="closeContactModal()">&times;</span>
          </div>
          
          <div class="modal-body">
            <!-- Personal Information Section -->
            <div class="crm-section">
              <h3 class="section-title">Información Personal</h3>
              <div class="form-row">
                <div class="form-group">
                  <label class="form-label">Nombre *</label>
                  <input type="text" id="contactFirstName" class="form-input" placeholder="Nombre">
                </div>
                <div class="form-group">
                  <label class="form-label">Apellido *</label>
                  <input type="text" id="contactLastName" class="form-input" placeholder="Apellido">
                </div>
              </div>
              <div class="form-row">
                <div class="form-group">
                  <label class="form-label">Email</label>
                  <input type="email" id="contactEmail" class="form-input" readonly style="background: #f7fafc;">
                </div>
                <div class="form-group">
                  <label class="form-label">Teléfono</label>
                  <input type="tel" id="contactPhone" class="form-input" placeholder="+56 9 1234 5678">
                </div>
              </div>
            </div>

            <!-- Company Information Section -->
            <div class="crm-section">
              <h3 class="section-title">Información de Empresa</h3>
              <div class="form-row">
                <div class="form-group">
                  <label class="form-label">Nombre de Empresa</label>
                  <input type="text" id="contactCompany" class="form-input" placeholder="Nombre de la empresa">
                </div>
                <div class="form-group">
                  <label class="form-label">Cargo</label>
                  <input type="text" id="contactPosition" class="form-input" placeholder="CEO, Manager, etc.">
                </div>
              </div>
              <div class="form-row">
                <div class="form-group">
                  <label class="form-label">Sitio Web</label>
                  <input type="url" id="contactWebsite" class="form-input" placeholder="https://ejemplo.com">
                </div>
                <div class="form-group">
                  <label class="form-label">Industria</label>
                  <select id="contactIndustry" class="form-select">
                    <option value="">Seleccionar industria</option>
                    <option value="Tecnología">Tecnología</option>
                    <option value="Marketing">Marketing</option>
                    <option value="Retail">Retail</option>
                    <option value="Salud">Salud</option>
                    <option value="Educación">Educación</option>
                    <option value="Finanzas">Finanzas</option>
                    <option value="Construcción">Construcción</option>
                    <option value="Otro">Otro</option>
                  </select>
                </div>
              </div>
            </div>

            <!-- CRM Status Section -->
            <div class="crm-section">
              <h3 class="section-title">Estado del Lead</h3>
              <div class="form-row">
                <div class="form-group">
                  <label class="form-label">Estado Actual</label>
                  <select id="contactStatus" class="form-select status-select">
                    <option value="New Lead">🔥 New Lead</option>
                    <option value="Qualified Lead">⭐ Qualified Lead</option>
                    <option value="Proposal Sent">📋 Proposal Sent</option>
                    <option value="Negotiation">💬 Negotiation</option>
                    <option value="Client">✅ Client</option>
                    <option value="Lost">❌ Lost</option>
                    <option value="Follow Up">🔄 Follow Up</option>
                  </select>
                </div>
                <div class="form-group">
                  <label class="form-label">Prioridad</label>
                  <select id="contactPriority" class="form-select priority-select">
                    <option value="Low">🟢 Low</option>
                    <option value="Medium">🟡 Medium</option>
                    <option value="High">🔴 High</option>
                  </select>
                </div>
              </div>
            </div>

            <!-- Activity Information Section -->
            <div class="crm-section">
              <h3 class="section-title">Actividad</h3>
              <div class="form-row">
                <div class="form-group">
                  <label class="form-label">Total Reuniones</label>
                  <input type="number" id="contactMeetingCount" class="form-input" readonly style="background: #f7fafc;">
                </div>
                <div class="form-group">
                  <label class="form-label">Última Reunión</label>
                  <input type="date" id="contactLastSeen" class="form-input" readonly style="background: #f7fafc;">
                </div>
              </div>
            </div>

            <!-- Notes Section -->
            <div class="crm-section">
              <h3 class="section-title">Notas y Observaciones</h3>
              <div class="form-group">
                <label class="form-label">Notas Internas</label>
                <textarea id="contactNotes" class="form-textarea" placeholder="Notas sobre el contacto, seguimiento, observaciones importantes, etc." rows="4"></textarea>
              </div>
            </div>
          </div>
          
          <div class="modal-footer">
            <button class="btn-cancel" onclick="closeContactModal()">Cancelar</button>
            <button class="btn-save" onclick="saveContactDetails()">Guardar Cambios</button>
          </div>
        </div>
      </div>
      
      <!-- Create Tag Modal -->
      <div id="createTagModal" class="modal">
        <div class="modal-content">
          <div class="modal-header">
            <h2>Crear Nueva Etiqueta</h2>
            <span class="close-btn" onclick="closeCreateTagModal()">&times;</span>
          </div>
          
          <div class="modal-body">
            <div class="form-group">
              <label class="form-label">Nombre de la Etiqueta *</label>
              <input type="text" id="newTagName" class="form-input" placeholder="Ej: Cliente Potencial" maxlength="50">
            </div>
            
            <div class="form-group">
              <label class="form-label">Color de la Etiqueta</label>
              <div class="color-picker-container">
                <input type="color" id="newTagColor" class="form-color-input" value="#FF6B00">
                <div class="color-preview">
                  <span id="colorPreviewText">Nueva Etiqueta</span>
                </div>
              </div>
            </div>
            
            <div class="form-group">
              <label class="form-label">Vista Previa</label>
              <div class="tag-preview">
                <span id="tagPreview" class="tag-badge">Nueva Etiqueta</span>
              </div>
            </div>
          </div>
          
          <div class="modal-footer">
            <button class="btn-cancel" onclick="closeCreateTagModal()">Cancelar</button>
            <button class="btn-save" onclick="createNewTag()">Crear Etiqueta</button>
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
        
        // Helper function to safely escape onclick attributes
        function safeOnclick(funcName, ...args) {
          const escapedArgs = args.map(arg => {
            if (arg === 'this') {
              return 'this';
            }
            if (typeof arg === 'string') {
              // Simple and safe escape - only escape essential characters
              const escaped = arg.replace(/'/g, '&#39;').replace(/"/g, '&quot;');
              return "'" + escaped + "'";
            }
            return String(arg);
          });
          return 'onclick="' + funcName + '(' + escapedArgs.join(', ') + ')"';
        }
        
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
            
            // Auto-load contacts when switching to contacts tab
            if (tabId === 'contacts') {
              loadContacts();
            }
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
            console.log('Auth success received - reloading page');
            // Small delay to ensure the auth process is complete
            setTimeout(() => {
              window.location.reload();
            }, 500);
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
        let currentTimeLineInterval = null;

        // Function to update the current time line in week view
        function updateCurrentTimeLine() {
          const weekBody = document.getElementById('week-body');
          if (!weekBody) return;
          
          const now = new Date();
          const currentHour = now.getHours();
          const currentMinutes = now.getMinutes();
          const currentDay = now.getDay();
          
          // Remove existing time line
          const existingLine = document.querySelector('.current-time-line');
          if (existingLine) {
            existingLine.remove();
          }
          
          // Find the current day column for the current hour
          const targetColumn = weekBody.querySelector('[data-day="' + currentDay + '"][data-hour="' + currentHour + '"]');
          if (!targetColumn) return;
          
          // Calculate position within the hour (0-60 minutes = 0-100% of hour slot)
          const minutePercentage = (currentMinutes / 60) * 100;
          
          // Create time line element
          const timeLine = document.createElement('div');
          timeLine.className = 'current-time-line';
          timeLine.style.position = 'absolute';
          timeLine.style.top = minutePercentage + '%';
          timeLine.style.left = '0';
          timeLine.style.right = '0';
          timeLine.style.height = '2px';
          timeLine.style.background = 'linear-gradient(90deg, #FF6B00, #FF8533)';
          timeLine.style.zIndex = '1000';
          timeLine.style.boxShadow = '0 0 8px rgba(255, 107, 0, 0.6)';
          
          // Add a circle at the start of the line
          const circle = document.createElement('div');
          circle.style.position = 'absolute';
          circle.style.left = '-6px';
          circle.style.top = '-4px';
          circle.style.width = '10px';
          circle.style.height = '10px';
          circle.style.borderRadius = '50%';
          circle.style.background = '#FF6B00';
          circle.style.border = '2px solid white';
          circle.style.boxShadow = '0 0 8px rgba(255, 107, 0, 0.6)';
          
          timeLine.appendChild(circle);
          targetColumn.appendChild(timeLine);
          
          // Auto-scroll to current time if it's the first time
          if (!document.querySelector('.current-time-line-scrolled')) {
            setTimeout(() => {
              targetColumn.scrollIntoView({ behavior: 'smooth', block: 'center' });
              document.body.classList.add('current-time-line-scrolled');
            }, 200);
          }
        }

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
        
        // Tag Management Functions
        function showCreateTagModal() {
          document.getElementById('createTagModal').style.display = 'block';
          document.getElementById('newTagName').value = '';
          document.getElementById('newTagColor').value = '#FF6B00';
          updateTagPreview();
        }
        
        function closeCreateTagModal() {
          document.getElementById('createTagModal').style.display = 'none';
        }
        
        function updateTagPreview() {
          const name = document.getElementById('newTagName').value || 'Nueva Etiqueta';
          const color = document.getElementById('newTagColor').value;
          
          const preview = document.getElementById('tagPreview');
          const colorPreview = document.getElementById('colorPreviewText');
          
          preview.textContent = name;
          preview.style.background = color;
          colorPreview.textContent = name;
          colorPreview.style.color = color;
        }
        
        async function createNewTag() {
          const name = document.getElementById('newTagName').value.trim();
          const color = document.getElementById('newTagColor').value;
          
          if (!name) {
            alert('Por favor ingresa un nombre para la etiqueta');
            return;
          }
          
          try {
            const response = await fetch('/api/tags', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json'
              },
              body: JSON.stringify({
                name: name,
                color: color
              })
            });
            
            const result = await response.json();
            
            if (result.success) {
              alert('Etiqueta creada exitosamente');
              closeCreateTagModal();
              // Reload tags for filter
              loadTagsForFilter();
              // Reload available tags for events
              loadTagsAndContacts();
            } else {
              alert('Error al crear etiqueta: ' + result.error);
            }
          } catch (error) {
            console.error('Error creating tag:', error);
            alert('Error de conexión al crear etiqueta');
          }
        }
        
        async function deleteTag(tagId, tagName) {
          if (tagName === 'New Lead') {
            alert('No se puede eliminar la etiqueta "New Lead"');
            return;
          }
          
          if (!confirm('¿Estás seguro de que quieres eliminar la etiqueta "' + tagName + '"? Esta acción no se puede deshacer.')) {
            return;
          }
          
          try {
            const response = await fetch('/api/tags/' + tagId, {
              method: 'DELETE'
            });
            
            const result = await response.json();
            
            if (result.success) {
              alert('Etiqueta eliminada exitosamente');
              // Reload tags for filter
              loadTagsForFilter();
              // Reload available tags for events
              loadTagsAndContacts();
              // Reload contacts to reflect changes
              loadContactsWithFilters();
            } else {
              alert('Error al eliminar etiqueta: ' + result.error);
            }
          } catch (error) {
            console.error('Error deleting tag:', error);
            alert('Error de conexión al eliminar etiqueta');
          }
        }
        
        // Add event listeners for tag preview
        document.addEventListener('DOMContentLoaded', function() {
          const nameInput = document.getElementById('newTagName');
          const colorInput = document.getElementById('newTagColor');
          
          if (nameInput) {
            nameInput.addEventListener('input', updateTagPreview);
          }
          if (colorInput) {
            colorInput.addEventListener('input', updateTagPreview);
          }
        });

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
                      '<div class="tag-dropdown" ' + safeOnclick('toggleTagDropdown', email) + '>' +
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
                   '<span class="tag-remove" ' + safeOnclick('removeTag', tag, 'this') + '>×</span></span>';
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
                   safeOnclick('toggleTag', email, tag, 'this') + '>' +
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
                
                // Sync attendee tags with contact tags
                try {
                  await fetch('/api/sync-attendee-tags', {
                    method: 'POST',
                    headers: {
                      'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                      eventId: currentEventId,
                      attendeeEmail: email,
                      tags: newTags
                    })
                  });
                  console.log('Attendee tags synchronized successfully');
                } catch (syncError) {
                  console.error('Error syncing attendee tags:', syncError);
                }
                
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
              
              // Sync attendee tags with contact tags
              fetch('/api/sync-attendee-tags', {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                  eventId: currentEventId,
                  attendeeEmail: email,
                  tags: newTags
                })
              }).then(syncResponse => {
                console.log('Attendee tags synchronized successfully');
              }).catch(syncError => {
                console.error('Error syncing attendee tags:', syncError);
              });
              
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
          // Parse full name into first and last name
          const fullName = contact.name || '';
          const nameParts = fullName.split(' ');
          const firstName = nameParts[0] || '';
          const lastName = nameParts.slice(1).join(' ') || '';
          
          // Personal Information
          document.getElementById('contactFirstName').value = firstName;
          document.getElementById('contactLastName').value = lastName;
          document.getElementById('contactEmail').value = contact.email || '';
          document.getElementById('contactPhone').value = contact.phone || '';
          
          // Company Information
          document.getElementById('contactCompany').value = contact.company || '';
          document.getElementById('contactPosition').value = contact.position || '';
          document.getElementById('contactWebsite').value = contact.website || '';
          document.getElementById('contactIndustry').value = contact.industry || '';
          
          // CRM Status - Map old tags to new status system
          const statusMapping = {
            'New Lead': 'New Lead',
            'Client': 'Client',
            'Lost': 'Lost'
          };
          
          // Check if contact has specific tags that map to status
          let contactStatus = 'New Lead'; // Default
          if (contact.tags && contact.tags.length > 0) {
            const mappedStatus = contact.tags.find(tag => statusMapping[tag]);
            if (mappedStatus) {
              contactStatus = statusMapping[mappedStatus];
            }
          }
          
          document.getElementById('contactStatus').value = contact.status || contactStatus;
          document.getElementById('contactPriority').value = contact.priority || 'Medium';
          
          // Activity Information
          document.getElementById('contactMeetingCount').value = contact.meeting_count || 0;
          document.getElementById('contactLastSeen').value = contact.last_seen || '';
          
          // Notes
          document.getElementById('contactNotes').value = contact.notes || '';
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
            return '<div class="tag-option ' + (isSelected ? 'selected' : '') + '" ' + safeOnclick('toggleContactTag', tagName) + '>' +
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
          
          // Collect all form data
          const firstName = document.getElementById('contactFirstName').value;
          const lastName = document.getElementById('contactLastName').value;
          const name = (firstName + ' ' + lastName).trim();
          const phone = document.getElementById('contactPhone').value;
          const company = document.getElementById('contactCompany').value;
          const position = document.getElementById('contactPosition').value;
          const website = document.getElementById('contactWebsite').value;
          const industry = document.getElementById('contactIndustry').value;
          const status = document.getElementById('contactStatus').value;
          const priority = document.getElementById('contactPriority').value;
          const notes = document.getElementById('contactNotes').value;
          const tags = currentContactData.tags || [];
          
          try {
            const response = await fetch('/api/contacts/' + currentContactData.id + '/update', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json'
              },
              body: JSON.stringify({
                name: name,
                phone: phone,
                company: company,
                position: position,
                website: website,
                industry: industry,
                status: status,
                priority: priority,
                notes: notes,
                tags: tags
              })
            });
            
            const result = await response.json();
            
            if (result.success) {
              // Sync attendee tags with contact tags
              try {
                await fetch('/api/sync-attendee-tags', {
                  method: 'POST',
                  headers: {
                    'Content-Type': 'application/json'
                  },
                  body: JSON.stringify({
                    eventId: currentEventId || 'contact-edit',
                    attendeeEmail: currentContactData.email,
                    tags: tags
                  })
                });
                console.log('Contact tags synchronized successfully');
              } catch (syncError) {
                console.error('Error syncing contact tags:', syncError);
              }
              
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
              '<div class="event-item event-clickable" ' + safeOnclick('showEventDetails', event.id) + '>' +
                '<div class="event-time">' + formatEventTime(event.start) + '</div>' +
                '<div class="event-title">' + (event.summary || 'Sin título') + '</div>' +
                '<div class="event-attendees">' + formatAttendees(event.attendees) + '</div>' +
                '<div class="event-actions">' +
                  (event.hangoutLink ? '<a href="' + event.hangoutLink + '" target="_blank" class="event-join-btn" onclick="event.stopPropagation();">Unirse</a>' : '') +
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
          
          // Get current day info for highlighting
          const today = new Date();
          const todayDay = today.getDay();
          const isCurrentWeek = today >= startOfWeek && today < endOfWeek;
          
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
          weekDays.forEach((day, index) => {
            const isToday = isCurrentWeek && index === todayDay;
            const dayClass = isToday ? 'day-header current-day' : 'day-header';
            html += '<div class="' + dayClass + '">' + day + '</div>';
          });
          html += '</div>';
          
          // Scrollable body with time slots and events
          html += '<div class="week-body" id="week-body">';
          timeSlots.forEach((time, timeIndex) => {
            const currentHour = parseInt(time);
            html += '<div class="time-slot">' + time + '</div>';
            
            for (let day = 0; day < 7; day++) {
              const isToday = isCurrentWeek && day === todayDay;
              const dayColumnClass = isToday ? 'day-column current-day-column' : 'day-column';
              html += '<div class="' + dayColumnClass + '" data-day="' + day + '" data-hour="' + currentHour + '">';
              
              // Find events for this day and time
              const dayEvents = weekEvents.filter(event => {
                const eventDate = new Date(event.start.dateTime || event.start.date);
                const eventHour = eventDate.getHours();
                const eventDay = eventDate.getDay();
                return eventDay === day && eventHour === currentHour;
              });
              
              dayEvents.forEach(event => {
                html += '<div class="event-block" ' + safeOnclick('showEventDetails', event.id) + '>';
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
          
          // Add current time line if viewing current week
          if (isCurrentWeek) {
            setTimeout(() => {
              updateCurrentTimeLine();
              // Clear any existing interval
              if (currentTimeLineInterval) {
                clearInterval(currentTimeLineInterval);
              }
              // Update time line every minute
              currentTimeLineInterval = setInterval(updateCurrentTimeLine, 60000);
            }, 100);
          } else {
            // Clear interval if not viewing current week
            if (currentTimeLineInterval) {
              clearInterval(currentTimeLineInterval);
              currentTimeLineInterval = null;
            }
          }
          
          return html;
        }

        function renderMonthView(events) {
          const now = currentDate;
          const year = now.getFullYear();
          const month = now.getMonth();
          
          // Get today's date for highlighting
          const today = new Date();
          const todayDateString = today.toDateString();
          
          console.log('Rendering month view for ' + year + '-' + (month + 1) + ':', {
            totalEvents: events.length,
            currentDate: currentDate.toDateString(),
            firstDay: new Date(year, month, 1).toDateString(),
            lastDay: new Date(year, month + 1, 0).toDateString(),
            todayDateString: todayDateString
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
            const isToday = date.toDateString() === todayDateString;
            
            let dayClass = isCurrentMonth ? 'month-day' : 'month-day other-month';
            if (isToday) {
              dayClass += ' current-day-month';
            }
            
            html += '<div class="' + dayClass + '">';
            
            // Day number with special styling for today
            let dayNumberClass = 'month-day-number';
            if (isToday) {
              dayNumberClass += ' today-number';
            }
            
            html += '<div class="' + dayNumberClass + '" ' + safeOnclick('selectDayFromMonth', getLocalDateString(date)) + '>' + date.getDate() + '</div>';
            
            // Find events for this day
            const dayEvents = events.filter(event => {
              const eventDate = new Date(event.start.dateTime || event.start.date);
              return eventDate.toDateString() === date.toDateString();
            });
            
            if (dayEvents.length > 0) {
              console.log('Day ' + date.toDateString() + ' has ' + dayEvents.length + ' events:', dayEvents.map(e => e.summary));
            }
            
            dayEvents.forEach(event => {
              html += '<div class="month-event" ' + safeOnclick('showEventDetails', event.id) + '>';
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
                      'New Lead': '●',
                      'Untagged': '○'
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
                      return '<div class="event-item contact-item" style="border-left: 4px solid ' + borderColor + '; cursor: pointer;" ' + safeOnclick('showContactDetails', contact.email) + '>' +
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

        // Global variable to store all contacts for filtering
        let allContactsData = [];

        // Enhanced loadContacts function with filtering support
        async function loadContactsWithFiltering() {
          const contactsList = document.getElementById('contactsList');
          contactsList.innerHTML = '<div class="status loading">Cargando contactos...</div>';
          
          try {
            const response = await fetch('/api/contacts');
            const result = await response.json();
            
            if (result.success) {
              allContactsData = result.data;
              
              // Load available tags for filter dropdown
              await loadTagsForFilter();
              
              // Apply current filters
              filterContacts();
            } else {
              contactsList.innerHTML = '<div class="status error">Error: ' + result.error + '</div>';
            }
          } catch (error) {
            contactsList.innerHTML = '<div class="status error">Error: ' + error.message + '</div>';
          }
        }

        // Load tags for filter dropdown
        async function loadTagsForFilter() {
          try {
            const response = await fetch('/api/tags');
            const result = await response.json();
            
            if (result.success) {
              const tagFilter = document.getElementById('contactTagFilter');
              // Clear existing options except "All tags"
              tagFilter.innerHTML = '<option value="">Todas las etiquetas</option>';
              
              // Add available tags
              result.data.forEach(tagInfo => {
                const option = document.createElement('option');
                option.value = tagInfo.tag;
                option.textContent = getTagIcon(tagInfo.tag) + ' ' + tagInfo.tag + ' (' + tagInfo.count + ')';
                tagFilter.appendChild(option);
              });
              
              // Add "Untagged" option
              const untaggedOption = document.createElement('option');
              untaggedOption.value = 'Untagged';
              untaggedOption.textContent = '○ Sin etiquetas';
              tagFilter.appendChild(untaggedOption);
            }
          } catch (error) {
            console.error('Error loading tags for filter:', error);
          }
        }

        // Filter contacts based on current filter settings
        function filterContacts() {
          const searchText = document.getElementById('contactSearchInput').value.toLowerCase();
          const tagFilter = document.getElementById('contactTagFilter').value;
          const sortFilter = document.getElementById('contactSortFilter').value;
          
          let filteredContacts = [...allContactsData];
          
          // Apply search filter
          if (searchText) {
            filteredContacts = filteredContacts.filter(contact => 
              contact.email.toLowerCase().includes(searchText) ||
              (contact.name && contact.name.toLowerCase().includes(searchText))
            );
          }
          
          // Apply tag filter
          if (tagFilter) {
            if (tagFilter === 'Untagged') {
              filteredContacts = filteredContacts.filter(contact => 
                !contact.tags || contact.tags.length === 0
              );
            } else {
              filteredContacts = filteredContacts.filter(contact => 
                contact.tags && contact.tags.includes(tagFilter)
              );
            }
          }
          
          // Apply sorting
          filteredContacts.sort((a, b) => {
            switch (sortFilter) {
              case 'name':
                const nameA = (a.name || a.email).toLowerCase();
                const nameB = (b.name || b.email).toLowerCase();
                return nameA.localeCompare(nameB);
              case 'meetings':
                return (b.meeting_count || 0) - (a.meeting_count || 0);
              case 'recent':
              default:
                return new Date(b.updated_at || b.created_at) - new Date(a.updated_at || a.created_at);
            }
          });
          
          // Update active filters display
          updateActiveFiltersDisplay(searchText, tagFilter, sortFilter);
          
          // Render filtered contacts
          renderFilteredContacts(filteredContacts);
        }

        // Update active filters display
        function updateActiveFiltersDisplay(searchText, tagFilter, sortFilter) {
          const filtersActive = document.getElementById('contactFiltersActive');
          const activeFiltersText = document.getElementById('activeFiltersText');
          
          const activeFilters = [];
          if (searchText) activeFilters.push('Búsqueda: "' + searchText + '"');
          if (tagFilter) activeFilters.push('Etiqueta: ' + tagFilter);
          if (sortFilter !== 'recent') activeFilters.push('Orden: ' + getSortLabel(sortFilter));
          
          if (activeFilters.length > 0) {
            activeFiltersText.textContent = activeFilters.join(' • ');
            filtersActive.style.display = 'block';
          } else {
            filtersActive.style.display = 'none';
          }
        }

        // Get sort label for display
        function getSortLabel(sortFilter) {
          switch (sortFilter) {
            case 'name': return 'Por nombre';
            case 'meetings': return 'Por reuniones';
            case 'recent': return 'Más recientes';
            default: return sortFilter;
          }
        }

        // Get tag icon
        function getTagIcon(tag) {
          const tagIcons = {
            'New Lead': '●',
            'Untagged': '○'
          };
          return tagIcons[tag] || '■';
        }

        // Render filtered contacts
        function renderFilteredContacts(contacts) {
          const contactsList = document.getElementById('contactsList');
          
          if (contacts.length === 0) {
            contactsList.innerHTML = '<div class="auth-prompt"><h3>No se encontraron contactos</h3><p>Intenta ajustar los filtros de búsqueda</p></div>';
            return;
          }
          
          // Organize contacts by tags for display
          const contactsByTag = {};
          
          contacts.forEach(contact => {
            if (!contact.tags || contact.tags.length === 0) {
              if (!contactsByTag['Untagged']) contactsByTag['Untagged'] = [];
              contactsByTag['Untagged'].push(contact);
            } else {
              contact.tags.forEach(tag => {
                if (!contactsByTag[tag]) contactsByTag[tag] = [];
                contactsByTag[tag].push(contact);
              });
            }
          });
          
          let html = '';
          
          // Show each category
          Object.keys(contactsByTag).forEach(tag => {
            const tagContacts = contactsByTag[tag];
            if (tagContacts.length > 0) {
              const tagIcons = {
                'New Lead': '●',
                'Untagged': '○'
              };
              
              const tagColors = {
                'New Lead': '#FF6B00',
                'Untagged': '#718096'
              };
              
              const icon = tagIcons[tag] || '🏷️';
              const color = tagColors[tag] || '#718096';
              
              html += '<div style="margin-bottom: 25px;">';
              html += '<h3 style="color: ' + color + '; margin-bottom: 15px; font-size: 18px;">' + icon + ' ' + tag + ' (' + tagContacts.length + ')</h3>';
              
              html += tagContacts.map(contact => {
                const borderColor = tag === 'Untagged' ? '#e2e8f0' : color;
                return '<div class="event-item contact-item" style="border-left: 4px solid ' + borderColor + '; cursor: pointer;" ' + safeOnclick('showContactDetails', contact.email) + '>' +
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

        // Clear all contact filters
        function clearContactFilters() {
          document.getElementById('contactSearchInput').value = '';
          document.getElementById('contactTagFilter').value = '';
          document.getElementById('contactSortFilter').value = 'recent';
          filterContacts();
        }

        // Override the original loadContacts function to use the new filtering version
        const originalLoadContacts = loadContacts;
        loadContacts = function() {
          // Check if we're on the contacts tab
          const activeTab = document.querySelector('.nav-item.active')?.getAttribute('data-tab');
          if (activeTab === 'contacts') {
            loadContactsWithFiltering();
          } else {
            originalLoadContacts();
          }
        };
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