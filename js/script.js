// ==================== CONFIG ====================
const BACKEND_URL      = "http://localhost:8000";
let currentFishermanId = null;
let currentChatId      = null;

// DOM Elements
let loginForm, signupForm, chatForm, feedbackForm;
let loginContainer, signupContainer, chatContainer, feedbackPopup, overlay;
let chatMessages, chatInput, chatHistory, newChatBtn, searchChats, userNameDisplay;

// Voice & sidebar
let sidebarToggle, sidebar;
let voicePopup, voiceBtn;
let activeSpeakBtn = null;
let isRecording    = false;
let mediaRecorder;
let audioChunks    = [];

// ==================== INIT ====================
document.addEventListener('DOMContentLoaded', () => {
    loginForm       = document.getElementById('login-form');
    signupForm      = document.getElementById('signup-form');
    chatForm        = document.getElementById('chat-form');
    feedbackForm    = document.getElementById('feedback-form');
    loginContainer  = document.getElementById('login-container');
    signupContainer = document.getElementById('signup-container');
    chatContainer   = document.getElementById('chat-container');
    feedbackPopup   = document.getElementById('feedback-popup');
    overlay         = document.getElementById('overlay');
    voicePopup      = document.getElementById('voice-popup');
    chatMessages    = document.getElementById('chat-messages');
    chatInput       = document.getElementById('chat-input');
    chatHistory     = document.getElementById('chat-history');
    newChatBtn      = document.getElementById('new-chat-btn');
    searchChats     = document.getElementById('search-chats');
    userNameDisplay = document.getElementById('user-name-display');
    sidebarToggle   = document.getElementById('sidebar-toggle');
    sidebar         = document.querySelector('.sidebar');
    voiceBtn        = document.getElementById('voice-btn');

    loginForm.addEventListener('submit', handleLogin);
    signupForm.addEventListener('submit', handleSignup);
    chatForm.addEventListener('submit', handleChatSubmit);
    feedbackForm.addEventListener('submit', handleFeedbackSubmit);
    newChatBtn.addEventListener('click', startNewChatUI);
    searchChats.addEventListener('input', searchChatHistory);

    if (sidebarToggle) {
        sidebarToggle.addEventListener('click', () => {
            if (sidebar) sidebar.classList.toggle('expanded');
        });
    }

    if (voiceBtn) voiceBtn.addEventListener('click', openVoicePopup);

    chatInput.addEventListener('input', () => {
        chatInput.style.height = 'auto';
        chatInput.style.height = chatInput.scrollHeight + 'px';
    });

    const darkToggle = document.getElementById('dark-toggle');
    if (darkToggle) {
        const isDark = localStorage.getItem('darkMode') === 'true';
        document.documentElement.classList.toggle('dark', isDark);
        darkToggle.addEventListener('click', () => {
            document.documentElement.classList.toggle('dark');
            localStorage.setItem('darkMode', document.documentElement.classList.contains('dark'));
        });
    }

    initSpeechRecognition();
    initApp();
});
// ── Profile dropdown toggle ──
function toggleProfileMenu() {
    const dropdown = document.getElementById('profile-dropdown');
    dropdown.classList.toggle('hidden');
}

// Close dropdown when clicking outside
document.addEventListener('click', (e) => {
    const dropdown = document.getElementById('profile-dropdown');
    const profileBtn = document.getElementById('profile-btn');
    if (dropdown && !dropdown.classList.contains('hidden')) {
        if (!dropdown.contains(e.target) && !profileBtn.contains(e.target)) {
            dropdown.classList.add('hidden');
        }
    }
});
async function initApp() {
    const user = JSON.parse(localStorage.getItem('currentUser') || 'null');
    if (user && user.fishermanId) {
        currentFishermanId = user.fishermanId;
        showChatInterface();
        if (userNameDisplay) userNameDisplay.textContent = user.name || "Fisherfolk";
        await loadUserChats();
        currentChatId = null;
    } else {
        showLogin();
    }
}

// ==================== AUTH HEADER HELPER ====================
function authHeaders(extra = {}) {
    return { 'X-Fisherman-ID': currentFishermanId, ...extra };
}

// ==================== READ ALOUD (BROWSER WEB SPEECH API) ====================
async function speakMessage(text, btn) {
    if (window.speechSynthesis.speaking && activeSpeakBtn === btn) {
        window.speechSynthesis.cancel();
        return;
    }
    if (window.speechSynthesis.speaking) {
        window.speechSynthesis.cancel();
    }

    const isBengali  = /[ঀ-৿]/.test(text);
    const utterance  = new SpeechSynthesisUtterance(text);
    utterance.lang   = isBengali ? 'bn-BD' : 'en-US';
    utterance.rate   = 0.9;
    utterance.pitch  = 1;

    const trySpeak = () => {
        const voices = window.speechSynthesis.getVoices();
        const match  = voices.find(v => v.lang.startsWith(isBengali ? 'bn' : 'en'));
        if (match) utterance.voice = match;

        btn.classList.add('speaking');
        btn.title     = 'Stop reading';
        btn.innerHTML = '<i class="fas fa-stop-circle"></i>';
        activeSpeakBtn = btn;

        utterance.onend = utterance.onerror = () => {
            btn.classList.remove('speaking');
            btn.title     = 'Read aloud';
            btn.innerHTML = '<i class="fas fa-volume-up"></i>';
            if (activeSpeakBtn === btn) activeSpeakBtn = null;
        };
        window.speechSynthesis.speak(utterance);
    };

    if (window.speechSynthesis.getVoices().length === 0) {
        window.speechSynthesis.onvoiceschanged = () => {
            window.speechSynthesis.onvoiceschanged = null;
            trySpeak();
        };
    } else {
        trySpeak();
    }
}

// ==================== VOICE INPUT google cloud ====================
let liveTranscriptEl, voiceMicActive, voiceSendBtn;

function initSpeechRecognition() {
    liveTranscriptEl = document.getElementById('live-transcript');
    voiceMicActive   = document.getElementById('voice-mic-active');
    voiceSendBtn     = document.getElementById('voice-send-btn');

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        if (voiceBtn) voiceBtn.style.display = 'none';
        console.error("Audio recording not supported in this browser.");
    }
}

async function openVoicePopup() {
    if (!voicePopup || !overlay) return;
    voicePopup.classList.remove('hidden');
    overlay.classList.remove('hidden');
    liveTranscriptEl.textContent = 'Initializing mic...';
    voiceSendBtn.classList.add('hidden');

    try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        mediaRecorder = new MediaRecorder(stream);
        audioChunks   = [];

        mediaRecorder.ondataavailable = event => {
            if (event.data.size > 0) audioChunks.push(event.data);
        };

        mediaRecorder.onstop = async () => {
            liveTranscriptEl.textContent   = 'Transcribing... please wait';
            liveTranscriptEl.style.opacity = '0.7';
            voiceMicActive.classList.remove('listening');
            const audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
            await processAudioWithGoogleSTT(audioBlob);
            stream.getTracks().forEach(track => track.stop());
        };

        mediaRecorder.start();
        isRecording = true;
        liveTranscriptEl.textContent   = 'Listening...';
        liveTranscriptEl.style.opacity = '0.5';
        voiceMicActive.classList.add('listening');

    } catch (err) {
        console.error("Error accessing mic:", err);
        liveTranscriptEl.textContent = 'Microphone access denied.';
        voiceMicActive.classList.remove('listening');
    }
}

function stopListening() {
    if (isRecording && mediaRecorder && mediaRecorder.state === "recording") {
        mediaRecorder.stop();
        isRecording = false;
    } else {
        openVoicePopup();
    }
}

async function processAudioWithGoogleSTT(audioBlob) {
    if (!currentFishermanId) return;

    startTranscribeProgress();

    const formData = new FormData();
    formData.append('audio', audioBlob, 'voice.webm');

    try {
        const res = await fetch(`${BACKEND_URL}/transcribe`, {
            method:  'POST',
            headers: authHeaders(),
            body:    formData
        });
        if (!res.ok) throw new Error('Transcription failed');
        const data = await res.json();

        finishTranscribeProgress();

        if (data.text) {
            liveTranscriptEl.textContent   = data.text;
            liveTranscriptEl.style.opacity = '1';
            voiceSendBtn.classList.remove('hidden');
        } else {
            liveTranscriptEl.textContent = 'Could not hear you clearly. Try recording again.';
        }
    } catch (err) {
        console.error(err);
        finishTranscribeProgress();
        liveTranscriptEl.textContent = 'Server error during transcription.';
    }
}

function startTranscribeProgress() {
    liveTranscriptEl.textContent   = 'Transcribing...';
    liveTranscriptEl.style.opacity = '0.7';

    let bar = document.getElementById('transcribe-progress');
    if (!bar) {
        bar = document.createElement('div');
        bar.id        = 'transcribe-progress';
        bar.innerHTML = `
            <div id="transcribe-progress-fill"></div>
            <span id="transcribe-progress-label">Transcribing...</span>`;
        liveTranscriptEl.insertAdjacentElement('afterend', bar);
    }

    const fill  = document.getElementById('transcribe-progress-fill');
    const label = document.getElementById('transcribe-progress-label');
    fill.style.width  = '0%';
    bar.style.display = 'block';

    const steps = [
        { pct: 15, label: 'Uploading audio...',    delay: 300  },
        { pct: 40, label: 'Processing speech...',  delay: 1200 },
        { pct: 65, label: 'Recognising words...',  delay: 2200 },
        { pct: 85, label: 'Almost done...',        delay: 3500 },
        { pct: 90, label: 'Finalising...',         delay: 5000 },
    ];
    steps.forEach(({ pct, label: text, delay }) => {
        setTimeout(() => {
            if (document.getElementById('transcribe-progress-fill')) {
                fill.style.width    = pct + '%';
                label.textContent   = text;
            }
        }, delay);
    });
}

function finishTranscribeProgress() {
    const fill  = document.getElementById('transcribe-progress-fill');
    const bar   = document.getElementById('transcribe-progress');
    const label = document.getElementById('transcribe-progress-label');
    if (!fill) return;
    fill.style.width = '100%';
    if (label) label.textContent = 'Done!';
    setTimeout(() => { if (bar) bar.style.display = 'none'; }, 600);
}

function closeVoicePopup() {
    if (!voicePopup || !overlay) return;
    if (isRecording && mediaRecorder && mediaRecorder.state === "recording") {
        mediaRecorder.onstop = null;
        mediaRecorder.stop();
        mediaRecorder.stream.getTracks().forEach(track => track.stop());
        isRecording = false;
    }
    voicePopup.classList.add('hidden');
    overlay.classList.add('hidden');
    if (chatInput) chatInput.focus();
}

function sendVoiceMessage() {
    const textToSend = liveTranscriptEl.textContent.trim();
    if (!textToSend || textToSend === 'Listening...' || textToSend.includes('Transcribing')) return;
    closeVoicePopup();
    chatInput.value = textToSend;
    chatForm.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
}

window.stopListening    = stopListening;
window.sendVoiceMessage = sendVoiceMessage;
window.closeVoicePopup  = closeVoicePopup;

// ==================== AUTH ====================
async function handleLogin(e) {
    e.preventDefault();
    const fishermanId = document.getElementById('login-fisherman-id').value.trim();
    const password    = document.getElementById('login-password').value.trim();
    if (!fishermanId || !password) { alert("Please enter Fisherfolk ID and Password"); return; }

    try {
        const res = await fetch(`${BACKEND_URL}/login`, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ fishermanId, password })
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.detail || "Invalid credentials");
        }
        const user = await res.json();
        currentFishermanId = user.fishermanId;
        localStorage.setItem('currentUser', JSON.stringify(user));
        if (userNameDisplay) userNameDisplay.textContent = user.name || "Fisherfolk";
        showChatInterface();
        await loadUserChats();
        startNewChatUI();
        appendSystemMessage("Welcome back!");
    } catch (err) {
        alert("Login failed: " + err.message);
    }
}

async function handleSignup(e) {
    e.preventDefault();
    const name            = document.getElementById('signup-name').value.trim();
    const fishermanId     = document.getElementById('signup-fisherman-id').value.trim();
    const country         = document.getElementById('signup-country').value;
    const location        = document.getElementById('signup-location').value.trim();
    const password        = document.getElementById('signup-password').value.trim();
    const confirmPassword = document.getElementById('signup-confirm-password').value.trim();

    if (!country) { alert("Please select a country"); return; }
    if (password.length < 8) { alert("Password must be at least 8 characters long"); return; }
    if (password !== confirmPassword) { alert("Passwords do not match!"); return; }

    const idRegex = /^[a-zA-Z0-9]+$/;
    if (!idRegex.test(fishermanId)) { alert("Fisherfolk ID must contain only letters and numbers"); return; }

    try {
        const res = await fetch(`${BACKEND_URL}/signup`, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ name, fishermanId, country, location, password })
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.detail || "Registration failed");
        }
        alert("Account submitted! Please wait for admin approval before logging in.");
        showLogin();
        signupForm.reset();
    } catch (err) {
        alert("Signup failed: " + err.message);
    }
}

function logout() {
    localStorage.removeItem('currentUser');
    currentFishermanId = null;
    currentChatId      = null;
    showLogin();
}

// ==================== UI NAVIGATION ====================
function showLogin() {
    loginContainer.classList.remove('hidden');
    signupContainer.classList.add('hidden');
    chatContainer.classList.add('hidden');
}

function showSignup() {
    loginContainer.classList.add('hidden');
    signupContainer.classList.remove('hidden');
    chatContainer.classList.add('hidden');
}

function showChatInterface() {
    loginContainer.classList.add('hidden');
    signupContainer.classList.add('hidden');
    chatContainer.classList.remove('hidden');
}

// ==================== CHAT HISTORY & CREATION ====================
async function loadUserChats() {
    if (!currentFishermanId) return;
    try {
        const res = await fetch(`${BACKEND_URL}/chats`, {
            headers: authHeaders()
        });
        if (!res.ok) {
            if (res.status === 401 || res.status === 403) { logout(); return; }
            throw new Error(`HTTP ${res.status}`);
        }
        const chats = await res.json();
        renderChatHistory(chats);
    } catch (e) {
        console.error("Failed to load chats:", e);
    }
}

function renderChatHistory(chats) {
    chatHistory.innerHTML = '';
    chats.forEach(chat => {
        const item = document.createElement('div');
        item.classList.add('chat-item');
        if (chat._id === currentChatId) item.classList.add('active');

        const pinIcon = chat.pinned ? '📌 ' : '';
        item.innerHTML = `
        <i class="fas fa-comment"></i>
        <div class="chat-item-title">${pinIcon}${chat.title || 'New Chat'}</div>
        <button class="menu-dots" onclick="event.stopPropagation(); showChatMenu(this.parentElement, '${chat._id}', ${chat.pinned || false})">⋮</button>`;

        item.addEventListener('click', () => loadChat(chat._id));
        chatHistory.appendChild(item);
    });
}

async function loadChat(chatId) {
    if (!currentFishermanId) return;
    currentChatId = chatId;

    document.querySelectorAll('.chat-item').forEach(item => item.classList.remove('active'));

    try {
        const res = await fetch(`${BACKEND_URL}/chats/${chatId}`, {
            headers: authHeaders()
        });
        if (!res.ok) throw new Error('Failed to load chat');

        const chat = await res.json();
        chatMessages.innerHTML = '';

        if (!chat.messages || chat.messages.length === 0) {
            const welcomeDiv = document.createElement('div');
            welcomeDiv.classList.add('welcome-message');
            welcomeDiv.innerHTML = `
<h1>How can I assist you today?</h1>
<p>Send your first message to start the conversation...</p>`;
            chatMessages.appendChild(welcomeDiv);
        } else {
            chat.messages.forEach(msg => addMessage(msg.content, msg.sender));
        }

        document.querySelectorAll('.chat-item').forEach(item => {
            const btn = item.querySelector('.menu-dots');
            if (btn && btn.getAttribute('onclick') && btn.getAttribute('onclick').includes(chatId)) {
                item.classList.add('active');
            }
        });
    } catch (e) {
        console.error("Failed to load chat:", e);
    }
}

async function createNewChat() {
    if (!currentFishermanId) return;
    try {
        const res = await fetch(`${BACKEND_URL}/chats`, {
            method:  'POST',
            headers: authHeaders()
        });
        if (!res.ok) throw new Error('Failed to create chat');
        const data    = await res.json();
        currentChatId = data.chat_id;
        await loadUserChats();
    } catch (e) {
        console.error("Failed to create chat:", e);
    }
}

function startNewChatUI() {
    currentChatId          = null;
    chatMessages.innerHTML = '';
    const welcomeDiv       = document.createElement('div');
    welcomeDiv.classList.add('welcome-message');
    welcomeDiv.innerHTML   = `
<h1>How can I assist you today?</h1>
<p>Send your first message to create the chat...</p>`;
    chatMessages.appendChild(welcomeDiv);
    document.querySelectorAll('.chat-item').forEach(item => item.classList.remove('active'));
}

// ==================== DELETE CHAT ====================
async function deleteChat(chatId) {
    if (!currentFishermanId) return;
    try {
        const res = await fetch(`${BACKEND_URL}/chats/${chatId}`, {
            method:  'DELETE',
            headers: authHeaders()
        });
        if (!res.ok) {
            if (res.status === 404) { alert("Chat not found."); return; }
            if (res.status === 401 || res.status === 403) { logout(); return; }
            throw new Error(`HTTP ${res.status}`);
        }
        if (currentChatId === chatId) {
            currentChatId          = null;
            chatMessages.innerHTML = '';
            const welcomeDiv       = document.createElement('div');
            welcomeDiv.classList.add('welcome-message');
            welcomeDiv.innerHTML   = `
<h1>How can I assist you today?</h1>
<p>Send your first message to create the chat...</p>`;
            chatMessages.appendChild(welcomeDiv);
        }
        await loadUserChats();
    } catch (e) {
        console.error("Failed to delete chat:", e);
        alert("Could not delete the chat. Please try again.");
    }
}

// ==================== 3-DOTS DROPDOWN MENU ====================
function showChatMenu(chatItem, chatId, isPinned) {
    const existingMenu = chatItem.querySelector('.chat-dropdown');
    if (existingMenu) { cleanupMenu(); return; }
    cleanupMenu();

    const menu     = document.createElement('div');
    menu.className = 'chat-dropdown show';
    menu.innerHTML = `
        <button class="menu-rename"><i class="fas fa-pencil-alt"></i> Rename</button>
        <button class="menu-pin"><i class="fas fa-thumbtack"></i> ${isPinned ? 'Unpin' : 'Pin'}</button>
        <button class="menu-share"><i class="fas fa-share-alt"></i> Share</button>
        <button class="menu-delete"><i class="fas fa-trash"></i> Delete</button>`;

    chatItem.appendChild(menu);
    chatItem.classList.add('menu-open');
    document.querySelectorAll('.chat-item').forEach(item => { if (item !== chatItem) item.style.pointerEvents = 'none'; });

    menu.querySelector('.menu-rename').addEventListener('click', (e) => { e.stopImmediatePropagation(); cleanupMenu(); renameChat(chatId); });
    menu.querySelector('.menu-pin').addEventListener('click',    (e) => { e.stopImmediatePropagation(); cleanupMenu(); togglePin(chatId, !isPinned); });
    menu.querySelector('.menu-share').addEventListener('click',  (e) => { e.stopImmediatePropagation(); cleanupMenu(); shareChat(chatId); });
    menu.querySelector('.menu-delete').addEventListener('click', (e) => { e.stopImmediatePropagation(); cleanupMenu(); if (confirm('Delete this chat permanently?')) deleteChat(chatId); });

    const closeHandler = (e) => { if (!chatItem.contains(e.target)) cleanupMenu(); };
    setTimeout(() => document.addEventListener('click', closeHandler), 10);
}

function cleanupMenu() {
    document.querySelectorAll('.chat-dropdown').forEach(menu => { if (menu.parentNode) menu.remove(); });
    document.querySelectorAll('.chat-item').forEach(item => { item.style.pointerEvents = 'auto'; item.classList.remove('menu-open'); });
    document.removeEventListener('click', cleanupMenu);
}

// ==================== TOGGLE PIN ====================
async function togglePin(chatId, newPinnedState) {
    try {
        const res = await fetch(`${BACKEND_URL}/chats/${chatId}/pin`, {
            method:  'PUT',
            headers: authHeaders({ 'Content-Type': 'application/json' }),
            body:    JSON.stringify({ pinned: newPinnedState })
        });
        if (res.ok) { await loadUserChats(); } else { alert("Failed to pin/unpin chat."); }
    } catch (e) { console.error(e); alert("Could not update pin status."); }
}

// ==================== RENAME CHAT ====================
async function renameChat(chatId) {
    const newTitle = prompt("Enter new title for this chat:", "");
    if (!newTitle || newTitle.trim() === "") return;
    try {
        const res = await fetch(`${BACKEND_URL}/chats/${chatId}/title`, {
            method:  'PUT',
            headers: authHeaders({ 'Content-Type': 'application/json' }),
            body:    JSON.stringify({ title: newTitle.trim() })
        });
        if (res.ok) { await loadUserChats(); } else { alert("Failed to rename chat."); }
    } catch (e) { console.error(e); alert("Could not rename the chat."); }
}

// ==================== SHARE CHAT ====================
async function shareChat(chatId) {
    try {
        const res = await fetch(`${BACKEND_URL}/chats/${chatId}`, {
            headers: authHeaders()
        });
        if (!res.ok) throw new Error("Failed to load chat");
        const chat = await res.json();

        let shareText = ` ${chat.title || 'Fisherfolk Chatbot Conversation'}\n\n`;
        if (chat.messages && chat.messages.length > 0) {
            chat.messages.forEach(msg => {
                const sender = msg.sender === 'user' ? 'You' : 'Fisherfolk Bot';
                shareText   += `${sender}: ${msg.content}\n\n`;
            });
        }
        shareText += `\n Shared from Fisherfolk Chatbot`;

        const encodedText = encodeURIComponent(shareText);
        const modal       = document.createElement('div');
        modal.className   = 'share-modal';
        modal.innerHTML   = `
            <h3>Share Chat</h3>
            <div class="share-options">
                <a href="https://wa.me/?text=${encodedText}" target="_blank" class="share-btn">
                    <img src="https://cdn.simpleicons.org/whatsapp/25D366" alt="WhatsApp" width="56" height="56">
                    <span>WhatsApp</span>
                </a>
                <a href="https://www.facebook.com/sharer/sharer.php?quote=${encodedText}&u=https://fishermen-chatbot.com" target="_blank" class="share-btn">
                    <img src="https://cdn.simpleicons.org/facebook/1877F2" alt="Facebook" width="56" height="56">
                    <span>Facebook</span>
                </a>
                <a href="https://m.me/?link=https://fishermen-chatbot.com" target="_blank" class="share-btn">
                    <img src="https://cdn.simpleicons.org/messenger/00B2FF" alt="Messenger" width="56" height="56">
                    <span>Messenger</span>
                </a>
            </div>
            <div class="copy-option">
                <button id="share-copy-btn"><i class="fas fa-copy"></i> Copy text</button>
            </div>
            <div style="text-align:center; margin-top:12px;">
                <button class="btn-secondary" style="font-size:13px; padding:6px 16px;" id="share-close-btn">Close</button>
            </div>`;

        document.body.appendChild(modal);
        overlay.classList.remove('hidden');

        modal.querySelector('#share-copy-btn').addEventListener('click', () => {
            navigator.clipboard.writeText(shareText)
                .then(() => alert('Copied to clipboard!'))
                .catch(() => alert('Copy failed. Please select and copy manually.'));
        });
        modal.querySelector('#share-close-btn').addEventListener('click', () => {
            modal.remove();
            overlay.classList.add('hidden');
        });
    } catch (e) {
        console.error("Share failed:", e);
        alert("Could not share the chat.");
    }
}

// ==================== CHAT SEND ====================
async function handleChatSubmit(e) {
    e.preventDefault();
    const message = chatInput.value.trim();
    if (!message || !currentFishermanId) return;

    if (!currentChatId) {
        await createNewChat();
        if (!currentChatId) { alert("Failed to create a new chat. Please try again."); return; }
    }

    addMessage(message, 'user');
    chatInput.value        = '';
    chatInput.style.height = 'auto';
    await sendMessageToBackend(message);
}

async function sendMessageToBackend(message) {
    if (!currentFishermanId || !currentChatId) {
        removeTypingIndicator();
        addMessage("Please login and create a new chat first.", 'bot');
        return;
    }

    showTypingIndicator();
    try {
        const res = await fetch(`${BACKEND_URL}/chat`, {
            method:  "POST",
            headers: authHeaders({ "Content-Type": "application/json" }),
            body:    JSON.stringify({ message, chat_id: currentChatId })
        });

        if (!res.ok) {
            if (res.status === 401 || res.status === 403) { logout(); return; }
            const errData = await res.json().catch(() => ({}));
            throw new Error(`Server error: ${res.status} — ${errData.detail || ''}`);
        }

        const data = await res.json();
        removeTypingIndicator();
        addMessage(data.reply, 'bot');
        await loadUserChats();
    } catch (err) {
        removeTypingIndicator();
        console.error("Chat request failed:", err);
        addMessage("Couldn't reach the chatbot server. Please ensure the backend is running.", 'bot');
    }
}

// ==================== UI HELPERS ====================
function addMessage(content, sender) {
    const messageDiv = document.createElement('div');
    messageDiv.classList.add('message', `${sender}-message`);

    const messageContent = document.createElement('div');
    messageContent.classList.add('message-content');
    messageContent.textContent = content;
    messageDiv.appendChild(messageContent);

    const timestampSpan = document.createElement('span');
    timestampSpan.classList.add('timestamp');
    timestampSpan.textContent = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    messageDiv.appendChild(timestampSpan);

    if (sender === 'bot') {
        const feedbackDiv = document.createElement('div');
        feedbackDiv.classList.add('message-feedback');

        const thumbsUpBtn = document.createElement('button');
        thumbsUpBtn.classList.add('feedback-btn', 'thumbs-up');
        thumbsUpBtn.innerHTML = '<i class="fas fa-thumbs-up"></i>';
        thumbsUpBtn.addEventListener('click', () => handleFeedback(messageDiv, true));

        const thumbsDownBtn = document.createElement('button');
        thumbsDownBtn.classList.add('feedback-btn', 'thumbs-down');
        thumbsDownBtn.innerHTML = '<i class="fas fa-thumbs-down"></i>';
        thumbsDownBtn.addEventListener('click', () => handleFeedback(messageDiv, false));

        const readAloudBtn = document.createElement('button');
        readAloudBtn.classList.add('feedback-btn', 'read-aloud-btn');
        readAloudBtn.innerHTML = '<i class="fas fa-volume-up"></i>';
        readAloudBtn.title     = 'Read aloud';
        readAloudBtn.addEventListener('click', () => speakMessage(content, readAloudBtn));

        feedbackDiv.appendChild(thumbsUpBtn);
        feedbackDiv.appendChild(thumbsDownBtn);
        feedbackDiv.appendChild(readAloudBtn);
        messageDiv.appendChild(feedbackDiv);
    }

    chatMessages.appendChild(messageDiv);
    chatMessages.scrollTop = chatMessages.scrollHeight;
}

function showTypingIndicator() {
    const typingDiv = document.createElement('div');
    typingDiv.classList.add('message', 'bot-message', 'typing-indicator');
    typingDiv.innerHTML = `<span></span><span></span><span></span>`;
    chatMessages.appendChild(typingDiv);
    chatMessages.scrollTop = chatMessages.scrollHeight;
}

function removeTypingIndicator() {
    const typing = document.querySelector('.typing-indicator');
    if (typing) typing.remove();
}

function appendSystemMessage(text) {
    const sysMsg = document.createElement("div");
    sysMsg.classList.add("message", "bot-message");
    sysMsg.innerHTML = `<div class="message-content">${text}</div>`;
    chatMessages.appendChild(sysMsg);
    chatMessages.scrollTop = chatMessages.scrollHeight;
}

// ==================== FEEDBACK ====================
async function handleFeedback(messageDiv, isPositive) {
    const thumbsUp        = messageDiv.querySelector('.thumbs-up');
    const thumbsDown      = messageDiv.querySelector('.thumbs-down');
    const reportedMessage = messageDiv.querySelector('.message-content').textContent;

    thumbsUp.classList.remove('active');
    thumbsDown.classList.remove('active');

    if (isPositive) {
        thumbsUp.classList.add('active');
        await sendFeedbackToBackend({ type: 'positive', reason: 'helpful', comments: '', message: reportedMessage });
    } else {
        thumbsDown.classList.add('active');
        showFeedbackPopup(reportedMessage);
    }
}

async function sendFeedbackToBackend(feedbackData) {
    if (!currentFishermanId) return;
    try {
        const res = await fetch(`${BACKEND_URL}/feedback`, {
            method:  'POST',
            headers: authHeaders({ 'Content-Type': 'application/json' }),
            body:    JSON.stringify(feedbackData)
        });
        if (!res.ok) console.error("Failed to save feedback");
    } catch (err) {
        console.error("Feedback submission error:", err);
    }
}

function showFeedbackPopup(message) {
    feedbackPopup.dataset.reportedMessage = message;
    feedbackPopup.classList.remove('hidden');
    overlay.classList.remove('hidden');
}

async function handleFeedbackSubmit(e) {
    e.preventDefault();
    const reason          = document.querySelector('input[name="feedback"]:checked')?.value || "other";
    const comments        = document.getElementById('feedback-text').value.trim();
    const reportedMessage = feedbackPopup.dataset.reportedMessage;
    await sendFeedbackToBackend({ type: "negative", reason, comments, message: reportedMessage });
    closeFeedbackPopup();
    alert('Thank you for your feedback!');
}

function closeFeedbackPopup() {
    feedbackPopup.classList.add('hidden');
    overlay.classList.add('hidden');
    feedbackForm.reset();
}

// ==================== UTILITIES ====================
function togglePasswordVisibility(inputId) {
    const input = document.getElementById(inputId);
    const icon  = input.nextElementSibling.querySelector('i');
    if (input.type === 'password') {
        input.type = 'text';
        icon.classList.replace('fa-eye', 'fa-eye-slash');
    } else {
        input.type = 'password';
        icon.classList.replace('fa-eye-slash', 'fa-eye');
    }
}

// Export chat
document.getElementById('export-chat')?.addEventListener('click', () => {
    const messages = Array.from(chatMessages.querySelectorAll('.message')).map(m => ({
        sender:  m.classList.contains('user-message') ? 'user' : 'bot',
        content: m.querySelector('.message-content').textContent,
        time:    m.querySelector('.timestamp')?.textContent || ''
    }));
    const dataStr = JSON.stringify(messages, null, 2);
    const blob    = new Blob([dataStr], { type: 'application/json' });
    const url     = URL.createObjectURL(blob);
    const a       = document.createElement('a');
    a.href        = url;
    a.download    = `fisherfolk-chat-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
});

function searchChatHistory() {
    const term  = searchChats.value.toLowerCase();
    const items = chatHistory.querySelectorAll('.chat-item');
    items.forEach(item => {
        const title = item.querySelector('.chat-item-title').textContent.toLowerCase();
        item.style.display = title.includes(term) ? 'flex' : 'none';
    });
}

// Expose global functions used by inline onclick handlers
window.togglePasswordVisibility = togglePasswordVisibility;
window.showSignup               = showSignup;
window.showLogin                = showLogin;
window.logout                   = logout;
window.closeFeedbackPopup       = closeFeedbackPopup;
window.toggleProfileMenu        = toggleProfileMenu;
// ==================== CONTRIBUTE TO KNOWLEDGE GRAPH ====================
let contribMediaRecorder = null;
let contribAudioChunks = [];
let contribIsRecording = false;

function openContributePopup() {
  const popup = document.getElementById('contribute-popup');
  const ovl   = document.getElementById('overlay');
  if (!popup || !ovl) return;
  popup.classList.remove('hidden');
  ovl.classList.remove('hidden');
  clearContribFields();
  document.getElementById('contrib-status-msg').style.display = 'none';
  switchContributeTab('text');
}
window.openContributePopup = openContributePopup;

function closeContributePopup() {
  document.getElementById('contribute-popup')?.classList.add('hidden');
  const feedbackPopup = document.getElementById('feedback-popup');
  const ovl = document.getElementById('overlay');
  if (ovl && (!feedbackPopup || feedbackPopup.classList.contains('hidden'))) {
    ovl.classList.add('hidden');
  }
  stopContribMic();
}
window.closeContributePopup = closeContributePopup;

function switchContributeTab(tab) {
  const textPanel  = document.getElementById('contrib-text-panel');
  const voicePanel = document.getElementById('contrib-voice-panel');
  const tabText    = document.getElementById('tab-text');
  const tabVoice   = document.getElementById('tab-voice');

  if (tab === 'text') {
    textPanel.classList.remove('hidden');
    voicePanel.classList.add('hidden');
    tabText.classList.add('active');
    tabText.setAttribute('aria-selected', 'true');
    tabVoice.classList.remove('active');
    tabVoice.setAttribute('aria-selected', 'false');
    stopContribMic();
  } else {
    textPanel.classList.add('hidden');
    voicePanel.classList.remove('hidden');
    tabVoice.classList.add('active');
    tabVoice.setAttribute('aria-selected', 'true');
    tabText.classList.remove('active');
    tabText.setAttribute('aria-selected', 'false');
  }
}
window.switchContributeTab = switchContributeTab;

function clearContribFields() {
  ['contrib-subject','contrib-relation','contrib-object','contrib-context'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  const transcript = document.getElementById('contrib-live-transcript');
  if (transcript) { transcript.textContent = 'Press the mic to start...'; transcript.style.opacity = '0.5'; }
  document.getElementById('contrib-use-transcript-btn')?.classList.add('hidden');
}

// ---- Voice recording ----
async function toggleContribMic() {
  if (contribIsRecording) stopContribMic();
  else await startContribMic();
}
window.toggleContribMic = toggleContribMic;

async function startContribMic() {
  const micBtn     = document.getElementById('contrib-mic-btn');
  const transcript = document.getElementById('contrib-live-transcript');
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    contribAudioChunks = [];
    contribMediaRecorder = new MediaRecorder(stream);
    contribMediaRecorder.ondataavailable = e => { if (e.data.size > 0) contribAudioChunks.push(e.data); };
    contribMediaRecorder.onstop = async () => {
      transcript.textContent = 'Transcribing...';
      transcript.style.opacity = '0.7';
      micBtn.classList.remove('listening');
      const blob = new Blob(contribAudioChunks, { type: 'audio/webm' });
      await transcribeContribAudio(blob);
      stream.getTracks().forEach(t => t.stop());
    };
    contribMediaRecorder.start();
    contribIsRecording = true;
    transcript.textContent = 'Listening...';
    transcript.style.opacity = '0.5';
    micBtn.classList.add('listening');
    micBtn.setAttribute('aria-label', 'Stop recording');
  } catch (err) {
    console.error('Contrib mic error:', err);
    transcript.textContent = 'Microphone access denied.';
  }
}

function stopContribMic() {
  if (contribIsRecording && contribMediaRecorder?.state === 'recording') {
    contribMediaRecorder.stop();
    contribIsRecording = false;
    const micBtn = document.getElementById('contrib-mic-btn');
    if (micBtn) { micBtn.classList.remove('listening'); micBtn.setAttribute('aria-label', 'Start recording'); }
  }
}

async function transcribeContribAudio(audioBlob) {
  if (!currentFishermanId) return;
  const formData = new FormData();
  formData.append('audio', audioBlob, 'contrib_voice.webm');
  const transcript = document.getElementById('contrib-live-transcript');
  const useBtn     = document.getElementById('contrib-use-transcript-btn');
  try {
    const res = await fetch(`${BACKEND_URL}/transcribe`, {
      method: 'POST',
      headers: authHeaders(),
      body: formData
    });
    if (!res.ok) throw new Error('Transcription failed');
    const data = await res.json();
    if (data.text) {
      transcript.textContent = data.text;
      transcript.style.opacity = '1';
      useBtn.classList.remove('hidden');
    } else {
      transcript.textContent = 'Could not hear clearly. Try again.';
    }
  } catch (err) {
    console.error(err);
    transcript.textContent = 'Server error during transcription.';
  }
}

function useContribTranscript() {
  const text = document.getElementById('contrib-live-transcript').textContent.trim();
  if (!text || text.includes('Listening') || text.includes('Transcribing') || text.includes('Press the mic')) return;
  const ctxEl = document.getElementById('contrib-context');
  if (ctxEl) ctxEl.value = text;
  switchContributeTab('text');
  document.getElementById('contrib-subject').focus();
}
window.useContribTranscript = useContribTranscript;

// ---- Submit ----
async function submitContribution() {
  const subject   = document.getElementById('contrib-subject').value.trim();
  const relation  = document.getElementById('contrib-relation').value.trim();
  const object_   = document.getElementById('contrib-object').value.trim();
  const context   = document.getElementById('contrib-context').value.trim();
  const statusMsg = document.getElementById('contrib-status-msg');
  const submitBtn = document.getElementById('contrib-submit-btn');

  if (!subject || !relation || !object_) {
    statusMsg.style.display  = 'block';
    statusMsg.style.color    = 'var(--danger-color)';
    statusMsg.textContent    = 'Please fill in Subject, Relationship, and Object.';
    return;
  }

  submitBtn.disabled  = true;
  submitBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Submitting...';
  statusMsg.style.display = 'none';

  try {
    const res = await fetch(`${BACKEND_URL}/contribute`, {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ subject, relation, object_, context })
    });
    const data = await res.json();
    if (res.ok) {
      statusMsg.style.color   = 'var(--secondary-color)';
      statusMsg.textContent   = '✅ ' + (data.message || 'Submitted for review!');
      statusMsg.style.display = 'block';
      clearContribFields();
      setTimeout(closeContributePopup, 2500);
    } else {
      throw new Error(data.detail || 'Submission failed');
    }
  } catch (err) {
    statusMsg.style.color   = 'var(--danger-color)';
    statusMsg.textContent   = '❌ ' + err.message;
    statusMsg.style.display = 'block';
  } finally {
    submitBtn.disabled  = false;
    submitBtn.innerHTML = '<i class="fas fa-paper-plane"></i> Submit';
  }
}
window.submitContribution = submitContribution;
// ==================== END CONTRIBUTE ====================