const fs = require('fs');
const path = require('path');
const { Client, RemoteAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const express = require('express');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

// --- Config ---
const PORT = process.env.PORT || 3000;
const SESSION_ID = process.env.WHATSAPP_SESSION_ID || 'default_session';
const BOT_VERSION = '1.0.1';
const startedAt = Date.now();

// Multiple webhook URLs support
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL;
const INTEREST_RATE_WEBHOOK_URL = process.env.INTEREST_RATE_WEBHOOK_URL;
const VALUATION_WEBHOOK_URL = process.env.VALUATION_WEBHOOK_URL;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

// --- Human-like Behavior Configuration ---
const HUMAN_BEHAVIOR = {
  // Typing speed (characters per minute)
  TYPING_SPEED_MIN: 150,
  TYPING_SPEED_MAX: 300,
  
  // Delays between actions (milliseconds)
  MIN_DELAY_BETWEEN_MESSAGES: 2000,
  MAX_DELAY_BETWEEN_MESSAGES: 8000,
  
  // Message chunk settings
  MAX_MESSAGE_LENGTH: 300,
  CHUNK_DELAY_MIN: 1000,
  CHUNK_DELAY_MAX: 3000,
  
  // Rate limiting
  MAX_MESSAGES_PER_MINUTE: 8,
  MAX_MESSAGES_PER_HOUR: 120,
  
  // Presence simulation
  ONLINE_DURATION_MIN: 30000, // 30 seconds
  ONLINE_DURATION_MAX: 300000, // 5 minutes
  OFFLINE_DURATION_MIN: 60000, // 1 minute
  OFFLINE_DURATION_MAX: 600000, // 10 minutes
};

// Rate limiting storage
const rateLimiter = {
  messageTimestamps: [],
  lastMessageTime: 0,
};

console.log('🔍 Loaded Webhook URLs:');
console.log('- N8N_WEBHOOK_URL:', N8N_WEBHOOK_URL);
console.log('- INTEREST_RATE_WEBHOOK_URL:', INTEREST_RATE_WEBHOOK_URL);
console.log('- VALUATION_WEBHOOK_URL:', VALUATION_WEBHOOK_URL);

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error('❌ Missing Supabase credentials. Exiting.');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const log = (level, message, ...args) => {
  const timestamp = new Date().toISOString();
  const formatted = `[${timestamp}] [${level.toUpperCase()}] [${SESSION_ID}] ${message}`;
  console[level](formatted, ...args);
};

// --- Human-like Behavior Utilities ---

/**
 * Generate random delay within specified range
 */
function getRandomDelay(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * Calculate typing time based on message length
 */
function calculateTypingTime(messageLength) {
  const speed = getRandomDelay(HUMAN_BEHAVIOR.TYPING_SPEED_MIN, HUMAN_BEHAVIOR.TYPING_SPEED_MAX);
  const baseTime = (messageLength / speed) * 60 * 1000; // Convert to milliseconds
  
  // Add some randomness and ensure minimum time
  const randomFactor = 0.5 + Math.random(); // 0.5 to 1.5
  return Math.max(1000, Math.floor(baseTime * randomFactor));
}

/**
 * Split long messages into human-like chunks
 */
function splitMessageIntoChunks(message, maxLength = HUMAN_BEHAVIOR.MAX_MESSAGE_LENGTH) {
  if (message.length <= maxLength) {
    return [message];
  }
  
  const chunks = [];
  const sentences = message.split(/[.!?]+/).filter(s => s.trim());
  
  let currentChunk = '';
  
  for (const sentence of sentences) {
    const trimmedSentence = sentence.trim();
    if (!trimmedSentence) continue;
    
    const sentenceWithPunctuation = trimmedSentence + (message.match(/[.!?]/) ? '.' : '');
    
    if ((currentChunk + sentenceWithPunctuation).length <= maxLength) {
      currentChunk += (currentChunk ? ' ' : '') + sentenceWithPunctuation;
    } else {
      if (currentChunk) {
        chunks.push(currentChunk);
        currentChunk = sentenceWithPunctuation;
      } else {
        // Handle very long sentences
        const words = sentenceWithPunctuation.split(' ');
        let wordChunk = '';
        
        for (const word of words) {
          if ((wordChunk + word).length <= maxLength) {
            wordChunk += (wordChunk ? ' ' : '') + word;
          } else {
            if (wordChunk) chunks.push(wordChunk);
            wordChunk = word;
          }
        }
        
        if (wordChunk) currentChunk = wordChunk;
      }
    }
  }
  
  if (currentChunk) {
    chunks.push(currentChunk);
  }
  
  return chunks.length > 0 ? chunks : [message];
}

/**
 * Check rate limits
 */
function checkRateLimit() {
  const now = Date.now();
  const oneMinuteAgo = now - 60000;
  const oneHourAgo = now - 3600000;
  
  // Clean old timestamps
  rateLimiter.messageTimestamps = rateLimiter.messageTimestamps.filter(
    timestamp => timestamp > oneHourAgo
  );
  
  const messagesLastMinute = rateLimiter.messageTimestamps.filter(
    timestamp => timestamp > oneMinuteAgo
  ).length;
  
  const messagesLastHour = rateLimiter.messageTimestamps.length;
  
  if (messagesLastMinute >= HUMAN_BEHAVIOR.MAX_MESSAGES_PER_MINUTE) {
    return { allowed: false, reason: 'Rate limit: too many messages per minute' };
  }
  
  if (messagesLastHour >= HUMAN_BEHAVIOR.MAX_MESSAGES_PER_HOUR) {
    return { allowed: false, reason: 'Rate limit: too many messages per hour' };
  }
  
  // Check minimum delay between messages
  const timeSinceLastMessage = now - rateLimiter.lastMessageTime;
  if (timeSinceLastMessage < HUMAN_BEHAVIOR.MIN_DELAY_BETWEEN_MESSAGES) {
    const waitTime = HUMAN_BEHAVIOR.MIN_DELAY_BETWEEN_MESSAGES - timeSinceLastMessage;
    return { allowed: false, reason: 'Rate limit: too fast', waitTime };
  }
  
  return { allowed: true };
}

/**
 * Record message for rate limiting
 */
function recordMessage() {
  const now = Date.now();
  rateLimiter.messageTimestamps.push(now);
  rateLimiter.lastMessageTime = now;
}

/**
 * Simulate human typing behavior
 */
async function simulateTyping(chat, message) {
  try {
    const typingTime = calculateTypingTime(message.length);
    const actualTypingTime = Math.min(typingTime, 10000); // Cap at 10 seconds
    
    log('info', `🔤 Simulating typing for ${actualTypingTime}ms`);
    
    // Start typing indicator
    await chat.sendStateTyping();
    
    // Wait for typing time with some interruptions to make it more realistic
    const intervals = Math.floor(actualTypingTime / 2000) || 1;
    const intervalTime = actualTypingTime / intervals;
    
    for (let i = 0; i < intervals; i++) {
      await new Promise(resolve => setTimeout(resolve, intervalTime));
      if (i < intervals - 1) {
        // Occasionally stop and start typing again
        if (Math.random() < 0.3) {
          await chat.clearState();
          await new Promise(resolve => setTimeout(resolve, getRandomDelay(200, 800)));
          await chat.sendStateTyping();
        }
      }
    }
    
    // Clear typing state
    await chat.clearState();
    
    // Small delay after typing before sending
    await new Promise(resolve => setTimeout(resolve, getRandomDelay(300, 1000)));
    
  } catch (error) {
    log('warn', `Failed to simulate typing: ${error.message}`);
  }
}

/**
 * Send message with human-like behavior
 */
async function sendHumanLikeMessage(client, targetId, message, options = {}) {
  const rateCheck = checkRateLimit();
  
  if (!rateCheck.allowed) {
    if (rateCheck.waitTime) {
      log('info', `⏳ Waiting ${rateCheck.waitTime}ms due to rate limiting`);
      await new Promise(resolve => setTimeout(resolve, rateCheck.waitTime));
    } else {
      throw new Error(rateCheck.reason);
    }
  }
  
  try {
    const chat = await client.getChatById(targetId);
    const messageChunks = splitMessageIntoChunks(message.toString());
    const sentMessages = [];
    
    log('info', `📝 Sending ${messageChunks.length} message chunk(s) to ${targetId}`);
    
    for (let i = 0; i < messageChunks.length; i++) {
      const chunk = messageChunks[i];
      
      // Simulate typing for each chunk
      await simulateTyping(chat, chunk);
      
      // Send the message
      let sentMessage;
      if (options.media) {
        sentMessage = await client.sendMessage(targetId, options.media, {
          caption: chunk,
          ...options.messageOptions
        });
      } else {
        sentMessage = await client.sendMessage(targetId, chunk, options.messageOptions);
      }
      
      sentMessages.push(sentMessage);
      recordMessage();
      
      // Add delay between chunks (except for the last one)
      if (i < messageChunks.length - 1) {
        const chunkDelay = getRandomDelay(
          HUMAN_BEHAVIOR.CHUNK_DELAY_MIN,
          HUMAN_BEHAVIOR.CHUNK_DELAY_MAX
        );
        log('info', `⏳ Waiting ${chunkDelay}ms between message chunks`);
        await new Promise(resolve => setTimeout(resolve, chunkDelay));
      }
    }
    
    // Add random delay after sending all chunks
    const postMessageDelay = getRandomDelay(
      HUMAN_BEHAVIOR.MIN_DELAY_BETWEEN_MESSAGES,
      HUMAN_BEHAVIOR.MAX_DELAY_BETWEEN_MESSAGES
    );
    
    setTimeout(() => {
      log('debug', `💤 Post-message cooldown: ${postMessageDelay}ms`);
    }, 100);
    
    return sentMessages;
    
  } catch (error) {
    log('error', `Failed to send human-like message: ${error.message}`);
    throw error;
  }
}

/**
 * Simulate human presence patterns
 */
function simulatePresence(client) {
  if (!client || typeof client.sendPresenceUnavailable !== 'function') return;
  
  const simulateOnlineOffline = async () => {
    try {
      // Random chance to change presence
      if (Math.random() < 0.3) {
        const isOnline = Math.random() < 0.7; // 70% chance to be online
        
        if (isOnline) {
          await client.sendPresenceAvailable();
          const onlineTime = getRandomDelay(
            HUMAN_BEHAVIOR.ONLINE_DURATION_MIN,
            HUMAN_BEHAVIOR.ONLINE_DURATION_MAX
          );
          log('debug', `👁️ Simulating online presence for ${onlineTime}ms`);
          
          setTimeout(async () => {
            try {
              await client.sendPresenceUnavailable();
            } catch (err) {
              log('warn', `Failed to set unavailable presence: ${err.message}`);
            }
          }, onlineTime);
        }
      }
    } catch (error) {
      log('warn', `Failed to simulate presence: ${error.message}`);
    }
  };
  
  // Set random intervals for presence simulation
  const baseInterval = 5 * 60 * 1000; // 5 minutes
  const randomInterval = getRandomDelay(baseInterval * 0.5, baseInterval * 2);
  
  setTimeout(() => {
    simulateOnlineOffline();
    simulatePresence(client); // Schedule next simulation
  }, randomInterval);
}

// --- Enhanced Session Data Extraction (Modified as per suggestion) ---
async function extractSessionData(client) {
  if (!client || !client.pupPage) {
    log('warn', '⚠️ Cannot extract session data: No puppeteer page available');
    return null;
  }

  try {
    // Check if page is still usable
    try {
      const isPageAlive = await client.pupPage.evaluate(() => true).catch(() => false);
      if (!isPageAlive) {
        log('warn', '⚠️ Puppeteer page is no longer responsive, cannot extract data');
        return null;
      }
    } catch (pageErr) {
      log('warn', `⚠️ Error checking page status: ${pageErr.message}`);
      return null;
    }

    // Enhanced localStorage extraction
    const rawLocalStorage = await client.pupPage.evaluate(() => {
      try {
        // First, verify WAWebJS has properly loaded
        if (typeof window.Store === 'undefined' || !window.Store) {
          console.error("WhatsApp Web Store not initialized");
          return { error: "Store not initialized" };
        }

        // Extract ALL localStorage data comprehensively
        const data = {};
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          data[key] = localStorage.getItem(key);
        }

        // Add additional WAWebJS-specific session data if available
        if (window.Store && window.Store.AppState) {
          data['WAWebJS_AppState'] = JSON.stringify(window.Store.AppState.serialize());
        }
        
        // Add session metadata (from original index (8).js)
        data['_session_metadata'] = JSON.stringify({
          timestamp: Date.now(),
          userAgent: navigator.userAgent,
          url: window.location.href
        });

        return data;
      } catch (e) {
        console.error("Error extracting localStorage:", e);
        return { error: e.toString() };
      }
    }).catch(err => {
      log('warn', `⚠️ Error during page evaluation: ${err.message}`);
      return { error: err.message };
    });

    if (rawLocalStorage && rawLocalStorage.error) {
      log('warn', `⚠️ Error in page extraction: ${rawLocalStorage.error}`);
      return null;
    }

    // Check if enough items were extracted
    if (rawLocalStorage && Object.keys(rawLocalStorage).length > 5) { // Min items check
      log('info', `🔍 Extracted raw localStorage with ${Object.keys(rawLocalStorage).length} items`);

      // Validate session size (common check in both files)
      const sessionSize = JSON.stringify(rawLocalStorage).length;
      if (sessionSize < 5000) {
        log('warn', `Session data too small (${sessionSize} bytes), might be invalid`);
        return null;
      }
      
      log('info', `✅ Valid session data extracted (${sessionSize} bytes)`);
      return rawLocalStorage; // Now, if size is okay, it will return the data
      
    } else {
      log('warn', 'localStorage extraction found too few items');
    }

    return null;
  } catch (err) {
    log('error', `Failed to extract session data: ${err.message}`);
    return null;
  }
}

// --- Enhanced Supabase Store for WhatsApp Session ---
class SupabaseStore {
  constructor(supabaseClient, sessionId) {
    this.supabase = supabaseClient;
    this.sessionId = sessionId;
    this.client = null; // Will be set by RemoteAuth
    log('info', `SupabaseStore initialized for session ID: ${this.sessionId}`);
  }

  // Required by RemoteAuth interface
  async sessionExists({ session }) {
    try {
      const { data, error } = await this.supabase
        .from('whatsapp_sessions')
        .select('session_key')
        .eq('session_key', session || this.sessionId)
        .limit(1);

      if (error) {
        log('error', `Supabase error in sessionExists: ${error.message}`);
        return false;
      }
      
      const exists = data && data.length > 0;
      log('info', `Session exists check: ${exists} for session: ${session || this.sessionId}`);
      return exists;
    } catch (err) {
      log('error', `Exception in sessionExists: ${err.message}`);
      return false;
    }
  }

  // Required by RemoteAuth interface
  async extract({ session }) {
    const sessionKey = session || this.sessionId;
    try {
      const { data, error } = await this.supabase
        .from('whatsapp_sessions')
        .select('session_data')
        .eq('session_key', sessionKey)
        .limit(1)
        .single();

      if (error) {
        log('warn', `No existing session found for ${sessionKey}: ${error.message}`);
        return null;
      }
      
      if (!data?.session_data) {
        log('warn', `Session data is empty for ${sessionKey}`);
        return null;
      }

      // Validate session data structure
      let sessionData = data.session_data;
      if (typeof sessionData === 'string') {
        try {
          sessionData = JSON.parse(sessionData);
        } catch (parseErr) {
          log('error', `Failed to parse session data: ${parseErr.message}`);
          return null;
        }
      }

      // Validate essential session keys
      if (typeof sessionData === 'object' && sessionData !== null) {
        const hasEssentialData = Object.keys(sessionData).some(key => 
          key.includes('WABrowserId') || key.includes('WASecretBundle') || key.includes('WAToken')
        );
        
        if (!hasEssentialData) {
          log('warn', `Session data exists (from Supabase) but missing essential WhatsApp keys for ${sessionKey}`);
        }
      }
      
      log('info', `✅ Valid session data extracted from Supabase for ${sessionKey}`);
      return sessionData;
    } catch (err) {
      log('error', `Exception in extract: ${err.message}`);
      return null;
    }
  }

  // Required by RemoteAuth interface
  async save({ session, sessionData }) {
    const sessionKey = session || this.sessionId;
    
    try {
      // Validate sessionData before saving
      if (!sessionData || typeof sessionData !== 'object') {
        log('error', 'Invalid session data provided for saving');
        return;
      }

      const dataSize = JSON.stringify(sessionData).length;
      log('info', `Saving session data (${dataSize} bytes) for ${sessionKey}`);

      // Ensure we have essential WhatsApp data
      const hasEssentialData = Object.keys(sessionData).some(key => 
        key.includes('WABrowserId') || key.includes('WASecretBundle') || key.includes('WAToken')
      );
      
      if (!hasEssentialData) {
        log('warn', 'Session data (for saving) missing essential WhatsApp keys, attempting to extract fresh data');
        
        if (this.client) {
          const freshData = await extractSessionData(this.client);
          if (freshData) {
            sessionData = freshData;
            log('info', 'Using fresh extracted session data for save');
            const freshHasEssential = Object.keys(sessionData).some(key => 
                key.includes('WABrowserId') || key.includes('WASecretBundle') || key.includes('WAToken')
            );
            if (!freshHasEssential) {
                log('warn', 'Freshly extracted session data also missing essential keys. Saving as is based on size/item count.');
            }
          } else {
            log('warn', 'Fresh extraction for save attempt also yielded no valid data. Aborting save.');
            return;
          }
        }
      }

      const { error } = await this.supabase
        .from('whatsapp_sessions')
        .upsert({ 
          session_key: sessionKey, 
          session_data: sessionData,
          updated_at: new Date().toISOString()
        }, { onConflict: 'session_key' });

      if (error) {
        log('error', `Failed to save session: ${error.message}`);
      } else {
        log('info', `💾 Session saved to Supabase successfully for ${sessionKey}`);
        
        // Create additional backup
        await this.createBackup(sessionKey, sessionData);
      }
    } catch (err) {
      log('error', `Exception in save: ${err.message}`);
    }
  }

  // Required by RemoteAuth interface
  async delete({ session }) {
    const sessionKey = session || this.sessionId;
    try {
      const { error } = await this.supabase
        .from('whatsapp_sessions')
        .delete()
        .eq('session_key', sessionKey);

      if (error) {
        log('error', `Failed to delete session: ${error.message}`);
      } else {
        log('info', `🗑️ Session deleted from Supabase for ${sessionKey}`);
      }
    } catch (err) {
      log('error', `Exception in delete: ${err.message}`);
    }
  }

  // Enhanced backup functionality
  async createBackup(sessionKey, sessionData) {
    try {
      const backupKey = `${sessionKey}_backup`;
      
      const { error } = await this.supabase
        .from('whatsapp_sessions')
        .upsert({
          session_key: backupKey,
          session_data: sessionData,
          updated_at: new Date().toISOString()
        }, { onConflict: 'session_key' });

      if (error) {
        log('warn', `Failed to create backup: ${error.message}`);
      } else {
        log('info', `📦 Backup created for ${sessionKey}`);
      }
    } catch (err) {
      log('warn', `Exception creating backup: ${err.message}`);
    }
  }

  // Method to extract and backup local session to Supabase
  async extractLocalSession() {
    try {
      const sessionPath = path.join(__dirname, `.wwebjs_auth/session-${this.sessionId}`);
      
      if (!fs.existsSync(sessionPath)) {
        log('warn', 'No local session directory found');
        return false;
      }

      // Read session files and create backup
      const sessionFiles = this.readSessionFiles(sessionPath);
      if (sessionFiles && Object.keys(sessionFiles).length > 0) {
        await this.save({ sessionData: sessionFiles });
        log('info', '📦 Local session extracted and saved to Supabase');
        return true;
      }
      
      return false;
    } catch (err) {
      log('error', `Failed to extract local session: ${err.message}`);
      return false;
    }
  }

  readSessionFiles(dirPath) {
    try {
      const sessionData = {};
      const files = fs.readdirSync(dirPath, { withFileTypes: true });
      
      for (const file of files) {
        const filePath = path.join(dirPath, file.name);
        
        if (file.isDirectory()) {
          sessionData[file.name] = this.readSessionFiles(filePath);
        } else {
          try {
            sessionData[file.name] = fs.readFileSync(filePath, 'utf8');
          } catch (err) {
            // Skip files that can't be read
            log('warn', `Could not read file ${filePath}: ${err.message}`);
          }
        }
      }
      
      return sessionData;
    } catch (err) {
      log('error', `Error reading session files: ${err.message}`);
      return null;
    }
  }

  // Enhanced session validation
  async validateSession(sessionData) {
    if (!sessionData || typeof sessionData !== 'object') {
      log('warn', 'SupabaseStore.validateSession: Session data is null or not an object.');
      return false;
    }

    const requiredKeys = ['WABrowserId', 'WASecretBundle', 'WAToken1', 'WAToken2'];
    const hasRequiredKeys = Object.keys(sessionData).some(dataKey => 
        requiredKeys.some(reqKey => dataKey.includes(reqKey))
    );

    if (!hasRequiredKeys) {
      log('warn', 'SupabaseStore.validateSession: Session data appears to be missing some commonly expected WhatsApp keys. Proceeding with size check.');
    }

    const dataSize = JSON.stringify(sessionData).length;
    if (dataSize < 5000) {
      log('warn', `SupabaseStore.validateSession: Session data too small: ${dataSize} bytes. Validation failed.`);
      return false;
    }

    log('info', `SupabaseStore.validateSession: Session data passed validation (Size: ${dataSize} bytes${hasRequiredKeys ? ", essential keys found" : ", specific essential keys not all confirmed but size is sufficient"}).`);
    return true; 
  }
}

// Enhanced session save function
async function safelyTriggerSessionSave(client) {
  if (!client) return false;
  
  try {
    const sessionData = await extractSessionData(client);
    
    if (sessionData) {
      const sessionSize = JSON.stringify(sessionData).length;
      log('info', `📥 Got session data to save (${sessionSize} bytes) from extractSessionData`);
      
      const storeFromAuth = client.authStrategy?.store;
      if (storeFromAuth && typeof storeFromAuth.validateSession === 'function') {
        const isValid = await storeFromAuth.validateSession(sessionData);
        if (!isValid) {
          log('warn', 'Session data validation failed by SupabaseStore.validateSession in safelyTriggerSessionSave');
          return false; 
        }
      } else {
        log('warn', 'SupabaseStore or validateSession method not found via client.authStrategy.store, falling back to basic size check.');
        if (sessionSize < 5000) {
            log('warn', `Fallback size check: Session data too small (${sessionSize} bytes), might be invalid`);
            return false;
        }
      }
      
      if (storeFromAuth && typeof storeFromAuth.save === 'function') {
        if (storeFromAuth.client !== client) {
            log('info', 'Setting client reference in storeFromAuth for saving.');
            storeFromAuth.client = client;
        }
        await storeFromAuth.save({ session: SESSION_ID, sessionData: sessionData });
        log('info', '📥 Session save triggered directly on SupabaseStore (from authStrategy) with valid data');
      } else if (supabaseStore && typeof supabaseStore.save === 'function') {
        log('warn', 'client.authStrategy.store.save not found or invalid, attempting to use global supabaseStore.save()');
        if (supabaseStore.client !== client) {
            log('info', 'Setting client reference in global supabaseStore for saving.');
            supabaseStore.client = client;
        }
        await supabaseStore.save({ session: SESSION_ID, sessionData: sessionData });
        log('info', '📥 Session save triggered on global supabaseStore instance');
      } else {
        log('error', 'CRITICAL: No save method available on any SupabaseStore instance.');
        return false;
      }

      // Extra: Create a backup copy of session data directly to file system
      try {
        const sessionDir = path.join(__dirname, `.wwebjs_auth/session-${SESSION_ID}`);
        if (!fs.existsSync(sessionDir)) {
          fs.mkdirSync(sessionDir, { recursive: true });
        }
        const backupFile = path.join(sessionDir, 'session_backup.json');
        await fs.promises.writeFile(
          backupFile,
          JSON.stringify(sessionData, null, 2),
          { encoding: 'utf8' }
        );
        log('info', '📥 Created additional filesystem backup of session');
      } catch (backupErr) {
        log('warn', `Failed to create filesystem backup: ${backupErr.message}`);
      }
      return true;
    } else {
      log('warn', '❓ Could not find valid session data from extractSessionData for saving (returned null).');
      return false;
    }
  } catch (err) {
    log('error', `Failed to request session save: ${err.message} ${err.stack}`);
    return false;
  }
}

const supabaseStore = new SupabaseStore(supabase, SESSION_ID);
let client = null;

function createWhatsAppClient() {
  try {
    // Ensure auth folder exists
    const sessionPath = path.join(__dirname, `.wwebjs_auth/session-${SESSION_ID}`);
    const parentDir = path.dirname(sessionPath);
    if (!fs.existsSync(parentDir)) {
      fs.mkdirSync(parentDir, { recursive: true });
      log('info', `📁 Created session directory: ${parentDir}`);
    }
    
    // Add .gitkeep to ensure folder is tracked
    const gitkeepPath = path.join(parentDir, '.gitkeep');
    if (!fs.existsSync(gitkeepPath)) {
      fs.writeFileSync(gitkeepPath, '');
      log('info', 'Added .gitkeep to session directory');
    }

    return new Client({
      authStrategy: new RemoteAuth({
        clientId: SESSION_ID,
        store: supabaseStore,
        backupSyncIntervalMs: 300000, // 5 minutes
        dataPath: sessionPath,
      }),
      puppeteer: {
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--no-first-run',
          '--no-zygote',
          '--single-process',
          '--disable-gpu',
          '--js-flags=--max-old-space-size=256',
          '--disable-extensions',
        ],
        timeout: 120000,
      },
      qrTimeout: 90000,
      restartOnAuthFail: true,
    });
  } catch (err) {
    log('error', `Failed to create WhatsApp client: ${err.message}`);
    return null;
  }
}

function setupClientEvents(c) {
  // Set client reference in store, useful for some store operations
  if (c.authStrategy && c.authStrategy.store) {
    c.authStrategy.store.client = c;
  }

  c.on('qr', qr => {
    const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?data=${encodeURIComponent(qr)}`;
    log('warn', `📱 Scan QR Code: ${qrUrl}`);
  });

  c.on('ready', async () => {
    log('info', '✅ WhatsApp client is ready.');
    
    // Start presence simulation after ready
    setTimeout(() => {
      simulatePresence(c);
    }, getRandomDelay(5000, 15000)); // Random delay before starting presence simulation
    
    // Trigger session save after client is ready
    setTimeout(async () => {
      try {
        await safelyTriggerSessionSave(c);
      } catch (err) {
        log('warn', `Failed to save session after ready: ${err.message}`);
      }
    }, 5000);
  });

  c.on('authenticated', async () => {
    log('info', '🔐 Client authenticated.');
    
    // Trigger session save after authentication
    setTimeout(async () => {
      try {
        await safelyTriggerSessionSave(c);
      } catch (err) {
        log('warn', `Failed to save session after auth: ${err.message}`);
      }
    }, 2000);
  });

  c.on('remote_session_saved', () => {
    log('info', '💾 Session saved to Supabase via RemoteAuth.');
  });

  c.on('disconnected', async reason => {
    log('warn', `Client disconnected: ${reason}`);
    
    // Try to save session before destroying
    if (client) {
      try {
        await safelyTriggerSessionSave(client);
        await client.destroy();
      } catch (err) {
        log('error', `Error during disconnect cleanup: ${err.message}`);
      }
      client = null;
    }
    
    // Exponential backoff for reconnection
    const attemptReconnection = (attempt = 1) => {
      const delay = Math.min(Math.pow(2, attempt) * 1000, 60000);
      log('info', `Will attempt reconnection (#${attempt}) in ${delay/1000} seconds`);
      
      setTimeout(async () => {
        try {
          if (client) {
            log('warn', 'Existing client found during reconnection attempt, destroying it first.');
            await client.destroy();
            client = null;
          }
          await startClient();
          
          const state = client ? await client.getState() : 'NO_CLIENT';
          if (!client || state !== 'CONNECTED') {
            log('warn', `Reconnection attempt #${attempt} failed. State: ${state}`);
            if (attempt < 5) {
                attemptReconnection(attempt + 1);
            } else {
                log('error', 'Max reconnection attempts reached. Please check network or restart manually.');
            }
          } else {
            log('info', `✅ Reconnected successfully after ${attempt} attempts`);
          }
        } catch (err) {
          log('error', `Error during reconnection attempt #${attempt}: ${err.message}`);
          if (attempt < 5) {
            attemptReconnection(attempt + 1);
          } else {
            log('error', 'Max reconnection attempts reached after error. Please check network or restart manually.');
          }
        }
      }, delay);
    };
    
    if (reason !== 'NAVIGATION') {
        attemptReconnection();
    } else {
        log('info', 'Disconnected due to NAVIGATION, manual restart might be needed if it persists.');
    }
  });

  c.on('auth_failure', async () => {
    log('error', '❌ Auth failed. Clearing session.');
    try {
      if (c.authStrategy && c.authStrategy.store && typeof c.authStrategy.store.delete === 'function') {
        await c.authStrategy.store.delete({ session: SESSION_ID });
      } else if (supabaseStore && typeof supabaseStore.delete === 'function') {
        await supabaseStore.delete({ session: SESSION_ID });
      }
      log('info', 'Session deleted. Will attempt to reinitialize...');
      if (client === c) {
        client = null;
      }
      setTimeout(startClient, 10000);
    } catch (err) {
      log('error', `Failed to clean up after auth failure: ${err.message}`);
    }
  });

  c.on('message', handleIncomingMessage);
}

let messageCount = 0;

async function handleIncomingMessage(msg) {
  // Only process messages from group chats
  if (!msg.from.endsWith('@g.us')) {
    return;
  }

  const groupId = msg.from;
  const senderId = msg.author || msg.from;
  const text = msg.body || '';
  const messageId = msg?.id?.id || msg?.id?._serialized || '';

  let replyInfo = null;
  let hasReply = false;

  try {
    const quoted = await msg.getQuotedMessage?.();
    if (quoted?.id) {
      hasReply = true;
      replyInfo = {
        message_id: quoted?.id?.id || quoted?.id?._serialized || null,
        text: quoted?.body || null,
      };
    }
  } catch (err) {
    log('warn', `⚠️ Failed to get quoted message: ${err.message}`);
  }

  // Check for different trigger conditions
  const isValuationMessage = 
    text.toLowerCase().includes('valuation request') ||
    (hasReply && replyInfo?.text?.toLowerCase().includes('valuation request'));

  const isInterestRateMessage = 
    text.toLowerCase().includes('keyquest mortgage team')

  // Skip if message doesn't match any trigger conditions
  if (!isValuationMessage && !isInterestRateMessage) {
    return;
  }

  // Log what triggered the message processing
  if (isValuationMessage) {
    if (text.toLowerCase().includes('valuation request')) {
      log('info', '📊 Valuation message detected (direct mention)');
    } else if (hasReply && replyInfo?.text?.toLowerCase().includes('valuation request')) {
      log('info', '📊 Valuation message detected (reply to valuation request)');
    }
  }
  
  if (isInterestRateMessage) {
    log('info', '💰 Interest rate message detected (direct mention)');
  }

  // Memory logging every 50 messages
  messageCount++;
  if (messageCount % 50 === 0) {
    const mem = process.memoryUsage();
    const rssMB = (mem.rss / 1024 / 1024).toFixed(1);
    const heapMB = (mem.heapUsed / 1024 / 1024).toFixed(1);
    log('info', `🧠 Memory usage — RSS: ${rssMB} MB, Heap: ${heapMB} MB`);

    if (parseFloat(rssMB) > 300) {
      log('warn', '⚠️ RSS memory usage above 300MB. Consider restarting or increasing instance size.');
    }
  }

  const payload = {
    groupId,
    senderId,
    text,
    messageId,
    hasReply,
    replyInfo,
    messageType: isValuationMessage ? 'valuation' : (isInterestRateMessage ? 'interest_rate' : 'unknown'),
    timestamp: new Date(msg.timestamp * 1000).toISOString(),
    botVersion: BOT_VERSION,
  };

  // Send to appropriate webhook based on message type
  if (isValuationMessage && VALUATION_WEBHOOK_URL) {
    await sendToWebhook(VALUATION_WEBHOOK_URL, payload, 'valuation');
  }
  
  if (isInterestRateMessage && INTEREST_RATE_WEBHOOK_URL) {
    await sendToWebhook(INTEREST_RATE_WEBHOOK_URL, payload, 'interest_rate');
  }

  // Also send to main N8N webhook if configured
  if (N8N_WEBHOOK_URL) {
    await sendToWebhook(N8N_WEBHOOK_URL, payload, 'main');
  }
}

async function sendToWebhook(webhookUrl, payload, type = 'unknown', attempt = 0) {
  if (!webhookUrl) {
    return;
  }

  // Truncate long texts to prevent payload size issues
  const processedPayload = { ...payload };
  if (processedPayload.text?.length > 1000) {
    processedPayload.text = processedPayload.text.slice(0, 1000) + '... [truncated]';
  }
  if (processedPayload.replyInfo?.text?.length > 500) {
    processedPayload.replyInfo.text = processedPayload.replyInfo.text.slice(0, 500) + '... [truncated]';
  }

  // Estimate payload size
  const payloadSize = Buffer.byteLength(JSON.stringify(processedPayload), 'utf8');
  if (payloadSize > 90_000) {
    log('warn', `🚫 ${type} payload too large (${payloadSize} bytes). Skipping webhook.`);
    return;
  }

  try {
    await axios.post(webhookUrl, processedPayload, { timeout: 10000 });
    log('info', `✅ ${type} webhook sent (${payloadSize} bytes).`);
  } catch (err) {
    const status = err.response?.status;
    const isNetworkError = !status;
    log('error', `${type} webhook attempt ${attempt + 1} failed: ${status ? 'HTTP '+status : err.message}`);
    
    // Retry only for network errors or 5xx server errors
    if ((isNetworkError || (status >= 500 && status < 600)) && attempt < 4) {
      const backoff = Math.min(Math.pow(2, attempt +1) * 1000, 15000);
      log('warn', `Will retry ${type} webhook in ${backoff/1000} seconds...`);
      setTimeout(() => sendToWebhook(webhookUrl, processedPayload, type, attempt + 1), backoff);
    } else {
      log('error', `Giving up on ${type} webhook after ${attempt + 1} attempts`);
    }
  }
}

async function startClient() {
  if (client) {
    log('info', '⏳ Client already exists or is initializing, skipping re-init.');
    return;
  }

  log('info', '🚀 Starting WhatsApp client...');
  const newClient = createWhatsAppClient();
  
  if (!newClient) {
    log('error', '❌ Failed to create WhatsApp client instance. Will retry later.');
    setTimeout(startClient, 30000);
    return;
  }
  client = newClient;

  setupClientEvents(client);

  try {
    await client.initialize();
    log('info', '✅ WhatsApp client initialized.');
  } catch (err) {
    log('error', `❌ WhatsApp client failed to initialize: ${err.message}`);
    if (client) {
        await client.destroy().catch(destroyErr => log('error', `Error destroying client after init failure: ${destroyErr.message}`));
    }
    client = null;
    setTimeout(startClient, 30000);
  }
}

// Express App Setup
const app = express();
app.use(express.json({ limit: '10mb' }));

// Graceful shutdown handling
const gracefulShutdown = async (signal) => {
  log('warn', `Received ${signal}. Shutting down gracefully...`);
  
  if (server) {
    server.close(() => {
      log('info', 'HTTP server closed');
    });
  }
  
  if (client) {
    try {
      log('info', 'Saving session before shutdown...');
      await safelyTriggerSessionSave(client);
      log('info', 'Destroying WhatsApp client...');
      await client.destroy();
      log('info', 'WhatsApp client destroyed successfully');
    } catch (err) {
      log('error', `Error destroying client during shutdown: ${err.message}`);
    }
  }
  
  setTimeout(() => {
    log('info', 'Exiting process...');
    process.exit(0);
  }, 3000);
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('unhandledRejection', (reason, promise) => {
  log('error', 'Unhandled Rejection at:', promise, 'reason:', reason);
});

// Routes
app.get('/', (_, res) => {
  res.status(200).json({
    status: client && client.pupPage ? '✅ Bot running' : '⚠️ Bot not fully ready or offline',
    sessionId: SESSION_ID,
    version: BOT_VERSION,
    uptimeMinutes: Math.floor((Date.now() - startedAt) / 60000),
    timestamp: new Date().toISOString(),
    humanBehavior: {
      rateLimits: {
        messagesPerMinute: HUMAN_BEHAVIOR.MAX_MESSAGES_PER_MINUTE,
        messagesPerHour: HUMAN_BEHAVIOR.MAX_MESSAGES_PER_HOUR,
      },
      messageSplitting: HUMAN_BEHAVIOR.MAX_MESSAGE_LENGTH,
      typingSimulation: true,
    }
  });
});

// Enhanced send message endpoint with human-like behavior
app.post('/send-message', async (req, res) => {
  const { jid, groupId, message, imageUrl } = req.body;
  
  // Support both jid and groupId parameters
  const targetIdInput = jid || groupId;

  if (!targetIdInput || (!message && !imageUrl)) {
    return res.status(400).json({ 
      success: false, 
      error: 'Missing target ID (jid/groupId) or message content (message/imageUrl)' 
    });
  }

  if (!client || typeof client.getState !== 'function') {
    return res.status(503).json({ 
      success: false, 
      error: 'WhatsApp client not ready or invalid' 
    });
  }
  
  try {
    const state = await client.getState();
    if (state !== 'CONNECTED') {
        return res.status(503).json({ success: false, error: `WhatsApp client not connected. State: ${state}` });
    }
  } catch (stateErr) {
    return res.status(503).json({ success: false, error: `Error getting client state: ${stateErr.message}` });
  }

  try {
    let formattedId = targetIdInput.trim();
    
    // Basic validation and formatting for ID
    if (!formattedId.includes('@')) {
        if (/^\d+$/.test(formattedId)) {
            formattedId = `${formattedId}@c.us`;
        } else if (/^[a-zA-Z0-9-]+$/.test(formattedId)) {
            formattedId = `${formattedId}@g.us`;
        } else {
            if (!formattedId.endsWith('@g.us') && !formattedId.endsWith('@c.us')) {
                if (formattedId.includes('-')) {
                    formattedId = `${formattedId}@g.us`;
                } else {
                    formattedId = `${formattedId}@c.us`;
                }
            }
        }
    } else if (!formattedId.endsWith('@g.us') && !formattedId.endsWith('@c.us')) {
        return res.status(400).json({ success: false, error: 'Invalid JID format: must end with @c.us or @g.us if @ is present' });
    }

    let sentMessages;
    
    // Prepare message options for human-like sending
    const messageOptions = {};
    
    // Send media if imageUrl provided
    if (imageUrl) {
      try {
        log('info', `Attempting to send media from URL: ${imageUrl} to ${formattedId}`);
        const media = await MessageMedia.fromUrl(imageUrl, { unsafeMime: true });
        
        sentMessages = await sendHumanLikeMessage(client, formattedId, message || '', {
          media: media,
          messageOptions: messageOptions
        });
        
        log('info', `📸 Image message sent to ${formattedId} with human-like behavior`);
      } catch (mediaErr) {
        log('error', `Failed to send image to ${formattedId}: ${mediaErr.message}`);
        // Fallback to text message if image fails and message content exists
        if (message) {
          log('info', `Falling back to text message for ${formattedId}`);
          const fallbackMessage = `${message}\n\n[Media could not be sent: ${imageUrl}]`;
          sentMessages = await sendHumanLikeMessage(client, formattedId, fallbackMessage, { messageOptions });
          log('info', `📝 Fallback text message sent to ${formattedId} with human-like behavior`);
        } else {
          return res.status(500).json({ success: false, error: `Failed to send media and no fallback text: ${mediaErr.message}` });
        }
      }
    } else {
      // Send plain text message with human-like behavior
      sentMessages = await sendHumanLikeMessage(client, formattedId, message, { messageOptions });
      log('info', `📝 Text message sent to ${formattedId} with human-like behavior`);
    }

    // Return information about sent messages
    const messageIds = sentMessages.map(msg => msg.id?.id || msg.id?._serialized || msg.id);
    
    return res.status(200).json({ 
      success: true, 
      messageIds: messageIds,
      messageCount: sentMessages.length,
      target: formattedId,
      type: imageUrl ? 'media' : 'text',
      humanBehavior: {
        chunked: sentMessages.length > 1,
        typingSimulated: true,
        rateLimited: true
      }
    });

  } catch (err) {
    log('error', `Failed to send message: ${err.message}`);
    
    // Handle rate limiting errors specifically
    if (err.message.includes('Rate limit')) {
      return res.status(429).json({ 
        success: false, 
        error: err.message,
        retryAfter: Math.ceil(HUMAN_BEHAVIOR.MIN_DELAY_BETWEEN_MESSAGES / 1000)
      });
    }
    
    // Check for common errors like "Chat not found"
    if (err.message && err.message.includes("Chat not found")) {
        return res.status(404).json({ success: false, error: `Chat not found for ID: ${targetIdInput}`});
    }
    
    return res.status(500).json({ 
      success: false, 
      error: err.message 
    });
  }
});

// Enhanced session management endpoints
app.post('/extract-session', async (req, res) => {
  try {
    let success = false;
    let message = 'No valid session found or client not ready.';
    
    // Try to extract from live client first
    if (client && typeof client.getState === 'function') {
      const state = await client.getState().catch(() => null);
      if (state === 'CONNECTED') {
        const extractedData = await extractSessionData(client);
        if (extractedData) {
          const isValidForStore = supabaseStore.validateSession ? await supabaseStore.validateSession(extractedData) : true;
          if (isValidForStore) {
            await supabaseStore.save({ session: SESSION_ID, sessionData: extractedData });
            success = true;
            message = 'Live session data extracted and saved to Supabase';
            log('info', message);
          } else {
            message = 'Live session data extracted but failed SupabaseStore validation.';
            log('warn', message);
          }
        } else {
            message = 'Live session extraction yielded no valid data (failed size/item check).';
            log('warn', message);
        }
      } else {
        message = `Client not connected (state: ${state}). Cannot extract live session.`;
        log('warn', message);
      }
    }
    
    // Fallback to local files if live extraction failed or wasn't possible
    if (!success) {
      log('info', 'Attempting to extract session from local files as fallback.');
      const localExtractSuccess = await supabaseStore.extractLocalSession();
      if (localExtractSuccess) {
        success = true;
        message = 'Local session files extracted and saved to Supabase.';
        log('info', message);
      } else if (success) {
        // retain the success message
      } else {
        message = 'Failed to extract session from live client or local files.';
      }
    }
    
    res.status(200).json({ 
      success, 
      message
    });
  } catch (err) {
    log('error', `/extract-session endpoint error: ${err.message}`);
    res.status(500).json({ 
      success: false, 
      error: err.message 
    });
  }
});

app.delete('/clear-session', async (req, res) => {
  try {
    await supabaseStore.delete({ session: SESSION_ID });
    // Also try to delete any local session files managed by RemoteAuth
    const sessionPath = path.join(__dirname, `.wwebjs_auth/session-${SESSION_ID}`);
    if (fs.existsSync(sessionPath)) {
        fs.rmSync(sessionPath, { recursive: true, force: true });
        log('info', `Local session files at ${sessionPath} deleted.`);
    }
    res.status(200).json({ 
      success: true, 
      message: 'Session cleared from Supabase and local cache.' 
    });
  } catch (err) {
    res.status(500).json({ 
      success: false, 
      error: err.message 
    });
  }
});

// Manual session save endpoint
app.post('/save-session', async (req, res) => {
  try {
    if (!client || typeof client.getState !== 'function') {
      return res.status(503).json({
        success: false,
        error: 'WhatsApp client not ready or invalid'
      });
    }
    const state = await client.getState().catch(() => null);
    if (state !== 'CONNECTED') {
        return res.status(503).json({ success: false, error: `Client not connected (state: ${state}). Cannot save session.` });
    }

    const success = await safelyTriggerSessionSave(client);
    res.status(200).json({
      success,
      message: success ? 'Session save triggered successfully' : 'Failed to trigger session save'
    });
  } catch (err) {
    log('error', `/save-session endpoint error: ${err.message}`);
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

// Health check endpoint
app.get('/health', async (_, res) => {
  try {
    const clientState = client && typeof client.getState === 'function' ? await client.getState().catch(()=> 'ERROR_GETTING_STATE') : 'NO_CLIENT';
    
    let supabaseStatus = 'UNKNOWN';
    try {
      const { error } = await supabase.from('whatsapp_sessions').select('session_key').limit(1);
      supabaseStatus = error ? `ERROR (${error.message})` : 'CONNECTED';
    } catch (err) {
      supabaseStatus = `EXCEPTION (${err.message})`;
    }
    
    const mem = process.memoryUsage();
    
    // Calculate current rate limit status
    const now = Date.now();
    const oneMinuteAgo = now - 60000;
    const oneHourAgo = now - 3600000;
    
    rateLimiter.messageTimestamps = rateLimiter.messageTimestamps.filter(
      timestamp => timestamp > oneHourAgo
    );
    
    const messagesLastMinute = rateLimiter.messageTimestamps.filter(
      timestamp => timestamp > oneMinuteAgo
    ).length;
    
    const health = {
      status: clientState === 'CONNECTED' && supabaseStatus === 'CONNECTED' ? 'healthy' : 'degraded',
      version: BOT_VERSION,
      uptime: {
        seconds: Math.floor((Date.now() - startedAt) / 1000),
        readable: formatUptime(Date.now() - startedAt),
      },
      whatsapp: {
        state: clientState,
      },
      supabase: supabaseStatus,
      system: {
        memory: {
          rss: `${(mem.rss / 1024 / 1024).toFixed(1)} MB`,
          heapUsed: `${(mem.heapUsed / 1024 / 1024).toFixed(1)} MB`,
          heapTotal: `${(mem.heapTotal / 1024 / 1024).toFixed(1)} MB`,
        },
        nodejs: process.version,
      },
      webhooks: {
        n8n: !!N8N_WEBHOOK_URL,
        valuation: !!VALUATION_WEBHOOK_URL,
        interest_rate: !!INTEREST_RATE_WEBHOOK_URL,
      },
      humanBehavior: {
        rateLimits: {
          messagesPerMinute: `${messagesLastMinute}/${HUMAN_BEHAVIOR.MAX_MESSAGES_PER_MINUTE}`,
          messagesPerHour: `${rateLimiter.messageTimestamps.length}/${HUMAN_BEHAVIOR.MAX_MESSAGES_PER_HOUR}`,
        },
        features: {
          typingSimulation: true,
          messageChunking: true,
          presenceSimulation: true,
          randomDelays: true,
        }
      },
      timestamp: new Date().toISOString(),
    };
    
    res.status(200).json(health);
  } catch (err) {
    res.status(500).json({
      status: 'error',
      error: err.message,
      timestamp: new Date().toISOString(),
    });
  }
});

// Keep-alive endpoint for Render/Fly.io etc.
app.get('/ping', (_, res) => {
  res.status(200).send('pong');
});

// Rate limit info endpoint
app.get('/rate-limit-status', (_, res) => {
  const now = Date.now();
  const oneMinuteAgo = now - 60000;
  const oneHourAgo = now - 3600000;
  
  // Clean old timestamps
  rateLimiter.messageTimestamps = rateLimiter.messageTimestamps.filter(
    timestamp => timestamp > oneHourAgo
  );
  
  const messagesLastMinute = rateLimiter.messageTimestamps.filter(
    timestamp => timestamp > oneMinuteAgo
  ).length;
  
  const timeSinceLastMessage = now - rateLimiter.lastMessageTime;
  
  res.status(200).json({
    messagesLastMinute: messagesLastMinute,
    maxMessagesPerMinute: HUMAN_BEHAVIOR.MAX_MESSAGES_PER_MINUTE,
    messagesLastHour: rateLimiter.messageTimestamps.length,
    maxMessagesPerHour: HUMAN_BEHAVIOR.MAX_MESSAGES_PER_HOUR,
    timeSinceLastMessage: timeSinceLastMessage,
    minDelayBetweenMessages: HUMAN_BEHAVIOR.MIN_DELAY_BETWEEN_MESSAGES,
    canSendMessage: timeSinceLastMessage >= HUMAN_BEHAVIOR.MIN_DELAY_BETWEEN_MESSAGES &&
                   messagesLastMinute < HUMAN_BEHAVIOR.MAX_MESSAGES_PER_MINUTE &&
                   rateLimiter.messageTimestamps.length < HUMAN_BEHAVIOR.MAX_MESSAGES_PER_HOUR,
    timestamp: new Date().toISOString()
  });
});

// Start server
let server;

const main = async () => {
    await startClient();

    server = app.listen(PORT, () => {
      log('info', `🚀 Server started on http://localhost:${PORT}`);
      log('info', `🤖 Bot Version: ${BOT_VERSION} with Human-like Behavior`);
      log('info', `👤 Human Behavior Features:`);
      log('info', `   - Typing simulation: ${HUMAN_BEHAVIOR.TYPING_SPEED_MIN}-${HUMAN_BEHAVIOR.TYPING_SPEED_MAX} CPM`);
      log('info', `   - Rate limiting: ${HUMAN_BEHAVIOR.MAX_MESSAGES_PER_MINUTE}/min, ${HUMAN_BEHAVIOR.MAX_MESSAGES_PER_HOUR}/hour`);
      log('info', `   - Message chunking: ${HUMAN_BEHAVIOR.MAX_MESSAGE_LENGTH} chars max`);
      log('info', `   - Random delays: ${HUMAN_BEHAVIOR.MIN_DELAY_BETWEEN_MESSAGES}-${HUMAN_BEHAVIOR.MAX_DELAY_BETWEEN_MESSAGES}ms`);
    });
};

main();

// Enhanced Watchdog - Monitor client health and save session periodically
const watchdogInterval = 5 * 60 * 1000; // 5 minutes
setInterval(async () => {
  if (!client || typeof client.getState !== 'function') {
    log('warn', '🕵️ Watchdog: client is missing or invalid. Attempting to restart...');
    await startClient();
    return;
  }

  try {
    const state = await client.getState();
    log('info', `✅ Watchdog: client state is "${state}".`);

    if (state === 'CONNECTED') {
      // Periodically save session when connected
      try {
        await safelyTriggerSessionSave(client);
        log('info', '💾 Watchdog: Periodic session save completed');
      } catch (saveErr) {
        log('warn', `Watchdog: Periodic session save failed: ${saveErr.message}`);
      }
    } else if (state !== 'OPENING' && state !== 'PAIRING' && state !== 'UNPAIRED') {
      log('warn', `⚠️ Watchdog detected non-ideal state "${state}". Attempting to restart client...`);
      await client.destroy().catch(err => log('error', `Watchdog: Error destroying client: ${err.message}`));
      client = null;
      await startClient();
    }
  } catch (err) {
    log('error', `🚨 Watchdog error during state check: ${err.message}. Attempting to restart...`);
    if (client) {
        await client.destroy().catch(destroyErr => log('error', `Watchdog: Error destroying client after error: ${destroyErr.message}`));
    }
    client = null;
    await startClient();
  }
}, watchdogInterval); 

// Memory monitoring
const memoryCheckInterval = 5 * 60 * 1000; // 5 minutes
setInterval(() => {
  const mem = process.memoryUsage();
  const rssMB = (mem.rss / 1024 / 1024).toFixed(1);
  const heapMB = (mem.heapUsed / 1024 / 1024).toFixed(1);
  const heapTotalMB = (mem.heapTotal / 1024 / 1024).toFixed(1);
  
  log('info', `🧠 Memory: RSS=${rssMB}MB, HeapUsed=${heapMB}MB, HeapTotal=${heapTotalMB}MB`);
  
  const memoryThresholdMB = parseInt(process.env.MEMORY_RESTART_THRESHOLD_MB || '450');

  if (parseFloat(rssMB) > memoryThresholdMB) {
    log('error', `🚨 CRITICAL MEMORY USAGE (RSS ${rssMB}MB > ${memoryThresholdMB}MB)! Forcing restart of client...`);
    
    if (global.gc) {
      log('warn', 'Forcing garbage collection before client restart...');
      global.gc();
    }
    
    if (client) {
      (async () => {
        try {
          await safelyTriggerSessionSave(client);
          await client.destroy();
          client = null;
          log('warn', 'Client destroyed due to memory pressure. Restarting...');
          setTimeout(startClient, 5000);
        } catch (err) {
          log('error', `Failed to properly restart client after memory pressure: ${err.message}`);
          process.exit(1);
        }
      })();
    } else {
        log('warn', 'Client was null during memory pressure restart. Attempting to start.');
        setTimeout(startClient, 5000);
    }
  } else if (parseFloat(rssMB) > memoryThresholdMB * 0.8) {
    log('warn', `⚠️ High memory usage detected (RSS ${rssMB}MB).`);
    if (global.gc) {
      log('info', 'Suggesting garbage collection due to high memory...');
      global.gc();
    }
  }
}, memoryCheckInterval);

// Self-ping mechanism
const appUrl = process.env.APP_URL;
if (appUrl) {
    const selfPingInterval = 4 * 60 * 1000; // 4 minutes
    setInterval(async () => {
      try {
        await axios.get(`${appUrl}/ping`, { timeout: 10000 });
        log('debug', '🏓 Self-ping successful');
      } catch (err) {
        log('warn', `Self-ping to ${appUrl}/ping failed: ${err.message}`);
      }
    }, selfPingInterval);
}

// Helper function to format uptime
function formatUptime(ms) {
  if (isNaN(ms) || ms < 0) return 'Invalid duration';
  let seconds = Math.floor(ms / 1000);
  let minutes = Math.floor(seconds / 60);
  let hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  
  seconds %= 60;
  minutes %= 60;
  hours %= 24;
  
  return `${days}d ${hours}h ${minutes}m ${seconds}s`;
}
