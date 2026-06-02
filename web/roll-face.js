/* Shared Roll face engine: animates frame sequences (loop/pingpong/once/hold)
   from ROLL_ANIM, typewriters her line, then settles to idle. Each new message
   clears the last. Used by the in-app dock and the pop-out window. */
(function () {
  const ANIM = window.ROLL_ANIM;
  const NAMES = window.ROLL_EXPRESSIONS;

  // Roll's downloaded voice clips: name → file under assets/roll/voice. Chosen by MEANING
  // (pickClip, in the renderer), the same way an expression is chosen, and played as she starts
  // a line. Names are the Japanese she actually says.
  const CLIPS = {
    appear:   'ro_appear',              // entrance / power-on
    ikuyo:    'ro_toujou_ikuyo',        // 行くよ — here we go (new / changed task)
    mitete:   'ro_toujou_mitete',       // 見てて — watch this (a discovery)
    yattane:  'ro_syoupo-zu_yattane',   // やったね — we did it (success)
    tasukete: 'ro_nakamayobi_tasukete', // 助けて — help (error / needs you)
    makasete: 'ro_koutaitou_makasete',  // 任せて — leave it to me
    sore:     'ro_kiai_soreltu',        // それっ — there! (effort)
    ya:       'ro_kiai_yaltu',          // やっ — hyah! (effort)
    kya:      'ro_ko_kya-ltu',          // きゃっ — eek! (surprise)
  };

  // Shared across every RollFace in this renderer so the one-time mic unlock can never
  // be requested twice concurrently (no stacked macOS prompts).
  let unlockPromise = null;

  class RollFace {
    constructor(faceEl, msgEl, opts) {
      this.faceEl = faceEl;
      this.msgEl = msgEl;
      this.base = (opts && opts.base) || '../assets/'; // app: src/ → ../assets; the landing page overrides
      this.img = document.createElement('img');
      this.img.alt = 'Roll';
      this.faceEl.replaceChildren(this.img);
      this.talking = false;
      this.animTimer = null;
      this.typeTimer = null;
      this.settleTimer = null;
      this.queue = [];                       // lines waiting their turn (never interrupts the current one)
      this._clipBytes = {};                  // name -> fetched ArrayBuffer
      this._clipBufs = new Map();            // name -> Map(ctx -> decoded AudioBuffer)
      this._lastClipAt = 0;
      this.play('idle');
      this._initAudio();
    }

    _frame(f) { this.img.src = `${this.base}roll/frames/${f}.png`; }

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
      const lc = ch.toLowerCase();
      const code = (lc.charCodeAt(0) || 100);
      // higher, feminine register; pitch wanders with the letter = "speech"
      const freq = 520 + (code % 22) * 22;
      const isCons = lc >= 'a' && lc <= 'z' && 'aeiou'.indexOf(lc) === -1; // consonants get a vibrato wobble
      for (const ctx of [this._audio, this._cap]) {
        if (ctx) { try { this._tone(ctx, freq, isCons); } catch (_) { /* this sink blocked — skip */ } }
      }
    }

    // Animalese blip peak gain. User-adjustable via localStorage 'rollBlipVol' (0..1) so it can be
    // balanced against the recorded clips; default 0.55 maps to the original ~0.038 peak.
    _blipVol() {
      let v = 0.55;
      try { const s = localStorage.getItem('rollBlipVol'); if (s != null && s !== '') v = parseFloat(s); } catch (_) {}
      return isNaN(v) ? 0.55 : Math.max(0, Math.min(1, v));
    }

    // Emit one animalese "boop" at `freq` into a single AudioContext. A sine that glides down a
    // touch per letter (bubbly), consonants get a quick vibrato wobble for "speechy" texture, and
    // a subtle square wave an octave down adds retro low-end body. (Preview voice #6 + sub-bass.)
    _tone(ctx, freq, isCons) {
      if (ctx.state === 'suspended') ctx.resume();
      const t = ctx.currentTime;
      // soft lowpass for a rounded, non-buzzy tone
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass'; lp.frequency.value = 1900; lp.Q.value = 0.5;
      const peak = Math.max(0.0002, 0.07 * this._blipVol());
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(peak, t + 0.015); // gentle attack
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.1); // soft tail
      lp.connect(g).connect(ctx.destination);
      // main sine "boop" — glides down slightly across the note
      const o = ctx.createOscillator(); o.type = 'sine';
      o.frequency.setValueAtTime(freq * 1.15, t);
      o.frequency.exponentialRampToValueAtTime(freq * 0.9, t + 0.1);
      o.connect(lp); o.start(t); o.stop(t + 0.11);
      // subtle square sub-bass an octave down — low gain so it's felt as body, not heard as buzz
      const sub = ctx.createOscillator(); sub.type = 'square'; sub.frequency.value = freq * 0.5;
      const sg = ctx.createGain(); sg.gain.value = 0.14;
      sub.connect(sg).connect(lp); sub.start(t); sub.stop(t + 0.11);
      // consonants wobble (vibrato); vowels glide clean
      if (isCons) {
        const lfo = ctx.createOscillator(); lfo.frequency.value = 20;
        const lfoG = ctx.createGain(); lfoG.gain.value = 26;
        lfo.connect(lfoG).connect(o.detune); lfo.start(t); lfo.stop(t + 0.11);
      }
    }

    // Clip playback gain. Recorded clips are far hotter than the synthesized animalese (~0.04 peak),
    // so default low to sit alongside it; user-adjustable via localStorage 'rollClipVol' (0..1).
    _clipVol() {
      let v = 0.3;
      try { const s = localStorage.getItem('rollClipVol'); if (s != null && s !== '') v = parseFloat(s); } catch (_) {}
      return isNaN(v) ? 0.3 : Math.max(0, Math.min(1, v));
    }

    // Play a named voice clip into EVERY active context (default + optional capture) so it's both
    // audible AND captured by OBS — same routing as the animalese. Throttled + mute-aware. Buffers
    // are fetched once and decoded once per context, then reused.
    async _playClip(name) {
      try { if (localStorage.getItem('rollVoice') === 'off') return; } catch (_) {}
      const file = CLIPS[name];
      if (!file) return;
      const now = (typeof performance !== 'undefined' ? performance.now() : 0);
      if (this._lastClipAt && now - this._lastClipAt < 4500) return; // don't stack exclamations
      this._lastClipAt = now;
      let bytes = this._clipBytes[name];
      if (!bytes) {
        try { bytes = await (await fetch(`${this.base}roll/voice/${file}.wav`)).arrayBuffer(); this._clipBytes[name] = bytes; }
        catch (_) { return; }
      }
      let bufs = this._clipBufs.get(name);
      if (!bufs) { bufs = new Map(); this._clipBufs.set(name, bufs); }
      for (const ctx of [this._audio, this._cap]) {
        if (!ctx) continue;
        try {
          if (ctx.state === 'suspended') ctx.resume();
          let buf = bufs.get(ctx);
          if (!buf) { buf = await ctx.decodeAudioData(bytes.slice(0)); bufs.set(ctx, buf); }
          const src = ctx.createBufferSource(); src.buffer = buf;
          // CLIP_SCALE pulls the whole recorded-clip range down so the slider lives at a usable
          // position instead of pinned near zero — the raw .wav files are very hot.
          const g = ctx.createGain(); g.gain.value = this._clipVol() * 0.45;
          src.connect(g).connect(ctx.destination);
          src.start();
        } catch (_) { /* this sink failed — skip it */ }
      }
    }

    // First-boot flourish: she's hidden for a beat (caller pre-adds .warp-pending), then "appears"
    // with the clip + a CRT/teleport warp-in, settles, and greets.
    intro(greeting) {
      setTimeout(() => {
        this.faceEl.classList.remove('warp-pending');
        this.faceEl.classList.add('warp-in');
        this._playClip('appear');
        this.play('idle');
        setTimeout(() => this.faceEl.classList.remove('warp-in'), 1100);
        if (greeting) setTimeout(() => this.speak(greeting), 750);
      }, 900);
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

    // Render a line INSTANTLY — full text, settled expression, no typing/queue/blips. Used for
    // window-to-window handoff (dock ⇄ pop-out) so a message already on screen isn't re-typed.
    show(state) {
      if (!state || !state.line) return;
      this._clear();
      this.queue.length = 0;
      this.talking = false;
      if (this.onStart) { try { this.onStart(state); } catch (_) {} }
      const expr = NAMES.includes(state.expression) ? state.expression : 'neutral';
      this.msgEl.classList.remove('typing');
      this.msgEl.textContent = String(state.line);
      this.msgEl.scrollTop = this.msgEl.scrollHeight;
      this.play(expr);
    }

    _startSpeak(state) {
      this._clear();
      this.talking = true;
      // fires as the line ACTUALLY starts typing (not when it was queued) so a caller can
      // sync UI — e.g. the colored "which tab" header — to the message on screen.
      if (this.onStart) { try { this.onStart(state); } catch (_) {} }
      if (state.clip) this._playClip(state.clip); // her chosen exclamation, at the start of the line
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
