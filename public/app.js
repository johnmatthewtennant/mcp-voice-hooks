// AudioPlayer: plays PCM16 audio chunks via AudioContext for WebSocket TTS streaming
class AudioPlayer {
    constructor() {
        this.playbackContext = null; // Created lazily on unlock
        this.nextStartTime = 0;
        this.scheduledSources = [];
        this.gainNode = null;
        this.ttsActive = false;
        this.currentAudioId = null;
        this.isFirstChunk = true;
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
        this.isFirstChunk = true;
        // Only reset scheduling if no audio is queued — otherwise new audio
        // should play after the currently scheduled audio finishes
        if (this.playbackContext && this.nextStartTime < this.playbackContext.currentTime) {
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

        // Recognition mode
        this.recognitionModeSelect = document.getElementById('recognitionModeSelect');

        // Settings
        this.settingsToggleHeader = document.getElementById('settingsToggleHeader');
        this.settingsContent = document.getElementById('settingsContent');
        this.speechRateSlider = document.getElementById('speechRate');
        this.speechRateInput = document.getElementById('speechRateInput');
        this.testTTSBtn = document.getElementById('testTTSBtn');

        // Session sidebar elements
        this.sessionSidebar = document.getElementById('sessionSidebar');
        this.sessionList = document.getElementById('sessionList');
        this.sidebarOpenBtn = document.getElementById('sidebarOpenBtn');
        this.sidebarCloseBtn = document.getElementById('sidebarCloseBtn');
        this.backgroundEnforcementToggle = document.getElementById('backgroundEnforcementToggle');

        // State
        this.recognitionMode = 'server'; // 'server' or 'browser'
        this.serverRecognitionAvailable = false; // set from server check
        this.isListening = false;
        this.isInterimText = false;
        this.debug = localStorage.getItem('voiceHooksDebug') === 'true';

        // TTS state
        this.speechRate = 1.0;

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

        // Voice state (driven by server SSE events)
        this.currentVoiceState = 'inactive';

        // Session state
        this.sessions = [];
        this.activeSessionKey = null;
        this.unreadCounts = {}; // key → count of messages since last viewed

        // Initialize
        this.initializeSpeechRecognition();
        this.initializeTTSEvents();
        this.initializeSessionSidebar();
        this.setupEventListeners();
        this.loadPreferences();
        this.checkServerRecognition();
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
                } else if (data.type === 'voice-state') {
                    // Server is the single source of truth for voice state
                    this.currentVoiceState = data.state;
                    this.updateVoiceStateUI(data.state);
                } else if (data.type === 'tts-clear') {
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
            // Reset voice state to prevent stale UI while disconnected
            this.currentVoiceState = 'inactive';
            this.updateVoiceStateUI('inactive');
        };
    }

    handleWaitStatus(isWaiting) {
        // Fallback handler for waitStatus SSE events.
        // voice-state SSE events are now the primary driver for UI state.
        const waitingIndicator = document.getElementById('waitingIndicator');
        if (waitingIndicator) {
            const wasAtBottom = this.isUserNearBottom();
            waitingIndicator.style.display = isWaiting ? 'block' : 'none';
            if (isWaiting && wasAtBottom) {
                this.scrollToBottom();
            }
        }
    }

    updateVoiceStateUI(state) {
        const waitingIndicator = document.getElementById('waitingIndicator');
        if (!waitingIndicator) return;

        const wasAtBottom = this.isUserNearBottom();

        if (state === 'listening') {
            waitingIndicator.textContent = 'Claude is waiting...';
            waitingIndicator.style.display = 'block';
        } else if (state === 'processing') {
            waitingIndicator.textContent = 'Claude is processing...';
            waitingIndicator.style.display = 'block';
        } else if (state === 'speaking') {
            waitingIndicator.textContent = 'Claude is speaking...';
            waitingIndicator.style.display = 'block';
        } else if (state === 'stopped') {
            waitingIndicator.textContent = 'Claude\'s turn ended';
            waitingIndicator.style.display = 'block';
        } else {
            waitingIndicator.style.display = 'none';
        }

        if (state !== 'inactive' && wasAtBottom) {
            this.scrollToBottom();
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

    loadPreferences() {
        // Load speech rate
        const savedRate = localStorage.getItem('speechRate');
        if (savedRate) {
            this.speechRate = parseFloat(savedRate);
            if (this.speechRateSlider) this.speechRateSlider.value = this.speechRate.toString();
            if (this.speechRateInput) this.speechRateInput.value = this.speechRate.toFixed(1);
        }

        // Load recognition mode
        const savedRecognitionMode = localStorage.getItem('recognitionMode');
        if (savedRecognitionMode) {
            this.recognitionMode = savedRecognitionMode;
        }

    }

    async checkServerRecognition() {
        try {
            const response = await fetch(`${this.baseUrl}/api/speech-recognition-available`);
            if (response.ok) {
                const data = await response.json();
                this.serverRecognitionAvailable = data.available;
            }
        } catch (error) {
            this.debugLog('Failed to check server recognition:', error);
            this.serverRecognitionAvailable = false;
        }

        // If server recognition not available, fall back to browser
        if (!this.serverRecognitionAvailable && this.recognitionMode === 'server') {
            this.recognitionMode = 'browser';
        }

        // Update UI
        if (this.recognitionModeSelect) {
            this.recognitionModeSelect.value = this.recognitionMode;
            // Disable server option if not available
            const serverOption = this.recognitionModeSelect.querySelector('option[value="server"]');
            if (serverOption) {
                serverOption.disabled = !this.serverRecognitionAvailable;
                serverOption.textContent = this.serverRecognitionAvailable
                    ? 'Server Recognition'
                    : 'Server Recognition (unavailable)';
            }
        }
    }

    /** Whether the active recognition mode uses server-side transcription. */
    get useServerRecognition() {
        return this.recognitionMode === 'server' && this.serverRecognitionAvailable && this.wsConnected;
    }

    setupEventListeners() {
        window.addEventListener('beforeunload', () => {
            this.currentVoiceState = 'inactive';
        });

        // Text input events
        this.messageInput.addEventListener('keydown', (e) => this.handleTextInputKeydown(e));
        this.messageInput.addEventListener('input', () => this.autoGrowTextarea());

        // Microphone button
        this.micBtn.addEventListener('click', () => this.toggleVoiceDictation());

        // Recognition mode selector
        if (this.recognitionModeSelect) {
            this.recognitionModeSelect.addEventListener('change', (e) => {
                this.recognitionMode = e.target.value;
                localStorage.setItem('recognitionMode', this.recognitionMode);
            });
        }

        // Settings toggle (dropdown)
        this.settingsToggleHeader.addEventListener('click', (e) => {
            e.stopPropagation();
            this.settingsContent.classList.toggle('open');
        });
        // Close dropdown when clicking outside
        document.addEventListener('click', (e) => {
            if (!this.settingsContent.contains(e.target) && !this.settingsToggleHeader.contains(e.target)) {
                this.settingsContent.classList.remove('open');
            }
        });

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

        // Test TTS button — triggers server-side TTS without side effects
        if (this.testTTSBtn) {
            this.testTTSBtn.addEventListener('click', async () => {
                try {
                    await fetch(`${this.baseUrl}/api/test-voice`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ text: 'This is Voice Mode for Claude Code. How can I help you today?' })
                    });
                } catch (error) {
                    console.error('Failed to test voice:', error);
                }
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

        // Check if user is near bottom before adding content
        const wasAtBottom = this.isUserNearBottom();

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

        // Only auto-scroll if user was already at the bottom
        if (wasAtBottom) {
            this.scrollToBottom();
        }
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

    isUserNearBottom() {
        const container = this.conversationContainer;
        return container.scrollHeight - container.scrollTop - container.clientHeight < 50;
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
        try {
            if (this.isInterimText) {
                this.messageInput.value = '';
                this.isInterimText = false;
            }

            this.isListening = true;
            this.micBtn.classList.add('listening');

            // Unlock AudioPlayer on user gesture (iOS Safari requirement)
            await this.audioPlayer.unlock();

            // Open WebSocket; audio capture starts from the onopen callback
            this.connectAudioWebSocket();

            // Start browser speech recognition only if NOT using server recognition
            if (!this.useServerRecognition && this.recognition) {
                this.recognition.start();
            }

            // Activate voice input and voice responses when mic is on
            await this.updateVoiceActive(true);
        } catch (e) {
            console.error('Failed to start recognition:', e);
            alert('Failed to start speech recognition');
        }
    }

    async stopVoiceDictation() {
        this.isListening = false;
        if (this.recognition) {
            this.recognition.stop();
        }
        this.micBtn.classList.remove('listening');

        // Send any accumulated text in the input (from browser recognition)
        const text = this.messageInput.value.trim();
        if (text && !this.isInterimText) {
            await this.sendMessage(text);
            this.messageInput.value = '';
        }

        this.isInterimText = false;
        this.messageInput.style.height = 'auto';

        // Stop audio capture and disconnect WebSocket
        this.stopAudioCapture();
        this.disconnectAudioWebSocket();

        // Deactivate voice input and voice responses when mic is turned off
        await this.updateVoiceActive(false);
    }

    initializeSpeechRecognition() {
        const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

        if (!SpeechRecognition) {
            console.error('Speech recognition not supported');
            return;
        }

        this.recognition = new SpeechRecognition();
        this.recognition.continuous = true;
        this.recognition.interimResults = true;
        this.recognition.lang = 'en-US';

        this.recognition.onresult = (event) => {
            // Skip browser recognition results when using server recognition
            if (this.useServerRecognition) return;

            let interimTranscript = '';

            for (let i = event.resultIndex; i < event.results.length; i++) {
                const transcript = event.results[i][0].transcript;

                if (event.results[i].isFinal) {
                    this.isInterimText = false;
                    const finalText = this.messageInput.value.trim();
                    this.sendMessage(finalText);
                    this.messageInput.value = '';
                } else {
                    interimTranscript += transcript;
                }
            }

            if (interimTranscript) {
                this.messageInput.value = interimTranscript;
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
            // Only restart browser recognition if listening and not using server
            if (this.isListening && !this.useServerRecognition) {
                try {
                    this.recognition.start();
                } catch (e) {
                    console.error('Failed to restart recognition:', e);
                    this.stopVoiceDictation();
                }
            }
        };
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

    async updateVoiceActive(active) {
        try {
            await fetch(`${this.baseUrl}/api/voice-active`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ active })
            });
        } catch (error) {
            console.error('Failed to update voice active state:', error);
        }
    }

    async syncSelectedVoiceToServer() {
        try {
            await fetch(`${this.baseUrl}/api/selected-voice`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ selectedVoice: 'system', speechRate: Math.round(this.speechRate * 200) })
            });
        } catch (error) {
            this.debugLog('Failed to sync selected voice to server:', error);
        }
    }

    async syncVoiceStateToServer() {
        // Re-send current browser voice state to the server after a session reset
        await this.updateVoiceActive(this.isListening);
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
        console.log('[WS] Connecting to', wsUrl);

        this.audioWs = new WebSocket(wsUrl);
        this.audioWs.binaryType = 'arraybuffer';

        this.audioWs.onopen = () => {
            console.log('[WS] Connected');
            this.wsConnected = true;
            this.wsReconnectDelay = 1000; // Reset backoff on successful connect
            // Start audio capture now that the WS connection is ready
            this.startAudioCapture();
        };

        this.audioWs.onmessage = (event) => {
            if (typeof event.data === 'string') {
                try {
                    const msg = JSON.parse(event.data);
                    this.handleWsMessage(msg);
                } catch (e) {
                    console.error('[WS] Failed to parse message:', e);
                }
            } else if (event.data instanceof ArrayBuffer) {
                // Binary frame = TTS audio PCM data
                if (this.audioPlayer.ttsActive) {
                    this.audioPlayer.playPCMChunk(event.data);
                }
            }
        };

        this.audioWs.onclose = () => {
            console.log('[WS] Disconnected');
            this.wsConnected = false;
            this.audioWs = null;
            // Reset TTS playback state and unmute mic on disconnect
            this.audioPlayer.clear();
            this._micMuted = false;
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
            case 'transcript-interim':
                // Display interim transcript in the message input (display only)
                if (this.useServerRecognition) {
                    this.messageInput.value = msg.text;
                    this.isInterimText = true;
                    this.autoGrowTextarea();
                }
                break;
            case 'transcript-final':
                // Server already created the utterance — just display it
                if (this.useServerRecognition) {
                    this.messageInput.value = '';
                    this.isInterimText = false;
                    this.messageInput.style.height = 'auto';
                    // Refresh conversation to show the new message
                    this.loadData();
                }
                break;
            case 'tts-start': {
                const isSfx = msg.kind === 'sfx';
                console.log('[WS] TTS start:', msg.audioId, 'sampleRate:', msg.sampleRate, 'kind:', msg.kind || 'tts');
                this.audioPlayer.prepareForPlayback(msg.sampleRate, msg.audioId);
                if (!isSfx) {
                    // Echo suppression: mute mic audio streaming during TTS playback
                    this._muteAudioCapture(true);
                }
                break;
            }
            case 'tts-end': {
                const isSfx = msg.kind === 'sfx';
                this.debugLog('[WS] TTS end:', msg.audioId, 'kind:', msg.kind || 'tts');
                this.audioPlayer.finishPlayback();
                if (!isSfx) {
                    // Wait for actual audio playback to finish, then ack and unmute
                    // (streaming finishes faster than playback)
                    this._waitForPlaybackThenAck(msg.audioId);
                }
                break;
            }
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

    _waitForPlaybackThenAck(audioId) {
        // Poll until AudioPlayer finishes all scheduled playback, then:
        // 1. Send tts-ack to server (so it knows playback is truly done)
        // 2. Unmute mic
        const checkDone = () => {
            if (!this.audioPlayer.isPlaying()) {
                if (this.audioWs && this.audioWs.readyState === WebSocket.OPEN) {
                    this.audioWs.send(JSON.stringify({ type: 'tts-ack', audioId }));
                }
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
            // Connect through a silent GainNode to keep the worklet processing
            // without playing captured audio through speakers (avoids feedback)
            const silentGain = this.audioContext.createGain();
            silentGain.gain.value = 0;
            this.audioWorkletNode.connect(silentGain);
            silentGain.connect(this.audioContext.destination);

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
