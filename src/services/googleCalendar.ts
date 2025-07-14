import { google } from 'googleapis';
import { authenticate } from '@google-cloud/local-auth';
import * as path from 'path';
import * as fs from 'fs';

const CREDENTIALS_PATH = path.join(__dirname, '..', '..', 'client_secret_419586581117-g9jfcu1hk0sr757gkp9cukbu148b90d8.apps.googleusercontent.com.json');
const SCOPES = ['https://www.googleapis.com/auth/calendar.readonly'];

export class GoogleCalendarService {
  private auth: any;

  async initialize() {
    if (!fs.existsSync(CREDENTIALS_PATH)) {
      throw new Error('Google credentials file not found');
    }

    this.auth = await authenticate({
      scopes: SCOPES,
      keyfilePath: CREDENTIALS_PATH,
    });

    if (!this.auth) {
      throw new Error('Google authentication failed');
    }
  }

  async getEvents(daysBack: number = 7): Promise<any[]> {
    if (!this.auth) {
      await this.initialize();
    }

    const calendar = google.calendar({ version: 'v3', auth: this.auth });
    
    const now = new Date();
    const pastDate = new Date(now.getTime() - daysBack * 24 * 60 * 60 * 1000);
    
    try {
      const response = await calendar.events.list({
        calendarId: 'primary',
        timeMin: pastDate.toISOString(),
        timeMax: now.toISOString(),
        singleEvents: true,
        orderBy: 'startTime',
      });

      return response.data.items || [];
    } catch (error) {
      console.error('Error fetching calendar events:', error);
      throw error;
    }
  }

  async getUpcomingEvents(daysAhead: number = 7): Promise<any[]> {
    if (!this.auth) {
      await this.initialize();
    }

    const calendar = google.calendar({ version: 'v3', auth: this.auth });
    
    const now = new Date();
    const futureDate = new Date(now.getTime() + daysAhead * 24 * 60 * 60 * 1000);
    
    try {
      const response = await calendar.events.list({
        calendarId: 'primary',
        timeMin: now.toISOString(),
        timeMax: futureDate.toISOString(),
        singleEvents: true,
        orderBy: 'startTime',
      });

      return response.data.items || [];
    } catch (error) {
      console.error('Error fetching upcoming events:', error);
      throw error;
    }
  }
}