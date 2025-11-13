class VoiceHooksClient {
    constructor() {
        this.baseUrl = window.location.origin;
        this.debug = localStorage.getItem('voiceHooksDebug') === 'true';
        this.refreshBtn = document.getElementById('refreshBtn');
        this.clearAllBtn = document.getElementById('clearAllBtn');
        this.utterancesList = document.getElementById('utterancesList');
        this.infoMessage = document.getElementById('infoMessage');

        // Voice controls
        this.listenBtn = document.getElementById('listenBtn');
        this.listenBtnText = document.getElementById('listenBtnText');
        this.listeningIndicator = document.getElementById('listeningIndicator');
        this.interimText = document.getElementById('interimText');

        // Send mode controls
        this.sendModeAutomatic = document.getElementById('sendModeAutomatic');
        this.sendModeWait = document.getElementById('sendModeWait');
        this.triggerWordControls = document.getElementById('triggerWordControls');
        this.triggerWordInput = document.getElementById('triggerWordInput');
        this.sendNowBtn = document.getElementById('sendNowBtn');
        this.queuedUtterancesSection = document.getElementById('queuedUtterancesSection');
        this.queuedUtterancesList = document.getElementById('queuedUtterancesList');
        this.queuedCount = document.getElementById('queuedCount');

        // Utterance queue for wait mode
        this.utteranceQueue = [];
        this.sendMode = 'automatic'; // 'automatic' or 'wait'
        this.triggerWord = '';

        // Speech recognition
        this.recognition = null;
        this.isListening = false;
        this.initializeSpeechRecognition();

        // Speech synthesis
        this.initializeSpeechSynthesis();

        // Server-Sent Events for TTS
        this.initializeTTSEvents();

        // TTS controls
        this.languageSelect = document.getElementById('languageSelect');
        this.voiceSelect = document.getElementById('voiceSelect');
        this.speechRateSlider = document.getElementById('speechRate');
        this.speechRateInput = document.getElementById('speechRateInput');
        this.testTTSBtn = document.getElementById('testTTSBtn');
        this.voiceResponsesToggle = document.getElementById('voiceResponsesToggle');
        this.voiceOptions = document.getElementById('voiceOptions');
        this.localVoicesGroup = document.getElementById('localVoicesGroup');
        this.cloudVoicesGroup = document.getElementById('cloudVoicesGroup');
        this.rateWarning = document.getElementById('rateWarning');
        this.systemVoiceInfo = document.getElementById('systemVoiceInfo');

        // Load saved preferences
        this.loadPreferences();

        this.setupEventListeners();
        this.loadData();

        // Auto-refresh every 2 seconds
        setInterval(() => this.loadData(), 2000);
    }

    initializeSpeechRecognition() {
        // Check for browser support
        const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

        if (!SpeechRecognition) {
            console.error('Speech recognition not supported in this browser');
            this.listenBtn.disabled = true;
            this.listenBtnText.textContent = 'Not Supported';
            return;
        }

        this.recognition = new SpeechRecognition();
        this.recognition.continuous = true;
        this.recognition.interimResults = true;

        // Handle results
        this.recognition.onresult = (event) => {
            let interimTranscript = '';

            for (let i = event.resultIndex; i < event.results.length; i++) {
                const transcript = event.results[i][0].transcript;

                if (event.results[i].isFinal) {
                    // User paused - handle based on send mode
                    if (this.sendMode === 'automatic') {
                        // Send immediately
                        this.sendVoiceUtterance(transcript);
                    } else {
                        // Queue the utterance and check for trigger word
                        this.queueUtterance(transcript);
                    }
                    // Restore placeholder text
                    this.interimText.textContent = 'Start speaking and your words will appear here...';
                    this.interimText.classList.remove('active');
                } else {
                    // Still speaking - show interim results
                    interimTranscript += transcript;
                }
            }

            if (interimTranscript) {
                this.interimText.textContent = interimTranscript;
                this.interimText.classList.add('active');
            }
        };

        // Handle errors
        this.recognition.onerror = (event) => {
            console.error('Speech recognition error:', event.error);

            if (event.error === 'no-speech') {
                // Continue listening
                return;
            }

            if (event.error === 'not-allowed') {
                alert('Microphone access denied. Please allow microphone access to use voice input.');
            } else {
                alert(`Speech recognition error: ${event.error}`);
            }

            this.stopListening();
        };

        // Handle end
        this.recognition.onend = () => {
            if (this.isListening) {
                // Restart recognition to continue listening
                try {
                    this.recognition.start();
                } catch (e) {
                    console.error('Failed to restart recognition:', e);
                    this.stopListening();
                }
            }
        };
    }

    setupEventListeners() {
        this.refreshBtn.addEventListener('click', () => this.loadData());
        this.clearAllBtn.addEventListener('click', () => this.clearAllUtterances());
        this.listenBtn.addEventListener('click', () => this.toggleListening());

        // Language filter
        if (this.languageSelect) {
            this.languageSelect.addEventListener('change', () => {
                // Save language preference
                localStorage.setItem('selectedLanguage', this.languageSelect.value);
                // Repopulate voice list with filtered voices
                this.populateVoiceList();
            });
        }

        // TTS controls
        this.voiceSelect.addEventListener('change', (e) => {
            this.selectedVoice = e.target.value;
            // Save selected voice to localStorage
            localStorage.setItem('selectedVoice', this.selectedVoice);
            this.updateVoicePreferences();
            this.updateVoiceWarnings();
        });

        this.speechRateSlider.addEventListener('input', (e) => {
            this.speechRate = parseFloat(e.target.value);
            this.speechRateInput.value = this.speechRate.toFixed(1);
            // Save rate to localStorage
            localStorage.setItem('speechRate', this.speechRate.toString());
        });

        this.speechRateInput.addEventListener('input', (e) => {
            let value = parseFloat(e.target.value);
            if (!isNaN(value)) {
                value = Math.max(0.5, Math.min(5, value)); // Clamp to valid range
                this.speechRate = value;
                this.speechRateSlider.value = value.toString();
                this.speechRateInput.value = value.toFixed(1);
                // Save rate to localStorage
                localStorage.setItem('speechRate', this.speechRate.toString());
            }
        });

        this.testTTSBtn.addEventListener('click', () => {
            this.speakText('This is Voice Mode for Claude Code. How can I help you today?');
        });

        // Voice toggle listeners
        this.voiceResponsesToggle.addEventListener('change', (e) => {
            const enabled = e.target.checked;
            localStorage.setItem('voiceResponsesEnabled', enabled);
            this.updateVoicePreferences();
            this.updateVoiceOptionsVisibility();
        });

        // Send mode listeners
        this.sendModeAutomatic.addEventListener('change', (e) => {
            if (e.target.checked) {
                this.sendMode = 'automatic';
                this.updateSendModeUI();
                localStorage.setItem('sendMode', 'automatic');
            }
        });

        this.sendModeWait.addEventListener('change', (e) => {
            if (e.target.checked) {
                this.sendMode = 'wait';
                this.updateSendModeUI();
                localStorage.setItem('sendMode', 'wait');
            }
        });

        this.triggerWordInput.addEventListener('input', (e) => {
            this.triggerWord = e.target.value.trim();
            localStorage.setItem('triggerWord', this.triggerWord);
        });

        this.sendNowBtn.addEventListener('click', () => {
            this.sendQueuedUtterances();
        });
    }


    async loadData() {
        try {
            // Load utterances
            const utterancesResponse = await fetch(`${this.baseUrl}/api/utterances?limit=20`);
            if (utterancesResponse.ok) {
                const data = await utterancesResponse.json();
                this.updateUtterancesList(data.utterances);
            }
        } catch (error) {
            console.error('Failed to load data:', error);
        }
    }

    updateUtterancesList(utterances) {
        if (utterances.length === 0) {
            this.utterancesList.innerHTML = '<div class="empty-state">Nothing yet.</div>';
            this.infoMessage.style.display = 'none';
            return;
        }

        // Check if all messages are pending
        const allPending = utterances.every(u => u.status === 'pending');
        if (allPending) {
            // Show info message but don't replace the utterances list
            this.infoMessage.style.display = 'block';
        } else {
            // Hide info message when at least one utterance is delivered
            this.infoMessage.style.display = 'none';
        }

        this.utterancesList.innerHTML = utterances.map(utterance => `
            <div class="utterance-item">
                <div class="utterance-text">${this.escapeHtml(utterance.text)}</div>
                <div class="utterance-meta">
                    <div>${this.formatTimestamp(utterance.timestamp)}</div>
                    <div class="utterance-status status-${utterance.status}">
                        ${utterance.status.toUpperCase()}
                    </div>
                </div>
            </div>
        `).join('');
    }

    formatTimestamp(timestamp) {
        const date = new Date(timestamp);
        return date.toLocaleTimeString();
    }

    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    toggleListening() {
        if (this.isListening) {
            this.stopListening();
        } else {
            this.startListening();
        }
    }

    async startListening() {
        if (!this.recognition) {
            alert('Speech recognition not supported in this browser');
            return;
        }

        try {
            this.recognition.start();
            this.isListening = true;
            this.listenBtn.classList.add('listening');
            this.listenBtnText.textContent = 'Stop Listening';
            this.listeningIndicator.classList.add('active');
            this.debugLog('Started listening');

            // Notify server that voice input is active
            await this.updateVoiceInputState(true);
        } catch (e) {
            console.error('Failed to start recognition:', e);
            alert('Failed to start speech recognition. Please try again.');
        }
    }

    async stopListening() {
        if (this.recognition) {
            this.isListening = false;
            this.recognition.stop();
            this.listenBtn.classList.remove('listening');
            this.listenBtnText.textContent = 'Start Listening';
            this.listeningIndicator.classList.remove('active');
            this.interimText.textContent = 'Start speaking and your words will appear here...';
            this.interimText.classList.remove('active');
            this.debugLog('Stopped listening');

            // Notify server that voice input is no longer active
            await this.updateVoiceInputState(false);
        }
    }

    async sendVoiceUtterance(text) {
        const trimmedText = text.trim();
        if (!trimmedText) return;

        this.debugLog('Sending voice utterance:', trimmedText);

        try {
            const response = await fetch(`${this.baseUrl}/api/potential-utterances`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    text: trimmedText,
                    timestamp: new Date().toISOString()
                }),
            });

            if (response.ok) {
                this.loadData(); // Refresh the list
            } else {
                const error = await response.json();
                console.error('Error sending voice utterance:', error);
            }
        } catch (error) {
            console.error('Failed to send voice utterance:', error);
        }
    }

    async clearAllUtterances() {

        this.clearAllBtn.disabled = true;
        this.clearAllBtn.textContent = 'Clearing...';

        try {
            const response = await fetch(`${this.baseUrl}/api/utterances`, {
                method: 'DELETE',
                headers: {
                    'Content-Type': 'application/json',
                }
            });

            if (response.ok) {
                const result = await response.json();
                this.loadData(); // Refresh the list
                this.debugLog('Cleared all utterances:', result);
            } else {
                const error = await response.json();
                alert(`Error: ${error.error || 'Failed to clear utterances'}`);
            }
        } catch (error) {
            console.error('Failed to clear utterances:', error);
            alert('Failed to clear utterances. Make sure the server is running.');
        } finally {
            this.clearAllBtn.disabled = false;
            this.clearAllBtn.textContent = 'Clear All';
        }
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

        // Set default voice preferences
        this.speechRate = 1.0;
        this.speechPitch = 1.0;
        this.selectedVoice = 'system';
    }

    initializeTTSEvents() {
        // Connect to Server-Sent Events endpoint
        this.eventSource = new EventSource(`${this.baseUrl}/api/tts-events`);

        this.eventSource.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
                this.debugLog('TTS Event:', data);

                if (data.type === 'speak' && data.text) {
                    this.speakText(data.text);
                } else if (data.type === 'waitStatus') {
                    this.handleWaitStatus(data.isWaiting);
                }
            } catch (error) {
                console.error('Failed to parse TTS event:', error);
            }
        };

        this.eventSource.onerror = (error) => {
            console.error('SSE connection error:', error);
            // Will automatically reconnect
        };

        this.eventSource.onopen = () => {
            this.debugLog('TTS Events connected');
            // Sync state when connection is established (includes reconnections)
            this.syncStateWithServer();
        };
    }

    populateLanguageFilter() {
        if (!this.languageSelect || !this.voices) return;

        // Get current selection
        const currentSelection = this.languageSelect.value || 'en-US';

        // Clear existing options
        this.languageSelect.innerHTML = '';

        // Add "All Languages" option
        const allOption = document.createElement('option');
        allOption.value = 'all';
        allOption.textContent = 'All Languages';
        this.languageSelect.appendChild(allOption);

        // Collect unique language codes
        const languageCodes = new Set();
        this.voices.forEach(voice => {
            languageCodes.add(voice.lang);
        });

        // Sort and add language codes
        Array.from(languageCodes).sort().forEach(lang => {
            const option = document.createElement('option');
            option.value = lang;
            option.textContent = lang;
            this.languageSelect.appendChild(option);
        });

        // Restore selection
        this.languageSelect.value = currentSelection;
        if (this.languageSelect.value !== currentSelection) {
            // If saved selection not available, default to en-US
            this.languageSelect.value = 'en-US';
        }
    }

    populateVoiceList() {
        if (!this.voiceSelect || !this.localVoicesGroup || !this.cloudVoicesGroup) return;
        

        // First populate the language filter
        this.populateLanguageFilter();

        // Clear existing browser voice options
        this.localVoicesGroup.innerHTML = '';
        this.cloudVoicesGroup.innerHTML = '';

        // List of voices to exclude (novelty, Eloquence, and non-premium voices)
        const excludedVoices = [
            // Eloquence voices
            'Eddy', 'Flo', 'Grandma', 'Grandpa', 'Reed', 'Rocko', 'Sandy', 'Shelley',
            // Novelty voices
            'Albert', 'Bad News', 'Bahh', 'Bells', 'Boing', 'Bubbles', 'Cellos',
            'Good News', 'Jester', 'Organ', 'Superstar', 'Trinoids', 'Whisper',
            'Wobble', 'Zarvox',
            // Voices without premium options
            'Fred', 'Junior', 'Kathy', 'Ralph'
        ];

        // Get selected language filter
        const selectedLanguage = this.languageSelect ? this.languageSelect.value : 'en-US';

        // Filter voices based on selected language
        this.voices.forEach((voice, index) => {
            const voiceLang = voice.lang;
            let shouldInclude = false;

            if (selectedLanguage === 'all') {
                // Include all languages
                shouldInclude = true;
            } else {
                // Check if voice matches selected language/locale
                shouldInclude = voiceLang === selectedLanguage;
            }

            if (shouldInclude) {
                // Check if voice should be excluded
                const voiceName = voice.name;
                const isExcluded = excludedVoices.some(excluded =>
                    voiceName.toLowerCase().startsWith(excluded.toLowerCase())
                );

                if (!isExcluded) {
                    const option = document.createElement('option');
                    option.value = `browser:${index}`;
                    // Show voice name and language code
                    option.textContent = `${voice.name} (${voice.lang})`;

                    // Categorize voices
                    if (voice.localService) {
                        this.localVoicesGroup.appendChild(option);
                        this.debugLog(voice.voiceURI);
                    } else {
                        this.cloudVoicesGroup.appendChild(option);
                    }
                }
            }
        });

        // Hide empty groups
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

        // Restore saved selection
        const savedVoice = localStorage.getItem('selectedVoice');
        if (savedVoice) {
            this.voiceSelect.value = savedVoice;
            this.selectedVoice = savedVoice;
        } else {
            // Look for Google US English Male voice first
            let googleUSMaleIndex = -1;
            let microsoftAndrewIndex = -1;

            this.voices.forEach((voice, index) => {
                const voiceName = voice.name.toLowerCase();

                // Check for Google US English Male
                if (voiceName.includes('google') &&
                    voiceName.includes('us') &&
                    voiceName.includes('english')) {
                    googleUSMaleIndex = index;
                }

                // Check for Microsoft Andrew Online
                if (voiceName.includes('microsoft') &&
                    voiceName.includes('andrew') &&
                    voiceName.includes('online')) {
                    microsoftAndrewIndex = index;
                }
            });

            if (googleUSMaleIndex !== -1) {
                this.selectedVoice = `browser:${googleUSMaleIndex}`;
                this.voiceSelect.value = this.selectedVoice;
                this.debugLog('Defaulting to Google US English Male voice');
            } else if (microsoftAndrewIndex !== -1) {
                this.selectedVoice = `browser:${microsoftAndrewIndex}`;
                this.voiceSelect.value = this.selectedVoice;
                this.debugLog('Google US English Male not found, defaulting to Microsoft Andrew Online');
            } else {
                this.selectedVoice = 'system';
                this.debugLog('Preferred voices not found, using system default');
            }
        }

        // Update warnings based on selected voice
        this.updateVoiceWarnings();
    }

    async speakText(text) {
        // Check if we should use system voice
        if (this.selectedVoice === 'system') {
            // Use Mac system voice via server
            try {
                const response = await fetch(`${this.baseUrl}/api/speak-system`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                        text: text,
                        rate: Math.round(this.speechRate * 150) // Convert rate to words per minute
                    }),
                });

                if (!response.ok) {
                    const error = await response.json();
                    console.error('Failed to speak via system voice:', error);
                }
            } catch (error) {
                console.error('Failed to call speak-system API:', error);
            }
        } else {
            // Use browser voice
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
    }

    loadPreferences() {
        // Simple localStorage with defaults to true
        const storedVoiceResponses = localStorage.getItem('voiceResponsesEnabled');

        // Default to true if not stored
        const voiceResponsesEnabled = storedVoiceResponses !== null
            ? storedVoiceResponses === 'true'
            : true;

        // Set the checkbox
        this.voiceResponsesToggle.checked = voiceResponsesEnabled;

        // Save to localStorage if this is first time
        if (storedVoiceResponses === null) {
            localStorage.setItem('voiceResponsesEnabled', 'true');
        }

        // Load voice settings
        const storedRate = localStorage.getItem('speechRate');
        if (storedRate !== null) {
            this.speechRate = parseFloat(storedRate);
            this.speechRateSlider.value = storedRate;
            this.speechRateInput.value = this.speechRate.toFixed(1);
        }

        // Load selected voice (will be applied after voices load)
        this.selectedVoice = localStorage.getItem('selectedVoice') || 'system';

        // Load selected language
        const savedLanguage = localStorage.getItem('selectedLanguage');
        if (savedLanguage && this.languageSelect) {
            this.languageSelect.value = savedLanguage;
        }

        // Load send mode preferences
        const savedSendMode = localStorage.getItem('sendMode');
        if (savedSendMode === 'wait') {
            this.sendMode = 'wait';
            this.sendModeWait.checked = true;
        } else {
            this.sendMode = 'automatic';
            this.sendModeAutomatic.checked = true;
        }

        // Load trigger word
        const savedTriggerWord = localStorage.getItem('triggerWord');
        if (savedTriggerWord) {
            this.triggerWord = savedTriggerWord;
            this.triggerWordInput.value = savedTriggerWord;
        }

        // Update UI visibility
        this.updateVoiceOptionsVisibility();
        this.updateSendModeUI();

        // Send preferences to server
        this.updateVoicePreferences();

        // Update warnings after preferences are loaded
        this.updateVoiceWarnings();
    }

    updateVoiceOptionsVisibility() {
        const voiceResponsesEnabled = this.voiceResponsesToggle.checked;
        this.voiceOptions.style.display = voiceResponsesEnabled ? 'flex' : 'none';
    }

    async updateVoicePreferences() {
        const voiceResponsesEnabled = this.voiceResponsesToggle.checked;

        try {
            // Send preferences to server
            await fetch(`${this.baseUrl}/api/voice-preferences`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    voiceResponsesEnabled
                }),
            });

            this.debugLog('Voice preferences updated:', { voiceResponsesEnabled });
        } catch (error) {
            console.error('Failed to update voice preferences:', error);
        }
    }

    async updateVoiceInputState(active) {
        try {
            // Send voice input state to server
            await fetch(`${this.baseUrl}/api/voice-input-state`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ active }),
            });

            this.debugLog('Voice input state updated:', { active });
        } catch (error) {
            console.error('Failed to update voice input state:', error);
        }
    }

    async syncStateWithServer() {
        this.debugLog('Syncing state with server after reconnection');

        // Sync voice response preferences
        await this.updateVoicePreferences();

        // Sync voice input state if currently listening
        if (this.isListening) {
            await this.updateVoiceInputState(true);
        }
    }

    updateVoiceWarnings() {
        // Show/hide warnings based on selected voice
        if (this.selectedVoice === 'system') {
            // Show system voice info for Mac System Voice
            this.systemVoiceInfo.style.display = 'flex';
            this.rateWarning.style.display = 'none';
        } else if (this.selectedVoice && this.selectedVoice.startsWith('browser:')) {
            // Check voice properties
            const voiceIndex = parseInt(this.selectedVoice.substring(8));
            const voice = this.voices[voiceIndex];

            if (voice) {
                const isGoogleVoice = voice.name.toLowerCase().includes('google');
                const isLocalVoice = voice.localService === true;

                // Show appropriate warnings
                if (isGoogleVoice) {
                    // Show rate warning for Google voices
                    this.rateWarning.style.display = 'flex';
                } else {
                    this.rateWarning.style.display = 'none';
                }

                if (isLocalVoice) {
                    // Show system info for local browser voices
                    this.systemVoiceInfo.style.display = 'flex';
                } else {
                    this.systemVoiceInfo.style.display = 'none';
                }
            } else {
                // Hide both warnings if voice not found
                this.rateWarning.style.display = 'none';
                this.systemVoiceInfo.style.display = 'none';
            }
        } else {
            // Hide both warnings if no voice selected
            this.rateWarning.style.display = 'none';
            this.systemVoiceInfo.style.display = 'none';
        }
    }

    handleWaitStatus(isWaiting) {
        const listeningIndicatorText = this.listeningIndicator.querySelector('span');

        if (isWaiting) {
            // Claude is waiting for voice input
            listeningIndicatorText.textContent = 'Claude is paused and waiting for voice input';
            this.debugLog('Claude is waiting for voice input');
        } else {
            // Back to normal listening state
            listeningIndicatorText.textContent = 'Listening...';
            this.debugLog('Claude finished waiting');
        }
    }

    queueUtterance(text) {
        const trimmedText = text.trim();
        if (!trimmedText) return;

        // Check for trigger word (case-insensitive)
        const hasTriggerWord = this.triggerWord &&
            trimmedText.toLowerCase().includes(this.triggerWord.toLowerCase());

        if (hasTriggerWord) {
            // Remove the trigger word from the text
            const regex = new RegExp(`\\b${this.triggerWord}\\b`, 'gi');
            const cleanedText = trimmedText.replace(regex, '').trim();

            // Add the cleaned text to the queue if it's not empty
            if (cleanedText) {
                this.utteranceQueue.push(cleanedText);
            }

            this.debugLog('Trigger word detected, sending queued utterances');
            this.sendQueuedUtterances();
        } else {
            // Just queue it
            this.utteranceQueue.push(trimmedText);
            this.updateQueuedUtterancesUI();
            this.debugLog('Queued utterance:', trimmedText);
        }
    }

    async sendQueuedUtterances() {
        if (this.utteranceQueue.length === 0) {
            this.debugLog('No utterances to send');
            return;
        }

        // Combine all queued utterances into one message
        const combinedText = this.utteranceQueue.join(' ');

        this.debugLog('Sending queued utterances:', combinedText);

        try {
            const response = await fetch(`${this.baseUrl}/api/potential-utterances`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    text: combinedText,
                    timestamp: new Date().toISOString()
                }),
            });

            if (response.ok) {
                // Clear the queue after successful send
                this.utteranceQueue = [];
                this.updateQueuedUtterancesUI();
                this.loadData(); // Refresh the list
            } else {
                const error = await response.json();
                console.error('Error sending queued utterances:', error);
            }
        } catch (error) {
            console.error('Failed to send queued utterances:', error);
        }
    }

    updateSendModeUI() {
        if (this.sendMode === 'wait') {
            // Show trigger word controls and queued utterances section
            this.triggerWordControls.style.display = 'block';
            this.queuedUtterancesSection.style.display = 'block';
        } else {
            // Hide trigger word controls and queued utterances section
            this.triggerWordControls.style.display = 'none';
            this.queuedUtterancesSection.style.display = 'none';

            // Clear queue when switching to automatic mode
            if (this.utteranceQueue.length > 0) {
                // Ask if user wants to send queued utterances before switching
                if (confirm('You have queued utterances. Send them before switching to automatic mode?')) {
                    this.sendQueuedUtterances();
                } else {
                    this.utteranceQueue = [];
                }
            }
        }
        this.updateQueuedUtterancesUI();
    }

    updateQueuedUtterancesUI() {
        this.queuedCount.textContent = this.utteranceQueue.length;

        if (this.utteranceQueue.length === 0) {
            this.queuedUtterancesList.innerHTML = '<div style="color: #999; font-style: italic; font-size: 13px;">No messages queued</div>';
        } else {
            this.queuedUtterancesList.innerHTML = this.utteranceQueue
                .map((utterance, index) => `
                    <div style="padding: 6px 0; border-bottom: 1px solid #ddd; font-size: 13px;">
                        ${index + 1}. ${this.escapeHtml(utterance)}
                    </div>
                `)
                .join('');
        }
    }
}

// Initialize the client when the page loads
document.addEventListener('DOMContentLoaded', () => {
    new VoiceHooksClient();
});