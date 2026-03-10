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
    const ua = navigator.userAgent || '';
    return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(ua) &&
      !(/Windows NT|Macintosh|CrOS/i.test(ua));
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

    if (this.isMobile) {
      this._setupMobileEvents();
      if (this.micInstruction) {
        this.micInstruction.innerHTML = 'Hold to <b>Speak</b>';
      }
    } else {
      this._setupDesktopEvents();
      if (this.micInstruction) {
        this.micInstruction.innerHTML = 'Click to <b>Speak</b>';
      }
    }

    console.log('[OrbUI] Initialized in', this.isMobile ? 'MOBILE' : 'DESKTOP', 'mode');
  }

  _setupDesktopEvents() {
    this.micButton.addEventListener('click', () => {
      this._toggleVoice();
    });
  }

  _setupMobileEvents() {
    this.micButton.addEventListener('touchstart', (e) => {
      e.preventDefault();
      this._touchHandled = true;
      this._startVoice();
    }, { passive: false });

    this.micButton.addEventListener('touchend', (e) => {
      e.preventDefault();
      this._stopVoice();
      setTimeout(() => { this._touchHandled = false; }, 300);
    }, { passive: false });

    this.micButton.addEventListener('touchcancel', (e) => {
      e.preventDefault();
      this._stopVoice();
      setTimeout(() => { this._touchHandled = false; }, 300);
    }, { passive: false });

    this.micButton.addEventListener('click', (e) => {
      if (this._touchHandled) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
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
    await this._startMicAnalyser();
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
    this._stopMicAnalyser();
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
      } else if (this.isMobile) {
        this.micInstruction.innerHTML = 'Hold to <b>Speak</b>';
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
      if (listening) {
        this._startMicAnalyser();
      } else {
        this._stopMicAnalyser();
      }
    }
  }

  destroy() {
    if (this.pressTimer) {
      clearTimeout(this.pressTimer);
    }
    this._stopMicAnalyser();
  }
}
