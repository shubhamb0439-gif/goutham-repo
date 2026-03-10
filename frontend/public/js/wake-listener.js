export class WakeListener {
  constructor({ wakePhrase = 'hey rhea', onWake, onError } = {}) {
    this._wakePhrase = wakePhrase.toLowerCase().trim();
    this._onWake = typeof onWake === 'function' ? onWake : () => {};
    this._onError = typeof onError === 'function' ? onError : () => {};

    this._SR = (typeof window !== 'undefined')
      ? (window.SpeechRecognition || window.webkitSpeechRecognition || null)
      : null;

    this._rec = null;
    this._running = false;
    this._paused = false;
    this._destroyed = false;

    this._cooldownMs = 2000;
    this._lastWakeAt = 0;
    this._restartAttempts = 0;
    this._maxRestartAttempts = 10;
    this._healthCheckTimer = null;
    this._lastActivityAt = 0;

    this._onResult = this._onResult.bind(this);
    this._onEnd = this._onEnd.bind(this);
    this._onRecError = this._onRecError.bind(this);
  }

  static isAvailable() {
    return !!(typeof window !== 'undefined' &&
      (window.SpeechRecognition || window.webkitSpeechRecognition));
  }

  start() {
    if (this._destroyed || this._running) return false;
    if (!this._SR) {
      this._onError('speech_api_unavailable');
      return false;
    }

    this._buildRecognizer();

    try {
      this._rec.start();
      this._running = true;
      this._restartAttempts = 0;
      this._lastActivityAt = Date.now();
      this._startHealthCheck();
      console.log('[WakeListener] Started listening for "' + this._wakePhrase + '"');
      return true;
    } catch (e) {
      this._running = false;
      this._onError(e?.message || 'start_failed');
      return false;
    }
  }

  stop() {
    this._running = false;
    this._paused = false;
    this._stopHealthCheck();
    if (this._rec) {
      try { this._rec.stop(); } catch {}
    }
    console.log('[WakeListener] Stopped');
  }

  pause() {
    if (!this._running) return;
    this._paused = true;
    this._stopHealthCheck();
    if (this._rec) {
      try { this._rec.stop(); } catch {}
    }
    console.log('[WakeListener] Paused (button active)');
  }

  resume() {
    if (!this._running || this._destroyed) return;
    this._paused = false;
    this._restartAttempts = 0;
    this._lastActivityAt = Date.now();
    this._restartRecognizer();
    this._startHealthCheck();
    console.log('[WakeListener] Resumed');
  }

  forceResume() {
    if (this._destroyed) return;
    this._paused = false;
    this._restartAttempts = 0;
    this._lastActivityAt = Date.now();
    if (!this._running) {
      this._running = true;
    }
    this._buildRecognizer();
    try {
      this._rec.start();
    } catch (e) {
      console.warn('[WakeListener] forceResume start failed:', e?.message);
      setTimeout(() => {
        if (this._running && !this._paused && !this._destroyed) {
          try {
            this._buildRecognizer();
            this._rec.start();
            this._lastActivityAt = Date.now();
          } catch {}
        }
      }, 500);
    }
    this._startHealthCheck();
    console.log('[WakeListener] Force-resumed with fresh recognizer');
  }

  isPaused() { return this._paused; }
  isRunning() { return this._running; }

  destroy() {
    this._destroyed = true;
    this.stop();
    this._rec = null;
  }

  _buildRecognizer() {
    if (this._rec) {
      try { this._rec.stop(); } catch {}
    }

    this._rec = new this._SR();
    this._rec.lang = 'en-US';
    this._rec.continuous = true;
    this._rec.interimResults = true;
    this._rec.maxAlternatives = 3;

    this._rec.onresult = this._onResult;
    this._rec.onend = this._onEnd;
    this._rec.onerror = this._onRecError;
  }

  _onResult(e) {
    this._lastActivityAt = Date.now();
    this._restartAttempts = 0;
    if (this._paused || !this._running) return;

    for (let i = e.resultIndex; i < e.results.length; i++) {
      const result = e.results[i];
      for (let alt = 0; alt < result.length; alt++) {
        const text = (result[alt]?.transcript || '').toLowerCase().trim();
        if (this._containsWakePhrase(text)) {
          const now = Date.now();
          if (now - this._lastWakeAt < this._cooldownMs) return;
          this._lastWakeAt = now;

          console.log('[WakeListener] Wake phrase detected:', text);
          this._onWake(text);
          return;
        }
      }
    }
  }

  _containsWakePhrase(text) {
    if (!text) return false;
    const normalized = text.replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();

    if (normalized.includes(this._wakePhrase)) return true;

    const variants = [
      'hey rhea', 'hey ria', 'hey reya', 'hey rea',
      'a rhea', 'hey rhia', 'hay rhea', 'hey riya',
      'he rhea', 'hey reia', 'hey rea', 'hey reha',
      'hey aria', 'hey areya', 'hey raya', 'hey reeha',
      'hey reah', 'hey rea', 'heyria', 'heyrhea',
      'hey rita', 'hey leah', 'hey raha', 'hey reia',
      'a ria', 'a reya', 'a reha', 'heyreeya',
      'hey rear', 'hey real', 'hey ray', 'hey re',
      'hey ree', 'hey ria', 'hey rihya',
      'hey ria', 'hey reeya', 'hey reeah',
      'hi rhea', 'hi ria', 'hi reya', 'hi reha', 'hi rea'
    ];
    for (const v of variants) {
      if (normalized.includes(v)) return true;
    }

    if (/\bh?e+y?\s*r[ehi]+a?\b/.test(normalized)) return true;

    return false;
  }

  _onEnd() {
    this._lastActivityAt = Date.now();
    if (!this._running || this._destroyed) return;
    if (this._paused) return;
    console.log('[WakeListener] onend - restarting...');
    setTimeout(() => this._restartRecognizer(), 200);
  }

  _onRecError(ev) {
    const code = ev?.error || 'unknown';
    console.log('[WakeListener] Error:', code);
    if (code === 'aborted' && this._paused) return;

    const recoverable = ['no-speech', 'aborted', 'audio-capture', 'network'];
    if (this._running && !this._paused && !this._destroyed && recoverable.includes(code)) {
      const delay = code === 'no-speech' ? 100 : 500;
      setTimeout(() => this._restartRecognizer(), delay);
    } else if (!recoverable.includes(code)) {
      this._onError(code);
    }
  }

  _restartRecognizer() {
    if (!this._running || this._paused || this._destroyed) return;

    this._restartAttempts++;
    if (this._restartAttempts > this._maxRestartAttempts) {
      console.warn('[WakeListener] Too many restart attempts, rebuilding recognizer...');
      this._restartAttempts = 0;
      this._buildRecognizer();
    }

    try {
      this._rec.start();
      this._lastActivityAt = Date.now();
    } catch (e) {
      const errMsg = e?.message || '';
      if (errMsg.includes('already started')) {
        this._restartAttempts = 0;
        return;
      }
      setTimeout(() => {
        if (this._running && !this._paused && !this._destroyed) {
          try {
            this._buildRecognizer();
            this._rec.start();
            this._lastActivityAt = Date.now();
            this._restartAttempts = 0;
          } catch (e2) {
            console.warn('[WakeListener] Rebuild+start failed:', e2?.message);
          }
        }
      }, 1000);
    }
  }

  _startHealthCheck() {
    this._stopHealthCheck();
    this._healthCheckTimer = setInterval(() => {
      if (!this._running || this._paused || this._destroyed) return;
      const silenceMs = Date.now() - this._lastActivityAt;
      if (silenceMs > 30000) {
        console.log('[WakeListener] Health check: no activity for', Math.round(silenceMs / 1000), 's - restarting');
        this._restartAttempts = 0;
        try { this._rec.stop(); } catch {}
        setTimeout(() => {
          this._buildRecognizer();
          this._restartRecognizer();
        }, 300);
        this._lastActivityAt = Date.now();
      }
    }, 15000);
  }

  _stopHealthCheck() {
    if (this._healthCheckTimer) {
      clearInterval(this._healthCheckTimer);
      this._healthCheckTimer = null;
    }
  }
}

export default WakeListener;
