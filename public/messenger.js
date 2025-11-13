class MessengerClient {
    constructor() {
        this.baseUrl = window.location.origin;

        // Conversation elements
        this.refreshBtn = document.getElementById('refreshBtn');
        this.clearAllBtn = document.getElementById('clearAllBtn');
        this.conversationMessages = document.getElementById('conversationMessages');
        this.conversationContainer = document.getElementById('conversationContainer');

        // Text input elements
        this.messageInput = document.getElementById('messageInput');
        this.micBtn = document.getElementById('micBtn');
        this.listeningIndicator = document.getElementById('listeningIndicator');

        // Send mode controls
        this.sendModeRadios = document.querySelectorAll('input[name="sendMode"]');
        this.triggerWordInputContainer = document.getElementById('triggerWordInputContainer');
        this.triggerWordInput = document.getElementById('triggerWordInput');

        // Settings
        this.settingsToggleHeader = document.getElementById('settingsToggleHeader');
        this.settingsContent = document.getElementById('settingsContent');
        this.voiceResponsesToggle = document.getElementById('voiceResponsesToggle');

        // State
        this.sendMode = 'automatic'; // 'automatic' or 'trigger'
        this.triggerWord = 'send';
        this.isListening = false;
        this.isInterimText = false;

        // Initialize
        this.initializeSpeechRecognition();
        this.setupEventListeners();
        this.loadData();

        // Activate voice input on load so hooks auto-dequeue messages
        // Use setTimeout to ensure this happens after initialization
        setTimeout(() => {
            this.updateVoiceInputState(true).then(() => {
                console.log('[MessengerUI] Voice input activated');
            }).catch(err => {
                console.error('[MessengerUI] Failed to activate voice input:', err);
            });
        }, 100);

        // Auto-refresh every 2 seconds
        setInterval(() => this.loadData(), 2000);
    }

    setupEventListeners() {
        // Refresh and clear buttons
        this.refreshBtn.addEventListener('click', () => this.loadData());
        this.clearAllBtn.addEventListener('click', () => this.clearAllMessages());

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
            await this.updateVoiceResponses(e.target.checked);
        });
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
        container.querySelectorAll('.message-bubble').forEach(el => el.remove());

        // Render messages in chronological order
        messages.forEach(message => {
            const bubble = document.createElement('div');
            bubble.className = `message-bubble ${message.role}`;

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
                const status = document.createElement('span');
                status.className = `message-status ${message.status}`;
                status.textContent = message.status.toUpperCase();
                messageMeta.appendChild(status);
            }

            bubble.appendChild(messageText);
            bubble.appendChild(messageMeta);
            container.appendChild(bubble);
        });

        this.scrollToBottom();
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
            this.listeningIndicator.classList.add('active');

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
            this.listeningIndicator.classList.remove('active');

            if (this.isInterimText) {
                this.messageInput.value = '';
                this.isInterimText = false;
            }

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

                    const finalText = this.messageInput.value.trim();

                    if (this.sendMode === 'automatic') {
                        // Send immediately
                        this.sendMessage(finalText);
                        this.messageInput.value = '';
                    } else {
                        // Trigger word mode: check for trigger word
                        if (this.containsTriggerWord(finalText)) {
                            const textToSend = this.removeTriggerWord(finalText);
                            this.sendMessage(textToSend);
                            this.messageInput.value = '';
                        } else {
                            // Append with newline
                            const currentText = this.messageInput.value;
                            this.messageInput.value = currentText ? currentText + '\n' + transcript : transcript;
                            this.autoGrowTextarea();
                        }
                    }
                } else {
                    // Still speaking
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

    async clearAllMessages() {
        if (!confirm('Clear all messages?')) return;

        try {
            const response = await fetch(`${this.baseUrl}/api/utterances`, {
                method: 'DELETE'
            });

            if (response.ok) {
                this.loadData();
            }
        } catch (error) {
            console.error('Failed to clear messages:', error);
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

    async updateVoiceResponses(enabled) {
        try {
            await fetch(`${this.baseUrl}/api/voice-preferences`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ voiceResponsesEnabled: enabled })
            });
        } catch (error) {
            console.error('Failed to update voice responses:', error);
        }
    }
}

// Initialize when page loads
document.addEventListener('DOMContentLoaded', () => {
    new MessengerClient();
});
