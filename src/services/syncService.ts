import { Database } from '../config/database';
import { GoogleCalendarService } from './googleCalendar';

export class SyncService {
  private db: Database;
  private calendarService: GoogleCalendarService;

  constructor() {
    this.db = new Database();
    this.calendarService = new GoogleCalendarService();
  }

  async syncContacts(daysBack: number = 7): Promise<{ 
    newContacts: string[], 
    totalContacts: number,
    eventsProcessed: number 
  }> {
    try {
      // Initialize Google Calendar service
      await this.calendarService.initialize();
      
      // Get recent events
      const events = await this.calendarService.getEvents(daysBack);
      
      console.log(`Processing ${events.length} events from last ${daysBack} days`);
      
      const newContacts: string[] = [];
      const processedEmails = new Set<string>();
      
      // Process each event
      for (const event of events) {
        const attendees = event.attendees || [];
        
        for (const attendee of attendees) {
          if (attendee.email && !processedEmails.has(attendee.email)) {
            processedEmails.add(attendee.email);
            
            // Check if contact exists
            const existingContact = await this.db.getContact(attendee.email);
            
            if (!existingContact) {
              // New contact found
              await this.db.addContact(attendee.email, attendee.displayName);
              newContacts.push(attendee.email);
              console.log(`📧 New contact: ${attendee.email} (${attendee.displayName || 'No name'})`);
            } else {
              // Update existing contact
              await this.db.addContact(attendee.email, attendee.displayName);
            }
          }
        }
      }
      
      // Get total contacts count
      const allContacts = await this.db.getAllContacts();
      
      return {
        newContacts,
        totalContacts: allContacts.length,
        eventsProcessed: events.length
      };
      
    } catch (error) {
      console.error('Sync error:', error);
      throw error;
    }
  }

  async getContacts() {
    return await this.db.getAllContacts();
  }

  async getNewContacts(days: number = 7) {
    return await this.db.getNewContacts(days);
  }

  async close() {
    await this.db.close();
  }
}