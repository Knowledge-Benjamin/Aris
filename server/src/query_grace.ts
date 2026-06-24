import 'dotenv/config';
import { getWhatsappConversationBySenders } from './db/whatsappStore';
import { resolveNameToPhones } from './db/contactsStore';

async function testGrace() {
  const userId = 1; // Assuming primary user
  const resolved = await resolveNameToPhones(userId, "Grace");
  console.log("Resolved Grace to:", resolved);
  
  if (resolved && resolved.phoneKeys.length > 0) {
     const msgs = await getWhatsappConversationBySenders(resolved.phoneKeys, resolved.whatsappIds || [], 5);
     console.log(`Found ${msgs.length} messages`);
     console.log(msgs);
  } else {
    console.log("No phones found for Grace.");
  }
}

testGrace().catch(console.error).finally(() => process.exit(0));
