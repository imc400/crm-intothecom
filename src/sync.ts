import { SyncService } from './services/syncService';

async function runSync() {
  console.log('🔄 Starting calendar sync...');
  
  const syncService = new SyncService();
  
  try {
    const result = await syncService.syncContacts();
    
    console.log('\n✅ Sync completed successfully!');
    console.log(`📊 Results:`);
    console.log(`   - Events processed: ${result.eventsProcessed}`);
    console.log(`   - New contacts: ${result.newContacts.length}`);
    console.log(`   - Total contacts: ${result.totalContacts}`);
    
    if (result.newContacts.length > 0) {
      console.log('\n🆕 New contacts found:');
      result.newContacts.forEach((email, index) => {
        console.log(`   ${index + 1}. ${email}`);
      });
    }
    
  } catch (error) {
    console.error('❌ Sync failed:', error);
    process.exit(1);
  } finally {
    await syncService.close();
  }
}

// Run sync if called directly
if (require.main === module) {
  runSync();
}

export { runSync };