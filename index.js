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
const BOT_VERSION = '1.0.0';
const startedAt = Date.now();

// Multiple webhook URLs support
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL;
const INTEREST_RATE_WEBHOOK_URL = process.env.INTEREST_RATE_WEBHOOK_URL;
const VALUATION_WEBHOOK_URL = process.env.VALUATION_WEBHOOK_URL;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

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

// --- Enhanced Supabase Store for WhatsApp Session ---
class SupabaseStore {
  constructor(supabaseClient, sessionId) {
    this.supabase = supabaseClient;
    this.sessionId = sessionId;
    log('info', `SupabaseStore initialized for session ID: ${this.sessionId}`);
  }

  async sessionExists({ session }) {
    try {
      const { count, error } = await this.supabase
        .from('whatsapp_sessions')
        .select('*', { count: 'exact', head: true })
        .eq('session_key', session);

      if (error) {
        log('error', `Supabase error in sessionExists: ${error.message}`);
        return false;
      }
      return count > 0;
    } catch (err) {
      log('error', `Exception in sessionExists: ${err.message}`);
      return false;
    }
  }

  async extract() {
    try {
      const { data, error } = await this.supabase
        .from('whatsapp_sessions')
        .select('session_data')
        .eq('session_key', this.sessionId)
        .limit(1)
        .single();

      if (error) {
        log('warn', `No existing session found: ${error.message}`);
        return null;
      }
      
      log('info', '✅ Session data extracted from Supabase');
      return data?.session_data || null;
    } catch (err) {
      log('error', `Exception in extract: ${err.message}`);
      return null;
    }
  }

  async save(sessionData) {
    try {
      const { error } = await this.supabase
        .from('whatsapp_sessions')
        .upsert({ 
          session_key: this.sessionId, 
          session_data: sessionData,
          updated_at: new Date().toISOString()
        }, { onConflict: 'session_key' });

      if (error) {
        log('error', `Failed to save session: ${error.message}`);
      } else {
        log('info', '💾 Session saved to Supabase successfully');
      }
    } catch (err) {
      log('error', `Exception in save: ${err.message}`);
    }
  }

  async delete() {
    try {
      const { error } = await this.supabase
        .from('whatsapp_sessions')
        .delete()
        .eq('session_key', this.sessionId);

      if (error) {
        log('error', `Failed to delete session: ${error.message}`);
      } else {
        log('info', '🗑️ Session deleted from Supabase');
      }
    } catch (err) {
      log('error', `Exception in delete: ${err.message}`);
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
        await this.save(sessionFiles);
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
  c.on('qr', qr => {
    const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?data=${encodeURIComponent(qr)}`;
    log('warn', `📱 Scan QR Code: ${qrUrl}`);
    qrcode.generate(qr, { small: true });
  });

  c.on('ready', async () => {
    log('info', '✅ WhatsApp client is ready.');
    
    // Extract and backup local session after client is ready
    try {
      await supabaseStore.extractLocalSession();
    } catch (err) {
      log('warn', `Failed to backup local session: ${err.message}`);
    }
  });

  c.on('authenticated', () => {
    log('info', '🔐 Client authenticated.');
  });

  c.on('remote_session_saved', () => {
    log('info', '💾 Session saved to Supabase.');
  });

  c.on('disconnected', async reason => {
    log('warn', `Client disconnected: ${reason}`);
    if (client) {
      try {
        await client.destroy();
      } catch (err) {
        log('error', `Error destroying client after disconnect: ${err.message}`);
      }
      client = null;
    }
    
    // Exponential backoff for reconnection
    const attemptReconnection = (attempt = 1) => {
      const delay = Math.min(Math.pow(2, attempt) * 1000, 60000);
      log('info', `Will attempt reconnection (#${attempt}) in ${delay/1000} seconds`);
      
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
      }, delay);
    };
    
    attemptReconnection();
  });

  c.on('auth_failure', async () => {
    log('error', '❌ Auth failed. Clearing session.');
    try {
      await supabaseStore.delete();
      log('info', 'Session deleted. Will attempt to reinitialize...');
      client = null;
      setTimeout(startClient, 10000);
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
    text.toLowerCase().includes('valuation') ||
    (hasReply && replyInfo?.text?.toLowerCase().includes('valuation'));

  const isInterestRateMessage = 
    text.toLowerCase().includes('dear valued partners') ||
    text.toLowerCase().includes('interest rate') ||
    (hasReply && replyInfo?.text?.toLowerCase().includes('dear valued partners')) ||
    (hasReply && replyInfo?.text?.toLowerCase().includes('interest rate'));

  // Skip if message doesn't match any trigger conditions
  if (!isValuationMessage && !isInterestRateMessage) {
    log('info', '🚫 Ignored message - no trigger keywords found.');
    return;
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
    await axios.post(webhookUrl, processedPayload, { timeout: 10000 });
    log('info', `✅ ${type} webhook sent (${payloadSize} bytes).`);
  } catch (err) {
    log('error', `${type} webhook attempt ${attempt + 1} failed: ${err.message}`);
    if (attempt < 4) {
      const backoff = Math.min(Math.pow(2, attempt) * 1000, 15000);
      log('warn', `Will retry ${type} webhook in ${backoff/1000} seconds...`);
      setTimeout(() => sendToWebhook(webhookUrl, processedPayload, type, attempt + 1), backoff);
    } else {
      log('error', `Giving up on ${type} webhook after 5 attempts`);
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
    timestamp: new Date().toISOString(),
  });
});

// Enhanced send message endpoint supporting both individual and group chats
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

// Session management endpoints
app.post('/extract-session', async (req, res) => {
  try {
    const success = await supabaseStore.extractLocalSession();
    res.status(200).json({ 
      success, 
      message: success ? 'Session extracted and saved to Supabase' : 'No local session found' 
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
    await supabaseStore.delete();
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
  log('info', '💻 Starting WhatsApp client in 3 seconds...');
  setTimeout(startClient, 3000);
});

// Watchdog - Monitor client health
setInterval(async () => {
  if (!client) {
    log('warn', '🕵️ Watchdog: client is missing. Restarting...');
    await startClient();
    return;
  }

  try {
    const state = await client.getState();
    log('info', `✅ Watchdog: client state is "${state}".`);

    if (state !== 'CONNECTED') {
      log('warn', `⚠️ Watchdog detected bad state "${state}". Restarting client...`);
      await client.destroy();
      client = null;
      await startClient();
    }
  } catch (err) {
    log('error', `🚨 Watchdog error during state check: ${err.message}. Restarting...`);
    client = null;
    await startClient();
  }
}, 5 * 60 * 1000); // every 5 minutes

// Memory monitoring
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
          await client.destroy();
          client = null;
          log('warn', 'Client destroyed due to memory pressure');
          setTimeout(startClient, 5000);
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

setInterval(checkMemoryUsage, 5 * 60 * 1000);

// Self-ping mechanism
let lastPingSent = 0;
const selfPing = async () => {
  try {
    const now = Date.now();
    if (now - lastPingSent > 4 * 60 * 1000) {
      lastPingSent = now;
      const appUrl = process.env.APP_URL || `http://localhost:${PORT}`;
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

setInterval(selfPing, 4 * 60 * 1000);

// Helper function to format uptime
function formatUptime(ms) {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  
  return `${days}d ${hours % 24}h ${minutes % 60}m ${seconds % 60}s`;
}
