export class OrbUIController {
  constructor({ voiceButton, onVoiceToggle }) {
    this.voiceButton = voiceButton;
    this.onVoiceToggle = onVoiceToggle;

    this.micButton = document.getElementById('micButton');
    this.micBtnInner = document.getElementById('mb');
    this.micInstruction = document.getElementById('micInstruction');
    this.orbVisual = document.getElementById('orbVisual');
    this.responseCard = document.getElementById('responseCard');
    this.responseText = document.getElementById('responseText');

    this.isListening = false;
    this.isMobile = this._detectMobile();
    this.pressTimer = null;
    this.isPressing = false;
    this._touchHandled = false;

    this._initAudioContext();
    this._init();
  }

  _detectMobile() {
    return false;
  }

  _initAudioContext() {
    this._audioCtx = null;
    this._analyser = null;
    this._micStream = null;
  }

  _init() {
    if (!this.micButton) {
      console.warn('[OrbUI] Mic button not found');
      return;
    }

    this._setupDesktopEvents();
    if (this.micInstruction) {
      this.micInstruction.innerHTML = 'Click to <b>Speak</b>';
    }

    console.log('[OrbUI] Initialized in TAP-TOGGLE mode (all platforms)');
  }

  _setupDesktopEvents() {
    this.micButton.addEventListener('click', () => {
      this._toggleVoice();
    });
  }

  _setupMobileEvents() {
    let touchStartTime = 0;
    let touchMoved = false;

    this.micButton.addEventListener('touchstart', (e) => {
      e.preventDefault();
      this._touchHandled = true;
      touchStartTime = Date.now();
      touchMoved = false;
      this._startVoice();
      console.log('[OrbUI] Touch start - voice starting');
    }, { passive: false });

    this.micButton.addEventListener('touchmove', (e) => {
      touchMoved = true;
    }, { passive: false });

    this.micButton.addEventListener('touchend', (e) => {
      e.preventDefault();
      const touchDuration = Date.now() - touchStartTime;
      console.log('[OrbUI] Touch end - duration:', touchDuration, 'ms, moved:', touchMoved);

      // If it was a very short tap (less than 100ms) and didn't move, treat as toggle instead
      if (touchDuration < 100 && !touchMoved) {
        console.log('[OrbUI] Quick tap detected, treating as toggle');
        this._toggleVoice();
      } else {
        this._stopVoice();
      }

      setTimeout(() => { this._touchHandled = false; }, 300);
    }, { passive: false });

    this.micButton.addEventListener('touchcancel', (e) => {
      e.preventDefault();
      console.log('[OrbUI] Touch cancelled');
      this._stopVoice();
      setTimeout(() => { this._touchHandled = false; }, 300);
    }, { passive: false });

    // Fallback for devices that don't fire touch events properly (some Android WebView versions)
    this.micButton.addEventListener('click', (e) => {
      if (this._touchHandled) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      console.log('[OrbUI] Click event (fallback)');
      this._toggleVoice();
    });
  }

  _toggleVoice() {
    if (this.isListening) {
      this._stopVoice();
    } else {
      this._startVoice();
    }
  }

  async _startVoice() {
    if (this.isListening) return;
    console.log('[OrbUI] Starting voice...');

    if (this.voiceButton && typeof this.onVoiceToggle === 'function') {
      this.onVoiceToggle(true);
    } else if (this.voiceButton) {
      this.voiceButton.click();
    }

    this.isListening = true;
    this._updateUI(true);
  }

  _stopVoice() {
    if (!this.isListening) return;
    console.log('[OrbUI] Stopping voice...');

    if (this.voiceButton && typeof this.onVoiceToggle === 'function') {
      this.onVoiceToggle(false);
    } else if (this.voiceButton) {
      this.voiceButton.click();
    }

    this.isListening = false;
    this._updateUI(false);
  }

  async _startMicAnalyser() {
    try {
      if (!navigator.mediaDevices?.getUserMedia) return;
      this._micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      this._audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (this._audioCtx.state === 'suspended') await this._audioCtx.resume();
      this._analyser = this._audioCtx.createAnalyser();
      this._analyser.fftSize = 1024;
      this._analyser.smoothingTimeConstant = .72;
      this._audioCtx.createMediaStreamSource(this._micStream).connect(this._analyser);
      const dataArr = new Uint8Array(this._analyser.frequencyBinCount);

      if (window._xrCanvas) {
        window._xrCanvas.analyser = this._analyser;
        window._xrCanvas.dataArr = dataArr;
        window._xrCanvas.listening = true;
      }
    } catch (e) {
      console.warn('[OrbUI] Mic analyser failed:', e.message);
    }
  }

  _stopMicAnalyser() {
    if (window._xrCanvas) {
      window._xrCanvas.listening = false;
      window._xrCanvas.dataArr = null;
      window._xrCanvas.analyser = null;
    }
    if (this._micStream) {
      this._micStream.getTracks().forEach(t => t.stop());
      this._micStream = null;
    }
    if (this._audioCtx) {
      this._audioCtx.close().catch(() => {});
      this._audioCtx = null;
      this._analyser = null;
    }
  }

  _updateUI(active) {
    if (this.micBtnInner) {
      this.micBtnInner.classList.toggle('on', active);
    }

    if (this.orbVisual) {
      this.orbVisual.classList.toggle('active', active);
    }

    if (this.responseCard) {
      this.responseCard.classList.toggle('active', active);
    }

    if (this.micInstruction) {
      if (active) {
        this.micInstruction.innerHTML = '<b>Listening...</b>';
      } else {
        this.micInstruction.innerHTML = 'Click to <b>Speak</b>';
      }
    }
  }

  updateResponse(text, isPlaceholder = false) {
    if (!this.responseText) return;
    this.responseText.textContent = text;
    if (isPlaceholder) {
      this.responseText.style.opacity = '0.5';
      this.responseText.style.fontStyle = 'italic';
    } else {
      this.responseText.style.opacity = '1';
      this.responseText.style.fontStyle = 'normal';
    }
  }

  syncVoiceState(listening) {
    if (this.isListening !== listening) {
      this.isListening = listening;
      this._updateUI(listening);
    }
  }

  destroy() {
    if (this.pressTimer) {
      clearTimeout(this.pressTimer);
    }
    this._stopMicAnalyser();
  }
}
