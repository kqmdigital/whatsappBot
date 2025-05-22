// config/index.js
class Config {
  constructor() {
    this.PORT = process.env.PORT || 3000;
    this.SESSION_ID = process.env.WHATSAPP_SESSION_ID || 'default_session';
    this.BOT_VERSION = '1.0.2';
    this.SUPABASE_URL = process.env.SUPABASE_URL;
    this.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
    this.N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL;
    this.INTEREST_RATE_WEBHOOK_URL = process.env.INTEREST_RATE_WEBHOOK_URL;
    this.VALUATION_WEBHOOK_URL = process.env.VALUATION_WEBHOOK_URL;
    this.APP_URL = process.env.APP_URL || `http://localhost:${this.PORT}`;
    
    this.validateConfig();
  }

  validateConfig() {
    if (!this.SUPABASE_URL || !this.SUPABASE_ANON_KEY) {
      throw new Error('Missing required Supabase credentials');
    }
  }

  logWebhooks() {
    console.log('🔍 Loaded Webhook URLs:');
    console.log('- N8N_WEBHOOK_URL:', !!this.N8N_WEBHOOK_URL);
    console.log('- INTEREST_RATE_WEBHOOK_URL:', !!this.INTEREST_RATE_WEBHOOK_URL);
    console.log('- VALUATION_WEBHOOK_URL:', !!this.VALUATION_WEBHOOK_URL);
  }
}

// utils/logger.js
class Logger {
  constructor(sessionId) {
    this.sessionId = sessionId;
  }

  log(level, message, ...args) {
    const timestamp = new Date().toISOString();
    const formatted = `[${timestamp}] [${level.toUpperCase()}] [${this.sessionId}] ${message}`;
    console[level](formatted, ...args);
  }

  info(message, ...args) { this.log('info', message, ...args); }
  warn(message, ...args) { this.log('warn', message, ...args); }
  error(message, ...args) { this.log('error', message, ...args); }
  debug(message, ...args) { this.log('debug', message, ...args); }
}

// services/SessionManager.js
const fs = require('fs');
const path = require('path');

class SessionManager {
  constructor(supabaseClient, sessionId, logger) {
    this.supabase = supabaseClient;
    this.sessionId = sessionId;
    this.logger = logger;
    this.client = null;
  }

  setClient(client) {
    this.client = client;
  }

  async extractSessionData() {
    if (!this.client?.pupPage) {
      this.logger.warn('Cannot extract session data: No puppeteer page available');
      return null;
    }
    
    try {
      const isPageAlive = await this.client.pupPage.evaluate(() => true).catch(() => false);
      if (!isPageAlive) {
        this.logger.warn('Puppeteer page is no longer responsive');
        return null;
      }

      const rawLocalStorage = await this.client.pupPage.evaluate(() => {
        try {
          const data = {};
          for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            data[key] = localStorage.getItem(key);
          }
          
          data['_session_metadata'] = JSON.stringify({
            timestamp: Date.now(),
            userAgent: navigator.userAgent,
            url: window.location.href
          });
          
          return data;
        } catch (e) {
          return { error: e.toString() };
        }
      });

      if (rawLocalStorage?.error) {
        this.logger.warn(`Error in page extraction: ${rawLocalStorage.error}`);
        return null;
      }

      return this.validateAndReturnSession(rawLocalStorage);
    } catch (err) {
      this.logger.error(`Failed to extract session data: ${err.message}`);
      return null;
    }
  }

  validateAndReturnSession(sessionData) {
    if (!sessionData || Object.keys(sessionData).length < 5) {
      this.logger.warn('Session data has too few items');
      return null;
    }

    const sessionSize = JSON.stringify(sessionData).length;
    const hasWAData = Object.keys(sessionData).some(key => 
      key.includes('WABrowserId') || key.includes('WASecretBundle') || key.includes('WAToken')
    );

    if (sessionSize < 5000) {
      this.logger.warn(`Session data too small (${sessionSize} bytes)`);
      return null;
    }

    if (!hasWAData) {
      this.logger.warn('Session data missing essential WhatsApp keys');
      return null;
    }

    this.logger.info(`Valid session data extracted (${sessionSize} bytes)`);
    return sessionData;
  }

  async saveToSupabase(sessionData) {
    const sessionSize = JSON.stringify(sessionData).length;
    this.logger.info(`Saving session to Supabase (${sessionSize} bytes)`);

    const { error } = await this.supabase
      .from('whatsapp_sessions')
      .upsert({
        session_key: this.sessionId,
        session_data: sessionData,
        updated_at: new Date().toISOString()
      }, { onConflict: 'session_key' });

    if (error) throw new Error(error.message);
    
    // Create backup
    await this.createBackup(sessionData);
    this.logger.info('Session saved to Supabase successfully');
  }

  async createBackup(sessionData) {
    try {
      await this.supabase
        .from('whatsapp_sessions')
        .upsert({
          session_key: `${this.sessionId}_backup`,
          session_data: sessionData,
          updated_at: new Date().toISOString()
        }, { onConflict: 'session_key' });
      
      this.logger.info('Session backup created');
    } catch (err) {
      this.logger.warn(`Failed to create backup: ${err.message}`);
    }
  }

  async loadFromSupabase() {
    const { data, error } = await this.supabase
      .from('whatsapp_sessions')
      .select('session_data')
      .eq('session_key', this.sessionId)
      .single();

    if (error) {
      this.logger.warn(`No existing session found: ${error.message}`);
      return null;
    }

    return this.validateAndReturnSession(data?.session_data);
  }

  async deleteFromSupabase() {
    const { error } = await this.supabase
      .from('whatsapp_sessions')
      .delete()
      .eq('session_key', this.sessionId);

    if (error) throw new Error(error.message);
    this.logger.info('Session deleted from Supabase');
  }
}

// services/WebhookService.js
const axios = require('axios');

class WebhookService {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
  }

  async sendToWebhook(webhookUrl, payload, type = 'unknown', attempt = 0) {
    if (!webhookUrl) {
      this.logger.warn(`${type} webhook skipped: URL not set`);
      return false;
    }

    const processedPayload = this.processPayload(payload);
    const payloadSize = Buffer.byteLength(JSON.stringify(processedPayload), 'utf8');
    
    if (payloadSize > 90_000) {
      this.logger.warn(`${type} payload too large (${payloadSize} bytes)`);
      return false;
    }

    try {
      await axios.post(webhookUrl, processedPayload, { timeout: 10000 });
      this.logger.info(`✅ ${type} webhook sent (${payloadSize} bytes)`);
      return true;
    } catch (err) {
      this.logger.error(`${type} webhook attempt ${attempt + 1} failed: ${err.message}`);
      
      if (attempt < 4) {
        const backoff = Math.min(Math.pow(2, attempt) * 1000, 15000);
        this.logger.warn(`Will retry ${type} webhook in ${backoff/1000} seconds...`);
        setTimeout(() => this.sendToWebhook(webhookUrl, processedPayload, type, attempt + 1), backoff);
        return false;
      }
      
      this.logger.error(`Giving up on ${type} webhook after 5 attempts`);
      return false;
    }
  }

  processPayload(payload) {
    const processed = { ...payload };
    
    if (processed.text?.length > 1000) {
      processed.text = processed.text.slice(0, 1000) + '... [truncated]';
    }
    
    if (processed.replyInfo?.text?.length > 500) {
      processed.replyInfo.text = processed.replyInfo.text.slice(0, 500) + '... [truncated]';
    }
    
    return processed;
  }

  async handleMessage(messageData) {
    const { messageType } = messageData;
    const promises = [];

    if (messageType === 'valuation' && this.config.VALUATION_WEBHOOK_URL) {
      promises.push(this.sendToWebhook(this.config.VALUATION_WEBHOOK_URL, messageData, 'valuation'));
    }
    
    if (messageType === 'interest_rate' && this.config.INTEREST_RATE_WEBHOOK_URL) {
      promises.push(this.sendToWebhook(this.config.INTEREST_RATE_WEBHOOK_URL, messageData, 'interest_rate'));
    }

    if (this.config.N8N_WEBHOOK_URL) {
      promises.push(this.sendToWebhook(this.config.N8N_WEBHOOK_URL, messageData, 'main'));
    }

    await Promise.allSettled(promises);
  }
}

// services/EnhancedLocalAuth.js
const { LocalAuth } = require('whatsapp-web.js');

class EnhancedLocalAuth extends LocalAuth {
  constructor(options = {}) {
    super(options);
    this.sessionManager = options.sessionManager;
    this.logger = options.logger;
    this.retryCount = 0;
    this.maxRetries = 3;
  }

  async afterInit(client) {
    this.logger.info('Starting session restoration process');
    this.sessionManager.setClient(client);
    
    try {
      super.afterInit(client).catch(err => {
        this.logger.warn(`Parent afterInit error: ${err.message}`);
      });

      const sessionData = await this.sessionManager.loadFromSupabase();
      if (sessionData) {
        await this.restoreSession(sessionData);
      }
    } catch (err) {
      this.logger.error(`Error in afterInit: ${err.message}`);
    }
  }

  async restoreSession(sessionData) {
    const sessionSize = JSON.stringify(sessionData).length;
    this.logger.info(`Found valid session in Supabase (${sessionSize} bytes)`);

    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        const sessionDir = path.join(this.dataPath, 'session-' + this.sessionManager.sessionId);
        if (!fs.existsSync(sessionDir)) {
          fs.mkdirSync(sessionDir, { recursive: true });
        }

        const sessionFile = path.join(sessionDir, 'session.json');
        if (fs.existsSync(sessionFile)) {
          fs.unlinkSync(sessionFile);
        }

        await fs.promises.writeFile(sessionFile, JSON.stringify(sessionData), { encoding: 'utf8' });
        
        // Verify the file
        const savedContent = await fs.promises.readFile(sessionFile, { encoding: 'utf8' });
        if (savedContent && savedContent.length > 5000) {
          this.logger.info('Session restoration completed successfully');
          return;
        }
        
        throw new Error('Session file verification failed');
      } catch (err) {
        this.logger.warn(`Session restoration attempt ${attempt}/${this.maxRetries} failed: ${err.message}`);
        
        if (attempt < this.maxRetries) {
          const delay = 1000 * Math.pow(2, attempt);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }
  }

  async save(session) {
    if (!session || JSON.stringify(session).length < 5000) {
      this.logger.warn('Session data appears invalid, attempting extraction');
      session = await this.sessionManager.extractSessionData();
      
      if (!session) {
        this.logger.warn('Could not extract valid session data');
        return;
      }
    }

    // Save locally
    try {
      await super.save(session);
    } catch (err) {
      this.logger.error(`Failed to save session locally: ${err.message}`);
    }

    // Save to Supabase
    try {
      await this.sessionManager.saveToSupabase(session);
    } catch (err) {
      this.logger.error(`Failed to save session to Supabase: ${err.message}`);
    }
  }

  async delete() {
    try {
      await this.sessionManager.deleteFromSupabase();
    } catch (err) {
      this.logger.error(`Failed to delete session from Supabase: ${err.message}`);
    }
    
    return super.delete();
  }
}

// services/WhatsAppClient.js
const { Client, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');

class WhatsAppClientService {
  constructor(config, logger, sessionManager, webhookService) {
    this.config = config;
    this.logger = logger;
    this.sessionManager = sessionManager;
    this.webhookService = webhookService;
    this.client = null;
    this.messageCount = 0;
    this.reconnectAttempt = 0;
  }

  createClient() {
    const sessionPath = path.join(__dirname, `.wwebjs_auth/session-${this.config.SESSION_ID}`);
    const parentDir = path.dirname(sessionPath);
    
    if (!fs.existsSync(parentDir)) {
      fs.mkdirSync(parentDir, { recursive: true });
      this.logger.info(`Created session directory: ${parentDir}`);
    }

    return new Client({
      authStrategy: new EnhancedLocalAuth({
        sessionManager: this.sessionManager,
        logger: this.logger,
        dataPath: path.join(__dirname, `.wwebjs_auth`),
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
  }

  setupEvents() {
    this.client.on('qr', this.handleQR.bind(this));
    this.client.on('ready', this.handleReady.bind(this));
    this.client.on('authenticated', this.handleAuthenticated.bind(this));
    this.client.on('disconnected', this.handleDisconnected.bind(this));
    this.client.on('auth_failure', this.handleAuthFailure.bind(this));
    this.client.on('message', this.handleMessage.bind(this));
  }

  handleQR(qr) {
    const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?data=${encodeURIComponent(qr)}`;
    this.logger.warn(`📱 Scan QR Code: ${qrUrl}`);
    qrcode.generate(qr, { small: true });
  }

  async handleReady() {
    this.logger.info('WhatsApp client is ready');
    this.reconnectAttempt = 0;
    
    setTimeout(async () => {
      await this.saveSession();
    }, 5000);
  }

  async handleAuthenticated() {
    this.logger.info('Client authenticated');
    
    setTimeout(async () => {
      await this.saveSession();
    }, 2000);
  }

  async handleDisconnected(reason) {
    this.logger.warn(`Client disconnected: ${reason}`);
    
    if (this.client) {
      try {
        await this.saveSession();
        await this.client.destroy();
      } catch (err) {
        this.logger.error(`Error during disconnect cleanup: ${err.message}`);
      }
      this.client = null;
    }
    
    this.scheduleReconnect();
  }

  async handleAuthFailure() {
    this.logger.error('Auth failed. Clearing session');
    
    try {
      await this.sessionManager.deleteFromSupabase();
      this.client = null;
      setTimeout(() => this.start(), 10000);
    } catch (err) {
      this.logger.error(`Failed to clean up after auth failure: ${err.message}`);
      process.exit(1);
    }
  }

  async handleMessage(msg) {
    if (!msg.from.endsWith('@g.us')) return;

    this.messageCount++;
    if (this.messageCount % 50 === 0) {
      this.logMemoryUsage();
    }

    const messageData = await this.processMessage(msg);
    if (messageData) {
      await this.webhookService.handleMessage(messageData);
    }
  }

  async processMessage(msg) {
    const text = msg.body || '';
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
      this.logger.warn(`Failed to get quoted message: ${err.message}`);
    }

    const isValuationMessage = 
      text.toLowerCase().includes('valuation request') ||
      (hasReply && replyInfo?.text?.toLowerCase().includes('valuation request'));

    const isInterestRateMessage = 
      text.toLowerCase().includes('keyquest mortgage team');

    if (!isValuationMessage && !isInterestRateMessage) {
      return null;
    }

    return {
      groupId: msg.from,
      senderId: msg.author || msg.from,
      text,
      messageId: msg?.id?.id || msg?.id?._serialized || '',
      hasReply,
      replyInfo,
      messageType: isValuationMessage ? 'valuation' : 'interest_rate',
      timestamp: new Date(msg.timestamp * 1000).toISOString(),
    };
  }

  scheduleReconnect() {
    this.reconnectAttempt++;
    const delay = Math.min(Math.pow(2, this.reconnectAttempt) * 1000, 60000);
    
    this.logger.info(`Will attempt reconnection (#${this.reconnectAttempt}) in ${delay/1000} seconds`);
    
    setTimeout(async () => {
      try {
        await this.start();
        const state = await this.client?.getState();
        
        if (state !== 'CONNECTED') {
          this.scheduleReconnect();
        } else {
          this.logger.info(`Reconnected successfully after ${this.reconnectAttempt} attempts`);
          this.reconnectAttempt = 0;
        }
      } catch (err) {
        this.logger.error(`Reconnection attempt #${this.reconnectAttempt} failed: ${err.message}`);
        this.scheduleReconnect();
      }
    }, delay);
  }

  async saveSession() {
    try {
      const sessionData = await this.sessionManager.extractSessionData();
      if (sessionData) {
        await this.sessionManager.saveToSupabase(sessionData);
        this.logger.info('Session saved successfully');
      }
    } catch (err) {
      this.logger.warn(`Failed to save session: ${err.message}`);
    }
  }

  async start() {
    if (this.client) {
      this.logger.info('Client already exists, skipping re-init');
      return;
    }

    this.logger.info('Starting WhatsApp client...');
    
    try {
      this.client = this.createClient();
      this.sessionManager.setClient(this.client);
      this.setupEvents();
      await this.client.initialize();
      this.logger.info('WhatsApp client initialized');
    } catch (err) {
      this.logger.error(`WhatsApp client failed to initialize: ${err.message}`);
      this.client = null;
      throw err;
    }
  }

  async sendMessage(targetId, message, imageUrl = null) {
    if (!this.client) {
      throw new Error('WhatsApp client not ready');
    }

    const formattedId = this.formatTargetId(targetId);
    let sentMessage;

    if (imageUrl) {
      try {
        const media = await MessageMedia.fromUrl(imageUrl);
        sentMessage = await this.client.sendMessage(formattedId, media, {
          caption: message || '',
        });
        this.logger.info(`Image message sent to ${formattedId}`);
      } catch (mediaErr) {
        if (message) {
          sentMessage = await this.client.sendMessage(formattedId, message);
          this.logger.info(`Fallback text message sent to ${formattedId}`);
        } else {
          throw mediaErr;
        }
      }
    } else {
      sentMessage = await this.client.sendMessage(formattedId, message);
      this.logger.info(`Text message sent to ${formattedId}`);
    }

    return {
      messageId: sentMessage.id?.id || sentMessage.id?._serialized || sentMessage.id,
      target: formattedId,
      type: imageUrl ? 'media' : 'text'
    };
  }

  formatTargetId(targetId) {
    if (targetId.includes('@g.us') || targetId.includes('@c.us')) {
      return targetId;
    }
    
    return /[a-zA-Z]/.test(targetId) ? `${targetId}@g.us` : `${targetId}@c.us`;
  }

  async getState() {
    return this.client ? await this.client.getState() : 'NO_CLIENT';
  }

  async destroy() {
    if (this.client) {
      await this.saveSession();
      await this.client.destroy();
      this.client = null;
    }
  }

  logMemoryUsage() {
    const mem = process.memoryUsage();
    const rssMB = (mem.rss / 1024 / 1024).toFixed(1);
    const heapMB = (mem.heapUsed / 1024 / 1024).toFixed(1);
    this.logger.info(`Memory usage — RSS: ${rssMB} MB, Heap: ${heapMB} MB`);
  }
}

// services/HealthMonitor.js
class HealthMonitor {
  constructor(whatsAppClient, config, logger) {
    this.whatsAppClient = whatsAppClient;
    this.config = config;
    this.logger = logger;
    this.intervals = [];
  }

  start() {
    // Watchdog - every 5 minutes
    this.intervals.push(setInterval(async () => {
      await this.watchdog();
    }, 5 * 60 * 1000));

    // Memory check - every 5 minutes
    this.intervals.push(setInterval(() => {
      this.checkMemory();
    }, 5 * 60 * 1000));

    // Self ping - every 4 minutes
    this.intervals.push(setInterval(async () => {
      await this.selfPing();
    }, 4 * 60 * 1000));
  }

  async watchdog() {
    try {
      const state = await this.whatsAppClient.getState();
      this.logger.info(`Watchdog: client state is "${state}"`);

      if (state === 'CONNECTED') {
        await this.whatsAppClient.saveSession();
      } else if (state !== 'NO_CLIENT') {
        this.logger.warn(`Bad state "${state}". Restarting client...`);
        await this.whatsAppClient.destroy();
        await this.whatsAppClient.start();
      }
    } catch (err) {
      this.logger.error(`Watchdog error: ${err.message}. Restarting...`);
      await this.whatsAppClient.destroy();
      await this.whatsAppClient.start();
    }
  }

  checkMemory() {
    const mem = process.memoryUsage();
    const rssMB = (mem.rss / 1024 / 1024).toFixed(1);
    
    if (parseFloat(rssMB) > 450) {
      this.logger.error('CRITICAL MEMORY USAGE! Restarting client...');
      this.forceGarbageCollection();
      this.restartClient();
    } else if (parseFloat(rssMB) > 350) {
      this.logger.warn('High memory usage detected');
      this.forceGarbageCollection();
    }
  }

  forceGarbageCollection() {
    if (global.gc) {
      this.logger.info('Forcing garbage collection...');
      global.gc();
    }
  }

  async restartClient() {
    try {
      await this.whatsAppClient.destroy();
      setTimeout(() => this.whatsAppClient.start(), 5000);
    } catch (err) {
      this.logger.error(`Failed to restart client: ${err.message}`);
    }
  }

  async selfPing() {
    try {
      const axios = require('axios');
      await axios.get(`${this.config.APP_URL}/ping`, { timeout: 5000 });
      this.logger.debug('Self-ping successful');
    } catch (err) {
      this.logger.warn(`Self-ping failed: ${err.message}`);
    }
  }

  stop() {
    this.intervals.forEach(interval => clearInterval(interval));
    this.intervals = [];
  }
}

// routes/index.js
const express = require('express');

function createRoutes(whatsAppClient, sessionManager, config, logger) {
  const router = express.Router();

  // Health check
  router.get('/health', async (req, res) => {
    try {
      const clientState = await whatsAppClient.getState();
      const mem = process.memoryUsage();
      
      const health = {
        status: clientState === 'CONNECTED' ? 'healthy' : 'degraded',
        version: config.BOT_VERSION,
        uptime: {
          seconds: Math.floor(process.uptime()),
          readable: formatUptime(process.uptime() * 1000),
        },
        whatsapp: { state: clientState },
        memory: {
          rss: `${(mem.rss / 1024 / 1024).toFixed(1)} MB`,
          heapUsed: `${(mem.heapUsed / 1024 / 1024).toFixed(1)} MB`,
        },
        timestamp: new Date().toISOString(),
      };
      
      res.json(health);
    } catch (err) {
      res.status(500).json({ status: 'error', error: err.message });
    }
  });

  // Send message
  router.post('/send-message', async (req, res) => {
    try {
      const { jid, groupId, message, imageUrl } = req.body;
      const targetId = jid || groupId;

      if (!targetId || (!message && !imageUrl)) {
        return res.status(400).json({ 
          success: false, 
          error: 'Missing target ID or message content' 
        });
      }

      const result = await whatsAppClient.sendMessage(targetId, message, imageUrl);
      res.json({ success: true, ...result });
    } catch (err) {
      logger.error(`Failed to send message: ${err.message}`);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Session management
  router.post('/save-session', async (req, res) => {
    try {
      await whatsAppClient.saveSession();
      res.json({ success: true, message: 'Session saved successfully' });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  router.delete('/clear-session', async (req, res) => {
    try {
      await sessionManager.deleteFromSupabase();
      res.json({ success: true, message: 'Session cleared' });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  router.get('/ping', (req, res) => {
    res.send('pong');
  });

  return router;
}

function formatUptime(ms) {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  
  return `${days}d ${hours % 24}h ${minutes % 60}m ${seconds % 60}s`;
}

// main.js - Application entry point
const express = require('express');
const { createClient } = require('@supabase/supabase-js');

class WhatsAppBotApplication {
  constructor() {
    this.config = new Config();
    this.logger = new Logger(this.config.SESSION_ID);
    this.supabase = createClient(this.config.SUPABASE_URL, this.config.SUPABASE_ANON_KEY);
    
    this.sessionManager = new SessionManager(this.supabase, this.config.SESSION_ID, this.logger);
    this.webhookService = new WebhookService(this.config, this.logger);
    this.whatsAppClient = new WhatsAppClientService(
      this.config, 
      this.logger, 
      this.sessionManager, 
      this.webhookService
    );
    this.healthMonitor = new HealthMonitor(this.whatsAppClient, this.config, this.logger);
    
    this.app = express();
    this.server = null;
    this.startedAt = Date.now();
  }

  setupExpress() {
    this.app.use(express.json({ limit: '10mb' }));
    
    this.app.get('/', (req, res) => {
      res.json({
        status: '✅ Bot running',
        sessionId: this.config.SESSION_ID,
        version: this.config.BOT_VERSION,
        uptimeMinutes: Math.floor((Date.now() - this.startedAt) / 60000),
        timestamp: new Date().toISOString(),
      });
    });

    const routes = createRoutes(
      this.whatsAppClient, 
      this.sessionManager, 
      this.config, 
      this.logger
    );
    this.app.use(routes);
  }

  setupGracefulShutdown() {
    const gracefulShutdown = async (signal) => {
      this.logger.warn(`Received ${signal}. Shutting down gracefully...`);
      
      this.healthMonitor.stop();
      
      if (this.server) {
        this.server.close(() => {
          this.logger.info('HTTP server closed');
        });
      }
      
      await this.whatsAppClient.destroy();
      
      setTimeout(() => {
        this.logger.info('Exiting process...');
        process.exit(0);
      }, 3000);
    };

    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
    process.on('SIGINT', () => gracefulShutdown('SIGINT'));
    process.on('unhandledRejection', (reason, promise) => {
      this.logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
    });
  }

  async start() {
    try {
      this.config.logWebhooks();
      this.setupExpress();
      this.setupGracefulShutdown();
      
      this.server = this.app.listen(this.config.PORT, () => {
        this.logger.info(`Server started on http://localhost:${this.config.PORT}`);
        this.logger.info(`Bot Version: ${this.config.BOT_VERSION}`);
      });

      // Start health monitoring
      this.healthMonitor.start();
      
      // Start WhatsApp client after 3 seconds
      setTimeout(() => {
        this.whatsAppClient.start().catch(err => {
          this.logger.error(`Failed to start WhatsApp client: ${err.message}`);
        });
      }, 3000);
      
    } catch (err) {
      this.logger.error(`Failed to start application: ${err.message}`);
      process.exit(1);
    }
  }
}

// Start the application
if (require.main === module) {
  const app = new WhatsAppBotApplication();
  app.start();
}

module.exports = WhatsAppBotApplication;
