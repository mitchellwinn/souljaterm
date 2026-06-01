/* Shared Roll face engine: animates frame sequences (loop/pingpong/once/hold)
   from ROLL_ANIM, typewriters her line, then settles to idle. Each new message
   clears the last. Used by the in-app dock and the pop-out window. */
(function () {
  const ANIM = window.ROLL_ANIM;
  const NAMES = window.ROLL_EXPRESSIONS;

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
      this.play('idle');
    }

    _frame(f) { this.img.src = `../assets/roll/frames/${f}.png`; }

    // Animal-Crossing-style "animalese" blip per character.
    _blip(ch) {
      try {
        if (localStorage.getItem('rollVoice') === 'off') return;
      } catch (_) {}
      try {
        const ctx = this._audio || (this._audio = new (window.AudioContext || window.webkitAudioContext)());
        if (ctx.state === 'suspended') ctx.resume();
        const code = (ch.toLowerCase().charCodeAt(0) || 100);
        const t = ctx.currentTime;
        // higher, feminine register; pitch wanders with the letter = "speech"
        const freq = 620 + (code % 22) * 26;
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
      } catch (_) { /* audio blocked — stay silent */ }
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

    speak(state) {
      if (!state || !state.line) return;
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
        if (ch && ch.trim() && i % 2 === 0) this._blip(ch); // every other letter = animalese
        if (i >= text.length) this._finish(expr);
      }, 38);
    }

    _finish(expr) {
      this._clear();
      this.talking = false;
      this.msgEl.classList.remove('typing');
      this.play(expr);                       // settle on the emotion
      this.settleTimer = setTimeout(() => { if (!this.talking) this.play('idle'); }, 2000);
    }
  }

  window.RollFace = RollFace;
})();
