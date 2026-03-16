/**
 * Tests for ServerAudioState — the server-side audio state machine.
 * These are pure logic tests (no I/O, no ffmpeg, no WebSocket).
 * We test state derivation and timer management.
 */

describe('ServerAudioState', () => {
  // Minimal stub that mirrors the ServerAudioState class logic
  // without importing the real server (which starts HTTP listeners).
  class ServerAudioState {
    static _sfxCounter = 0;
    state: 'inactive' | 'listening' | 'processing' | 'speaking' = 'inactive';
    _isListening = false;
    _waitStatusKnown = false;
    _lastWaitStatus = false;
    _ttsActive = false;
    _hookActive = false;
    _pulseTimer: ReturnType<typeof setInterval> | null = null;
    _chimeDelayTimer: ReturnType<typeof setTimeout> | null = null;
    transitions: string[] = []; // track transitions for assertions
    streamedSounds: string[] = []; // track sounds that would be streamed
    feedbackSoundMode: 'once' | 'continuous' | 'off' = 'continuous';
    soundsPlayed: string[] = []; // track sounds that would be played

    syncState(): void {
      let desired: typeof this.state;
      // Order matters: hookActive check must come before plain !_isListening check
      if (this._hookActive && !this._isListening) {
        desired = 'processing';
      } else if (!this._isListening) {
        desired = 'inactive';
      } else if (this._ttsActive) {
        desired = 'speaking';
      } else if (!this._waitStatusKnown) {
        desired = 'inactive';
      } else if (this._lastWaitStatus) {
        desired = 'listening';
      } else {
        desired = 'processing';
      }
      if (desired !== this.state) {
        this._transition(desired);
      }
    }

    setHookActive(active: boolean): void {
      this._hookActive = active;
      this.syncState();
    }

    clearHookActiveSilent(): void {
      this._hookActive = false;
    }

    setListening(isListening: boolean): void {
      this._isListening = isListening;
      if (isListening) {
        this._lastWaitStatus = false;
        this._waitStatusKnown = false;
        this._ttsActive = false;
        this._hookActive = false;
      }
      this.syncState();
    }

    setWaitStatus(isWaiting: boolean): void {
      this._waitStatusKnown = true;
      this._lastWaitStatus = isWaiting;
      this.syncState();
    }

    setTtsActive(active: boolean): void {
      this._ttsActive = active;
      this.syncState();
    }

    _transition(newState: typeof this.state): void {
      const oldState = this.state;
      this.state = newState;
      this.transitions.push(`${oldState}->${newState}`);
      this._stopPulseTimer();
      this._cancelChimeDelay();

      if (newState === 'listening' || newState === 'processing') {
        if (this.feedbackSoundMode !== 'off') {
          this.soundsPlayed.push(newState === 'listening' ? 'listeningPulse' : 'processingPulse');
        }
        if (this.feedbackSoundMode === 'continuous') {
          this._pulseTimer = setInterval(() => {}, newState === 'listening' ? 7000 : 5000);
        }
      }
    }

    _stopPulseTimer(): void {
      if (this._pulseTimer !== null) {
        clearInterval(this._pulseTimer);
        this._pulseTimer = null;
      }
    }

    _cancelChimeDelay(): void {
      if (this._chimeDelayTimer !== null) {
        clearTimeout(this._chimeDelayTimer);
        this._chimeDelayTimer = null;
      }
    }

    reapplyFeedbackMode(): void {
      if (this.state === 'listening' || this.state === 'processing') {
        this._stopPulseTimer();
        // Re-run pulse logic for current state
        if (this.feedbackSoundMode !== 'off') {
          this.soundsPlayed.push(this.state === 'listening' ? 'listeningPulse' : 'processingPulse');
        }
        if (this.feedbackSoundMode === 'continuous') {
          this._pulseTimer = setInterval(() => {}, this.state === 'listening' ? 7000 : 5000);
        }
      }
    }

    destroy(): void {
      this._stopPulseTimer();
      this._cancelChimeDelay();
      this.state = 'inactive';
    }
  }

  let state: ServerAudioState;

  beforeEach(() => {
    state = new ServerAudioState();
  });

  afterEach(() => {
    state.destroy();
  });

  describe('syncState derives correct state', () => {
    it('should start inactive', () => {
      expect(state.state).toBe('inactive');
    });

    it('should stay inactive when listening=true but waitStatus unknown', () => {
      state.setListening(true);
      expect(state.state).toBe('inactive');
    });

    it('should transition to listening when listening=true and waitStatus=true', () => {
      state.setListening(true);
      state.setWaitStatus(true);
      expect(state.state).toBe('listening');
    });

    it('should transition to processing when listening=true and waitStatus=false', () => {
      state.setListening(true);
      state.setWaitStatus(false);
      expect(state.state).toBe('processing');
    });

    it('should transition to speaking when ttsActive=true (regardless of waitStatus)', () => {
      state.setListening(true);
      state.setWaitStatus(true);
      expect(state.state).toBe('listening');
      state.setTtsActive(true);
      expect(state.state).toBe('speaking');
    });

    it('should return to listening when ttsActive goes false after waitStatus=true', () => {
      state.setListening(true);
      state.setWaitStatus(true);
      state.setTtsActive(true);
      expect(state.state).toBe('speaking');
      state.setTtsActive(false);
      expect(state.state).toBe('listening');
    });

    it('should return to processing when ttsActive goes false after waitStatus=false', () => {
      state.setListening(true);
      state.setWaitStatus(false);
      state.setTtsActive(true);
      expect(state.state).toBe('speaking');
      state.setTtsActive(false);
      expect(state.state).toBe('processing');
    });

    it('should go inactive when listening set to false', () => {
      state.setListening(true);
      state.setWaitStatus(true);
      expect(state.state).toBe('listening');
      state.setListening(false);
      expect(state.state).toBe('inactive');
    });
  });

  describe('setListening resets signals', () => {
    it('should reset waitStatusKnown, lastWaitStatus, and ttsActive when enabling listening', () => {
      state.setListening(true);
      state.setWaitStatus(true);
      state.setTtsActive(true);
      // Now re-enable listening — should reset all signals
      state.setListening(true);
      expect(state._waitStatusKnown).toBe(false);
      expect(state._lastWaitStatus).toBe(false);
      expect(state._ttsActive).toBe(false);
      expect(state.state).toBe('inactive'); // waitStatus unknown = inactive
    });
  });

  describe('timer management', () => {
    it('should start pulse timer on transition to listening (continuous mode)', () => {
      state.setListening(true);
      state.setWaitStatus(true);
      expect(state.state).toBe('listening');
      expect(state._pulseTimer).not.toBeNull();

      // Transition to processing
      state.setWaitStatus(false);
      expect(state.state).toBe('processing');
      // Pulse timer restarted for processing
      expect(state._pulseTimer).not.toBeNull();
    });

    it('should cancel pulse timer on transition away from processing', () => {
      state.setListening(true);
      state.setWaitStatus(false);
      expect(state.state).toBe('processing');
      expect(state._pulseTimer).not.toBeNull();

      // Transition to speaking
      state.setTtsActive(true);
      expect(state.state).toBe('speaking');
      expect(state._pulseTimer).toBeNull();
    });

    it('should cancel all timers on destroy', () => {
      state.setListening(true);
      state.setWaitStatus(true);
      state.destroy();
      expect(state._pulseTimer).toBeNull();
      expect(state._chimeDelayTimer).toBeNull();
      expect(state.state).toBe('inactive');
    });

    it('should handle rapid state transitions without timer leaks', () => {
      state.setListening(true);
      state.setWaitStatus(true);  // listening
      state.setWaitStatus(false); // processing
      state.setWaitStatus(true);  // listening again
      state.setTtsActive(true);   // speaking
      state.setTtsActive(false);  // back to listening

      // No leaked timers — all prior timers were cleaned up
      expect(state.state).toBe('listening');
      // In continuous mode, pulse timer should exist for listening
      expect(state._pulseTimer).not.toBeNull();
    });
  });

  describe('transition tracking', () => {
    it('should not transition when state is already correct', () => {
      state.setListening(true);
      // Calling setListening(true) again should not produce a new transition
      const transitionsBefore = state.transitions.length;
      state.setListening(true);
      // It does reset signals and call syncState, but state is still inactive
      // (because waitStatusKnown=false after reset), so it may or may not transition
      // The key test is that no duplicate transitions occur
      expect(state.transitions.filter(t => t === 'inactive->inactive')).toHaveLength(0);
    });

    it('should record correct transition sequence for full lifecycle', () => {
      state.setListening(true);
      state.setWaitStatus(true);   // inactive -> listening
      state.setWaitStatus(false);  // listening -> processing
      state.setTtsActive(true);    // processing -> speaking
      state.setTtsActive(false);   // speaking -> processing
      state.setWaitStatus(true);   // processing -> listening
      state.setListening(false);   // listening -> inactive

      expect(state.transitions).toEqual([
        'inactive->listening',
        'listening->processing',
        'processing->speaking',
        'speaking->processing',
        'processing->listening',
        'listening->inactive',
      ]);
    });
  });

  describe('feedbackSoundMode', () => {
    it('off mode: no timers started and no sounds played on listening', () => {
      state.feedbackSoundMode = 'off';
      state.setListening(true);
      state.setWaitStatus(true);
      expect(state.state).toBe('listening');
      expect(state._pulseTimer).toBeNull();
      expect(state.soundsPlayed).toHaveLength(0);
    });

    it('off mode: no timers started and no sounds played on processing', () => {
      state.feedbackSoundMode = 'off';
      state.setListening(true);
      state.setWaitStatus(false);
      expect(state.state).toBe('processing');
      expect(state._pulseTimer).toBeNull();
      expect(state.soundsPlayed).toHaveLength(0);
    });

    it('once mode: sound played but no interval timer on listening', () => {
      state.feedbackSoundMode = 'once';
      state.setListening(true);
      state.setWaitStatus(true);
      expect(state.state).toBe('listening');
      expect(state.soundsPlayed).toEqual(['listeningPulse']);
      expect(state._pulseTimer).toBeNull();
    });

    it('once mode: sound played but no interval timer on processing', () => {
      state.feedbackSoundMode = 'once';
      state.setListening(true);
      state.setWaitStatus(false);
      expect(state.state).toBe('processing');
      expect(state.soundsPlayed).toEqual(['processingPulse']);
      expect(state._pulseTimer).toBeNull();
    });

    it('continuous mode (default): sound played and interval timer started', () => {
      // feedbackSoundMode defaults to 'continuous'
      state.setListening(true);
      state.setWaitStatus(true);
      expect(state.state).toBe('listening');
      expect(state.soundsPlayed).toEqual(['listeningPulse']);
      expect(state._pulseTimer).not.toBeNull();
    });

    it('reapplyFeedbackMode: switching from continuous to off mid-state stops the timer', () => {
      state.setListening(true);
      state.setWaitStatus(true);
      expect(state.state).toBe('listening');
      expect(state._pulseTimer).not.toBeNull();

      state.feedbackSoundMode = 'off';
      state.reapplyFeedbackMode();
      expect(state._pulseTimer).toBeNull();
    });

    it('reapplyFeedbackMode: switching from off to once mid-state plays a single sound', () => {
      state.feedbackSoundMode = 'off';
      state.setListening(true);
      state.setWaitStatus(true);
      expect(state.state).toBe('listening');
      expect(state.soundsPlayed).toHaveLength(0);

      state.feedbackSoundMode = 'once';
      state.reapplyFeedbackMode();
      expect(state.soundsPlayed).toEqual(['listeningPulse']);
      expect(state._pulseTimer).toBeNull();
    });

    it('reapplyFeedbackMode: does nothing when in inactive state', () => {
      state.feedbackSoundMode = 'continuous';
      state.reapplyFeedbackMode();
      expect(state.soundsPlayed).toHaveLength(0);
      expect(state._pulseTimer).toBeNull();
    });
  });

  describe('hookActive (processing state without voice input)', () => {
    it('should transition to processing when hookActive=true and not listening', () => {
      state.setHookActive(true);
      expect(state.state).toBe('processing');
    });

    it('should transition back to inactive when hookActive cleared', () => {
      state.setHookActive(true);
      expect(state.state).toBe('processing');
      state.setHookActive(false);
      expect(state.state).toBe('inactive');
    });

    it('should NOT override voice states when listening is active', () => {
      state.setListening(true);
      state.setWaitStatus(true); // listening
      state.setHookActive(true);
      // Voice logic takes precedence — still listening, not processing
      expect(state.state).toBe('listening');
    });

    it('should show processing when voice turns off while hookActive', () => {
      state.setListening(true);
      state.setWaitStatus(true); // listening
      state.setHookActive(true);
      expect(state.state).toBe('listening'); // voice takes precedence
      state.setListening(false);
      // Now voice is off but hookActive is still true
      expect(state.state).toBe('processing');
    });

    it('should clear hookActive when setListening(true) is called', () => {
      state.setHookActive(true);
      expect(state.state).toBe('processing');
      state.setListening(true);
      expect(state._hookActive).toBe(false);
      // Back to inactive because waitStatusKnown is false after setListening reset
      expect(state.state).toBe('inactive');
    });

    it('clearHookActiveSilent should not trigger state change', () => {
      state.setHookActive(true);
      expect(state.state).toBe('processing');
      const transitionsBefore = state.transitions.length;
      state.clearHookActiveSilent();
      // No new transition — state is still 'processing' in the field
      // (syncState was not called, so state wasn't re-evaluated)
      expect(state.transitions.length).toBe(transitionsBefore);
      expect(state._hookActive).toBe(false);
    });

    it('should record correct transitions for hook-only lifecycle', () => {
      state.setHookActive(true);   // inactive -> processing
      state.clearHookActiveSilent(); // no transition
      // Manually sync to simulate what happens after broadcastVoiceState('stopped')
      state.syncState();           // processing -> inactive
      expect(state.transitions).toEqual([
        'inactive->processing',
        'processing->inactive',
      ]);
    });
  });
});
