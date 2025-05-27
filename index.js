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
const HUMAN_CONFIG = {
  // Random delays (in milliseconds)
  MIN_READ_DELAY: 2000,        // Minimum time before "reading" a message
  MAX_READ_DELAY: 15000,       // Maximum time before "reading" a message
  MIN_RESPONSE_DELAY: 1000,    // Minimum time before processing/responding
  MAX_RESPONSE_DELAY: 10000,   // Maximum time before processing/responding
  MIN_TYPING_DURATION: 1000,   // Minimum typing indicator duration
  MAX_TYPING_DURATION: 5000,   // Maximum typing indicator duration
  
  // Rate limiting
  MAX_MESSAGES_PER_HOUR: 80,   // Maximum messages to process per hour
  MAX_MESSAGES_PER_DAY: 480,   // Maximum messages to process per day
  COOLDOWN_BETWEEN_ACTIONS: 250, // Minimum time between any actions
  
  // Activity patterns (24-hour format)
  ACTIVE_HOURS_START: 7,       // Start being active at 7 AM
  ACTIVE_HOURS_END: 23,        // Stop being active at 11 PM
  SLEEP_MODE_DELAY_MULTIPLIER: 5, // Multiply delays during sleep hours
  
  // Session behavior
   SESSION_BREAK_INTERVAL: 365 * 24 * 60 * 60 * 1000, // 1 year
   SESSION_BREAK_DURATION: 1000, // 1 second
  
  // Message patterns
  IGNORE_PROBABILITY: 0,    // 5% chance to ignore a message (simulate human oversight)
  DOUBLE_CHECK_PROBABILITY: 0.1, // 10% chance to re-read a message
};

// --- Human Behavior Tracking ---
class HumanBehaviorManager {
  constructor() {
    this.messageCount = { hourly: 0, daily: 0 };
    this.lastAction = 0;
    this.lastHourReset = Date.now();
    this.lastDayReset = Date.now();
    this.isOnBreak = false;
    this.breakStartTime = 0;
    this.lastBreakTime = Date.now();
    this.processedMessages = new Set(); // Track processed message IDs
    this.messageQueue = []; // Queue for processing messages
    this.isProcessingQueue = false;
  }

  // Check if we're in active hours
  isActiveHours() {
    const now = new Date();
    const hour = now.getHours();
    return hour >= HUMAN_CONFIG.ACTIVE_HOURS_START && hour < HUMAN_CONFIG.ACTIVE_HOURS_END;
  }

  // Check if we should take a break
  shouldTakeBreak() {
    const timeSinceLastBreak = Date.now() - this.lastBreakTime;
    return timeSinceLastBreak > HUMAN_CONFIG.SESSION_BREAK_INTERVAL && this.isActiveHours();
  }

  // Start a session break
  async startBreak() {
    if (this.isOnBreak) return;
    
    this.isOnBreak = true;
    this.breakStartTime = Date.now();
    log('info', '😴 Starting human-like session break...');
    
    setTimeout(() => {
      this.endBreak();
    }, HUMAN_CONFIG.SESSION_BREAK_DURATION);
  }

  // End a session break
  endBreak() {
    this.isOnBreak = false;
    this.lastBreakTime = Date.now();
    log('info', '😊 Session break ended, resuming activity...');
  }

  // Check if we can process more messages (rate limiting)
  canProcessMessage() {
    this.resetCountersIfNeeded();
    
    if (this.isOnBreak) {
      log('info', '😴 Currently on break, skipping message processing');
      return false;
    }

    if (this.messageCount.hourly >= HUMAN_CONFIG.MAX_MESSAGES_PER_HOUR) {
      log('warn', '⏱️ Hourly message limit reached, skipping message');
      return false;
    }

    if (this.messageCount.daily >= HUMAN_CONFIG.MAX_MESSAGES_PER_DAY) {
      log('warn', '📅 Daily message limit reached, skipping message');
      return false;
    }

    // Check cooldown between actions
    const timeSinceLastAction = Date.now() - this.lastAction;
    if (timeSinceLastAction < HUMAN_CONFIG.COOLDOWN_BETWEEN_ACTIONS) {
      return false;
    }

    return true;
  }

  // Reset counters when needed
  resetCountersIfNeeded() {
    const now = Date.now();
    
    // Reset hourly counter
    if (now - this.lastHourReset > 60 * 60 * 1000) {
      this.messageCount.hourly = 0;
      this.lastHourReset = now;
      log('debug', '🔄 Hourly message counter reset');
    }

    // Reset daily counter
    if (now - this.lastDayReset > 24 * 60 * 60 * 1000) {
      this.messageCount.daily = 0;
      this.lastDayReset = now;
      log('debug', '🔄 Daily message counter reset');
    }
  }

  // Record message processing
  recordMessageProcessed(messageId) {
    this.messageCount.hourly++;
    this.messageCount.daily++;
    this.lastAction = Date.now();
    this.processedMessages.add(messageId);
    
    // Clean old processed messages (keep only last 1000)
    if (this.processedMessages.size > 1000) {
      const messagesToRemove = Array.from(this.processedMessages).slice(0, 100);
      messagesToRemove.forEach(id => this.processedMessages.delete(id));
    }
  }

  // Check if message was already processed
  wasMessageProcessed(messageId) {
    return this.processedMessages.has(messageId);
  }

  // Generate human-like delay
  getRandomDelay(min, max) {
    const baseDelay = Math.random() * (max - min) + min;
    
    // Apply sleep mode multiplier if outside active hours
    if (!this.isActiveHours()) {
      return baseDelay * HUMAN_CONFIG.SLEEP_MODE_DELAY_MULTIPLIER;
    }
    
    return baseDelay;
  }

  // Add message to processing queue
  addToQueue(messageData) {
    this.messageQueue.push({
      ...messageData,
      addedAt: Date.now(),
      processAt: Date.now() + this.getRandomDelay(HUMAN_CONFIG.MIN_READ_DELAY, HUMAN_CONFIG.MAX_READ_DELAY)
    });

    if (!this.isProcessingQueue) {
      this.processQueue();
    }
  }

  // Process message queue with human-like timing
  async processQueue() {
    if (this.isProcessingQueue) return;
    this.isProcessingQueue = true;

    while (this.messageQueue.length > 0) {
      const now = Date.now();
      const nextMessage = this.messageQueue.find(msg => msg.processAt <= now);

      if (!nextMessage) {
        // Wait for the next message to be ready
        const nextProcessTime = Math.min(...this.messageQueue.map(msg => msg.processAt));
        const waitTime = Math.min(nextProcessTime - now, 5000); // Wait max 5 seconds
        await this.sleep(waitTime);
        continue;
      }

      // Remove message from queue
      const messageIndex = this.messageQueue.indexOf(nextMessage);
      this.messageQueue.splice(messageIndex, 1);

      // Process the message
      try {
        await this.processMessageWithHumanBehavior(nextMessage);
      } catch (err) {
        log('error', `Error processing queued message: ${err.message}`);
      }

      // Random delay between processing messages
      const delay = this.getRandomDelay(1000, 5000);
      await this.sleep(delay);
    }

    this.isProcessingQueue = false;
  }

  // Process message with human-like behavior
  async processMessageWithHumanBehavior(messageData) {
    const { msg, payload } = messageData;

    // Check if we should take a break
    if (this.shouldTakeBreak()) {
      await this.startBreak();
      return;
    }

    // Random chance to ignore message (simulate human oversight)
    if (Math.random() < HUMAN_CONFIG.IGNORE_PROBABILITY) {
      log('info', '🤷 Randomly ignoring message (simulating human oversight)');
      return;
    }

    // Check rate limits
    if (!this.canProcessMessage()) {
      log('info', '⏱️ Rate limit reached, skipping message processing');
      return;
    }

    // Simulate reading the message
    await this.simulateReadingMessage(msg);

    // Random chance to double-check message
    if (Math.random() < HUMAN_CONFIG.DOUBLE_CHECK_PROBABILITY) {
      log('info', '🔍 Double-checking message (simulating human behavior)');
      await this.sleep(this.getRandomDelay(1000, 3000));
    }

    // Add response delay
    const responseDelay = this.getRandomDelay(
      HUMAN_CONFIG.MIN_RESPONSE_DELAY, 
      HUMAN_CONFIG.MAX_RESPONSE_DELAY
    );
    await this.sleep(responseDelay);

    // Process the message
    await this.sendWebhooks(payload);
    this.recordMessageProcessed(payload.messageId);
  }

  // Simulate reading a message (mark as read after delay)
  async simulateReadingMessage(msg) {
    try {
      // Random delay before marking as read
      const readDelay = this.getRandomDelay(HUMAN_CONFIG.MIN_READ_DELAY, HUMAN_CONFIG.MAX_READ_DELAY);
      await this.sleep(readDelay);
      
      // Mark message as read (if supported)
      if (msg && typeof msg.markAsRead === 'function') {
        await msg.markAsRead();
        log('debug', '👁️ Message marked as read');
      }
    } catch (err) {
      log('warn', `Failed to mark message as read: ${err.message}`);
    }
  }

  // Send webhooks with human-like timing
  async sendWebhooks(payload) {
    const webhooks = [];
    
    if (payload.messageType === 'valuation' && VALUATION_WEBHOOK_URL) {
      webhooks.push({ url: VALUATION_WEBHOOK_URL, type: 'valuation' });
    }
    
    if (payload.messageType === 'interest_rate' && INTEREST_RATE_WEBHOOK_URL) {
      webhooks.push({ url: INTEREST_RATE_WEBHOOK_URL, type: 'interest_rate' });
    }

    if (N8N_WEBHOOK_URL) {
      webhooks.push({ url: N8N_WEBHOOK_URL, type: 'main' });
    }

    // Send webhooks with delays between them
    for (let i = 0; i < webhooks.length; i++) {
      const webhook = webhooks[i];
      await sendToWebhook(webhook.url, payload, webhook.type);
      
      // Add delay between webhook calls (except for the last one)
      if (i < webhooks.length - 1) {
        const delay = this.getRandomDelay(500, 2000);
        await this.sleep(delay);
      }
    }
  }

  // Sleep utility
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // Get status for health endpoint
  getStatus() {
    return {
      isOnBreak: this.isOnBreak,
      messageCount: this.messageCount,
      queueLength: this.messageQueue.length,
      isProcessingQueue: this.isProcessingQueue,
      isActiveHours: this.isActiveHours(),
      lastAction: new Date(this.lastAction).toISOString(),
    };
  }
}

// Initialize human behavior manager
const humanBehavior = new HumanBehaviorManager();

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

// --- Enhanced Session Data Extraction ---
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
        
        // Add session metadata
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
    
    if (rawLocalStorage && Object.keys(rawLocalStorage).length > 5) {
      log('info', `🔍 Extracted raw localStorage with ${Object.keys(rawLocalStorage).length} items`);
      
      // Validate session size and content
      const sessionSize = JSON.stringify(rawLocalStorage).length;
      const hasWAData = Object.keys(rawLocalStorage).some(key => 
        key.includes('WABrowserId') || key.includes('WASecretBundle') || key.includes('WAToken')
      );
      
      if (sessionSize < 5000) {
        log('warn', `Session data too small (${sessionSize} bytes), might be invalid`);
        return null;
      }
      
      if (!hasWAData) {
        log('warn', 'Session data missing essential WhatsApp keys');
        return null;
      }
      
      log('info', `✅ Valid session data extracted (${sessionSize} bytes)`);
      return rawLocalStorage;
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
          log('warn', `Session data exists but missing essential WhatsApp keys for ${sessionKey}`);
          return null;
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
        log('warn', 'Session data missing essential WhatsApp keys, attempting to extract fresh data');
        
        if (this.client) {
          const freshData = await extractSessionData(this.client);
          if (freshData) {
            sessionData = freshData;
            log('info', 'Using fresh extracted session data');
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
      return false;
    }

    const requiredKeys = ['WABrowserId', 'WASecretBundle', 'WAToken1', 'WAToken2'];
    const hasRequiredKeys = requiredKeys.some(key => 
      Object.keys(sessionData).some(dataKey => dataKey.includes(key))
    );

    if (!hasRequiredKeys) {
      log('warn', 'Session data missing required WhatsApp keys');
      return false;
    }

    const dataSize = JSON.stringify(sessionData).length;
    if (dataSize < 5000) {
      log('warn', `Session data too small: ${dataSize} bytes`);
      return false;
    }

    return true;
  }
}

// Enhanced session save function
async function safelyTriggerSessionSave(client) {
  if (!client) return false;
  
  try {
    // Use direct localStorage extraction to get session data
    const sessionData = await extractSessionData(client);
    
    if (sessionData) {
      const sessionSize = JSON.stringify(sessionData).length;
      log('info', `📥 Got session data to save (${sessionSize} bytes)`);
      
      // Validate session data
      const supabaseStore = client.authStrategy?.store;
      if (supabaseStore && typeof supabaseStore.validateSession === 'function') {
        const isValid = await supabaseStore.validateSession(sessionData);
        if (!isValid) {
          log('warn', 'Session data validation failed');
          return false;
        }
      }
      
      // Save using auth strategy
      if (client.authStrategy && typeof client.authStrategy.save === 'function') {
        // Make sure client reference is set
        if (client.authStrategy.store) {
          client.authStrategy.store.client = client;
        }
        
        await client.authStrategy.save({ sessionData });
        log('info', '📥 Session save triggered with valid data');

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
        log('warn', 'No save method available on auth strategy');
        return false;
      }
    } else {
      log('warn', '❓ Could not find valid session data for saving');
      return false;
    }
  } catch (err) {
    log('error', `Failed to request session save: ${err.message}`);
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
        backupSyncIntervalMs: 300000,
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
  // Set client reference in store
  if (c.authStrategy && c.authStrategy.store) {
    c.authStrategy.store.client = c;
  }

  c.on('qr', qr => {
    const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?data=${encodeURIComponent(qr)}`;
    log('warn', `📱 Scan QR Code: ${qrUrl}`);
  });

  c.on('ready', async () => {
    log('info', '✅ WhatsApp client is ready.');
    
    // Trigger session save after client is ready with human-like delay
    const delay = humanBehavior.getRandomDelay(3000, 8000);
    setTimeout(async () => {
      try {
        await safelyTriggerSessionSave(c);
      } catch (err) {
        log('warn', `Failed to save session after ready: ${err.message}`);
      }
    }, delay);
  });

  c.on('authenticated', async () => {
    log('info', '🔐 Client authenticated.');
    
    // Trigger session save after authentication with human-like delay
    const delay = humanBehavior.getRandomDelay(1000, 3000);
    setTimeout(async () => {
      try {
        await safelyTriggerSessionSave(c);
      } catch (err) {
        log('warn', `Failed to save session after auth: ${err.message}`);
      }
    }, delay);
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
    
    // Exponential backoff for reconnection with human-like randomness
    const attemptReconnection = (attempt = 1) => {
      const baseDelay = Math.min(Math.pow(2, attempt) * 1000, 60000);
      const randomDelay = baseDelay + (Math.random() * 10000); // Add up to 10s randomness
      log('info', `Will attempt reconnection (#${attempt}) in ${randomDelay/1000} seconds`);
      
      setTimeout(async () => {
        try {
          await startClient();
          
          const state = await client?.getState();
          if (!client || state !== 'CONNECTED') {
            log('warn', `Reconnection attempt #${attempt} failed. State: ${state || 'No client'}`);
            attemptReconnection(attempt + 1);
          } else {
            log('info', `✅ Reconnected successfully after ${attempt} attempts`);
          }
        } catch (err) {
          log('error', `Error during reconnection attempt #${attempt}: ${err.message}`);
          attemptReconnection(attempt + 1);
        }
      }, randomDelay);
    };
    
    attemptReconnection();
  });

  c.on('auth_failure', async () => {
    log('error', '❌ Auth failed. Clearing session.');
    try {
      await supabaseStore.delete({ session: SESSION_ID });
      log('info', 'Session deleted. Will attempt to reinitialize...');
      client = null;
      
      // Add human-like delay before restart
      const delay = humanBehavior.getRandomDelay(8000, 15000);
      setTimeout(startClient, delay);
    } catch (err) {
      log('error', `Failed to clean up after auth failure: ${err.message}`);
      process.exit(1);
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

  // Skip if message was already processed
  if (humanBehavior.wasMessageProcessed(messageId)) {
    log('debug', '🔄 Message already processed, skipping');
    return;
  }

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
    log('info', '🚫 Ignored message - no trigger keywords found.');
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
    messageType: isValuationMessage ? 'valuation' : 'interest_rate',
    timestamp: new Date(msg.timestamp * 1000).toISOString(),
  };

  // Add message to human behavior queue instead of processing immediately
  humanBehavior.addToQueue({ msg, payload });
  log('info', '📝 Message added to processing queue with human-like timing');
}

async function sendToWebhook(webhookUrl, payload, type = 'unknown', attempt = 0) {
  if (!webhookUrl) {
    log('warn', `${type} webhook skipped: URL not set.`);
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
    // Add human-like delay before sending webhook
    const delay = humanBehavior.getRandomDelay(500, 2000);
    await humanBehavior.sleep(delay);

    await axios.post(webhookUrl, processedPayload, { timeout: 15000 }); // Increased timeout
    log('info', `✅ ${type} webhook sent (${payloadSize} bytes).`);
  } catch (err) {
    log('error', `${type} webhook attempt ${attempt + 1} failed: ${err.message}`);
    if (attempt < 2) { // Reduced retry attempts to 3 total
      const backoff = Math.min(Math.pow(2, attempt) * 1000, 10000) + (Math.random() * 2000);
      log('warn', `Will retry ${type} webhook in ${backoff/1000} seconds...`);
      setTimeout(() => sendToWebhook(webhookUrl, processedPayload, type, attempt + 1), backoff);
    } else {
      log('error', `Giving up on ${type} webhook after 3 attempts`);
    }
  }
}

async function startClient() {
  if (client) {
    log('info', '⏳ Client already exists, skipping re-init.');
    return;
  }

  log('info', '🚀 Starting WhatsApp client...');
  client = createWhatsAppClient();
  
  if (!client) {
    log('error', '❌ Failed to create WhatsApp client');
    return;
  }

  setupClientEvents(client);

  try {
    await client.initialize();
    log('info', '✅ WhatsApp client initialized.');
  } catch (err) {
    log('error', `❌ WhatsApp client failed to initialize: ${err.message}`);
    client = null;
  }
}

// Express App Setup
const app = express();
app.use(express.json({ limit: '10mb' }));

// Graceful shutdown handling
const gracefulShutdown = async (signal) => {
  log('warn', `Received ${signal}. Shutting down gracefully...`);
  
  server.close(() => {
    log('info', 'HTTP server closed');
  });
  
  if (client) {
    try {
      log('info', 'Saving session before shutdown...');
      await safelyTriggerSessionSave(client);
      log('info', 'Destroying WhatsApp client...');
      await client.destroy();
      log('info', 'WhatsApp client destroyed successfully');
    } catch (err) {
      log('error', `Error destroying client: ${err.message}`);
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
    status: '✅ Bot running',
    sessionId: SESSION_ID,
    version: BOT_VERSION,
    uptimeMinutes: Math.floor((Date.now() - startedAt) / 60000),
    humanBehavior: humanBehavior.getStatus(),
    timestamp: new Date().toISOString(),
  });
});

// Enhanced send message endpoint with human behavior
app.post('/send-message', async (req, res) => {
  const { jid, groupId, message, imageUrl } = req.body;
  
  // Support both jid and groupId parameters
  const targetId = jid || groupId;

  if (!targetId || (!message && !imageUrl)) {
    return res.status(400).json({ 
      success: false, 
      error: 'Missing target ID (jid/groupId) or message content (message/imageUrl)' 
    });
  }

  if (!client) {
    return res.status(503).json({ 
      success: false, 
      error: 'WhatsApp client not ready' 
    });
  }

  // Check rate limits for sending messages
  if (!humanBehavior.canProcessMessage()) {
    return res.status(429).json({
      success: false,
      error: 'Rate limit exceeded or bot is on break'
    });
  }

  try {
    let formattedId = targetId;
    
    // Format ID based on type (group or individual)
    if (targetId.includes('@g.us')) {
      // Already a group ID
      formattedId = targetId;
    } else if (targetId.includes('@c.us')) {
      // Already an individual ID
      formattedId = targetId;
    } else {
      // Need to determine if it's a group or individual
      // If it contains letters, assume it's a group ID that needs @g.us
      // If it's only numbers, assume it's an individual that needs @c.us
      if (/[a-zA-Z]/.test(targetId)) {
        formattedId = targetId.endsWith('@g.us') ? targetId : `${targetId}@g.us`;
      } else {
        formattedId = targetId.endsWith('@c.us') ? targetId : `${targetId}@c.us`;
      }
    }

    // Add human-like delay before sending
    const delay = humanBehavior.getRandomDelay(2000, 8000);
    await humanBehavior.sleep(delay);

    // Simulate typing (if supported)
    try {
      const chat = await client.getChatById(formattedId);
      if (chat && typeof chat.sendStateTyping === 'function') {
        await chat.sendStateTyping();
        log('info', '⌨️ Typing indicator sent');
        
        // Random typing duration
        const typingDuration = humanBehavior.getRandomDelay(
          HUMAN_CONFIG.MIN_TYPING_DURATION, 
          HUMAN_CONFIG.MAX_TYPING_DURATION
        );
        await humanBehavior.sleep(typingDuration);
      }
    } catch (typingErr) {
      log('warn', `Failed to send typing indicator: ${typingErr.message}`);
    }

    let sentMessage;

    // Send media if imageUrl provided
    if (imageUrl) {
      try {
        const media = await MessageMedia.fromUrl(imageUrl);
        sentMessage = await client.sendMessage(formattedId, media, {
          caption: message || '',
        });
        log('info', `📸 Image message sent to ${formattedId}`);
      } catch (mediaErr) {
        log('error', `Failed to send image: ${mediaErr.message}`);
        // Fallback to text message if image fails
        if (message) {
          sentMessage = await client.sendMessage(formattedId, message);
          log('info', `📝 Fallback text message sent to ${formattedId}`);
        } else {
          throw mediaErr;
        }
      }
    } else {
      // Send plain text message
      sentMessage = await client.sendMessage(formattedId, message);
      log('info', `📝 Text message sent to ${formattedId}`);
    }

    // Record the action
    humanBehavior.recordMessageProcessed(`sent_${Date.now()}`);

    // Return original WhatsApp message ID format
    const messageId = sentMessage.id?.id || sentMessage.id?._serialized || sentMessage.id;
    
    return res.status(200).json({ 
      success: true, 
      messageId: messageId,
      target: formattedId,
      type: imageUrl ? 'media' : 'text'
    });

  } catch (err) {
    log('error', `Failed to send message: ${err.message}`);
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
    
    // Try to extract from live client first
    if (client) {
      const extractedData = await extractSessionData(client);
      if (extractedData) {
        await supabaseStore.save({ sessionData: extractedData });
        success = true;
        log('info', 'Live session data extracted and saved');
      }
    }
    
    // Fallback to local files if live extraction failed
    if (!success) {
      success = await supabaseStore.extractLocalSession();
    }
    
    res.status(200).json({ 
      success, 
      message: success ? 'Session extracted and saved to Supabase' : 'No valid session found' 
    });
  } catch (err) {
    res.status(500).json({ 
      success: false, 
      error: err.message 
    });
  }
});

app.delete('/clear-session', async (req, res) => {
  try {
    await supabaseStore.delete({ session: SESSION_ID });
    res.status(200).json({ 
      success: true, 
      message: 'Session cleared from Supabase' 
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
    if (!client) {
      return res.status(503).json({
        success: false,
        error: 'WhatsApp client not ready'
      });
    }

    const success = await safelyTriggerSessionSave(client);
    res.status(200).json({
      success,
      message: success ? 'Session saved successfully' : 'Failed to save session'
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

// Human behavior control endpoints
app.post('/toggle-break', async (req, res) => {
  try {
    if (humanBehavior.isOnBreak) {
      humanBehavior.endBreak();
      res.status(200).json({ success: true, message: 'Break ended' });
    } else {
      await humanBehavior.startBreak();
      res.status(200).json({ success: true, message: 'Break started' });
    }
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/human-status', (req, res) => {
  res.status(200).json({
    success: true,
    status: humanBehavior.getStatus(),
    config: HUMAN_CONFIG
  });
});

// Health check endpoint
app.get('/health', async (_, res) => {
  try {
    const clientState = client ? await client.getState() : 'NO_CLIENT';
    
    let supabaseStatus = 'UNKNOWN';
    try {
      const { error } = await supabase.from('whatsapp_sessions').select('count(*)', { count: 'exact', head: true });
      supabaseStatus = error ? 'ERROR' : 'CONNECTED';
    } catch (err) {
      supabaseStatus = 'ERROR: ' + err.message;
    }
    
    const mem = process.memoryUsage();
    
    const health = {
      status: clientState === 'CONNECTED' && supabaseStatus === 'CONNECTED' ? 'healthy' : 'degraded',
      version: BOT_VERSION,
      uptime: {
        seconds: Math.floor((Date.now() - startedAt) / 1000),
        readable: formatUptime(Date.now() - startedAt),
      },
      whatsapp: {
        state: clientState,
        ready: client ? true : false,
      },
      supabase: supabaseStatus,
      humanBehavior: humanBehavior.getStatus(),
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

// Keep-alive endpoint
app.get('/ping', (_, res) => {
  res.status(200).send('pong');
});

// Start server
const server = app.listen(PORT, () => {
  log('info', `🚀 Server started on http://localhost:${PORT}`);
  log('info', `🤖 Bot Version: ${BOT_VERSION}`);
  log('info', `🧠 Human behavior enabled with smart timing and rate limiting`);
  log('info', '💻 Starting WhatsApp client in 5 seconds...');
  
  // Add random delay before starting client
  const startDelay = humanBehavior.getRandomDelay(3000, 8000);
  setTimeout(startClient, startDelay);
});

// Enhanced Watchdog with human behavior consideration
setInterval(async () => {
  if (!client) {
    log('warn', '🕵️ Watchdog: client is missing. Restarting...');
    const delay = humanBehavior.getRandomDelay(2000, 8000);
    setTimeout(startClient, delay);
    return;
  }

  try {
    const state = await client.getState();
    log('info', `✅ Watchdog: client state is "${state}".`);

    if (state === 'CONNECTED') {
      // Only save session periodically when not on break and during active hours
      if (!humanBehavior.isOnBreak && humanBehavior.isActiveHours()) {
        try {
          await safelyTriggerSessionSave(client);
          log('info', '💾 Periodic session save completed');
        } catch (saveErr) {
          log('warn', `Periodic session save failed: ${saveErr.message}`);
        }
      } else {
        log('debug', '💤 Skipping session save (break time or inactive hours)');
      }
    } else {
      log('warn', `⚠️ Watchdog detected bad state "${state}". Restarting client...`);
      await client.destroy();
      client = null;
      const delay = humanBehavior.getRandomDelay(5000, 15000);
      setTimeout(startClient, delay);
    }
  } catch (err) {
    log('error', `🚨 Watchdog error during state check: ${err.message}. Restarting...`);
    client = null;
    const delay = humanBehavior.getRandomDelay(5000, 15000);
    setTimeout(startClient, delay);
  }
}, 8 * 60 * 1000); // Increased interval to 8 minutes for more human-like behavior

// Memory monitoring with human-aware timing
const checkMemoryUsage = () => {
  const mem = process.memoryUsage();
  const rssMB = (mem.rss / 1024 / 1024).toFixed(1);
  const heapMB = (mem.heapUsed / 1024 / 1024).toFixed(1);
  const heapTotalMB = (mem.heapTotal / 1024 / 1024).toFixed(1);
  
  log('info', `🧠 Memory: RSS=${rssMB}MB, HeapUsed=${heapMB}MB, HeapTotal=${heapTotalMB}MB`);
  
  if (parseFloat(rssMB) > 450) {
    log('error', '🚨 CRITICAL MEMORY USAGE! Force restarting client...');
    
    if (global.gc) {
      log('warn', 'Forcing garbage collection...');
      global.gc();
    }
    
    if (client) {
      (async () => {
        try {
          await safelyTriggerSessionSave(client);
          await client.destroy();
          client = null;
          log('warn', 'Client destroyed due to memory pressure');
          
          // Add human-like delay before restart
          const delay = humanBehavior.getRandomDelay(5000, 15000);
          setTimeout(startClient, delay);
        } catch (err) {
          log('error', `Failed to restart client: ${err.message}`);
        }
      })();
    }
  } else if (parseFloat(rssMB) > 350) {
    log('warn', '⚠️ High memory usage detected');
    if (global.gc) {
      log('info', 'Suggesting garbage collection...');
      global.gc();
    }
  }
};

setInterval(checkMemoryUsage, 7 * 60 * 1000); // Slightly increased interval

// Self-ping mechanism with human behavior
let lastPingSent = 0;
const selfPing = async () => {
  try {
    const now = Date.now();
    if (now - lastPingSent > 6 * 60 * 1000) { // Increased ping interval
      lastPingSent = now;
      const appUrl = process.env.APP_URL || `http://localhost:${PORT}`;
      
      // Add random delay before ping
      const delay = humanBehavior.getRandomDelay(0, 2000);
      await humanBehavior.sleep(delay);
      
      await axios.get(`${appUrl}/ping`, { timeout: 5000 });
      log('debug', '🏓 Self-ping successful');
    }
  } catch (err) {
    log('warn', `Self-ping failed: ${err.message}`);
  }
};

app.use((req, res, next) => {
  if (req.path === '/ping') {
    lastPingSent = Date.now();
  }
  next();
});

setInterval(selfPing, 6 * 60 * 1000); // Increased to 6 minutes

// Helper function to format uptime
function formatUptime(ms) {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  
  return `${days}d ${hours % 24}h ${minutes % 60}m ${seconds % 60}s`;
}
