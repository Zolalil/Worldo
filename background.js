// Service Worker Principal - Worldo Extension
let state = {
  currentDomain: null,
  lastActiveTime: Date.now(),
  mediaPlayingSites: new Set(),
  isIdle: false,
  isPaused: false,
  focusSession: null,
  notificationTimeouts: new Map()
};

const STORAGE_KEY = 'att_data_v1';
const DEFAULT_SETTINGS = {
  activeMode: 'tab',
  considerWindowFocus: true,
  idlePauseMinutes: 5,
  focusEnabled: false,
  siteLimits: {},
  notificationsEnabled: true,
  darkMode: true
};

// Initialisation au démarrage
chrome.runtime.onStartup.addListener(initialize);
chrome.runtime.onInstalled.addListener(initialize);

async function initialize() {
  console.log('🚀 Worldo Extension initialized');
  
  // Configuration des alarmes
  chrome.alarms.create('tracking-tick', { periodInMinutes: 0.016 }); // ~1 seconde
  chrome.alarms.create('daily-reset', { when: getNextMidnight() });
  
  // Configuration idle detection
  const settings = await getSettings();
  chrome.idle.setDetectionInterval(settings.idlePauseMinutes * 60);
  
  // Restaurer l'état
  await restoreState();
}

// Gestion des alarmes
chrome.alarms.onAlarm.addListener(async (alarm) => {
  switch (alarm.name) {
    case 'tracking-tick':
      await updateTracking();
      break;
    case 'daily-reset':
      await dailyReset();
      chrome.alarms.create('daily-reset', { when: getNextMidnight() });
      break;
  }
});

// Tracking principal
async function updateTracking() {
  if (state.isPaused || state.isIdle) return;
  
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tabs.length) return;
    
    const tab = tabs[0];
    if (!tab.url || tab.url.startsWith('chrome://')) return;
    
    const domain = extractDomain(tab.url);
    const now = Date.now();
    const settings = await getSettings();
    
    // Mise à jour du domaine actuel
    if (state.currentDomain !== domain) {
      state.currentDomain = domain;
      await broadcastStateUpdate();
    }
    
    // Calcul du temps écoulé
    const elapsed = Math.min(now - state.lastActiveTime, 2000); // Max 2 secondes
    state.lastActiveTime = now;
    
    // Vérification de l'activité selon le mode
    let shouldTrack = false;
    if (settings.activeMode === 'tab') {
      shouldTrack = true;
    } else if (settings.activeMode === 'input') {
      shouldTrack = await checkRecentInput(tab.id);
    }
    
    if (shouldTrack) {
      await incrementTime(domain, 'activeMs', elapsed);
      
      // Vérifier les limites et notifications
      await checkSiteLimits(domain);
    }
    
    // Tracking média séparé
    if (state.mediaPlayingSites.has(domain)) {
      await incrementTime(domain, 'mediaMs', elapsed);
    }
    
    // Mise à jour session focus
    if (state.focusSession) {
      await updateFocusSession(elapsed);
    }
    
  } catch (error) {
    console.error('❌ Erreur tracking:', error);
  }
}

// Gestion des messages
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender, sendResponse);
  return true; // Keep channel open for async response
});

async function handleMessage(message, sender, sendResponse) {
  try {
    switch (message.type) {
      case 'ATT_INPUT':
        await handleInputActivity(sender.tab.id);
        sendResponse({ success: true });
        break;
        
      case 'ATT_MEDIA':
        await handleMediaState(sender.tab.url, message.isPlaying);
        sendResponse({ success: true });
        break;
        
      case 'ATT_GET_STATE':
        sendResponse({
          currentDomain: state.currentDomain,
          isPaused: state.isPaused,
          focusSession: state.focusSession
        });
        break;
        
      case 'ATT_GET_DOMAIN':
        if (sender.tab?.url) {
          sendResponse({ domain: extractDomain(sender.tab.url) });
        }
        break;
        
      case 'FOCUS_START':
        await startFocusSession(message.config);
        sendResponse({ success: true });
        break;
        
      case 'FOCUS_STOP':
        await stopFocusSession();
        sendResponse({ success: true });
        break;
        
      case 'GET_DATA':
        const data = await getData();
        sendResponse(data);
        break;
        
      case 'EXPORT_CSV':
        await exportToCSV();
        sendResponse({ success: true });
        break;
        
      default:
        sendResponse({ error: 'Type de message inconnu' });
    }
  } catch (error) {
    console.error('❌ Erreur message:', error);
    sendResponse({ error: error.message });
  }
}

// Gestion de l'état idle
chrome.idle.onStateChanged.addListener((newState) => {
  state.isIdle = (newState !== 'active');
  console.log('🔄 État idle:', newState);
});

// Gestion navigation
chrome.webNavigation.onCompleted.addListener(async (details) => {
  if (details.frameId === 0) { // Frame principal uniquement
    const domain = extractDomain(details.url);
    if (domain !== state.currentDomain) {
      state.currentDomain = domain;
      await broadcastStateUpdate();
    }
  }
});

// Fonctions utilitaires
function extractDomain(url) {
  try {
    const hostname = new URL(url).hostname;
    return hostname.replace(/^www\./, '');
  } catch {
    return 'unknown';
  }
}

function getTodayKey() {
  return new Date().toISOString().split('T')[0];
}

function getNextMidnight() {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(0, 0, 0, 0);
  return tomorrow.getTime();
}

async function getData() {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  return result[STORAGE_KEY] || {
    days: {},
    tags: {},
    colors: {},
    settings: DEFAULT_SETTINGS,
    focusSessions: []
  };
}

async function saveData(data) {
  await chrome.storage.local.set({ [STORAGE_KEY]: data });
}

async function getSettings() {
  const data = await getData();
  return { ...DEFAULT_SETTINGS, ...data.settings };
}

async function incrementTime(domain, type, ms) {
  const data = await getData();
  const today = getTodayKey();
  
  if (!data.days[today]) {
    data.days[today] = { domains: {}, totals: { activeMs: 0, mediaMs: 0 } };
  }
  
  if (!data.days[today].domains[domain]) {
    data.days[today].domains[domain] = { activeMs: 0, mediaMs: 0 };
  }
  
  data.days[today].domains[domain][type] += ms;
  data.days[today].totals[type] += ms;
  
  await saveData(data);
}

async function handleInputActivity(tabId) {
  // Marquer l'activité récente pour ce tab
  const now = Date.now();
  state.lastInputActivity = now;
}

async function checkRecentInput(tabId) {
  const now = Date.now();
  return state.lastInputActivity && (now - state.lastInputActivity) < 15000;
}

async function handleMediaState(url, isPlaying) {
  const domain = extractDomain(url);
  
  if (isPlaying) {
    state.mediaPlayingSites.add(domain);
  } else {
    state.mediaPlayingSites.delete(domain);
  }
  
  console.log('🎵 Média:', domain, isPlaying ? 'lecture' : 'pause');
}

async function checkSiteLimits(domain) {
  const settings = await getSettings();
  const limit = settings.siteLimits[domain];
  
  if (!limit || !settings.notificationsEnabled) return;
  
  const data = await getData();
  const today = getTodayKey();
  const domainTime = data.days[today]?.domains[domain]?.activeMs || 0;
  const minutes = Math.floor(domainTime / 60000);
  
  // Notifications à 50%, 80%, 100% de la limite
  const thresholds = [0.5, 0.8, 1.0];
  
  for (const threshold of thresholds) {
    const thresholdMinutes = Math.floor(limit * threshold);
    
    if (minutes >= thresholdMinutes && !state.notificationTimeouts.has(`${domain}-${threshold}`)) {
      state.notificationTimeouts.set(`${domain}-${threshold}`, true);
      
      let message;
      if (threshold === 1.0) {
        message = `⚠️ Limite atteinte sur ${domain} (${limit}min)`;
      } else {
        message = `⏰ ${Math.floor(threshold * 100)}% de la limite sur ${domain}`;
      }
      
      chrome.notifications.create({
        type: 'basic',
        iconUrl: 'icons/icon48.png',
        title: 'Worldo - Limite de temps',
        message
      });
    }
  }
}

async function startFocusSession(config) {
  state.focusSession = {
    id: Date.now(),
    type: config.type,
    startTime: Date.now(),
    duration: config.duration * 60000, // minutes vers ms
    isPaused: false,
    elapsed: 0,
    stats: {
      tabChanges: 0,
      sitesVisited: new Set()
    }
  };
  
  // Notification de début
  if ((await getSettings()).notificationsEnabled) {
    chrome.notifications.create({
      type: 'basic',
      iconUrl: 'icons/icon48.png',
      title: 'Worldo - Session Focus',
      message: `Session ${config.type} démarrée (${config.duration}min)`
    });
  }
  
  await broadcastStateUpdate();
}

async function stopFocusSession() {
  if (!state.focusSession) return;
  
  const session = {
    ...state.focusSession,
    endTime: Date.now(),
    completed: state.focusSession.elapsed >= state.focusSession.duration
  };
  
  // Sauvegarder la session
  const data = await getData();
  data.focusSessions.push(session);
  await saveData(data);
  
  // Notification de fin
  const settings = await getSettings();
  if (settings.notificationsEnabled) {
    const minutes = Math.floor(session.elapsed / 60000);
    chrome.notifications.create({
      type: 'basic',
      iconUrl: 'icons/icon48.png',
      title: 'Worldo - Session terminée',
      message: `Session ${session.type}: ${minutes}min complétées`
    });
  }
  
  state.focusSession = null;
  await broadcastStateUpdate();
}

async function updateFocusSession(elapsed) {
  if (!state.focusSession || state.focusSession.isPaused) return;
  
  state.focusSession.elapsed += elapsed;
  
  // Auto-stop si durée atteinte
  if (state.focusSession.elapsed >= state.focusSession.duration) {
    await stopFocusSession();
  }
}

async function broadcastStateUpdate() {
  // Notifier toutes les pages ouvertes du changement d'état
  try {
    const tabs = await chrome.tabs.query({});
    const stateData = {
      currentDomain: state.currentDomain,
      isPaused: state.isPaused,
      focusSession: state.focusSession
    };
    
    for (const tab of tabs) {
      chrome.tabs.sendMessage(tab.id, {
        type: 'STATE_UPDATE',
        state: stateData
      }).catch(() => {}); // Ignorer les erreurs pour les onglets non compatible
    }
  } catch (error) {
    console.error('❌ Erreur broadcast:', error);
  }
}

async function exportToCSV() {
  const data = await getData();
  const rows = ['Date,Domaine,Tag,Temps Actif (min),Temps Média (min)'];
  
  for (const [date, dayData] of Object.entries(data.days)) {
    for (const [domain, times] of Object.entries(dayData.domains)) {
      const tag = data.tags[domain] || 'Non catégorisé';
      const activeMin = Math.round(times.activeMs / 60000);
      const mediaMin = Math.round(times.mediaMs / 60000);
      
      rows.push(`${date},${domain},${tag},${activeMin},${mediaMin}`);
    }
  }
  
  const csv = rows.join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  
  await chrome.downloads.download({
    url,
    filename: `worldo-export-${getTodayKey()}.csv`,
    saveAs: true
  });
}

async function dailyReset() {
  // Nettoyage quotidien des timeouts de notification
  state.notificationTimeouts.clear();
  console.log('🌅 Reset quotidien effectué');
}

async function restoreState() {
  // Restaurer l'état depuis le stockage si nécessaire
  state.lastActiveTime = Date.now();
  console.log('🔄 État restauré');
}
