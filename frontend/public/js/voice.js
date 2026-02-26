// public/js/voice.js
// VoiceController: Web Speech API wrapper matching your Android SpeechRecognizer flow.
// - Commands recognized (case-insensitive):
//   connect, disconnect
//   start stream, stop stream
//   mute (mic), unmute (mic)
//   hide video, show video
//   send urgent message / urgent message
//   note  -> starts note-taking mode (partial transcripts throttled)
//   create -> stops note-taking mode and emits final note
//
// Callbacks:
//   onCommand(action, rawText)       action ∈ ['connect','disconnect','start_stream','stop_stream','mute','unmute','hide_video','show_video','urgent','start_note','stop_note']
//   onTranscript(text, isFinal)      partial/final transcript text
//   onListenStateChange(isListening) true/false when recognition starts/stops
//   onError(error)                   string message/code
//
// Usage example:
//   import { VoiceController } from '/public/js/voice.js';
//   const voice = new VoiceController({
//     onCommand: (a, t) => console.log(a, t),
//     onTranscript: (txt, fin) => console.log(fin ? 'FINAL' : 'PART', txt),
//   });
//   voice.start(); // must be triggered from a user gesture in most browsers

export class VoiceController {
  /**
   * @param {Object} opts
   * @param {string} [opts.lang='en-US']
   * @param {boolean} [opts.continuous=true]
   * @param {boolean} [opts.interimResults=true]
   * @param {number} [opts.partialThrottleMs=800]
   * @param {(action:string, rawText:string)=>void} [opts.onCommand]
   * @param {(text:string, isFinal:boolean)=>void} [opts.onTranscript]
   * @param {(isListening:boolean)=>void} [opts.onListenStateChange]
   * @param {(err:string)=>void} [opts.onError]
   * @param {Array<{re:RegExp, action:string}>} [opts.customMap]  // optional extra phrases
   */
  constructor(opts = {}) {
    this.lang = opts.lang || 'en-US';
    this.continuous = opts.continuous !== false;
    this.interimResults = opts.interimResults !== false;
    this.partialThrottleMs = Number.isFinite(opts.partialThrottleMs)
      ? opts.partialThrottleMs : 800;

    this.onCommand = typeof opts.onCommand === 'function' ? opts.onCommand : () => { };
    this.onTranscript = typeof opts.onTranscript === 'function' ? opts.onTranscript : () => { };
    this.onListenStateChange = typeof opts.onListenStateChange === 'function' ? opts.onListenStateChange : () => { };
    this.onError = typeof opts.onError === 'function' ? opts.onError : () => { };

    this._customMap = Array.isArray(opts.customMap) ? opts.customMap : [];

    this._SR = (typeof window !== 'undefined')
      ? (window.SpeechRecognition || window.webkitSpeechRecognition || null)
      : null;

    this._rec = null;
    this._listening = false;
    this._lastPartialAt = 0;

    this._noteMode = false;
    this._noteBuffer = '';

    this._bindHandlers();
  }

  static isAvailable() {
    return !!(typeof window !== 'undefined' && (window.SpeechRecognition || window.webkitSpeechRecognition));
    // For broader coverage, consider swapping to Azure/Vosk when unavailable.
  }

  isListening() { return this._listening; }

  setLanguage(lang) {
    this.lang = lang || 'en-US';
    if (this._rec) this._rec.lang = this.lang;
  }

  start() {
    if (!this._SR) { this.onError('speech_api_unavailable'); return false; }
    if (this._listening) return true;

    if (!this._rec) this._setup();

    try {
      this._rec.start();
      this._listening = true;
      this.onListenStateChange(true);
      return true;
    } catch (e) {
      this._listening = false;
      this.onListenStateChange(false);
      this.onError(this._errString(e));
      return false;
    }
  }

  stop() {
    if (!this._rec) return;
    try { this._rec.stop(); } catch { }
    this._listening = false;
    this.onListenStateChange(false);
    // If we were in note mode, finalize
    if (this._noteMode) this._emitStopNote();
  }

  destroy() {
    try { this.stop(); } catch { }
    this._rec = null;
  }

  // ---------------------- internals ----------------------

  _bindHandlers() {
    this._onResult = this._onResult.bind(this);
    this._onError = this._onError.bind(this);
    this._onEnd = this._onEnd.bind(this);
  }

  _setup() {
    this._rec = new this._SR();
    this._rec.lang = this.lang;
    this._rec.continuous = this.continuous;
    this._rec.interimResults = this.interimResults;

    this._rec.onresult = this._onResult;
    this._rec.onerror = this._onError;
    this._rec.onend = this._onEnd;
  }

  _onResult(e) {
    // Aggregate interim + final across results block
    let interim = '';
    let finalTxt = '';

    for (let i = e.resultIndex; i < e.results.length; i++) {
      const res = e.results[i];
      const txt = (res[0]?.transcript || '').toLowerCase().trim();
      if (!txt) continue;

      if (res.isFinal) finalTxt += (finalTxt ? ' ' : '') + txt;
      else interim += (interim ? ' ' : '') + txt;
    }

    // Partial transcript throttling
    if (interim) {
      const now = Date.now();
      if (now - this._lastPartialAt >= this.partialThrottleMs) {
        this._lastPartialAt = now;
        // Apply MRN formatting to interim transcripts
        const formattedInterim = this._formatMRN(interim);
        if (this._noteMode) {
          // Note mode buffers partials locally, still notify UI
          this.onTranscript(formattedInterim, false);
        } else {
          this.onTranscript(formattedInterim, false);
        }
      }
    }

    if (finalTxt) {
      // Apply MRN formatting to final transcript
      const formattedFinal = this._formatMRN(finalTxt);

      // If in note mode, buffer AND do not treat as a command
      if (this._noteMode) {
        this._noteBuffer += (this._noteBuffer ? ' ' : '') + formattedFinal;
        this.onTranscript(formattedFinal, true);
        // "create" stops note mode
        if (/\bcreate\b/.test(finalTxt)) {
          this._emitStopNote(); // includes final note buffer
        }
        return;
      }

      // Normal command mode
      const action = this._parseCommand(finalTxt);
      if (action) {
        this.onCommand(action, formattedFinal);
      } else {
        // Deliver final transcript even if no command matched
        this.onTranscript(formattedFinal, true);
      }
    }
  }

  _onError(ev) {
    const code = ev?.error || ev?.message || 'speech_error';
    this.onError(String(code));

    // Auto-restart on recoverable errors
    const recoverable = ['no-speech', 'aborted', 'audio-capture', 'network'];
    if (this._listening && recoverable.includes(code)) {
      try { this._rec.start(); } catch { }
    }
  }

  _onEnd() {
    // Chrome fires onend frequently; auto-restart if we want to keep listening
    if (this._listening) {
      try { this._rec.start(); } catch { }
    } else {
      this.onListenStateChange(false);
    }
  }

  _errString(e) {
    if (!e) return 'speech_error';
    if (typeof e === 'string') return e;
    return e.message || e.name || 'speech_error';
  }

  /**
   * Format MRN numbers in transcript text
   * Converts spoken MRN patterns to formatted MRN-XXXXXX format
   * Examples: "mrn aba 121" -> "MRN-ABA121"
   *           "m r n zero zero zero one a b c" -> "MRN-0001ABC"
   */
  _formatMRN(text) {
    if (!text) return text;

    // Pattern 1: "mrn" or "m r n" followed by alphanumeric characters with spaces/dashes
    // Captures: mrn aba 121, m r n zero zero zero one a b c, etc.
    let formatted = text.replace(
      /\b(m\s*r\s*n|mrn)[\s\-]*([\da-z]+(?:[\s\-]+[\da-z]+)*)\b/gi,
      (match, prefix, code) => {
        // Remove all spaces and dashes from the code part
        const cleanCode = code.replace(/[\s\-]+/g, '').toUpperCase();
        return `MRN-${cleanCode}`;
      }
    );

    // Pattern 2: Handle spelled out numbers (zero, one, two, etc.)
    const numberWords = {
      'zero': '0', 'one': '1', 'two': '2', 'three': '3', 'four': '4',
      'five': '5', 'six': '6', 'seven': '7', 'eight': '8', 'nine': '9'
    };

    // Convert number words within MRN codes
    formatted = formatted.replace(/MRN-([A-Z0-9\s]+)/gi, (match, code) => {
      let processedCode = code;
      Object.entries(numberWords).forEach(([word, digit]) => {
        const regex = new RegExp(word, 'gi');
        processedCode = processedCode.replace(regex, digit);
      });
      return `MRN-${processedCode.replace(/\s+/g, '')}`;
    });

    return formatted;
  }

  _emitStartNote() {
    if (this._noteMode) return;
    this._noteMode = true;
    this._noteBuffer = '';
    this.onCommand('start_note', 'note');
  }

  _emitStopNote() {
    if (!this._noteMode) return;
    this._noteMode = false;
    const finalNote = this._noteBuffer.trim();
    this._noteBuffer = '';
    // Emit final transcript of the note and a stop_note command
    if (finalNote) this.onTranscript(finalNote, true);
    this.onCommand('stop_note', 'create');
  }

  // ------------------ command parsing ------------------

  _parseCommand(s) {
    const text = String(s || '').toLowerCase().trim();
    if (!text) return null;

    // Custom overrides first
    for (const { re, action } of this._customMap) {
      if (re.test(text)) return action;
    }

    // Note-taking first (so "note" doesn't hit other rules)
    if (/\bnote\b/.test(text)) return (this._emitStartNote(), 'start_note');
    if (/\bcreate\b/.test(text)) return (this._emitStopNote(), 'stop_note');

    // Connect / disconnect
    if (/\bdisconnect\b/.test(text)) return 'disconnect';
    if (/\bconnect\b/.test(text)) return 'connect';

    // Unmute before mute to avoid matching "unmute" as "mute"
    if (/\bunmute(\s+mic(rophone)?)?\b/.test(text)) return 'unmute';
    if (/\bmute(\s+mic(rophone)?)?\b/.test(text)) return 'mute';

    // Start/Stop stream
    if (/\bstart( the)? (stream|video|camera)\b/.test(text)) return 'start_stream';
    if (/\bstop( the)? (stream|video|camera)\b/.test(text)) return 'stop_stream';

    // Hide/Show video
    if (/\bhide( the)? (video|camera|preview)?\b/.test(text)) return 'hide_video';
    if (/\bshow( the)? (video|camera|preview)?\b/.test(text)) return 'show_video';

    // Urgent message
    if (/\bsend( an)? urgent (message|alert)\b/.test(text)) return 'urgent';
    if (/\burgent\b.*\bmessage\b/.test(text)) return 'urgent';

    return null;
  }
}

// ---- ASR control helpers for UI (safe, additive) ----
// Allow UI to start/stop recognition without needing a direct ref.
// We look for a globally stored instance: window.voiceController or window.voice.
export function startRecognition() {
  try {
    const inst = (typeof window !== 'undefined') && (window.voiceController || window.voice);
    if (inst && typeof inst.start === 'function') inst.start();
  } catch { }
}

export function stopRecognition() {
  try {
    const inst = (typeof window !== 'undefined') && (window.voiceController || window.voice);
    if (inst && typeof inst.stop === 'function') inst.stop();
  } catch { }
}

// Optional: if a voice instance already exists on window, add helpers onto it.
// This does not override existing start()/stop(); it just adds new methods.
try {
  if (typeof window !== 'undefined') {
    const inst = window.voiceController || window.voice;
    if (inst && typeof inst === 'object') {
      inst.startRecognition = startRecognition;
      inst.stopRecognition = stopRecognition;
    }
  }
} catch { }


export default VoiceController;
