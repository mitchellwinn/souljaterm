/* Shared Roll face engine: animates frame sequences (loop/pingpong/once/hold)
   from ROLL_ANIM, typewriters her line, then settles to idle. Each new message
   clears the last. Used by the in-app dock and the pop-out window. */
(function () {
  const ANIM = window.ROLL_ANIM;
  const NAMES = window.ROLL_EXPRESSIONS;

  // Shared across every RollFace in this renderer so the one-time mic unlock can never
  // be requested twice concurrently (no stacked macOS prompts).
  let unlockPromise = null;

  class RollFace {
    constructor(faceEl, msgEl) {
      this.faceEl = faceEl;
      this.msgEl = msgEl;
      this.img = document.createElement('img');
      this.img.alt = 'Roll';
      this.faceEl.replaceChildren(this.img);
      this.talking = false;
      this.animTimer = null;
      this.typeTimer = null;
      this.settleTimer = null;
      this.queue = [];                       // lines waiting their turn (never interrupts the current one)
      this.play('idle');
      this._initAudio();
    }

    _frame(f) { this.img.src = `../assets/roll/frames/${f}.png`; }

    // Resolve which output device Roll should sing through. Default: prefer a virtual
    // device (BlackHole) so OBS can capture her voice off that DEVICE — ScreenCaptureKit
    // app-audio capture can't see Electron's renderer audio, but a device tap can.
    // Override via localStorage 'rollSink':
    //   'default' → system default output (no routing)
    //   <substr>  → first audiooutput whose label contains <substr> (case-insensitive)
    // The chosen deviceId is cached in 'rollSinkId'; the mic unlock used to read device
    // labels happens AT MOST ONCE EVER (gated by 'rollMicTried' across launches + a shared
    // in-flight promise across windows) so macOS never stacks repeat prompts.
    async _resolveSinkId() {
      let pref = null;
      try { pref = localStorage.getItem('rollSink'); } catch (_) {}
      if (pref === 'default') return null;
      const match = (pref && pref.trim()) ? pref.trim().toLowerCase() : 'blackhole';
      try { const c = localStorage.getItem('rollSinkId'); if (c) return c; } catch (_) {}
      const md = navigator.mediaDevices;
      if (!md || !md.enumerateDevices) return null;
      const find = (list) => list.find((d) => d.kind === 'audiooutput' && (d.label || '').toLowerCase().includes(match));
      let dev = find(await md.enumerateDevices());
      // Labels stay hidden until a media device is unlocked once. Try that a single time —
      // ever — then stop, so a denied/dismissed prompt doesn't nag on every launch.
      if (!dev) {
        let tried = false;
        try { tried = localStorage.getItem('rollMicTried') === '1'; } catch (_) {}
        if (!tried) {
          try { localStorage.setItem('rollMicTried', '1'); } catch (_) {} // set BEFORE asking
          unlockPromise = unlockPromise || md.getUserMedia({ audio: true })
            .then((s) => { s.getTracks().forEach((t) => t.stop()); })
            .catch(() => { /* mic blocked — fall back to default output */ });
          await unlockPromise;
          dev = find(await md.enumerateDevices());
        }
      }
      if (dev && dev.deviceId) {
        try { localStorage.setItem('rollSinkId', dev.deviceId); } catch (_) {}
        return dev.deviceId;
      }
      return null;
    }

    // Roll speaks through TWO output contexts at once:
    //   _audio — the system default output, NEVER routed, so YOU always hear her.
    //   _cap   — a best-effort second context pinned to the capture device (BlackHole)
    //            so OBS can tap her voice off that DEVICE. Purely additive: if the sink
    //            can't be resolved (mic denied, no BlackHole, no setSinkId support), Roll
    //            still plays on _audio. We never mute the default output to feed OBS.
    _initAudio() {
      const Ctor = window.AudioContext || window.webkitAudioContext;
      if (!Ctor) return;
      try { this._audio = new Ctor(); } catch (_) { return; /* audio unavailable */ }
      if (typeof this._audio.setSinkId !== 'function') return; // no per-context routing here
      this._resolveSinkId()
        .then((id) => {
          if (!id) return; // 'default' pref, or no capture device — default output is enough
          const cap = new Ctor();
          return cap.setSinkId(id).then(() => {
            this._cap = cap;
            console.log('[Roll] OBS tap → sink', id);
          });
        })
        .catch(() => { /* capture routing unavailable — default output only */ });
    }

    // Animal-Crossing-style "animalese" blip per character, fanned to every active
    // context (default + optional capture) so it's audible AND captured.
    _blip(ch) {
      try {
        if (localStorage.getItem('rollVoice') === 'off') return;
      } catch (_) {}
      const code = (ch.toLowerCase().charCodeAt(0) || 100);
      // higher, feminine register; pitch wanders with the letter = "speech"
      const freq = 620 + (code % 22) * 26;
      for (const ctx of [this._audio, this._cap]) {
        if (ctx) { try { this._tone(ctx, freq); } catch (_) { /* this sink blocked — skip */ } }
      }
    }

    // Emit one animalese blip at `freq` into a single AudioContext.
    _tone(ctx, freq) {
      if (ctx.state === 'suspended') ctx.resume();
      const t = ctx.currentTime;
      // soft lowpass for a rounded, non-buzzy tone
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass'; lp.frequency.value = 2400; lp.Q.value = 0.7;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.038, t + 0.012); // gentle attack
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.09); // soft tail
      lp.connect(g).connect(ctx.destination);
      // main triangle voice + a quiet detuned sine for a subtle cyborg shimmer
      const o1 = ctx.createOscillator(); o1.type = 'triangle'; o1.frequency.value = freq;
      const o2 = ctx.createOscillator(); o2.type = 'sine'; o2.frequency.value = freq * 1.5; o2.detune.value = 8;
      const g2 = ctx.createGain(); g2.gain.value = 0.35;
      o1.connect(lp); o2.connect(g2).connect(lp);
      o1.start(t); o2.start(t);
      o1.stop(t + 0.1); o2.stop(t + 0.1);
    }

    play(name) {
      const a = ANIM[name] || ANIM.neutral;
      if (this.animTimer) { clearInterval(this.animTimer); this.animTimer = null; }
      let seq = a.frames.slice();
      if (a.mode === 'pingpong' && seq.length > 2) seq = seq.concat(a.frames.slice(1, -1).reverse());
      this._frame(seq[0]);
      if (a.mode === 'hold' || seq.length < 2) return;
      let i = 0;
      this.animTimer = setInterval(() => {
        i += 1;
        if (a.mode === 'once' && i >= seq.length) {
          clearInterval(this.animTimer); this.animTimer = null;
          this._frame(seq[seq.length - 1]);
          return;
        }
        this._frame(seq[i % seq.length]);
      }, 1000 / (a.fps || 4));
    }

    _clear() {
      if (this.typeTimer) { clearInterval(this.typeTimer); this.typeTimer = null; }
      if (this.settleTimer) { clearTimeout(this.settleTimer); this.settleTimer = null; }
    }

    // Public entry: never cut off a line that's mid-type. If she's talking (or lines are
    // already waiting), queue this one and let the current finish + breathe first.
    speak(state) {
      if (!state || !state.line) return;
      if (this.talking || this.queue.length) {
        if (this.queue.length >= 4) this.queue.shift(); // keep the backlog recent, not infinite
        this.queue.push(state);
        return;
      }
      this._startSpeak(state);
    }

    _startSpeak(state) {
      this._clear();
      this.talking = true;
      const expr = NAMES.includes(state.expression) ? state.expression : 'neutral';
      const a = ANIM[expr];
      // animate the emotion while talking; if it's static, flap the mouth instead
      const talkAnim = (a && a.frames.length > 1 && a.mode !== 'hold') ? expr : 'talk';
      this.play(talkAnim);

      this.msgEl.textContent = '';
      this.msgEl.classList.add('typing');
      const text = String(state.line);
      let i = 0;
      this.typeTimer = setInterval(() => {
        const ch = text[i];
        this.msgEl.textContent = text.slice(0, ++i);
        this.msgEl.scrollTop = this.msgEl.scrollHeight; // keep the newest line in view
        if (ch && ch.trim() && i % 2 === 0) this._blip(ch); // every other letter = animalese
        if (i >= text.length) this._finish(expr);
      }, 38);
    }

    _finish(expr) {
      this._clear();
      this.talking = false;
      this.msgEl.classList.remove('typing');
      this.play(expr);                       // settle on the emotion
      if (this.queue.length) {
        // hold the finished line on screen at least half a second, then type the next one
        this.settleTimer = setTimeout(() => { this._startSpeak(this.queue.shift()); }, 500);
      } else {
        this.settleTimer = setTimeout(() => { if (!this.talking) this.play('idle'); }, 2000);
      }
    }
  }

  window.RollFace = RollFace;
})();
