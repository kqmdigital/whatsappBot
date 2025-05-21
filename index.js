// At the top with other imports
const fs = require('fs');
const path = require('path');
const express = require('express');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');

// Supabase configuration
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const VALUATION_WEBHOOK_URL = process.env.VALUATION_WEBHOOK_URL;
const INTEREST_RATE_WEBHOOK_URL = process.env.INTEREST_RATE_WEBHOOK_URL;

// Add retry package for better network request handling
const { default: PQueue } = require('p-queue');

// --- Config ---
const PORT = process.env.PORT || 3000;
const SESSION_ID = process.env.WHATSAPP_SESSION_ID || 'default_session';
const BOT_VERSION = '2.0.1'; // Updated version
const startedAt = Date.now();

// Enhanced logging with levels
const log = (level, message, ...args) => {
  const timestamp = new Date().toISOString();
  const formatted = `[${timestamp}] [${level.toUpperCase()}] [${SESSION_ID}] ${message}`;
  
  console[level in console ? level : 'log'](formatted, ...args);
};

// Add debug level specifically for self-pings
log.debug = (message, ...args) => {
  const timestamp = new Date().toISOString();
  const formatted = `[${timestamp}] [DEBUG] [${SESSION_ID}] ${message}`;
  
  console.log(formatted, ...args);
};

// Helper function to download media with retries
async function downloadMedia(url, options = {}) {
  log('info', `🔽 Downloading media from ${url.substring(0, 50)}...`);
  
  const defaultOptions = {
    timeout: 30000,
    maxRetries: 3,
    retryDelay: 2000,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
      'Accept': 'image/*,*/*'
    }
  };
  
  const mergedOptions = { ...defaultOptions, ...options };
  let lastError = null;
  
  for (let i = 0; i < mergedOptions.maxRetries; i++) {
    try {
      const response = await axios.get(url, {
        responseType: 'arraybuffer',
        timeout: mergedOptions.timeout,
        headers: mergedOptions.headers
      });
      
      const buffer = Buffer.from(response.data);
      const mimeType = response.headers['content-type'] || 'application/octet-stream';
      
      log('info', `✅ Media downloaded successfully: ${buffer.length} bytes, type: ${mimeType}`);
      
      // Create MessageMedia object manually
      return new MessageMedia(
        mimeType,
        buffer.toString('base64'),
        url.split('/').pop() || 'file'
      );
    } catch (err) {
      lastError = err;
      log('warn', `⚠️ Media download attempt ${i+1}/${mergedOptions.maxRetries} failed: ${err.message}`);
      
      if (i < mergedOptions.maxRetries - 1) {
        // Wait before retry with exponential backoff
        const delay = mergedOptions.retryDelay * Math.pow(2, i);
        log('info', `⏱️ Waiting ${delay}ms before retry...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
  
  throw new Error(`Failed to download media after ${mergedOptions.maxRetries} attempts: ${lastError.message}`);
}

// Performance settings
const MEMORY_THRESHOLD_MB = parseInt(process.env.MEMORY_THRESHOLD_MB || '400'); // Reduced from 450MB to 400MB
const RECONNECT_DELAY = parseInt(process.env.RECONNECT_DELAY || '10000');
const WATCHDOG_INTERVAL = parseInt(process.env.WATCHDOG_INTERVAL || '180000'); // Reduced from 5 minutes to 3 minutes
const DEBUG_SESSION = process.env.DEBUG_SESSION === 'true' || false;
let MAX_MESSAGES_PER_HOUR = 90; // Default, can be increased for regular accounts

// Add session state machine
const SESSION_STATES = {
  INITIALIZING: 'initializing',
  WAITING_FOR_QR: 'waiting_for_qr',
  AUTHENTICATED: 'authenticated',
  CONNECTED: 'connected',
  DISCONNECTED: 'disconnected',
  FAILED: 'failed'
};

let sessionState = SESSION_STATES.INITIALIZING;
let isBusinessAccount = false;

function updateSessionState(newState, details = {}) {
  log('info', `Session state: ${sessionState} → ${newState}`);
  sessionState = newState;
  
  // Take actions based on state transitions
  if (newState === SESSION_STATES.AUTHENTICATED) {
    // Force immediate session save on authentication
    if (client && client.authStrategy) {
      setTimeout(() => safelyTriggerSessionSave(client), 2000);
    }
  }
  
  if (newState === SESSION_STATES.DISCONNECTED) {
    // Try to save session before disconnect
    if (client && client.authStrategy) {
      safelyTriggerSessionSave(client).catch(err => 
        log('error', `Failed to save session on disconnect: ${err.message}`)
      );
    }
  }
}

// Enhanced function to directly extract session data from WhatsApp Web
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
    
    // Improved localStorage extraction 
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
      
      // Validate session size
      const sessionSize = JSON.stringify(rawLocalStorage).length;
      if (sessionSize < 5000) {  // Increased minimum size threshold
        log('warn', `Session data too small (${sessionSize} bytes), might be invalid`);
        return null;
      } else {
        return rawLocalStorage;
      }
    } else {
      log('warn', 'localStorage extraction found too few items');
    }
    
    return null;
  } catch (err) {
    log('error', `Failed to extract session data: ${err.message}`);
    return null;
  }
}

async function safelyTriggerSessionSave(client) {
  if (!client || !client.pupPage) {
    log('warn', '⚠️ Cannot save session: Client or pupPage not available');
    return false;
  }
  
  try {
    // Use direct localStorage extraction to get session data
    const sessionData = await extractSessionData(client);
    
    if (sessionData) {
      const sessionSize = JSON.stringify(sessionData).length;
      log('info', `📥 Got session data to save (${sessionSize} bytes)`);
      
      if (sessionSize < 5000) {
        log('warn', `Session appears too small (${sessionSize} bytes), might be invalid`);
        return false;
      }
      
      // For enhanced LocalAuth, use the save method directly
      if (client.authStrategy && typeof client.authStrategy.save === 'function') {
        // Make sure client reference is set
        if (client.authStrategy.client === null) {
          client.authStrategy.client = client;
          log('info', '🔗 Set client reference in auth strategy during save');
        }
        
        await client.authStrategy.save(sessionData);
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
            JSON.stringify(sessionData),
            { encoding: 'utf8' }
          );
          log('info', '📥 Created additional filesystem backup of session');
        } catch (backupErr) {
          log('warn', `Failed to create filesystem backup: ${backupErr.message}`);
        }
        return true;
      } else if (client.authStrategy && typeof client.authStrategy.requestSave === 'function') {
        // For RemoteAuth fallback
        await client.authStrategy.requestSave();
        log('info', '📥 Session save requested');
        return true;
      } else {
        log('info', '📥 Session will be saved automatically (no manual save available)');
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

// Add validation for critical environment variables
if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error('❌ Missing Supabase credentials. Exiting.');
  process.exit(1);
}

// Validate at least one webhook URL is present
if (!VALUATION_WEBHOOK_URL && !INTEREST_RATE_WEBHOOK_URL) {
  console.error('❌ Missing both webhook URLs. At least one is required. Exiting.');
  process.exit(1);
}

// Setup Supabase client with error handling
let supabase;
try {
  supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  console.log('✅ Supabase client initialized');
} catch (error) {
  console.error('❌ Failed to initialize Supabase client:', error.message);
  process.exit(1);
}

// --- Enhanced LocalAuth with Supabase Integration ---
class EnhancedLocalAuth extends LocalAuth {
  constructor(options = {}) {
    super(options);
    this.supabase = options.supabase;
    this.sessionId = options.sessionId || 'default';
    this.retryCount = 0;
    this.maxRetries = 3;
    this.client = null; // Add client reference
    log('info', `EnhancedLocalAuth initialized for session ID: ${this.sessionId}`);
  }

  async _executeWithRetry(operation, fallback = null) {
    this.retryCount = 0;
    while (this.retryCount < this.maxRetries) {
      try {
        return await operation();
      } catch (err) {
        this.retryCount++;
        log('warn', `Supabase operation failed (attempt ${this.retryCount}/${this.maxRetries}): ${err.message}`);
        if (this.retryCount >= this.maxRetries) {
          log('error', `Max retries reached for Supabase operation: ${err.message}`);
          return fallback;
        }
        // Exponential backoff
        await new Promise(resolve => setTimeout(resolve, 1000 * Math.pow(2, this.retryCount)));
      }
    }
  }

  async afterInit(client) {
    log('info', '🔄 afterInit called - starting session restoration process');
    
    try {
      // Call parent afterInit but make sure it doesn't block our restoration
      super.afterInit(client).catch(err => {
        log('warn', `Parent afterInit error (continuing anyway): ${err.message}`);
      });
      
      // Keep a reference to the client for session extraction
      this.client = client;
      
      log('info', '🔍 Attempting to restore session from Supabase...');
      
      // Try to load session from Supabase first
      const { data, error } = await this.supabase
        .from('whatsapp_sessions')
        .select('session_data')
        .eq('session_key', this.sessionId)
        .single();
      
      if (error) {
        log('warn', `Failed to query session from Supabase: ${error.message}`);
        return;
      }
      
      if (data?.session_data) {
        // Check if session data is valid
        const sessionSize = JSON.stringify(data.session_data).length;
        if (sessionSize < 5000) {
          log('warn', `Session data too small (${sessionSize} bytes), might be invalid`);
          return;
        }
        
        log('info', `✅ Found valid session in Supabase (${sessionSize} bytes)`);
        
        // Save to local storage with retries
        let retries = 0;
        const maxRetries = 3;
        
        while (retries < maxRetries) {
          try {
            const sessionDir = path.join(this.dataPath, 'session-' + this.sessionId);
            if (!fs.existsSync(sessionDir)) {
              fs.mkdirSync(sessionDir, { recursive: true });
              log('info', `Created session directory: ${sessionDir}`);
            }
            
            // Make sure to clear any existing session file first
            const sessionFile = path.join(sessionDir, 'session.json');
            if (fs.existsSync(sessionFile)) {
              log('info', 'Removing existing session file before writing new one');
              fs.unlinkSync(sessionFile);
            }
            
            // Write the session data
            await fs.promises.writeFile(
              sessionFile,
              JSON.stringify(data.session_data),
              { encoding: 'utf8' }
            );
            
            log('info', '✅ Session restored from Supabase to local storage');
            
            // Add a forced delay to ensure proper session loading
            log('info', '⏳ Waiting 5 seconds for session to be properly applied...');
            await new Promise(resolve => setTimeout(resolve, 5000));
            
            // Verify the file was written correctly
            const savedContent = await fs.promises.readFile(
              sessionFile,
              { encoding: 'utf8' }
            );
            
            if (savedContent && savedContent.length > 5000) {
              log('info', '✓ Session file verification successful');
              break; // Success - exit retry loop
            } else {
              throw new Error('Session file verification failed');
            }
          } catch (writeErr) {
            retries++;
            log('warn', `Session restoration attempt ${retries}/${maxRetries} failed: ${writeErr.message}`);
            
            if (retries >= maxRetries) {
              log('error', `❌ Failed to restore session after ${maxRetries} attempts`);
            } else {
              // Wait before retry with exponential backoff
              const delay = 1000 * Math.pow(2, retries);
              log('info', `⏱️ Waiting ${delay}ms before retry...`);
              await new Promise(resolve => setTimeout(resolve, delay));
            }
          }
        }
        
        // Signal that we've successfully restored the session
        log('info', '🎉 Session restoration process completed successfully');
      } else {
        log('info', '❓ No session data found in Supabase');
      }
    } catch (err) {
      log('error', `❌ Error in afterInit: ${err.message}`);
      log('error', err.stack);
    }
  }
  
  async save(session) {
    // Check if session is valid and has sufficient data
    if (!session || JSON.stringify(session).length < 5000) {
      log('warn', '⚠️ Session data appears too small or invalid');
      
      // Skip trying all other methods and go straight to direct localStorage extraction
      if (this.client && this.client.pupPage) {
        try {
          log('info', 'Attempting direct localStorage extraction as last resort');
          
          // Check if page is still responsive
          const isPageAlive = await this.client.pupPage.evaluate(() => true).catch(() => false);
          if (!isPageAlive) {
            log('warn', '⚠️ Puppeteer page is no longer responsive, cannot extract data directly');
            return;
          }
          
          const rawLocalStorage = await this.client.pupPage.evaluate(() => {
            const data = {};
            for (let i = 0; i < localStorage.length; i++) {
              const key = localStorage.key(i);
              data[key] = localStorage.getItem(key);
            }
            return data;
          }).catch(err => {
            log('error', `Direct localStorage evaluation failed: ${err.message}`);
            return null;
          });
          
          if (rawLocalStorage && Object.keys(rawLocalStorage).length > 5) {
            session = rawLocalStorage;
            const newSize = JSON.stringify(session).length;
            log('info', `Found better session data via direct extraction (${newSize} bytes)`);
            
            // Only continue if the extracted data is valid
            if (newSize < 1000) {
              log('warn', `Extracted session still too small (${newSize} bytes), aborting save`);
              return;
            }
          } else {
            log('warn', 'Direct extraction found too few items, aborting save');
            return;
          }
        } catch (e) {
          log('error', `Last resort extraction failed: ${e.message}`);
          return;
        }
      } else {
        log('warn', 'No client or pupPage available for extraction, aborting save');
        return;
      }
    }
    
    // Save locally using the parent method if available
    try {
      if (typeof super.save === 'function') {
        await super.save(session);
      } else {
        log('warn', 'Parent save method not available, skipping local save');
        
        // Try manual save to local storage
        try {
          const sessionDir = path.join(this.dataPath, 'session-' + this.sessionId);
          if (!fs.existsSync(sessionDir)) {
            fs.mkdirSync(sessionDir, { recursive: true });
          }
          
          await fs.promises.writeFile(
            path.join(sessionDir, 'session.json'),
            JSON.stringify(session),
            { encoding: 'utf8' }
          );
          log('info', '✅ Session manually saved to local storage');
        } catch (writeErr) {
          log('error', `Failed to manually write session to local storage: ${writeErr.message}`);
        }
      }
    } catch (err) {
      log('error', `Failed to save session locally: ${err.message}`);
      // Continue anyway to try Supabase save
    }
    
    // Then save to Supabase
    try {
      const sessionSize = JSON.stringify(session).length;
      log('info', `Saving session to Supabase (${sessionSize} bytes)`);
      
      // One final check before saving to Supabase
      if (sessionSize < 5000) {
        log('warn', `Session is still too small (${sessionSize} bytes), skipping Supabase save`);
        return;
      }
      
      const { error } = await this.supabase
        .from('whatsapp_sessions')
        .upsert({
          session_key: this.sessionId,
          session_data: session,
          updated_at: new Date().toISOString()
        }, { onConflict: 'session_key' });
      
      if (error) throw new Error(error.message);
      log('info', '✅ Session saved to Supabase');
      
      // Also create a backup copy
      await this.supabase
        .from('whatsapp_sessions')
        .upsert({
          session_key: `${this.sessionId}_backup`,
          session_data: session,
          updated_at: new Date().toISOString()
        }, { onConflict: 'session_key' });
      
      log('info', '📥 Created session backup');
    } catch (err) {
      log('error', `⚠️ Failed to save session to Supabase: ${err.message}`);
    }
  }

  async delete() {
    // Delete from Supabase
    try {
      const { error } = await this.supabase
        .from('whatsapp_sessions')
        .delete()
        .eq('session_key', this.sessionId);
      
      if (error) {
        log('error', `Failed to delete session from Supabase: ${error.message}`);
      } else {
        log('info', '✅ Session deleted from Supabase');
      }
      
      // Also delete backup if it exists
      await this.supabase
        .from('whatsapp_sessions')
        .delete()
        .eq('session_key', `${this.sessionId}_backup`);
    } catch (err) {
      log('error', `Failed to delete session from Supabase: ${err.message}`);
    }
    
    // Delete local session
    return super.delete();
  }
}

let client = null;
let connectionRetryCount = 0;
let isClientInitializing = false;
let currentQRCode = null;
let lastActivityTime = Date.now();
let lastBrowserReset = Date.now(); // New variable to track browser resets

// Function to detect if using a business number
async function detectBusinessAccount(client) {
  if (!client) return false;
  
  try {
    // Check if business profile function exists
    if (typeof client.getBusinessProfile !== 'function') {
      log('info', `Account type detection not supported in this version, assuming regular account`);
      return false;
    }
    
    // Try to access business profile (only available on business accounts)
    const profile = await client.getBusinessProfile();
    const isBusinessAcct = Boolean(profile && (profile.description || profile.email || (profile.websites && profile.websites.length > 0)));
    log('info', `Account type: ${isBusinessAcct ? 'Business 💼' : 'Regular 👤'}`);
    return isBusinessAcct;
  } catch (err) {
    log('warn', `Failed to detect account type: ${err.message}`);
    return false;
  }
}

// Apply specific optimizations for business accounts
function applyBusinessOptimizations(client) {
  if (!client) return;
  
  log('info', '🔧 Applying business account optimizations...');
  
  // Shorter keepalive intervals for business accounts
  if (client.options && client.options.webVersionCache) {
    client.options.webVersionCache.checkInterval = 15000; // 15 seconds
  }
  
  // Different message sending behavior for business accounts
  // Business accounts need more conservative sending patterns
  MAX_MESSAGES_PER_HOUR = 70; // Lower limit for business accounts
  
  // Other business-specific optimizations here if needed
  log('info', '✅ Applied business account optimizations');
}

// Optimized WhatsApp client creation
function createWhatsAppClient() {
  const sessionPath = path.join(__dirname, `.wwebjs_auth/session-${SESSION_ID}`);
  const parentDir = path.dirname(sessionPath);
  
  // Ensure session directory exists
  try {
    if (!fs.existsSync(parentDir)) {
      fs.mkdirSync(parentDir, { recursive: true });
      log('info', `📁 Created session directory: ${parentDir}`);
    }
  } catch (err) {
    log('error', `Failed to create session directory: ${err.message}`);
    // Continue anyway as Supabase is the primary storage
  }

  return new Client({
    authStrategy: new EnhancedLocalAuth({
      supabase: supabase,
      sessionId: SESSION_ID,
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
        '--disable-gpu',
        '--disable-extensions',
        '--window-size=1280,720', // Larger viewport helps with business number UI
        '--disable-features=site-per-process',
        '--js-flags="--max-old-space-size=512"', // Increased from 300 to 512
        '--disable-web-security',
        '--disable-features=IsolateOrigins,site-per-process',
        '--disable-site-isolation-trials',
        // Removed --single-process flag as it can cause stability issues
        '--disable-breakpad', // Disable crash reporting
        '--disable-component-extensions-with-background-pages', // Reduce memory usage
      ],
      defaultViewport: null, // Allow responsive viewport
      timeout: 180000, // Increased from 120000 to 180000 (3 minutes)
      protocolTimeout: 90000, // Increased from 60000 to 90000 (1.5 minutes)
      handleSIGINT: false, // Don't let Puppeteer handle SIGINT, we'll do it ourselves
      handleSIGTERM: false, // Don't let Puppeteer handle SIGTERM, we'll do it ourselves
      handleSIGHUP: false, // Don't let Puppeteer handle SIGHUP, we'll do it ourselves
    },
    webVersionCache: {
      type: 'local', // Use local caching for better stability
      path: path.join(__dirname, '.wwebjs_cache'),
      lockTimeoutMs: 30000, // 30 second lock timeout
      maxTimeoutMs: 60000, // 60 second max timeout
    },
    qrMaxRetries: 3, // Limit QR code attempts
    restartOnAuthFail: true,
    takeoverOnConflict: true,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    multiDevice: true,
    sessionCacheEnabled: true, 
    clearSessionOnLogout: false, // Preserve session on logout
  });
}

// Handle Render sleep detection and preparation
async function handleRenderSleep() {
  log('info', '💤 Preparing for potential Render sleep...');
  
  // Try to save session before sleep
  if (client && client.authStrategy) {
    try {
      await safelyTriggerSessionSave(client);
      log('info', '📥 Session saved before potential sleep');
    } catch (err) {
      log('error', `Failed to save session before sleep: ${err.message}`);
    }
  }
}

// Function to clear existing invalid session
async function clearInvalidSession() {
  log('info', '🧹 Clearing invalid session...');
  try {
    if (client && client.authStrategy) {
      await client.authStrategy.delete();
      log('info', '🧹 Session cleared via auth strategy');
    } else {
      // Fallback to manual deletion
      const { error } = await supabase
        .from('whatsapp_sessions')
        .delete()
        .eq('session_key', SESSION_ID);
        
      if (error) {
        log('error', `Failed to delete session from Supabase: ${error.message}`);
      } else {
        log('info', '🧹 Session deleted from Supabase');
      }
      
      // Also delete backup if it exists
      await supabase
        .from('whatsapp_sessions')
        .delete()
        .eq('session_key', `${SESSION_ID}_backup`);
    }
    
    // Also clear local session files
    const sessionPath = path.join(__dirname, `.wwebjs_auth/session-${SESSION_ID}`);
    if (fs.existsSync(sessionPath)) {
      try {
        fs.rmSync(sessionPath, { recursive: true, force: true });
        log('info', '🧹 Local session files cleared');
      } catch (err) {
        log('error', `Failed to clear local session files: ${err.message}`);
      }
    }
    
    return true;
  } catch (err) {
    log('error', `Failed to clear invalid session: ${err.message}`);
    return false;
  }
}

// Function to check browser health
async function checkBrowserHealth(client) {
  if (!client || !client.pupPage || !client.pupBrowser) {
    return false;
  }
  
  // If client was just initialized, give it more time to load properly
  const timeSinceInit = Date.now() - lastActivityTime;
  if (timeSinceInit < 5 * 60 * 1000) { // 5 minute grace period after initialization
    try {
      // Only check if page is responsive during grace period, not if WhatsApp Web is loaded
      const isPageResponsive = await client.pupPage.evaluate(() => true).catch(() => false);
      if (isPageResponsive) {
        return true; // Consider healthy if page is responsive during grace period
      }
    } catch (err) {
      log('warn', `Basic page check failed during grace period: ${err.message}`);
      return false;
    }
  }
  
  try {
    // Check if page is responsive (most important check)
    const isPageResponsive = await client.pupPage.evaluate(() => true).catch(() => false);
    if (!isPageResponsive) {
      log('warn', '⚠️ Puppeteer page is not responsive');
      return false;
    }
    
    // Check if WhatsApp Web is properly loaded
    const isWAWebLoaded = await client.pupPage.evaluate(() => {
      return typeof window.Store !== 'undefined' && window.Store !== null;
    }).catch(() => false);
    
    if (!isWAWebLoaded) {
      log('warn', '⚠️ WhatsApp Web is not properly loaded');
      
      // Check if we're in QR code phase - this is still considered "healthy"
      if (currentQRCode !== null) {
        log('info', '🔍 QR code is active, considering browser healthy');
        return true; // QR code state is normal and healthy
      }
      
      return false;
    }
    
    return true;
  } catch (err) {
    log('error', `Browser health check failed: ${err.message}`);
    return false;
  }
}

// New function to periodically reset browser to prevent memory leaks and crashes
async function performPeriodicBrowserReset() {
  if (!client || isClientInitializing) {
    return false;
  }
  
  const BROWSER_RESET_INTERVAL = 8 * 60 * 60 * 1000; // 8 hours
  const now = Date.now();
  
  if (now - lastBrowserReset < BROWSER_RESET_INTERVAL) {
    return false; // Not time to reset yet
  }
  
  log('info', '🔄 Performing scheduled browser reset to prevent memory issues');
  
  // Make sure we save session before the reset
  if (client && client.authStrategy) {
    try {
      await safelyTriggerSessionSave(client);
      log('info', '📥 Session saved before browser reset');
    } catch (err) {
      log('error', `Failed to save session before browser reset: ${err.message}`);
    }
  }
  
  // Destroy the client and restart
  if (client) {
    try {
      await client.destroy();
      log('info', '🧹 Client destroyed for scheduled reset');
    } catch (err) {
      log('error', `Error destroying client during scheduled reset: ${err.message}`);
    } finally {
      client = null;
    }
  }
  
  // Reset the counter
  lastBrowserReset = now;
  
  // Start client after a short delay
  setTimeout(startClient, 5000);
  return true;
}

function setupClientEvents(c) {
  if (!c) return;
  
  c.on('qr', qr => {
    // Update session state
    updateSessionState(SESSION_STATES.WAITING_FOR_QR);
    
    // Log QR code URL for scanning (this is what you need)
    const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?data=${encodeURIComponent(qr)}&size=300x300`;
    log('warn', `📱 Scan QR Code: ${qrUrl}`);
    
    // Store QR code in memory for web endpoint access
    currentQRCode = qr;
    
    // Reset connection retry count when we get a QR code
    connectionRetryCount = 0;
    
    // Reset activity time to prevent watchdog from restarting during QR scan
    lastActivityTime = Date.now();
  });

  c.on('ready', async () => {
    log('info', '✅ WhatsApp client is ready.');
    updateSessionState(SESSION_STATES.CONNECTED);
    connectionRetryCount = 0; // Reset retry count on successful connection
    currentQRCode = null; // Clear QR code on ready
    
    // Force a session save one more time after fully ready
    setTimeout(async () => {
      try {
        await safelyTriggerSessionSave(c);
        log('info', '📥 Force-saved session after ready state');
      } catch (err) {
        log('error', `Failed to force-save session after ready: ${err.message}`);
      }
    }, 5000);
    
    // Check if this is a business account and apply optimizations
    try {
      isBusinessAccount = await detectBusinessAccount(c);
      if (isBusinessAccount) {
        applyBusinessOptimizations(c);
      }
    } catch (err) {
      log('warn', `Failed to detect account type: ${err.message}`);
    }
    
    // Reset activity time
    lastActivityTime = Date.now();
    
    // Force garbage collection if available
    if (global.gc) {
      log('info', '🧹 Running garbage collection');
      global.gc();
    }
  });

  c.on('authenticated', () => {
    log('info', '🔐 Client authenticated.');
    updateSessionState(SESSION_STATES.AUTHENTICATED);
    currentQRCode = null; // Clear QR code once authenticated
    
    // Reset activity time
    lastActivityTime = Date.now();
    
    // Try to save session immediately after authentication
    setTimeout(async () => {
      try {
        await safelyTriggerSessionSave(c);
        log('info', '📥 Forced session save after authentication');
      } catch (err) {
        log('error', `Failed to force session save: ${err.message}`);
      }
    }, 2000);
  });

  c.on('disconnected', async reason => {
    log('warn', `Client disconnected: ${reason}`);
    updateSessionState(SESSION_STATES.DISCONNECTED, { reason });
    currentQRCode = null;
    
    // Try to save session before disconnecting if possible
    if (c.authStrategy?.authState && reason !== 'NAVIGATION') {
      try {
        log('info', '📥 Attempting to save session before disconnection');
        await safelyTriggerSessionSave(c);
        log('info', '📥 Session saved before disconnection');
      } catch (err) {
        log('error', `📥 Failed to save session before disconnection: ${err.message}`);
      }
    }
    
    if (client) {
      try {
        await client.destroy();
      } catch (err) {
        log('error', `Error destroying client: ${err.message}`);
      } finally {
        client = null;
      }
    }
    
    connectionRetryCount++;
    const delay = Math.min(RECONNECT_DELAY * Math.pow(1.5, Math.min(connectionRetryCount - 1, 5)), 5 * 60 * 1000); // Exponential backoff, cap at 5 minutes
    log('info', `Will try to reconnect in ${delay/1000} seconds (attempt ${connectionRetryCount})`);
    
    setTimeout(startClient, delay);
  });

  c.on('auth_failure', async msg => {
    log('error', `❌ Auth failed: ${msg}. Clearing session.`);
    updateSessionState(SESSION_STATES.FAILED, { reason: msg });
    currentQRCode = null;
    
    // Clear the session data
    await clearInvalidSession();
    
    // Don't exit - instead try to restart the client after a delay
    if (client) {
      try {
        await client.destroy();
      } catch (err) {
        log('error', `Error destroying client on auth failure: ${err.message}`);
      } finally {
        client = null;
      }
    }
    
    log('info', '🔄 Restarting client after auth failure...');
    setTimeout(startClient, 30000); // Wait 30 seconds before trying again
  });

  c.on('message', handleIncomingMessage);
  
  // Additional event handlers for better monitoring
  c.on('loading_screen', (percent, message) => {
    // Only log significant loading changes to reduce log noise
    if (percent === 0 || percent === 100 || percent % 25 === 0) {
      log('info', `Loading: ${percent}% - ${message}`);
    }
    
    // Reset activity time on loading updates
    lastActivityTime = Date.now();
  });
  
  c.on('change_state', state => {
    log('info', `Connection state changed to: ${state}`);
    
    // Update activity time on state change
    lastActivityTime = Date.now();
    
    // Try to save session on state change
    if (state === 'CONNECTED' && c.authStrategy) {
      try {
        log('info', '📥 Attempting to save session on state change to CONNECTED');
        safelyTriggerSessionSave(c);
      } catch (err) {
        log('error', `Failed to save session on state change: ${err.message}`);
      }
    }
  });
  
  // Add error handler to catch unexpected puppeteer/browser errors
  if (c.pupBrowser) {
    c.pupBrowser.on('disconnected', () => {
      log('warn', '⚠️ Browser disconnected unexpectedly');
      if (sessionState === SESSION_STATES.CONNECTED) {
        log('info', 'Browser disconnect detected while connection was active, triggering reconnect');
        if (client === c) { // Only if this is still the current client
          setTimeout(() => {
            if (client === c) { // Double-check
              client = null;
              startClient();
            }
          }, 5000);
        }
      }
    });
  }
}

let messageCount = 0;
let lastMemoryCheck = 0;

// COMBINED message handler for both workflows
async function handleIncomingMessage(msg) {
  try {
    // Basic validation
    if (!msg || !msg.from) {
      log('warn', '⚠️ Received invalid message object');
      return;
    }
    
    // Only process group messages and direct messages
    if (!msg.from.endsWith('@g.us') && !msg.from.endsWith('@c.us')) {
      return;
    }

    const chatId = msg.from;
    const senderId = msg.author || msg.from;
    const text = msg.body || '';
    const messageId = msg.id._serialized || '';

    let replyInfo = null;
    let hasReply = false;

    // Get quoted message if this is a reply
    try {
      const quoted = await msg.getQuotedMessage?.();
      if (quoted?.id?._serialized) {
        hasReply = true;
        replyInfo = {
          message_id: quoted.id._serialized || null,
          text: quoted?.body || null,
        };
        log('info', `📝 Message ${messageId} is replying to message ${replyInfo.message_id}`);
      }
    } catch (err) {
      log('warn', `⚠️ Failed to get quoted message: ${err.message}`);
    }

    // Check for VALUATION keyword
    const isValuationRelated = 
      text.toLowerCase().includes('valuation') ||
      (hasReply && replyInfo?.text?.toLowerCase().includes('valuation'));

    // Check for INTEREST RATE keyword
    const isInterestRateRelated = 
      text.toLowerCase().includes('keyquest mortgage team');

    // Skip if no keywords match
    if (!isValuationRelated && !isInterestRateRelated) {
      log('info', '🚫 Ignored message (no relevant keywords).');
      return;
    }

    // Update activity time when processing messages
    lastActivityTime = Date.now();

    // Memory usage tracking
    messageCount++;
    const now = Date.now();
    
    // Only check memory every 50 messages or at least 5 minutes
    if (messageCount % 50 === 0 || (now - lastMemoryCheck > 5 * 60 * 1000)) {
      lastMemoryCheck = now;
      const mem = process.memoryUsage();
      const rssMB = (mem.rss / 1024 / 1024).toFixed(1);
      const heapUsedMB = (mem.heapUsed / 1024 / 1024).toFixed(1);
      const heapTotalMB = (mem.heapTotal / 1024 / 1024).toFixed(1);
      log('info', `🧠 Memory: RSS=${rssMB}MB, HeapUsed=${heapUsedMB}MB, HeapTotal=${heapTotalMB}MB`);

      // Warning threshold
      if (parseFloat(rssMB) > MEMORY_THRESHOLD_MB) {
        log('warn', `⚠️ RSS memory usage above ${MEMORY_THRESHOLD_MB}MB.`);
        
        // Force garbage collection if available
        if (global.gc) {
          log('info', '🧹 Running forced garbage collection');
          global.gc();
        }
      }
    }

    // Prepare payload for n8n webhook
    const payload = {
      groupId: chatId,
      senderId,
      text,
      messageId,
      hasReply,
      replyInfo,
      timestamp: new Date(msg.timestamp * 1000).toISOString(),
      botVersion: BOT_VERSION,
    };

    // Send to appropriate webhook based on detected keywords
    if (isValuationRelated && VALUATION_WEBHOOK_URL) {
      log('info', '💼 Detected valuation related message');
      await sendToN8nWebhook(VALUATION_WEBHOOK_URL, payload, 'VALUATION');
    } 
    
    if (isInterestRateRelated && INTEREST_RATE_WEBHOOK_URL) {
      log('info', '💰 Detected interest rate related message');
      await sendToN8nWebhook(INTEREST_RATE_WEBHOOK_URL, payload, 'INTEREST_RATE');
    }
  } catch (err) {
    log('error', `Error processing message: ${err.message}`);
  }
}

// Improved webhook sender with webhook type parameter and messageId tracking
async function sendToN8nWebhook(webhookUrl, payload, webhookType, attempt = 0) {
  if (!webhookUrl) {
    log('warn', `⚠️ ${webhookType} webhook URL not set. Webhook skipped.`);
    return;
  }

  // Truncate long texts to avoid large payloads
  if (payload.text?.length > 1000) {
    payload.text = payload.text.slice(0, 1000) + '... [truncated]';
  }
  if (payload.replyInfo?.text?.length > 500) {
    payload.replyInfo.text = payload.replyInfo.text.slice(0, 500) + '... [truncated]';
  }

  // Add webhook type to payload
  payload.webhookType = webhookType;
  
  // Ensure message IDs are clearly labeled
  if (payload.messageId) {
    // Save original message ID format
    payload.whatsapp_messageId = payload.messageId;
    
    // If this is a reply, create a clear relationship
    if (payload.hasReply && payload.replyInfo && payload.replyInfo.message_id) {
      payload.replying_to_messageId = payload.replyInfo.message_id;
      log('info', `📝 Linking message ${payload.messageId} to original message ${payload.replying_to_messageId}`);
    }
  }

  // Estimate payload size
  const payloadSize = Buffer.byteLength(JSON.stringify(payload), 'utf8');
  if (payloadSize > 90_000) {
    log('warn', `🚫 Payload too large (${payloadSize} bytes). Skipping ${webhookType} webhook.`);
    return;
  }

  try {
    // Use exponential backoff for retries
    const timeout = Math.min(10000 + attempt * 5000, 30000); // Increase timeout with each attempt, max 30s
    
    log('info', `📤 Sending ${webhookType} webhook (${payloadSize} bytes)...`);
    
    await axios.post(webhookUrl, payload, { 
      timeout,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': `WhatsAppBot/${BOT_VERSION}`,
        'X-Webhook-Type': webhookType
      },
      // Add validation to prevent accidental redirect following
      maxRedirects: 0,
    });
    
    log('info', `✅ ${webhookType} webhook sent successfully`);
  } catch (err) {
    const status = err.response?.status;
    const isNetworkError = !status; // axios network errors don't have status
    
    // Only retry network errors or 5xx server errors
    if ((isNetworkError || (status >= 500 && status < 600)) && attempt < 3) {
      const nextAttempt = attempt + 1;
      const delayMs = 1000 * Math.pow(2, nextAttempt); // Exponential backoff: 2s, 4s, 8s
      
      log('warn', `${webhookType} webhook attempt ${nextAttempt}/3 will retry in ${delayMs/1000}s: ${err.message}`);
      setTimeout(() => sendToN8nWebhook(webhookUrl, payload, webhookType, nextAttempt), delayMs);
    } else {
      // Don't retry client errors (4xx) or after max retries
      const errorContext = status ? `HTTP ${status}` : 'Network error';
      log('error', `${webhookType} webhook failed after ${attempt + 1} attempt(s): ${errorContext} - ${err.message}`);
    }
  }
}

// Function to check session status in Supabase
async function checkSessionStatus() {
  try {
    log('info', '🔍 Checking WhatsApp session status in Supabase...');
    
    const { data, error } = await supabase
      .from('whatsapp_sessions')
      .select('*')
      .eq('session_key', SESSION_ID)
      .limit(1)
      .single();
    
    if (error) {
      log('error', `❌ Failed to check session status: ${error.message}`);
      return false;
    }
    
    if (!data) {
      log('info', '❓ No session found in Supabase');
      
      // Check for backup session
      const { data: backupData, error: backupError } = await supabase
        .from('whatsapp_sessions')
        .select('*')
        .eq('session_key', `${SESSION_ID}_backup`)
        .limit(1)
        .single();
        
      if (!backupError && backupData) {
        log('info', '🔄 Found backup session, restoring...');
        
        // Restore from backup
        const { error: restoreError } = await supabase
          .from('whatsapp_sessions')
          .upsert({
            session_key: SESSION_ID,
            session_data: backupData.session_data,
            updated_at: new Date().toISOString()
          }, { onConflict: 'session_key' });
          
        if (restoreError) {
          log('error', `Failed to restore from backup: ${restoreError.message}`);
          return false;
        }
        
        log('info', '✅ Session restored from backup');
        return true;
      }
      
      return false;
    }
    
    const sessionDataSize = JSON.stringify(data.session_data).length;
    log('info', `✅ Found session in Supabase (${sessionDataSize} bytes)`);
    
    // Session data less than 1000 bytes is almost certainly invalid
    if (sessionDataSize < 5000) {
      log('warn', '⚠️ Session data appears to be too small, might be invalid');
      await clearInvalidSession();
      return false;
    }
    
    return true;
  } catch (err) {
    log('error', `❌ Error checking session status: ${err.message}`);
    return false;
  }
}

async function forceSessionRestoration() {
  try {
    log('info', '🔄 Performing forced session restoration attempt');
    
    // Get session data directly from Supabase
    const { data, error } = await supabase
      .from('whatsapp_sessions')
      .select('session_data')
      .eq('session_key', SESSION_ID)
      .single();
      
    if (error || !data || !data.session_data) {
      log('error', `Failed to retrieve session: ${error?.message || 'No data'}`);
      return false;
    }
    
    // Write it to a file directly
    const sessionDir = path.join(__dirname, `.wwebjs_auth/session-${SESSION_ID}`);
    if (!fs.existsSync(sessionDir)) {
      fs.mkdirSync(sessionDir, { recursive: true });
    }
    
    const sessionFile = path.join(sessionDir, 'session.json');
    await fs.promises.writeFile(
      sessionFile,
      JSON.stringify(data.session_data),
      { encoding: 'utf8' }
    );
    
    log('info', '✅ Force-wrote session data from Supabase');
    
    // Verify the file
    const stats = fs.statSync(sessionFile);
    log('info', `Session file size: ${stats.size} bytes`);
    
    return true;
  } catch (err) {
    log('error', `Force restoration failed: ${err.message}`);
    return false;
  }
}

// Improved client starter with mutex to prevent multiple initializations
async function startClient() {
  if (isClientInitializing) {
    log('info', '⏳ Client already initializing, skipping duplicate init.');
    return;
  }
  
  if (client) {
    log('info', '⏳ Client already exists, skipping re-init.');
    return;
  }

  isClientInitializing = true;
  currentQRCode = null;
  updateSessionState(SESSION_STATES.INITIALIZING);
  
  try {
    // Check if we have a valid session before starting
    const hasValidSession = await checkSessionStatus();
    if (!hasValidSession) {
      log('info', '🔄 No valid session found, starting fresh authentication');
    } else {
      log('info', '✅ Valid session found in Supabase, will restore');
      
      // IMPORTANT: Pre-create the session directory and file with the content from Supabase
      // This helps ensure the session is available before WhatsApp-web.js tries to use it
      try {
        const { data } = await supabase
          .from('whatsapp_sessions')
          .select('session_data')
          .eq('session_key', SESSION_ID)
          .single();
          
        if (data?.session_data) {
          const sessionDir = path.join(__dirname, `.wwebjs_auth/session-${SESSION_ID}`);
          if (!fs.existsSync(sessionDir)) {
            fs.mkdirSync(sessionDir, { recursive: true });
            log('info', `📁 Created session directory: ${sessionDir}`);
          }
          
          const sessionFile = path.join(sessionDir, 'session.json');
          await fs.promises.writeFile(
            sessionFile,
            JSON.stringify(data.session_data),
            { encoding: 'utf8' }
          );
          
          log('info', '🔑 Pre-loaded session data from Supabase before client initialization');
        }
      } catch (err) {
        log('warn', `⚠️ Failed to pre-load session: ${err.message}`);
      }
    }
    
    log('info', '🚀 Starting WhatsApp client...');
    client = createWhatsAppClient();
    
    // Ensure auth strategy has client reference with a short delay
    setTimeout(() => {
      if (client && client.authStrategy) {
        client.authStrategy.client = client;
        log('info', '🔗 Added client reference to auth strategy');
      }
    }, 1000);
    
    setupClientEvents(client);
    
    // Add a longer delay before initialization
    log('info', '⏱️ Waiting 5 seconds before initialization...');
    // Add a delay before initialization to ensure session files are properly set up
    await new Promise(resolve => setTimeout(resolve, 5000));
    log('info', '🚀 Starting client initialization');
    
    // Reset activity time
    lastActivityTime = Date.now();
    
    // Add timeout guard for initialization
    const initPromise = client.initialize();
    
    // Set timeout for initialization
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('Client initialization timed out after 3 minutes')), 180000);
    });
    
    // Race between initialization and timeout
    await Promise.race([initPromise, timeoutPromise]);
    
    log('info', '✅ WhatsApp client initialized.');
    
    // Reset activity time on successful initialization
    lastActivityTime = Date.now();
    
    // Try to force save session right after successful initialization
    if (client && client.authStrategy) {
      try {
        // Double-check client reference is set
        if (!client.authStrategy.client) {
          client.authStrategy.client = client;
          log('info', '🔗 Set client reference in auth strategy after init');
        }
        
        log('info', '📥 Forcing session save after initialization');
        await safelyTriggerSessionSave(client);
        log('info', '📥 Session saved successfully after initialization');
      } catch (err) {
        log('error', `📥 Failed to save session after initialization: ${err.message}`);
      }
    }
    
    // Reset browser reset timer on successful initialization
    lastBrowserReset = Date.now();
  } catch (err) {
    log('error', `❌ WhatsApp client failed to initialize: ${err.message}`);
    updateSessionState(SESSION_STATES.FAILED, { reason: err.message });
    
    if (client) {
      try {
        await client.destroy();
      } catch (destroyErr) {
        log('error', `Error destroying client after init failure: ${destroyErr.message}`);
      }
    }
    
    client = null;
    
    // Try again after a delay with exponential backoff
    connectionRetryCount++;
    const delay = Math.min(RECONNECT_DELAY * Math.pow(1.5, Math.min(connectionRetryCount - 1, 5)), 10 * 60 * 1000); // Cap at 10 minutes
    log('info', `Will try to initialize again in ${delay/1000} seconds (attempt ${connectionRetryCount})`);
    setTimeout(startClient, delay);
  } finally {
    isClientInitializing = false;
  }
}

// Message queue to prevent rate limiting and add human-like behavior
const messageQueue = [];
let isProcessingQueue = false;
let messagesSentLastHour = 0;
let lastHourReset = Date.now();
const QUEUE_CHECK_INTERVAL = 2000; // Check queue every 2 seconds

// Improved queue processor that uses our custom media handler
async function processMessageQueue() {
  if (isProcessingQueue || messageQueue.length === 0) return;
  
  // Check hourly message limit
  const now = Date.now();
  if (now - lastHourReset > 60 * 60 * 1000) {
    // Reset counter after an hour
    messagesSentLastHour = 0;
    lastHourReset = now;
  }
  
  // Stop if we've hit the hourly limit
  if (messagesSentLastHour >= MAX_MESSAGES_PER_HOUR) {
    log('warn', `⚠️ Hourly message limit reached (${messagesSentLastHour}/${MAX_MESSAGES_PER_HOUR}). Queue paused.`);
    return;
  }
  
  isProcessingQueue = true;
  
  try {
    const task = messageQueue.shift();
    const { jid, message, imageUrl, options = {}, callback } = task;
    
    // Add human-like random delay (500-2500ms)
    const delay = 500 + Math.floor(Math.random() * 2000);
    log('info', `🕒 Adding human-like delay of ${delay}ms before sending message`);
    await new Promise(resolve => setTimeout(resolve, delay));
    
    if (!client || !client.pupPage) {
      log('error', 'Client not ready when processing queue');
      messageQueue.unshift(task); // Put the task back at the front
      return callback({ success: false, error: 'WhatsApp client not ready' });
    }
    
    // Check if Puppeteer page is ready and has WhatsApp Web loaded properly
    try {
      // Validate WhatsApp Web is loaded properly by checking a basic element
      const isReady = await client.pupPage.evaluate(() => {
        return typeof window.Store !== 'undefined' && window.Store !== null;
      }).catch(() => false);
      
      if (!isReady) {
        log('warn', '⚠️ WhatsApp Web not fully loaded when trying to send message. Deferring task...');
        // Requeue the task for later
        messageQueue.unshift(task);
        isProcessingQueue = false;
        setTimeout(processMessageQueue, 10000); // Try again in 10 seconds
        return;
      }
    } catch (pageErr) {
      log('error', `Failed to check WhatsApp Web readiness: ${pageErr.message}`);
      // Continue anyway - we'll catch any errors below
    }
    
    let sentMessage;
    
    if (imageUrl) {
      try {
        log('info', `📤 Preparing to send media from URL: ${imageUrl.substring(0, 100)}...`);
        
        // Use our custom media downloader instead of MessageMedia.fromUrl
        try {
          const media = await downloadMedia(imageUrl, { 
            timeout: 30000,
            maxRetries: 3
          });
          
          log('info', '📤 Sending media message...');
          sentMessage = await client.sendMessage(jid, media, {
            caption: message || '',
            ...options
          });
          
          const rawMessageId = sentMessage.id._serialized;
          log('info', `📤 Media message sent successfully with ID: ${rawMessageId}`);
          
          callback({ 
            success: true, 
            messageId: rawMessageId,
            message_id: rawMessageId,
            timestamp: new Date().toISOString()
          });
        } catch (mediaErr) {
          log('error', `Media download/send failed: ${mediaErr.message}`);
          
          // Fallback to text-only if media sending fails
          log('info', '📤 Falling back to text-only message');
          sentMessage = await client.sendMessage(jid, `${message || ''}\n\n[Media could not be sent: ${imageUrl}]`);
          
          const rawMessageId = sentMessage.id._serialized;
          
          callback({ 
            success: true, 
            messageId: rawMessageId,
            message_id: rawMessageId, 
            timestamp: new Date().toISOString()
          });
        }
      } catch (err) {
        log('error', `Failed to process media: ${err.message}`);
        
        // Try to send a fallback text message
        try {
          log('info', '📤 Sending fallback text message without media');
          sentMessage = await client.sendMessage(jid, `${message || ''}\n\n[Media could not be processed: ${imageUrl}]`);
          
          const rawMessageId = sentMessage.id._serialized;
          
          callback({ 
            success: true, 
            messageId: rawMessageId,
            message_id: rawMessageId, 
            timestamp: new Date().toISOString()
          });
        } catch (textErr) {
          return callback({ 
            success: false, 
            error: `Failed to send even fallback message: ${textErr.message}`,
            messageId: null,
            message_id: null
          });
        }
      }
    } else {
      // Random typing delay for text messages to appear more human-like
      try {
        // Simulate "typing..." for a random duration based on message length
        const typingTime = Math.min(
          1000 + (message.length * 20), 
          7000 // Cap at 7 seconds for very long messages
        );
        log('info', `🖊️ Simulating typing for ${Math.round(typingTime/1000)}s`);
        
        // Try to simulate typing but don't fail if it doesn't work
        try {
          await client.sendMessage(jid, { isTyping: true });
          await new Promise(resolve => setTimeout(resolve, typingTime));
          await client.sendMessage(jid, { isTyping: false });
        } catch (typingErr) {
          log('warn', `Typing simulation error: ${typingErr.message}`);
          // Just add a simple delay instead
          await new Promise(resolve => setTimeout(resolve, Math.min(typingTime, 2000)));
        }
        
        // Send the actual message
        log('info', '📤 Sending text message...');
        sentMessage = await client.sendMessage(jid, message, options);
        
        const rawMessageId = sentMessage.id._serialized;
        log('info', `📤 Text message sent successfully with ID: ${rawMessageId}`);
        
        // Update activity time
        lastActivityTime = Date.now();
        messagesSentLastHour++;
        
        callback({ 
          success: true, 
          messageId: rawMessageId,
          message_id: rawMessageId, 
          timestamp: new Date().toISOString()
        });
        
        log('info', `✉️ Message sent from queue (${messagesSentLastHour}/${MAX_MESSAGES_PER_HOUR} this hour, ${messageQueue.length} remaining)`);
      } catch (err) {
        // Retry once with a simpler approach if the first attempt fails
        log('warn', `Message send failed: ${err.message}. Retrying without typing simulation...`);
        
        try {
          // Simple retry without typing simulation
          await new Promise(resolve => setTimeout(resolve, 1000));
          sentMessage = await client.sendMessage(jid, message, options);
          
          const rawMessageId = sentMessage.id._serialized;
          
          callback({ 
            success: true, 
            messageId: rawMessageId,
            message_id: rawMessageId, 
            timestamp: new Date().toISOString()
          });
        } catch (retryErr) {
          return callback({ 
            success: false, 
            error: `Failed to send message after retry: ${retryErr.message}`,
            messageId: null,
            message_id: null
          });
        }
      }
    }
  } catch (err) {
    log('error', `Error processing message from queue: ${err.message}`);
    if (messageQueue.length > 0) {
      const task = messageQueue[0];
      task.callback({ 
        success: false, 
        error: err.message,
        messageId: null,
        message_id: null
      });
      messageQueue.shift();
    }
  } finally {
    isProcessingQueue = false;
    
    // Process next item after a small delay
    if (messageQueue.length > 0) {
      setTimeout(processMessageQueue, 1000);
    }
  }
}

// We'll no longer normalize message IDs - we'll use the raw WhatsApp IDs

// Enhanced Express server with basic security
const app = express();

// Security middleware
app.use((req, res, next) => {
  // Add security headers
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  
  // Update activity timestamp to detect Render sleep
  lastActivityTime = Date.now();
  
  next();
});

// Basic rate limiting
const requestCounts = new Map();
const RATE_LIMIT_WINDOW = 60 * 1000; // 1 minute
const RATE_LIMIT_MAX = 60; // 60 requests per minute

app.use((req, res, next) => {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  
  // Clean up old entries
  if (requestCounts.size > 100) {
    for (const [key, { timestamp }] of requestCounts.entries()) {
      if (now - timestamp > RATE_LIMIT_WINDOW) {
        requestCounts.delete(key);
      }
    }
  }
  
  // Check rate limit
  if (!requestCounts.has(ip)) {
    requestCounts.set(ip, { count: 1, timestamp: now });
  } else {
    const record = requestCounts.get(ip);
    if (now - record.timestamp > RATE_LIMIT_WINDOW) {
      // Reset if window expired
      record.count = 1;
      record.timestamp = now;
    } else {
      record.count++;
      if (record.count > RATE_LIMIT_MAX) {
        return res.status(429).json({ 
          error: 'Too many requests',
          retry_after: Math.ceil((record.timestamp + RATE_LIMIT_WINDOW - now) / 1000)
        });
      }
    }
  }
  
  next();
});

app.use(express.json({ limit: '1mb' })); // Limit request body size

// Public health check endpoint
app.get('/', (_, res) => {
  const uptime = Date.now() - startedAt;
  res.status(200).json({
    status: client ? '✅ Bot running' : '⚠️ Bot initializing',
    sessionId: SESSION_ID,
    version: BOT_VERSION,
    accountType: isBusinessAccount ? 'Business' : 'Regular',
    sessionState: sessionState,
    monitoring: {
      valuation: Boolean(VALUATION_WEBHOOK_URL),
      interestRate: Boolean(INTEREST_RATE_WEBHOOK_URL)
    },
    queue: {
      length: messageQueue.length,
      sentThisHour: messagesSentLastHour,
      limit: MAX_MESSAGES_PER_HOUR
    },
    uptimeMinutes: Math.floor(uptime / 60000),
    uptimeHours: Math.floor(uptime / 3600000),
    uptimeDays: Math.floor(uptime / 86400000),
    timestamp: new Date().toISOString(),
    nodeVersion: process.version,
  });
});

// Render sleep detection endpoint
app.post('/prepare-sleep', async (req, res) => {
  res.status(202).json({
    success: true,
    message: 'Preparing for sleep'
  });
  
  await handleRenderSleep();
});

// QR code access endpoint - access via browser to scan
app.get('/qr', (req, res) => {
  if (!currentQRCode) {
    return res.status(404).send('No QR code available. The bot is either already authenticated or still initializing.');
  }

  // Generate QR code as HTML
  res.setHeader('Content-Type', 'text/html');
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>WhatsApp QR Code</title>
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <style>
        body { font-family: Arial, sans-serif; text-align: center; margin: 20px; }
        img { max-width: 100%; height: auto; }
        .container { max-width: 500px; margin: 0 auto; }
      </style>
    </head>
    <body>
      <div class="container">
        <h1>WhatsApp QR Code</h1>
        <p>Scan this QR code with WhatsApp to authenticate the bot:</p>
        <img src="https://api.qrserver.com/v1/create-qr-code/?data=${encodeURIComponent(currentQRCode)}&size=300x300" alt="WhatsApp QR Code">
        <p><small>This QR code will expire when a new one is generated.</small></p>
      </div>
    </body>
    </html>
  `);
});

// Delete session endpoint to manually clear an invalid session
app.post('/delete-session', async (req, res) => {
  try {
    await clearInvalidSession();
    
    res.status(200).json({
      success: true,
      message: 'Session deleted successfully'
    });
    
    // Restart client after session deletion
    if (client) {
      try {
        await client.destroy();
      } catch (err) {
        log('error', `Error destroying client after session deletion: ${err.message}`);
      } finally {
        client = null;
      }
    }
    
    setTimeout(startClient, 2000);
  } catch (err) {
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

// Session check endpoint
app.get('/session', async (req, res) => {
  try {
    const hasSession = await checkSessionStatus();
    
    return res.status(200).json({
      hasSession,
      sessionState: sessionState,
      clientState: client ? await client.getState() : 'not_initialized',
      isBusinessAccount: isBusinessAccount,
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    return res.status(500).json({
      error: err.message
    });
  }
});

// Message status tracking endpoint
app.get('/message/:messageId', async (req, res) => {
  try {
    const messageId = req.params.messageId;
    
    if (!messageId) {
      return res.status(400).json({
        success: false,
        error: 'Missing messageId parameter'
      });
    }
    
    if (!client) {
      return res.status(503).json({
        success: false,
        error: 'WhatsApp client not ready'
      });
    }
    
    try {
      // Check browser health before attempting to get message
      const isBrowserHealthy = await checkBrowserHealth(client);
      if (!isBrowserHealthy) {
        return res.status(503).json({
          success: false,
          error: 'Browser not healthy, cannot retrieve message status'
        });
      }
      
      // Try to get message status
      const message = await client.getMessageById(messageId);
      
      if (!message) {
        return res.status(404).json({
          success: false,
          error: 'Message not found'
        });
      }
      
      return res.status(200).json({
        success: true,
        messageId: messageId,
        status: message.ack || 0, // 0: pending, 1: received, 2: viewed, 3: played (for audio/video)
        timestamp: new Date(message.timestamp * 1000).toISOString(),
        from: message.from,
        to: message.to,
        hasMedia: Boolean(message.hasMedia),
        body: message.body,
        quotedMsgId: message._data?.quotedStanzaID || null
      });
      
    } catch (err) {
      return res.status(404).json({
        success: false,
        error: `Failed to get message status: ${err.message}`
      });
    }
  } catch (err) {
    return res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

// Start queue processor
setInterval(processMessageQueue, QUEUE_CHECK_INTERVAL);

// Enhanced message sending endpoint with queue and messageId tracking
app.post('/send-message', async (req, res) => {
  // Accept either jid or groupId parameter
  const jid = req.body.jid || req.body.groupId;
  const { message, imageUrl, options = {} } = req.body;

  if (!jid || (!message && !imageUrl)) {
    return res.status(400).json({ 
      success: false, 
      error: 'Missing jid/groupId or message/imageUrl',
      received: {
        jid: req.body.jid,
        groupId: req.body.groupId,
        hasMessage: Boolean(message),
        hasImageUrl: Boolean(imageUrl)
      }
    });
  }

  if (!client) {
    return res.status(503).json({ success: false, error: 'WhatsApp client not ready' });
  }
  
  // Check browser health before adding to queue
  const isBrowserHealthy = await checkBrowserHealth(client);
  if (!isBrowserHealthy) {
    log('warn', '⚠️ Browser health check failed before sending message, initiating restart');
    
    // Trigger client restart in the background
    setTimeout(async () => {
      if (client) {
        try {
          await client.destroy();
        } catch (err) {
          log('error', `Error destroying client after health check failure: ${err.message}`);
        } finally {
          client = null;
          startClient();
        }
      }
    }, 1000);
    
    return res.status(503).json({ 
      success: false, 
      error: 'WhatsApp browser needs to restart, please retry in 30 seconds'
    });
  }
  
  // Validate URL to prevent request forgery if imageUrl provided
  if (imageUrl) {
    try {
      new URL(imageUrl); // Will throw if invalid URL
      
      // Additional validation for image URL
      if (!imageUrl.startsWith('http://') && !imageUrl.startsWith('https://')) {
        return res.status(400).json({ success: false, error: 'Invalid imageUrl format - must begin with http:// or https://' });
      }
      
      // Pre-check if image URL is accessible
      try {
        const headResponse = await axios.head(imageUrl, { 
          timeout: 5000,
          validateStatus: status => status < 400 // Accept any status < 400
        });
        
        // Log content type for debugging
        const contentType = headResponse.headers['content-type'] || 'unknown';
        log('info', `🔍 Image URL content type: ${contentType}`);
        
        // If it doesn't appear to be an image/media, warn but continue
        if (!contentType.startsWith('image/') && 
            !contentType.startsWith('video/') && 
            !contentType.includes('application/')) {
          log('warn', `⚠️ URL may not be valid media (content-type: ${contentType})`);
        }
      } catch (headErr) {
        // Just log the error but don't block the request - we'll handle this during actual processing
        log('warn', `⚠️ Failed to pre-validate image URL: ${headErr.message}`);
      }
    } catch (err) {
      return res.status(400).json({ success: false, error: 'Invalid imageUrl format' });
    }
  }
  
  // Check if queue is getting too long
  if (messageQueue.length >= 50) {
    return res.status(429).json({ 
      success: false, 
      error: 'Message queue too long. Try again later.',
      queueLength: messageQueue.length
    });
  }

  // Wait for the message to be sent and get the real WhatsApp message ID
  try {
    // Create a promise that resolves when we get the real message ID
    const messageResult = await new Promise((resolve, reject) => {
      // Add message to queue
      messageQueue.push({
        jid,
        message,
        imageUrl,
        options,
        addedAt: Date.now(),
        callback: (result) => {
          // This will be called when the message is actually sent
          log('info', `Message completed with result: ${result.success ? 'success' : 'failure'}`);
          
          if (result.success) {
            resolve(result);
          } else {
            reject(new Error(result.error || 'Failed to send message'));
          }
        }
      });
      
      log('info', `📨 Adding message to queue for ${jid} (queue length: ${messageQueue.length})`);
      
      // Start processing if not already running
      if (!isProcessingQueue) {
        processMessageQueue();
      }
    });
    
    // When we get here, the message has been sent and we have the real ID
    return res.status(200).json({
      success: true,
      message: 'Message sent successfully',
      messageId: messageResult.messageId,
      timestamp: messageResult.timestamp
    });
  } catch (err) {
    // If anything goes wrong, return an error
    return res.status(500).json({
      success: false,
      error: err.message || 'Failed to send message'
    });
  }
});

// Get client status endpoint (enhanced)
app.get('/status', async (req, res) => {
  try {
    if (!client) {
      return res.status(503).json({ 
        status: 'offline',
        error: 'Client not initialized',
        sessionState: sessionState
      });
    }
    
    // Check browser health
    const isBrowserHealthy = await checkBrowserHealth(client);
    
    let state;
    try {
      state = await client.getState();
    } catch (stateErr) {
      log('warn', `Failed to get client state: ${stateErr.message}`);
      state = 'unknown';
    }
    
    const connectionState = client.pupPage ? 'connected' : 'disconnected';
    const mem = process.memoryUsage();
    
    // Check session status
    const sessionStatus = await checkSessionStatus();
    
    // Calculate time since last activity
    const inactiveTime = Math.floor((Date.now() - lastActivityTime) / 1000);
    
    return res.status(200).json({
      status: state,
      sessionState: sessionState,
      connectionState,
      browserHealth: isBrowserHealthy,
      connectionRetries: connectionRetryCount,
      uptime: Math.floor((Date.now() - startedAt) / 1000),
      inactiveSeconds: inactiveTime,
      isBusinessAccount: isBusinessAccount,
      timeSinceLastBrowserReset: Math.floor((Date.now() - lastBrowserReset) / 1000),
      webhooks: {
        valuation: Boolean(VALUATION_WEBHOOK_URL),
        interestRate: Boolean(INTEREST_RATE_WEBHOOK_URL)
      },
      messageQueue: {
        length: messageQueue.length,
        processing: isProcessingQueue,
        sentThisHour: messagesSentLastHour,
        hourlyLimit: MAX_MESSAGES_PER_HOUR
      },
      memory: {
        rss: Math.round(mem.rss / 1024 / 1024),
        heapTotal: Math.round(mem.heapTotal / 1024 / 1024),
        heapUsed: Math.round(mem.heapUsed / 1024 / 1024),
        external: Math.round(mem.external / 1024 / 1024),
        threshold: MEMORY_THRESHOLD_MB
      },
      messagesProcessed: messageCount,
      needsQrScan: Boolean(currentQRCode),
      hasSession: sessionStatus,
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    log('error', `Status check error: ${err.message}`);
    return res.status(500).json({ 
      status: 'error',
      error: err.message,
      sessionState: sessionState
    });
  }
});

// Force browser health check endpoint
app.post('/check-browser', async (req, res) => {
  if (!client) {
    return res.status(503).json({ 
      success: false, 
      error: 'Client not initialized' 
    });
  }
  
  try {
    const isHealthy = await checkBrowserHealth(client);
    
    if (!isHealthy) {
      log('warn', '⚠️ Manual browser health check failed, scheduling restart');
      
      res.status(200).json({
        success: true,
        healthy: false,
        action: 'restart_scheduled',
        message: 'Browser health check failed, restart scheduled'
      });
      
      // Schedule restart in background
      setTimeout(async () => {
        if (client) {
          try {
            await client.destroy();
          } catch (err) {
            log('error', `Error destroying client after manual health check: ${err.message}`);
          } finally {
            client = null;
            startClient();
          }
        }
      }, 1000);
    } else {
      res.status(200).json({
        success: true,
        healthy: true,
        message: 'Browser health check passed'
      });
    }
  } catch (err) {
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

// Force session save endpoint with verification
app.post('/save-session', async (req, res) => {
  if (!client || !client.authStrategy) {
    return res.status(503).json({ 
      success: false, 
      error: 'WhatsApp client not ready or not authenticated' 
    });
  }
  
  try {
    log('info', '📥 Manual session save requested');
    const result = await safelyTriggerSessionSave(client);
    
    if (result) {
      log('info', '📥 Manual session save completed successfully');
      
      // Verify the session was saved to Supabase
      const { data, error } = await supabase
        .from('whatsapp_sessions')
        .select('updated_at')
        .eq('session_key', SESSION_ID)
        .single();
      
      if (error || !data) {
        log('warn', '⚠️ Session verification failed: Session not found in Supabase');
        return res.status(500).json({
          success: false,
          error: 'Session save verification failed'
        });
      }
      
      return res.status(200).json({ 
        success: true, 
        message: 'Session saved and verified successfully',
        updated_at: data.updated_at
      });
    } else {
      log('warn', '⚠️ Session save operation did not complete successfully');
      return res.status(500).json({
        success: false,
        error: 'Session save operation did not complete successfully'
      });
    }
  } catch (err) {
    log('error', `Failed to manually save session: ${err.message}`);
    return res.status(500).json({ 
      success: false, 
      error: err.message 
    });
  }
});

// Force browser reset endpoint
app.post('/reset-browser', async (req, res) => {
  log('info', '🔄 Manual browser reset requested');
  
  res.status(202).json({ 
    success: true, 
    message: 'Browser reset initiated' 
  });
  
  // Force next watchdog check to restart the browser
  await performPeriodicBrowserReset();
});

// Force restart endpoint
app.post('/restart', async (req, res) => {
  log('info', '🔄 Manual restart requested');
  
  res.status(202).json({ 
    success: true, 
    message: 'Restart initiated' 
  });
  
  // Try to save session before restarting
  if (client && client.authStrategy) {
    try {
      log('info', '📥 Saving session before manual restart');
      await safelyTriggerSessionSave(client);
      log('info', '📥 Session saved before manual restart');
    } catch (err) {
      log('error', `Failed to save session before manual restart: ${err.message}`);
    }
  }
  
  // Clear message queue
  const queueLength = messageQueue.length;
  if (queueLength > 0) {
    log('info', `Clearing message queue (${queueLength} items)`);
    messageQueue.length = 0;
    isProcessingQueue = false;
  }
  
  // Destroy and restart client
  if (client) {
    try {
      await client.destroy();
    } catch (err) {
      log('error', `Error during manual client destroy: ${err.message}`);
    } finally {
      client = null;
      // Reset counters on manual restart
      connectionRetryCount = 0; 
      messagesSentLastHour = 0;
    }
  }
  
  // Start client after a short delay
  setTimeout(startClient, 2000);
});

// Queue management endpoints
app.get('/queue', (req, res) => {
  res.status(200).json({
    queue_length: messageQueue.length,
    is_processing: isProcessingQueue,
    sent_this_hour: messagesSentLastHour,
    hourly_limit: MAX_MESSAGES_PER_HOUR,
    time_until_reset: lastHourReset + (60 * 60 * 1000) - Date.now(),
    queue_preview: messageQueue.slice(0, 5).map(item => ({
      jid: item.jid,
      added_at: new Date(item.addedAt).toISOString(),
      message_preview: item.message ? 
        (item.message.length > 30 ? item.message.substring(0, 30) + '...' : item.message) : 
        (item.imageUrl ? '[IMAGE]' : '[UNKNOWN]')
    }))
  });
});

// Clear queue endpoint
app.post('/queue/clear', (req, res) => {
  const queueLength = messageQueue.length;
  messageQueue.length = 0;
  isProcessingQueue = false;
  
  res.status(200).json({
    success: true,
    message: `Queue cleared (${queueLength} items removed)`
  });
});

// Webhook configuration endpoint
app.get('/webhooks', (req, res) => {
  res.status(200).json({
    valuation: {
      configured: Boolean(VALUATION_WEBHOOK_URL),
      url: VALUATION_WEBHOOK_URL ? '[configured]' : null,
    },
    interestRate: {
      configured: Boolean(INTEREST_RATE_WEBHOOK_URL),
      url: INTEREST_RATE_WEBHOOK_URL ? '[configured]' : null,
    }
  });
});

// Health check endpoint
app.get('/health', async (req, res) => {
  try {
    // Check WhatsApp client
    const clientState = client ? await client.getState() : 'NO_CLIENT';
    
    // Check browser health
    const isBrowserHealthy = client ? await checkBrowserHealth(client) : false;
    
    // Check Supabase connection
    let supabaseStatus = 'UNKNOWN';
    try {
      const { data, error } = await supabase.from('whatsapp_sessions').select('count(*)', { count: 'exact', head: true });
      supabaseStatus = error ? 'ERROR' : 'CONNECTED';
    } catch (err) {
      supabaseStatus = 'ERROR: ' + err.message;
    }
    
    // Get memory metrics
    const mem = process.memoryUsage();
    
    // Build health response
    const health = {
      status: clientState === 'CONNECTED' && supabaseStatus === 'CONNECTED' && isBrowserHealthy ? 'healthy' : 'degraded',
      version: BOT_VERSION,
      uptime: {
        seconds: Math.floor((Date.now() - startedAt) / 1000),
        readable: formatUptime(Date.now() - startedAt),
      },
      whatsapp: {
        state: clientState,
        ready: client ? true : false,
        browserHealth: isBrowserHealthy,
        timeSinceLastReset: formatUptime(Date.now() - lastBrowserReset),
      },
      webhooks: {
        valuation: Boolean(VALUATION_WEBHOOK_URL),
        interestRate: Boolean(INTEREST_RATE_WEBHOOK_URL),
      },
      supabase: supabaseStatus,
      system: {
        memory: {
          rss: `${(mem.rss / 1024 / 1024).toFixed(1)} MB`,
          heapUsed: `${(mem.heapUsed / 1024 / 1024).toFixed(1)} MB`,
          heapTotal: `${(mem.heapTotal / 1024 / 1024).toFixed(1)} MB`,
          threshold: `${MEMORY_THRESHOLD_MB} MB`,
        },
        nodejs: process.version,
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

// Helper function to format uptime
function formatUptime(ms) {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  
  return `${days}d ${hours % 24}h ${minutes % 60}m ${seconds % 60}s`;
}

// Keep-alive endpoint
app.get('/ping', (_, res) => {
  res.status(200).send('pong');
});

// Start server and initialize client
const server = app.listen(PORT, () => {
  log('info', `🚀 Server started on http://localhost:${PORT}`);
  log('info', `🤖 Bot Version: ${BOT_VERSION}`);
  log('info', `💼 Valuation webhook: ${VALUATION_WEBHOOK_URL ? 'Configured' : 'Not configured'}`);
  log('info', `💰 Interest rate webhook: ${INTEREST_RATE_WEBHOOK_URL ? 'Configured' : 'Not configured'}`);
  
  // Force restoration attempt before checking status
  forceSessionRestoration().then(() => {
    // Check if session is valid first, and delete if not
    checkSessionStatus().then(hasValidSession => {
      if (!hasValidSession) {
        log('warn', '⚠️ Invalid or missing session detected. Will ask for QR code on startup.');
      }
      
      // Start WhatsApp client
      startClient();
    });
  });
});

// Set up watchdog timer to detect and fix connection issues
// IMPORTANT: Delay watchdog initialization to prevent it from running too early
let watchdogInitialized = false;
setTimeout(() => {
  watchdogInitialized = true;
  log('info', '🔍 Watchdog timer initialized and active');
}, 180000); // Wait 3 minutes before enabling watchdog

setInterval(async () => {
  // Skip if watchdog hasn't been initialized yet or during client initialization
  if (!watchdogInitialized || isClientInitializing) {
    return;
  }
  
  // Skip if no client exists
  if (!client) {
    return;
  }
  
  // Only check browser health if puppeteer page and browser exist
  if (client.pupPage && client.pupBrowser) {
    try {
      const isBrowserHealthy = await checkBrowserHealth(client);
      
      if (!isBrowserHealthy) {
        log('warn', '⚠️ Watchdog detected unhealthy browser state, initiating restart');
        
        // Try to save session before restart
        if (client.authStrategy) {
          try {
            await safelyTriggerSessionSave(client);
            log('info', '📥 Session saved before watchdog restart');
          } catch (err) {
            log('error', `Failed to save session before watchdog restart: ${err.message}`);
          }
        }
        
        // Destroy and restart client
        try {
          await client.destroy();
        } catch (err) {
          log('error', `Error during watchdog client destroy: ${err.message}`);
        } finally {
          client = null;
          setTimeout(startClient, 5000);
        }
        return;
      }
    } catch (err) {
      log('error', `Watchdog browser health check error: ${err.message}`);
      // Continue with other checks even if browser health check fails
    }
  }
  
  // Check for inactivity
  const inactiveTime = Date.now() - lastActivityTime;
  if (inactiveTime > 30 * 60 * 1000) { // 30 minutes of inactivity
    log('warn', `⚠️ Watchdog detected ${Math.floor(inactiveTime/60000)} minutes of inactivity, checking connection`);
    
    try {
      // Force a state check to verify connection
      const state = await client.getState();
      log('info', `Connection check: state is ${state}`);
      
      // Update activity time
      lastActivityTime = Date.now();
    } catch (err) {
      log('error', `Watchdog connection check failed: ${err.message}`);
      
      // Try to save session before restart
      if (client.authStrategy) {
        try {
          await safelyTriggerSessionSave(client);
        } catch (saveErr) {
          log('error', `Failed to save session during watchdog restart: ${saveErr.message}`);
        }
      }
      
      // Destroy and restart client
      try {
        await client.destroy();
      } catch (destroyErr) {
        log('error', `Error during watchdog client destroy: ${destroyErr.message}`);
      } finally {
        client = null;
        setTimeout(startClient, 5000);
      }
    }
  }
  
  // Perform periodic browser reset if needed
  if (!isClientInitializing && client) {
    try {
      await performPeriodicBrowserReset();
    } catch (err) {
      log('error', `Periodic browser reset error: ${err.message}`);
    }
  }
  
}, WATCHDOG_INTERVAL);

// Process cleanup on exit
process.on('SIGTERM', async () => {
  log('info', '🛑 SIGTERM received, shutting down gracefully');
  
  // Try to save session before exit
  if (client && client.authStrategy) {
    try {
      await safelyTriggerSessionSave(client);
      log('info', '📥 Session saved before exit');
    } catch (err) {
      log('error', `Failed to save session before exit: ${err.message}`);
    }
  }
  
  // Destroy client if it exists
  if (client) {
    try {
      await client.destroy();
      log('info', '🧹 Client destroyed during shutdown');
    } catch (err) {
      log('error', `Error destroying client during shutdown: ${err.message}`);
    } finally {
      client = null;
    }
  }
  
  // Close server
  server.close(() => {
    log('info', '👋 Server closed, exiting process');
    process.exit(0);
  });
  
  // Force exit after timeout
  setTimeout(() => {
    log('info', '⏱️ Force exit after timeout');
    process.exit(1);
  }, 10000);
});

// Handle SIGINT (Ctrl+C)
process.on('SIGINT', async () => {
  log('info', '🛑 SIGINT received, shutting down gracefully');
  
  // Try to save session before exit
  if (client && client.authStrategy) {
    try {
      await safelyTriggerSessionSave(client);
      log('info', '📥 Session saved before exit');
    } catch (err) {
      log('error', `Failed to save session before exit: ${err.message}`);
    }
  }
  
  // Destroy client if it exists
  if (client) {
    try {
      await client.destroy();
      log('info', '🧹 Client destroyed during shutdown');
    } catch (err) {
      log('error', `Error destroying client during shutdown: ${err.message}`);
    } finally {
      client = null;
    }
  }
  
  // Close server
  server.close(() => {
    log('info', '👋 Server closed, exiting process');
    process.exit(0);
  });
  
  // Force exit after timeout
  setTimeout(() => {
    log('info', '⏱️ Force exit after timeout');
    process.exit(1);
  }, 10000);
});

// Handle uncaught exceptions
process.on('uncaughtException', (err) => {
  log('error', `💥 Uncaught exception: ${err.message}`);
  log('error', err.stack);
  // Continue running - don't exit
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  log('error', `🔥 Unhandled promise rejection: ${reason}`);
  // Continue running - don't exit
});

// Add self-ping to prevent Render from sleeping
if (process.env.SELF_PING_URL) {
  const PING_INTERVAL = parseInt(process.env.SELF_PING_INTERVAL || '300000'); // 5 minutes by default
  
  log('info', `📡 Self-ping enabled, will ping ${process.env.SELF_PING_URL} every ${PING_INTERVAL/60000} minutes`);
  
  setInterval(async () => {
    try {
      log.debug(`🏓 Self-ping: ${process.env.SELF_PING_URL}`);
      await axios.get(process.env.SELF_PING_URL, { timeout: 5000 });
    } catch (err) {
      log('warn', `Self-ping failed: ${err.message}`);
    }
  }, PING_INTERVAL);
}

// Set memory monitoring interval
if (global.gc) {
  // If garbage collection is exposed, monitor memory and trigger GC when needed
  setInterval(() => {
    const mem = process.memoryUsage();
    const rssMB = Math.round(mem.rss / 1024 / 1024);
    
    if (rssMB > MEMORY_THRESHOLD_MB) {
      log('warn', `Memory usage high (${rssMB}MB), running garbage collection`);
      global.gc();
      
      // Log memory after GC
      setTimeout(() => {
        const memAfter = process.memoryUsage();
        const rssMBAfter = Math.round(memAfter.rss / 1024 / 1024);
        log('info', `Memory after GC: ${rssMBAfter}MB (reduced by ${rssMB - rssMBAfter}MB)`);
      }, 1000);
    }
  }, 60000); // Check every minute
}

log('info', '✅ Application bootstrap completed, waiting for events...');
