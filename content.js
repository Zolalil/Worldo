// Content Script - Détection d'activité et média
(function() {
  'use strict';
  
  let lastInputTime = 0;
  let mediaElements = new Set();
  let isMediaPlaying = false;
  let observer = null;
  
  // Initialisation
  initialize();
  
  function initialize() {
    setupInputTracking();
    setupMediaTracking();
    setupMediaObserver();
    
    console.log('🎯 Worldo content script initialisé sur:', location.hostname);
  }
  
  // Tracking des inputs utilisateur
  function setupInputTracking() {
    const inputEvents = ['mousedown', 'mousemove', 'keydown', 'scroll', 'click'];
    
    inputEvents.forEach(eventType => {
      document.addEventListener(eventType, throttle(handleInputActivity, 1000), {
        passive: true,
        capture: true
      });
    });
  }
  
  function handleInputActivity() {
    const now = Date.now();
    
    // Éviter le spam d'événements
    if (now - lastInputTime < 1000) return;
    lastInputTime = now;
    
    // Notifier le background script
    chrome.runtime.sendMessage({
      type: 'ATT_INPUT',
      timestamp: now
    }).catch(() => {}); // Ignorer les erreurs de connexion
  }
  
  // Tracking média robuste
  function setupMediaTracking() {
    // Écouter les éléments média existants
    scanForMediaElements();
    
    // Scan périodique pour les éléments ajoutés dynamiquement
    setInterval(scanForMediaElements, 1500);
  }
  
  function scanForMediaElements() {
    const allMedia = document.querySelectorAll('video, audio');
    
    allMedia.forEach(element => {
      if (!mediaElements.has(element)) {
        mediaElements.add(element);
        attachMediaListeners(element);
      }
    });
  }
  
  function attachMediaListeners(element) {
    const events = ['play', 'pause', 'ended', 'ratechange', 'volumechange'];
    
    events.forEach(eventType => {
      element.addEventListener(eventType, () => {
        handleMediaEvent(element, eventType);
      }, { passive: true });
    });
  }
  
  function handleMediaEvent(element, eventType) {
    const wasPlaying = isMediaPlaying;
    
    // Déterminer le nouvel état
    const anyPlaying = Array.from(mediaElements).some(media => 
      !media.paused && !media.ended && media.readyState > 2
    );
    
    isMediaPlaying = anyPlaying;
    
    // Notifier seulement si changement d'état
    if (wasPlaying !== isMediaPlaying) {
      chrome.runtime.sendMessage({
        type: 'ATT_MEDIA',
        isPlaying: isMediaPlaying,
        element: {
          tagName: element.tagName,
          src: element.src || element.currentSrc,
          title: element.title || document.title
        }
      }).catch(() => {});
      
      console.log('🎵 Média:', isMediaPlaying ? 'lecture' : 'pause');
    }
  }
  
  // Observer pour nouveaux éléments média
  function setupMediaObserver() {
    observer = new MutationObserver(mutations => {
      mutations.forEach(mutation => {
        mutation.addedNodes.forEach(node => {
          if (node.nodeType === Node.ELEMENT_NODE) {
            // Vérifier si c'est un élément média
            if (node.matches && node.matches('video, audio')) {
              if (!mediaElements.has(node)) {
                mediaElements.add(node);
                attachMediaListeners(node);
              }
            }
            
            // Vérifier les sous-éléments
            const subMedia = node.querySelectorAll && node.querySelectorAll('video, audio');
            if (subMedia) {
              subMedia.forEach(media => {
                if (!mediaElements.has(media)) {
                  mediaElements.add(media);
                  attachMediaListeners(media);
                }
              });
            }
          }
        });
      });
    });
    
    observer.observe(document.body || document.documentElement, {
      childList: true,
      subtree: true
    });
  }
  
  // Gestion des messages du background
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    switch (message.type) {
      case 'STATE_UPDATE':
        handleStateUpdate(message.state);
        break;
        
      case 'GET_MEDIA_STATE':
        sendResponse({
          isPlaying: isMediaPlaying,
          mediaCount: mediaElements.size
        });
        break;
    }
  });
  
  function handleStateUpdate(state) {
    // Réagir aux changements d'état si nécessaire
    if (state.focusSession && state.focusSession.type === 'strict') {
      // Mode focus strict - pourrait bloquer certains éléments
      console.log('🔒 Mode focus strict activé');
    }
  }
  
  // Utilitaires
  function throttle(func, limit) {
    let inThrottle;
    return function() {
      const args = arguments;
      const context = this;
      if (!inThrottle) {
        func.apply(context, args);
        inThrottle = true;
        setTimeout(() => inThrottle = false, limit);
      }
    };
  }
  
  // Nettoyage à la fermeture
  window.addEventListener('beforeunload', () => {
    if (observer) {
      observer.disconnect();
    }
  });
  
  // Gestion des erreurs
  window.addEventListener('error', (event) => {
    console.error('❌ Erreur content script:', event.error);
  });
  
})();
