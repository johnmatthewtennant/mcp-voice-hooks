// AudioPlayer: plays PCM16 audio chunks via AudioContext for WebSocket TTS streaming
class AudioPlayer {
    constructor() {
        this.playbackContext = null; // Created lazily on unlock
        this.nextStartTime = 0;
        this.scheduledSources = [];
        this.gainNode = null;
        this.ttsActive = false;
        this.currentAudioId = null;
    }

    // Must be called on user gesture (e.g., Start Listening tap)
    async unlock() {
        if (!this.playbackContext) {
            this.playbackContext = new AudioContext({ sampleRate: 22050 });
            this.gainNode = this.playbackContext.createGain();
            this.gainNode.connect(this.playbackContext.destination);
        }
        await this.playbackContext.resume();
        // Play silent buffer to warm up iOS audio pipeline
        const silence = this.playbackContext.createBuffer(1, 1, 22050);
        const source = this.playbackContext.createBufferSource();
        source.buffer = silence;
        source.connect(this.playbackContext.destination);
        source.start();
    }

    prepareForPlayback(sampleRate, audioId) {
        this.ttsActive = true;
        this.currentAudioId = audioId;
        // Reset scheduling so new audio starts from "now"
        if (this.playbackContext) {
            this.nextStartTime = this.playbackContext.currentTime;
        }
    }

    // Convert Int16 PCM buffer to Float32
    static int16ToFloat32(int16Array) {
        const float32 = new Float32Array(int16Array.length);
        for (let i = 0; i < int16Array.length; i++) {
            float32[i] = int16Array[i] / 32768;
        }
        return float32;
    }

    // Schedule a PCM16 chunk for gapless playback
    playPCMChunk(pcm16Buffer, sampleRate = 22050) {
        if (!this.playbackContext || this.playbackContext.state !== 'running') return;

        const int16 = new Int16Array(pcm16Buffer);
        const float32 = AudioPlayer.int16ToFloat32(int16);
        const audioBuffer = this.playbackContext.createBuffer(1, float32.length, sampleRate);
        audioBuffer.copyToChannel(float32, 0);

        const source = this.playbackContext.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(this.gainNode || this.playbackContext.destination);

        const now = this.playbackContext.currentTime;
        const startTime = Math.max(now, this.nextStartTime);
        source.start(startTime);
        this.nextStartTime = startTime + audioBuffer.duration;
        this.scheduledSources.push(source);

        // Clean up finished sources
        source.onended = () => {
            const idx = this.scheduledSources.indexOf(source);
            if (idx !== -1) this.scheduledSources.splice(idx, 1);
        };
    }

    finishPlayback() {
        this.ttsActive = false;
        this.currentAudioId = null;
    }

    clear() {
        // Stop all scheduled sources
        for (const source of this.scheduledSources) {
            try { source.stop(); } catch (_e) { /* may already be stopped */ }
        }
        this.scheduledSources = [];
        this.nextStartTime = 0;
        this.ttsActive = false;
        this.currentAudioId = null;
    }

    isPlaying() {
        return this.ttsActive || this.scheduledSources.length > 0;
    }
}

class MessengerClient {
    constructor() {
        this.baseUrl = window.location.origin;

        // Conversation elements
        this.conversationMessages = document.getElementById('conversationMessages');
        this.conversationContainer = document.getElementById('conversationContainer');

        // Text input elements
        this.messageInput = document.getElementById('messageInput');
        this.micBtn = document.getElementById('micBtn');

        // Send mode controls
        this.sendModeRadios = document.querySelectorAll('input[name="sendMode"]');
        this.triggerWordInputContainer = document.getElementById('triggerWordInputContainer');
        this.triggerWordInput = document.getElementById('triggerWordInput');

        // Settings
        this.settingsToggleHeader = document.getElementById('settingsToggleHeader');
        this.settingsContent = document.getElementById('settingsContent');
        this.voiceResponsesToggle = document.getElementById('voiceResponsesToggle');
        this.voiceOptions = document.getElementById('voiceOptions');
        this.languageSelect = document.getElementById('languageSelect');
        this.voiceSelect = document.getElementById('voiceSelect');
        this.localVoicesGroup = document.getElementById('localVoicesGroup');
        this.cloudVoicesGroup = document.getElementById('cloudVoicesGroup');
        this.speechRateSlider = document.getElementById('speechRate');
        this.speechRateInput = document.getElementById('speechRateInput');
        this.testTTSBtn = document.getElementById('testTTSBtn');
        this.rateWarning = document.getElementById('rateWarning');
        this.systemVoiceInfo = document.getElementById('systemVoiceInfo');

        // Session sidebar elements
        this.sessionSidebar = document.getElementById('sessionSidebar');
        this.sessionList = document.getElementById('sessionList');
        this.sidebarOpenBtn = document.getElementById('sidebarOpenBtn');
        this.sidebarCloseBtn = document.getElementById('sidebarCloseBtn');
        this.backgroundEnforcementToggle = document.getElementById('backgroundEnforcementToggle');

        // State
        this.sendMode = 'automatic'; // 'automatic' or 'trigger'
        this.triggerWord = 'send';
        this.isListening = false;
        this.isInterimText = false;
        this.accumulatedText = ''; // For trigger word mode
        this.debug = localStorage.getItem('voiceHooksDebug') === 'true';

        // TTS state
        this.voices = [];
        this.selectedVoice = 'system';
        this.speechRate = 1.0;
        this.speechPitch = 1.0;

        // Audio playback queue (for server-rendered system voice)
        this.audioQueue = [];
        this.audioPlaying = false;
        this.currentAudio = null;

        // WebSocket audio capture state
        this.audioWs = null;
        this.audioContext = null;
        this.audioWorkletNode = null;
        this.mediaStream = null;
        this.wsReconnectTimer = null;
        this.wsReconnectDelay = 1000; // exponential backoff start

        // WebSocket TTS audio player
        this.audioPlayer = new AudioPlayer();
        this.wsConnected = false;

        // Session state
        this.sessions = [];
        this.activeSessionKey = null;
        this.unreadCounts = {}; // key → count of messages since last viewed

        // Initialize
        this.initializeSpeechRecognition();
        this.initializeSpeechSynthesis();
        this.initializeTTSEvents();
        this.initializeSessionSidebar();
        this.setupEventListeners();
        this.loadPreferences();
        this.loadData();

        // Auto-refresh every 2 seconds
        setInterval(() => this.loadData(), 2000);
        // Refresh sessions every 3 seconds
        setInterval(() => this.loadSessions(), 3000);
    }

    debugLog(...args) {
        if (this.debug) {
            console.log(...args);
        }
    }

    initializeSpeechSynthesis() {
        // Check for browser support
        if (!window.speechSynthesis) {
            console.warn('Speech synthesis not supported in this browser');
            return;
        }

        // Get available voices
        this.voices = [];

        // Enhanced voice loading with deduplication
        const loadVoices = () => {
            const voices = window.speechSynthesis.getVoices();

            // Deduplicate voices - keep the first occurrence of each unique voice
            const deduplicatedVoices = [];
            const seen = new Set();

            voices.forEach(voice => {
                // Create a unique key based on name, language, and URI
                const key = `${voice.name}-${voice.lang}-${voice.voiceURI}`;
                if (!seen.has(key)) {
                    seen.add(key);
                    deduplicatedVoices.push(voice);
                }
            });

            this.voices = deduplicatedVoices;
            this.populateVoiceList();
        };

        // Load voices initially and with a delayed retry for reliability
        loadVoices();
        setTimeout(loadVoices, 100);

        // Set up voice change listener
        if (window.speechSynthesis.onvoiceschanged !== undefined) {
            window.speechSynthesis.onvoiceschanged = loadVoices;
        }
    }

    initializeTTSEvents() {
        // Connect to SSE for TTS events
        this.eventSource = new EventSource(`${this.baseUrl}/api/tts-events`);

        this.eventSource.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);

                if (data.type === 'connected') {
                    // Connected (or reconnected) to server — sync voice state
                    // This handles both initial connect and reconnect after server restart
                    console.log('[SSE] Connected to server, syncing voice state');
                    this.syncVoiceStateToServer();
                } else if (data.type === 'speak' && data.text) {
                    // If system voice is selected, don't do browser TTS — audio will arrive via tts-audio event
                    if (this.selectedVoice !== 'system') {
                        this.speakText(data.text);
                    }
                } else if (data.type === 'tts-audio' && data.audioUrl) {
                    // Server-rendered audio ready — queue for playback (SSE fallback)
                    // Skip if WS is connected (audio arrives as binary frames)
                    if (!this.wsConnected) {
                        this.audioQueue.push(data.audioUrl);
                        this.processAudioQueue();
                    }
                } else if (data.type === 'tts-clear') {
                    this.clearAudioQueue();
                    // Also clear WS audio player
                    this.audioPlayer.clear();
                } else if (data.type === 'waitStatus') {
                    this.handleWaitStatus(data.isWaiting);
                } else if (data.type === 'session-reset') {
                    // New Claude session started — re-sync our voice state with the server
                    console.log('[SSE] New Claude session detected, re-syncing voice state');
                    this.syncVoiceStateToServer();
                }
            } catch (error) {
                console.error('Failed to parse TTS event:', error);
            }
        };

        this.eventSource.onerror = (error) => {
            console.error('SSE connection error:', error);
        };
    }

    handleWaitStatus(isWaiting) {
        const waitingIndicator = document.getElementById('waitingIndicator');
        if (waitingIndicator) {
            waitingIndicator.style.display = isWaiting ? 'block' : 'none';
            if (isWaiting) {
                this.scrollToBottom();
            }
        }
    }

    initializeSessionSidebar() {
        if (this.sidebarOpenBtn) {
            this.sidebarOpenBtn.addEventListener('click', () => this.toggleSidebar(true));
        }
        if (this.sidebarCloseBtn) {
            this.sidebarCloseBtn.addEventListener('click', () => this.toggleSidebar(false));
        }
        // Delegated click handler on sessionList — survives innerHTML replacement
        if (this.sessionList) {
            this.sessionList.addEventListener('click', (e) => {
                const item = e.target.closest('.session-item');
                if (!item) return;
                const key = item.dataset.sessionKey;
                if (key && key !== this.activeSessionKey) {
                    this.switchActiveSession(key);
                }
            });
        }
        // Background enforcement toggle
        if (this.backgroundEnforcementToggle) {
            // Load saved preference from localStorage, then sync with server
            const saved = localStorage.getItem('backgroundVoiceEnforcement');
            if (saved !== null) {
                this.backgroundEnforcementToggle.checked = saved === 'true';
                this.updateBackgroundEnforcement(saved === 'true');
            } else {
                // Load from server on first visit
                this.loadBackgroundEnforcement();
            }
            this.backgroundEnforcementToggle.addEventListener('change', (e) => {
                const enabled = e.target.checked;
                this.updateBackgroundEnforcement(enabled);
            });
        }
        // Load sessions immediately
        this.loadSessions();
    }

    toggleSidebar(open) {
        if (this.sessionSidebar) {
            if (open) {
                this.sessionSidebar.classList.remove('collapsed');
                if (this.sidebarOpenBtn) this.sidebarOpenBtn.classList.remove('visible');
            } else {
                this.sessionSidebar.classList.add('collapsed');
                if (this.sidebarOpenBtn) this.sidebarOpenBtn.classList.add('visible');
            }
        }
    }

    async loadSessions() {
        try {
            const response = await fetch(`${this.baseUrl}/api/sessions`);
            if (!response.ok) return;
            const data = await response.json();
            this.sessions = data.sessions || [];
            this.activeSessionKey = data.activeKey;

            // Show sidebar button when there are multiple sessions
            const hasMultipleSessions = this.sessions.length > 1;
            if (hasMultipleSessions && this.sessionSidebar.classList.contains('collapsed')) {
                if (this.sidebarOpenBtn) this.sidebarOpenBtn.classList.add('visible');
            }

            // Track unread counts for inactive sessions
            for (const session of this.sessions) {
                if (!session.isActive && session.pendingCount > 0) {
                    const key = session.key;
                    this.unreadCounts[key] = session.pendingCount;
                }
            }

            this.renderSessionList();
        } catch (error) {
            this.debugLog('Failed to load sessions:', error);
        }
    }

    renderSessionList() {
        if (!this.sessionList) return;

        if (this.sessions.length === 0) {
            this.sessionList.innerHTML = '<div style="padding: 16px; color: #999; font-size: 13px; text-align: center;">No sessions connected</div>';
            return;
        }

        // Hide default session when real sessions exist (unless it's active or has content)
        const hasRealSessions = this.sessions.some(s => s.sessionId !== 'default');
        const visibleSessions = hasRealSessions
            ? this.sessions.filter(s => {
                if (s.sessionId === 'default') {
                    return s.isActive || (s.messageCount || 0) > 0 || s.utteranceCount > 0;
                }
                return true;
            })
            : this.sessions;

        // Group sessions by sessionId
        const groups = {};
        for (const session of visibleSessions) {
            const sid = session.sessionId;
            if (!groups[sid]) groups[sid] = [];
            groups[sid].push(session);
        }

        let html = '';
        for (const [sessionId, members] of Object.entries(groups)) {
            html += '<div class="session-group">';
            // Sort: main agent first, then sub-agents
            members.sort((a, b) => {
                if (!a.agentId && b.agentId) return -1;
                if (a.agentId && !b.agentId) return 1;
                return 0;
            });

            for (const session of members) {
                const isActive = session.key === this.activeSessionKey;
                const isSubAgent = !!session.agentId;
                const label = isSubAgent
                    ? (session.agentType || session.agentId || 'sub-agent')
                    : this.formatSessionLabel(sessionId);
                const unread = this.unreadCounts[session.key] || 0;

                const classes = ['session-item'];
                if (isActive) classes.push('active');
                if (isSubAgent) classes.push('sub-agent');

                html += `<div class="${classes.join(' ')}" data-session-key='${session.key.replace(/'/g, "&#39;")}' title="${this.escapeHtml(session.key)}">`;
                html += `<span class="session-label">${this.escapeHtml(label)}</span>`;
                if (unread > 0 && !isActive) {
                    html += `<span class="session-badge">${unread}</span>`;
                }
                html += '</div>';
            }
            html += '</div>';
        }

        this.sessionList.innerHTML = html;
    }

    formatSessionLabel(sessionId) {
        if (sessionId === 'default') {
            const hasReal = this.sessions.some(s => s.sessionId !== 'default');
            return hasReal ? 'Unattached' : 'Main Session';
        }
        // Truncate long session IDs
        if (sessionId.length > 16) return sessionId.substring(0, 8) + '...';
        return sessionId;
    }

    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    async switchActiveSession(key) {
        try {
            const response = await fetch(`${this.baseUrl}/api/active-session`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ key }),
            });
            if (response.ok) {
                this.activeSessionKey = key;
                // Clear unread for this session
                delete this.unreadCounts[key];
                // Clear existing messages so the new session's messages replace them
                this.conversationMessages.querySelectorAll('.message-bubble').forEach(el => el.remove());
                // Reload conversation for new active session
                this.loadData();
                this.loadSessions();
            }
        } catch (error) {
            console.error('Failed to switch session:', error);
        }
    }

    processAudioQueue() {
        if (this.audioPlaying || this.audioQueue.length === 0) return;
        this.audioPlaying = true;
        const url = this.audioQueue.shift();
        const audio = new Audio(url);
        this.currentAudio = audio;

        audio.play().catch((err) => {
            console.warn('Audio playback failed (autoplay restriction?):', err);
            this.audioPlaying = false;
            this.currentAudio = null;
            this.processAudioQueue();
        });

        audio.addEventListener('ended', () => {
            this.audioPlaying = false;
            this.currentAudio = null;
            this.processAudioQueue();
        });

        audio.addEventListener('error', (e) => {
            console.warn('Audio playback error:', e);
            this.audioPlaying = false;
            this.currentAudio = null;
            this.processAudioQueue();
        });
    }

    clearAudioQueue() {
        this.audioQueue = [];
        if (this.currentAudio) {
            this.currentAudio.pause();
            this.currentAudio = null;
        }
        this.audioPlaying = false;
    }

    speakText(text) {
        // Browser TTS only — system voice audio arrives via SSE tts-audio events
        if (!window.speechSynthesis) {
            console.error('Speech synthesis not available');
            return;
        }

        // Cancel any ongoing speech
        window.speechSynthesis.cancel();

        // Create utterance
        const utterance = new SpeechSynthesisUtterance(text);

        // Set voice if using browser voice
        if (this.selectedVoice && this.selectedVoice.startsWith('browser:')) {
            const voiceIndex = parseInt(this.selectedVoice.substring(8));
            if (this.voices[voiceIndex]) {
                utterance.voice = this.voices[voiceIndex];
            }
        }

        // Set speech properties
        utterance.rate = this.speechRate;
        utterance.pitch = this.speechPitch;

        // Event handlers
        utterance.onstart = () => {
            this.debugLog('Started speaking:', text);
        };

        utterance.onend = () => {
            this.debugLog('Finished speaking');
        };

        utterance.onerror = (event) => {
            console.error('Speech synthesis error:', event);
        };

        // Speak the text
        window.speechSynthesis.speak(utterance);
    }

    loadPreferences() {
        // Load voice responses preference from localStorage
        const savedVoiceResponses = localStorage.getItem('voiceResponsesEnabled');
        if (savedVoiceResponses !== null) {
            const enabled = savedVoiceResponses === 'true';
            this.voiceResponsesToggle.checked = enabled;
            this.voiceOptions.style.display = enabled ? 'block' : 'none';
            this.updateVoiceResponses(enabled);
        }

        // Load voice selection
        const savedVoice = localStorage.getItem('selectedVoice');
        if (savedVoice) {
            this.selectedVoice = savedVoice;
        }

        // Load speech rate
        const savedRate = localStorage.getItem('speechRate');
        if (savedRate) {
            this.speechRate = parseFloat(savedRate);
            if (this.speechRateSlider) this.speechRateSlider.value = this.speechRate.toString();
            if (this.speechRateInput) this.speechRateInput.value = this.speechRate.toFixed(1);
        }

        // Sync selected voice to server on load
        this.syncSelectedVoiceToServer();
    }

    populateLanguageFilter() {
        if (!this.languageSelect || !this.voices) return;

        const currentSelection = this.languageSelect.value || 'en-US';
        this.languageSelect.innerHTML = '';

        const allOption = document.createElement('option');
        allOption.value = 'all';
        allOption.textContent = 'All Languages';
        this.languageSelect.appendChild(allOption);

        const languageCodes = new Set();
        this.voices.forEach(voice => {
            languageCodes.add(voice.lang);
        });

        Array.from(languageCodes).sort().forEach(lang => {
            const option = document.createElement('option');
            option.value = lang;
            option.textContent = lang;
            this.languageSelect.appendChild(option);
        });

        this.languageSelect.value = currentSelection;
        if (this.languageSelect.value !== currentSelection) {
            this.languageSelect.value = 'en-US';
        }
    }

    populateVoiceList() {
        if (!this.voiceSelect || !this.localVoicesGroup || !this.cloudVoicesGroup) return;

        this.populateLanguageFilter();

        this.localVoicesGroup.innerHTML = '';
        this.cloudVoicesGroup.innerHTML = '';

        const excludedVoices = [
            'Eddy', 'Flo', 'Grandma', 'Grandpa', 'Reed', 'Rocko', 'Sandy', 'Shelley',
            'Albert', 'Bad News', 'Bahh', 'Bells', 'Boing', 'Bubbles', 'Cellos',
            'Good News', 'Jester', 'Organ', 'Superstar', 'Trinoids', 'Whisper',
            'Wobble', 'Zarvox', 'Fred', 'Junior', 'Kathy', 'Ralph'
        ];

        const selectedLanguage = this.languageSelect ? this.languageSelect.value : 'en-US';

        this.voices.forEach((voice, index) => {
            const voiceLang = voice.lang;
            let shouldInclude = selectedLanguage === 'all' || voiceLang === selectedLanguage;

            if (shouldInclude) {
                const voiceName = voice.name;
                const isExcluded = excludedVoices.some(excluded =>
                    voiceName.toLowerCase().startsWith(excluded.toLowerCase())
                );

                if (!isExcluded) {
                    const option = document.createElement('option');
                    option.value = `browser:${index}`;
                    option.textContent = `${voice.name} (${voice.lang})`;

                    if (voice.localService) {
                        this.localVoicesGroup.appendChild(option);
                    } else {
                        this.cloudVoicesGroup.appendChild(option);
                    }
                }
            }
        });

        if (this.localVoicesGroup.children.length === 0) {
            this.localVoicesGroup.style.display = 'none';
        } else {
            this.localVoicesGroup.style.display = '';
        }

        if (this.cloudVoicesGroup.children.length === 0) {
            this.cloudVoicesGroup.style.display = 'none';
        } else {
            this.cloudVoicesGroup.style.display = '';
        }

        // Restore selection or find default
        if (this.selectedVoice) {
            this.voiceSelect.value = this.selectedVoice;
        }

        this.updateVoiceWarnings();
    }

    updateVoiceWarnings() {
        if (this.selectedVoice === 'system') {
            this.systemVoiceInfo.style.display = 'flex';
            this.rateWarning.style.display = 'none';
        } else if (this.selectedVoice && this.selectedVoice.startsWith('browser:')) {
            const voiceIndex = parseInt(this.selectedVoice.substring(8));
            const voice = this.voices[voiceIndex];

            if (voice) {
                const isGoogleVoice = voice.name.toLowerCase().includes('google');
                this.rateWarning.style.display = isGoogleVoice ? 'flex' : 'none';
                this.systemVoiceInfo.style.display = voice.localService ? 'flex' : 'none';
            } else {
                this.rateWarning.style.display = 'none';
                this.systemVoiceInfo.style.display = 'none';
            }
        } else {
            this.rateWarning.style.display = 'none';
            this.systemVoiceInfo.style.display = 'none';
        }
    }

    setupEventListeners() {
        // Text input events
        this.messageInput.addEventListener('keydown', (e) => this.handleTextInputKeydown(e));
        this.messageInput.addEventListener('input', () => this.autoGrowTextarea());

        // Microphone button
        this.micBtn.addEventListener('click', () => this.toggleVoiceDictation());

        // Send mode radio buttons
        this.sendModeRadios.forEach(radio => {
            radio.addEventListener('change', (e) => {
                this.sendMode = e.target.value;
                this.triggerWordInputContainer.style.display =
                    this.sendMode === 'trigger' ? 'flex' : 'none';
            });
        });

        // Trigger word input
        this.triggerWordInput.addEventListener('input', (e) => {
            this.triggerWord = e.target.value.trim().toLowerCase();
        });

        // Settings toggle
        this.settingsToggleHeader.addEventListener('click', () => {
            const arrow = this.settingsToggleHeader.querySelector('.toggle-arrow');
            if (this.settingsContent.classList.contains('open')) {
                this.settingsContent.classList.remove('open');
                arrow.classList.remove('open');
            } else {
                this.settingsContent.classList.add('open');
                arrow.classList.add('open');
            }
        });

        // Voice responses toggle
        this.voiceResponsesToggle.addEventListener('change', async (e) => {
            const enabled = e.target.checked;
            await this.updateVoiceResponses(enabled);
            // Show/hide voice options based on toggle
            this.voiceOptions.style.display = enabled ? 'block' : 'none';
        });

        // Voice selection
        this.voiceSelect.addEventListener('change', (e) => {
            this.selectedVoice = e.target.value;
            localStorage.setItem('selectedVoice', this.selectedVoice);
            this.updateVoiceWarnings();
            this.syncSelectedVoiceToServer();
        });

        // Language filter
        if (this.languageSelect) {
            this.languageSelect.addEventListener('change', () => {
                this.populateVoiceList();
            });
        }

        // Speech rate slider
        if (this.speechRateSlider) {
            this.speechRateSlider.addEventListener('input', (e) => {
                this.speechRate = parseFloat(e.target.value);
                this.speechRateInput.value = this.speechRate.toFixed(1);
                localStorage.setItem('speechRate', this.speechRate.toString());
                this.syncSelectedVoiceToServer();
            });
        }

        // Speech rate text input
        if (this.speechRateInput) {
            this.speechRateInput.addEventListener('input', (e) => {
                let value = parseFloat(e.target.value);
                if (!isNaN(value)) {
                    value = Math.max(0.5, Math.min(5, value));
                    this.speechRate = value;
                    this.speechRateSlider.value = value.toString();
                    this.speechRateInput.value = value.toFixed(1);
                    localStorage.setItem('speechRate', this.speechRate.toString());
                    this.syncSelectedVoiceToServer();
                }
            });
        }

        // Test TTS button
        if (this.testTTSBtn) {
            this.testTTSBtn.addEventListener('click', () => {
                this.speakText('This is Voice Mode for Claude Code. How can I help you today?');
            });
        }
    }

    async loadData() {
        try {
            // Load full conversation
            const conversationResponse = await fetch(`${this.baseUrl}/api/conversation?limit=50`);
            if (conversationResponse.ok) {
                const data = await conversationResponse.json();
                this.updateConversation(data.messages);
            }
        } catch (error) {
            console.error('Failed to load data:', error);
        }
    }

    updateConversation(messages) {
        const container = this.conversationMessages;
        const emptyState = container.querySelector('.empty-state');

        if (messages.length === 0) {
            emptyState.style.display = 'flex';
            container.querySelectorAll('.message-bubble').forEach(el => el.remove());
            return;
        }

        emptyState.style.display = 'none';

        // Get existing message IDs to avoid duplicates
        const existingBubbles = container.querySelectorAll('.message-bubble');
        const existingIds = new Set();
        existingBubbles.forEach(bubble => {
            if (bubble.dataset.messageId) {
                existingIds.add(bubble.dataset.messageId);
            }
        });

        // Get waiting indicator to insert messages before it
        const waitingIndicator = container.querySelector('.waiting-indicator');

        // Only render new messages and update status for existing ones
        messages.forEach(message => {
            if (!existingIds.has(message.id)) {
                // New message - create bubble and insert before waiting indicator
                const bubble = this.createMessageBubble(message);
                if (waitingIndicator) {
                    container.insertBefore(bubble, waitingIndicator);
                } else {
                    container.appendChild(bubble);
                }
            } else {
                // Existing message - update status if it's a user message
                if (message.role === 'user' && message.status) {
                    const bubble = container.querySelector(`[data-message-id="${message.id}"]`);
                    if (bubble) {
                        const statusEl = bubble.querySelector('.message-status');
                        if (statusEl) {
                            // Check if status changed from pending to something else
                            const wasPending = statusEl.classList.contains('pending');
                            const isPending = message.status === 'pending';

                            if (wasPending && !isPending) {
                                // Status changed from pending - remove delete button
                                const deleteBtn = statusEl.querySelector('.delete-message-btn');
                                if (deleteBtn) {
                                    deleteBtn.remove();
                                }
                            }

                            // Update status class and text
                            statusEl.className = `message-status ${message.status}`;
                            const statusText = statusEl.querySelector('span:last-child');
                            if (statusText) {
                                statusText.textContent = message.status.toUpperCase();
                            }
                        }
                    }
                }
            }
        });

        this.scrollToBottom();
    }

    createMessageBubble(message) {
        const bubble = document.createElement('div');
        bubble.className = `message-bubble ${message.role}`;
        bubble.dataset.messageId = message.id;

        const messageText = document.createElement('div');
        messageText.className = 'message-text';
        messageText.textContent = message.text;

        const messageMeta = document.createElement('div');
        messageMeta.className = 'message-meta';

        const timestamp = document.createElement('span');
        timestamp.className = 'message-timestamp';
        timestamp.textContent = this.formatTimestamp(message.timestamp);
        messageMeta.appendChild(timestamp);

        // Only show status for user messages
        if (message.role === 'user' && message.status) {
            const statusContainer = document.createElement('div');
            statusContainer.className = `message-status ${message.status}`;

            // Add delete button for pending messages (shows on hover)
            if (message.status === 'pending') {
                const deleteBtn = document.createElement('span');
                deleteBtn.className = 'delete-message-btn';
                deleteBtn.innerHTML = `
                    <svg class="delete-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
                        <path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/>
                    </svg>
                `;
                deleteBtn.onclick = (e) => {
                    e.stopPropagation();
                    this.deleteMessage(message.id);
                };
                statusContainer.appendChild(deleteBtn);
            }

            const statusText = document.createElement('span');
            statusText.textContent = message.status.toUpperCase();
            statusContainer.appendChild(statusText);

            messageMeta.appendChild(statusContainer);
        }

        bubble.appendChild(messageText);
        bubble.appendChild(messageMeta);

        return bubble;
    }

    scrollToBottom() {
        this.conversationContainer.scrollTo({
            top: this.conversationContainer.scrollHeight,
            behavior: 'smooth'
        });
    }

    formatTimestamp(timestamp) {
        const date = new Date(timestamp);
        return date.toLocaleTimeString();
    }

    // Text input handling
    handleTextInputKeydown(e) {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            this.sendTypedMessage();
        }
        // Shift+Enter allows new line
    }

    autoGrowTextarea() {
        const textarea = this.messageInput;
        textarea.style.height = 'auto';
        textarea.style.height = Math.min(textarea.scrollHeight, 120) + 'px';
    }

    async sendTypedMessage() {
        const text = this.messageInput.value.trim();
        if (!text || this.isInterimText) return;

        this.messageInput.value = '';
        this.messageInput.style.height = 'auto';

        await this.sendMessage(text);
    }

    async sendMessage(text) {
        try {
            const response = await fetch(`${this.baseUrl}/api/potential-utterances`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text, timestamp: new Date().toISOString() })
            });

            if (response.ok) {
                this.loadData();
            }
        } catch (error) {
            console.error('Failed to send message:', error);
        }
    }

    // Voice dictation
    toggleVoiceDictation() {
        if (this.isListening) {
            this.stopVoiceDictation();
        } else {
            this.startVoiceDictation();
        }
    }

    async startVoiceDictation() {
        if (!this.recognition) {
            alert('Speech recognition not supported in this browser');
            return;
        }

        try {
            if (this.isInterimText) {
                this.messageInput.value = '';
                this.isInterimText = false;
            }

            this.recognition.start();
            this.isListening = true;
            this.micBtn.classList.add('listening');

            // Unlock AudioPlayer on user gesture (iOS Safari requirement)
            await this.audioPlayer.unlock();

            // Open WebSocket and start audio capture alongside Web Speech API
            this.connectAudioWebSocket();
            // Wait briefly for WS to connect before starting capture
            setTimeout(() => this.startAudioCapture(), 200);

            // Activate voice input when mic is on
            await this.updateVoiceInputState(true);
        } catch (e) {
            console.error('Failed to start recognition:', e);
            alert('Failed to start speech recognition');
        }
    }

    async stopVoiceDictation() {
        if (this.recognition) {
            this.isListening = false;
            this.recognition.stop();
            this.micBtn.classList.remove('listening');

            // Send any accumulated text in the input
            const text = this.messageInput.value.trim();
            if (text) {
                // In trigger mode, check for trigger word
                if (this.sendMode === 'trigger') {
                    if (this.containsTriggerWord(text)) {
                        const textToSend = this.removeTriggerWord(text);
                        await this.sendMessage(textToSend);
                        this.messageInput.value = '';
                    }
                    // If no trigger word, keep text in input for user to continue
                } else {
                    // In automatic mode, send the text
                    await this.sendMessage(text);
                    this.messageInput.value = '';
                }
            }

            this.isInterimText = false;
            this.messageInput.style.height = 'auto';

            // Stop audio capture and disconnect WebSocket
            this.stopAudioCapture();
            this.disconnectAudioWebSocket();

            // Deactivate voice input when mic is turned off
            await this.updateVoiceInputState(false);
        }
    }

    initializeSpeechRecognition() {
        const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

        if (!SpeechRecognition) {
            console.error('Speech recognition not supported');
            this.micBtn.disabled = true;
            return;
        }

        this.recognition = new SpeechRecognition();
        this.recognition.continuous = true;
        this.recognition.interimResults = true;
        this.recognition.lang = 'en-US';

        this.recognition.onresult = (event) => {
            let interimTranscript = '';

            for (let i = event.resultIndex; i < event.results.length; i++) {
                const transcript = event.results[i][0].transcript;

                if (event.results[i].isFinal) {
                    // User paused
                    this.isInterimText = false;

                    if (this.sendMode === 'automatic') {
                        // Send immediately
                        const finalText = this.messageInput.value.trim();
                        this.sendMessage(finalText);
                        this.messageInput.value = '';
                        this.accumulatedText = '';
                    } else {
                        // Trigger word mode: accumulate until trigger word
                        // Use the previously saved accumulated text (before interim was shown)
                        const previouslyAccumulated = this.accumulatedText || '';
                        const newUtterance = transcript.trim();

                        // Check if this new utterance contains the trigger word
                        if (this.containsTriggerWord(newUtterance)) {
                            // Send everything accumulated plus this utterance (minus trigger word)
                            const combined = previouslyAccumulated
                                ? previouslyAccumulated + ' ' + newUtterance
                                : newUtterance;
                            const textToSend = this.removeTriggerWord(combined).trim();
                            if (textToSend) {
                                this.sendMessage(textToSend);
                            }
                            this.messageInput.value = '';
                            this.accumulatedText = '';
                        } else {
                            // No trigger word - append with space (no newlines)
                            const newAccumulated = previouslyAccumulated
                                ? previouslyAccumulated + ' ' + newUtterance
                                : newUtterance;
                            this.messageInput.value = newAccumulated;
                            this.accumulatedText = newAccumulated;
                            this.autoGrowTextarea();
                        }
                    }
                } else {
                    // Still speaking
                    interimTranscript += transcript;
                }
            }

            if (interimTranscript) {
                // In trigger mode, preserve accumulated text and append interim
                if (this.sendMode === 'trigger' && this.accumulatedText) {
                    // Show accumulated + interim with single space
                    this.messageInput.value = this.accumulatedText + ' ' + interimTranscript.trim();
                } else {
                    // Show just interim
                    this.messageInput.value = interimTranscript;
                }

                this.isInterimText = true;
                this.autoGrowTextarea();
            }
        };

        this.recognition.onerror = (event) => {
            if (event.error !== 'no-speech') {
                console.error('Speech error:', event.error);
                this.stopVoiceDictation();
            }
        };

        this.recognition.onend = () => {
            if (this.isListening) {
                try {
                    this.recognition.start();
                } catch (e) {
                    console.error('Failed to restart recognition:', e);
                    this.stopVoiceDictation();
                }
            }
        };
    }

    containsTriggerWord(text) {
        if (!this.triggerWord) return false;
        const words = text.toLowerCase().split(/\s+/);
        return words.includes(this.triggerWord.toLowerCase());
    }

    removeTriggerWord(text) {
        if (!this.triggerWord) return text;
        const words = text.split(/\s+/);
        const filtered = words.filter(w => w.toLowerCase() !== this.triggerWord.toLowerCase());
        return filtered.join(' ');
    }

    async deleteMessage(messageId) {
        try {
            const response = await fetch(`${this.baseUrl}/api/utterances/${messageId}`, {
                method: 'DELETE'
            });

            if (response.ok) {
                // Remove the message bubble from DOM immediately
                const bubble = this.conversationMessages.querySelector(`[data-message-id="${messageId}"]`);
                if (bubble) {
                    bubble.remove();
                }
                // Refresh to sync with server
                this.loadData();
            } else {
                const error = await response.json();
                console.error('Failed to delete message:', error);
                alert(`Failed to delete: ${error.error || 'Unknown error'}`);
            }
        } catch (error) {
            console.error('Failed to delete message:', error);
        }
    }

    async updateVoiceInputState(active) {
        try {
            await fetch(`${this.baseUrl}/api/voice-input-state`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ active })
            });
        } catch (error) {
            console.error('Failed to update voice input state:', error);
        }
    }

    async syncSelectedVoiceToServer() {
        try {
            await fetch(`${this.baseUrl}/api/selected-voice`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ selectedVoice: this.selectedVoice, speechRate: Math.round(this.speechRate * 200) })
            });
        } catch (error) {
            this.debugLog('Failed to sync selected voice to server:', error);
        }
    }

    async updateVoiceResponses(enabled) {
        try {
            // Save to localStorage
            localStorage.setItem('voiceResponsesEnabled', enabled.toString());

            // Update server
            await fetch(`${this.baseUrl}/api/voice-preferences`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ voiceResponsesEnabled: enabled })
            });
        } catch (error) {
            console.error('Failed to update voice responses:', error);
        }
    }

    async syncVoiceStateToServer() {
        // Reset audio playback state — old audio from previous server is invalid
        this.clearAudioQueue();
        // Re-send current browser voice state to the server after a session reset
        await this.updateVoiceInputState(this.isListening);
        const voiceResponsesEnabled = this.voiceResponsesToggle ? this.voiceResponsesToggle.checked : false;
        await this.updateVoiceResponses(voiceResponsesEnabled);
        await this.syncSelectedVoiceToServer();
    }

    async loadBackgroundEnforcement() {
        try {
            const response = await fetch(`${this.baseUrl}/api/background-voice-enforcement`);
            if (response.ok) {
                const data = await response.json();
                if (this.backgroundEnforcementToggle) {
                    this.backgroundEnforcementToggle.checked = data.enabled;
                }
                localStorage.setItem('backgroundVoiceEnforcement', data.enabled.toString());
            }
        } catch (error) {
            this.debugLog('Failed to load background enforcement:', error);
        }
    }

    async updateBackgroundEnforcement(enabled) {
        try {
            localStorage.setItem('backgroundVoiceEnforcement', enabled.toString());
            await fetch(`${this.baseUrl}/api/background-voice-enforcement`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ enabled })
            });
        } catch (error) {
            console.error('Failed to update background enforcement:', error);
        }
    }

    // ── WebSocket audio capture ──────────────────────────────────────

    connectAudioWebSocket() {
        if (this.audioWs && (this.audioWs.readyState === WebSocket.OPEN || this.audioWs.readyState === WebSocket.CONNECTING)) {
            return; // Already connected or connecting
        }

        const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = `${protocol}//${location.host}/ws/audio`;
        this.debugLog('[WS] Connecting to', wsUrl);

        this.audioWs = new WebSocket(wsUrl);
        this.audioWs.binaryType = 'arraybuffer';

        this.audioWs.onopen = () => {
            this.debugLog('[WS] Connected');
            this.wsConnected = true;
            this.wsReconnectDelay = 1000; // Reset backoff on successful connect
        };

        this.audioWs.onmessage = (event) => {
            if (typeof event.data === 'string') {
                try {
                    const msg = JSON.parse(event.data);
                    this.handleWsMessage(msg);
                } catch (e) {
                    console.error('[WS] Failed to parse message:', e);
                }
            }
            } else if (event.data instanceof ArrayBuffer) {
                // Binary frame = TTS audio PCM data
                if (this.audioPlayer.ttsActive) {
                    this.audioPlayer.playPCMChunk(event.data);
                }
                return;
        };

        this.audioWs.onclose = () => {
            this.debugLog('[WS] Disconnected');
            this.wsConnected = false;
            this.audioWs = null;
            // Reconnect if still listening
            if (this.isListening) {
                this.scheduleWsReconnect();
            }
        };

        this.audioWs.onerror = (err) => {
            console.error('[WS] Error:', err);
        };
    }

    handleWsMessage(msg) {
        switch (msg.type) {
            case 'tts-start':
                this.debugLog('[WS] TTS start:', msg.audioId, 'sampleRate:', msg.sampleRate);
                this.audioPlayer.prepareForPlayback(msg.sampleRate, msg.audioId);
                // Echo suppression: mute mic audio streaming during TTS playback
                this._muteAudioCapture(true);
                break;
            case 'tts-end':
                this.debugLog('[WS] TTS end:', msg.audioId);
                this.audioPlayer.finishPlayback();
                // Send tts-ack to server
                if (this.audioWs && this.audioWs.readyState === WebSocket.OPEN) {
                    this.audioWs.send(JSON.stringify({ type: 'tts-ack', audioId: msg.audioId }));
                }
                // Un-mute mic audio streaming after TTS playback finishes
                // Wait for remaining scheduled audio to finish
                this._scheduleUnmute();
                break;
            case 'tts-clear':
                this.debugLog('[WS] TTS clear');
                this.audioPlayer.clear();
                this._muteAudioCapture(false);
                break;
            case 'pong':
                this.debugLog('[WS] Received pong');
                break;
            case 'error':
                console.error('[WS] Server error:', msg.message);
                break;
            default:
                this.debugLog('[WS] Unknown message type:', msg.type);
        }
    }

    // Echo suppression: mute/unmute mic audio streaming
    _muteAudioCapture(mute) {
        this._micMuted = mute;
    }

    _scheduleUnmute() {
        // Check periodically if audio player has finished all scheduled playback
        const checkDone = () => {
            if (!this.audioPlayer.isPlaying()) {
                this._muteAudioCapture(false);
            } else {
                setTimeout(checkDone, 100);
            }
        };
        setTimeout(checkDone, 100);
    }

    scheduleWsReconnect() {
        if (this.wsReconnectTimer) return; // Already scheduled
        this.debugLog(`[WS] Reconnecting in ${this.wsReconnectDelay}ms`);
        this.wsReconnectTimer = setTimeout(() => {
            this.wsReconnectTimer = null;
            if (this.isListening) {
                this.connectAudioWebSocket();
            }
        }, this.wsReconnectDelay);
        // Exponential backoff: 1s, 2s, 4s, 8s, max 30s
        this.wsReconnectDelay = Math.min(this.wsReconnectDelay * 2, 30000);
    }

    disconnectAudioWebSocket() {
        if (this.wsReconnectTimer) {
            clearTimeout(this.wsReconnectTimer);
            this.wsReconnectTimer = null;
        }
        if (this.audioWs) {
            this.audioWs.close();
            this.audioWs = null;
        }
    }

    async startAudioCapture() {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    channelCount: 1,
                    echoCancellation: true,
                    autoGainControl: true,
                    noiseSuppression: true,
                }
            });
            this.mediaStream = stream;

            // Create AudioContext at native rate — worklet handles downsampling
            this.audioContext = new AudioContext();
            await this.audioContext.resume(); // Required on iOS after user gesture

            const source = this.audioContext.createMediaStreamSource(stream);
            await this.audioContext.audioWorklet.addModule('/audio-capture-worklet.js');

            this.audioWorkletNode = new AudioWorkletNode(this.audioContext, 'audio-capture-processor');
            this.audioWorkletNode.port.onmessage = (e) => {
                if (e.data.type === 'audio-frame' && this.audioWs && this.audioWs.readyState === WebSocket.OPEN && !this._micMuted) {
                    // Convert Float32 [-1,1] to Int16 PCM
                    const float32 = e.data.frame;
                    const pcm16 = new Int16Array(float32.length);
                    for (let i = 0; i < float32.length; i++) {
                        const s = Math.max(-1, Math.min(1, float32[i]));
                        pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
                    }
                    this.audioWs.send(pcm16.buffer);
                }
            };

            source.connect(this.audioWorkletNode);
            // Connect to destination to keep the worklet processing (required)
            this.audioWorkletNode.connect(this.audioContext.destination);

            // Send audio-start control message
            if (this.audioWs && this.audioWs.readyState === WebSocket.OPEN) {
                this.audioWs.send(JSON.stringify({
                    type: 'audio-start',
                    sampleRate: 16000,
                    channels: 1,
                    encoding: 'pcm16',
                }));
            }

            this.debugLog('[Audio] Capture started, native rate:', this.audioContext.sampleRate);
        } catch (err) {
            console.error('[Audio] Failed to start capture:', err);
        }
    }

    stopAudioCapture() {
        // Send audio-stop control message
        if (this.audioWs && this.audioWs.readyState === WebSocket.OPEN) {
            this.audioWs.send(JSON.stringify({ type: 'audio-stop' }));
        }

        // Clean up AudioWorklet and context
        if (this.audioWorkletNode) {
            this.audioWorkletNode.disconnect();
            this.audioWorkletNode = null;
        }
        if (this.audioContext) {
            this.audioContext.close().catch(() => {});
            this.audioContext = null;
        }
        if (this.mediaStream) {
            this.mediaStream.getTracks().forEach(track => track.stop());
            this.mediaStream = null;
        }

        this.debugLog('[Audio] Capture stopped');
    }
}

// Initialize when page loads
document.addEventListener('DOMContentLoaded', () => {
    new MessengerClient();
});
