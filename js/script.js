// ==================== CONFIG ====================
const BACKEND_URL = "http://localhost:8000";
let currentToken = null;
let currentChatId = null;

// DOM Elements
let loginForm, signupForm, chatForm, feedbackForm;
let loginContainer, signupContainer, chatContainer, feedbackPopup, overlay;
let chatMessages, chatInput, chatHistory, newChatBtn, searchChats, userNameDisplay;

// Sprint2: Voice input & mobile sidebar
let sidebarToggle, sidebar;
let voicePopup, voiceBtn, voiceDoneBtn;
let recognition = null;
let isRecording = false;
let finalTranscript = '';
const speechRecognitionLang = 'en-US';

// ==================== INIT ====================
document.addEventListener('DOMContentLoaded', () => {
    loginForm = document.getElementById('login-form');
    signupForm = document.getElementById('signup-form');
    chatForm = document.getElementById('chat-form');
    feedbackForm = document.getElementById('feedback-form');

    loginContainer = document.getElementById('login-container');
    signupContainer = document.getElementById('signup-container');
    chatContainer = document.getElementById('chat-container');
    feedbackPopup = document.getElementById('feedback-popup');
    overlay = document.getElementById('overlay');
    voicePopup = document.getElementById('voice-popup');

    chatMessages = document.getElementById('chat-messages');
    chatInput = document.getElementById('chat-input');
    chatHistory = document.getElementById('chat-history');
    newChatBtn = document.getElementById('new-chat-btn');
    searchChats = document.getElementById('search-chats');
    userNameDisplay = document.getElementById('user-name-display');
    sidebarToggle = document.getElementById('sidebar-toggle');
    sidebar = document.querySelector('.sidebar');
    voiceBtn = document.getElementById('voice-btn');
    voiceDoneBtn = document.getElementById('voice-done-btn');

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
    if (voiceDoneBtn) voiceDoneBtn.addEventListener('click', closeVoicePopup);

    chatInput.addEventListener('input', () => {
        chatInput.style.height = 'auto';
        chatInput.style.height = (chatInput.scrollHeight) + 'px';
    });

    // Dark mode
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

async function initApp() {
    const token = localStorage.getItem('token');
    if (token) {
        currentToken = token;
        showChatInterface();
        await loadUserChats();
        await loadUserInfo();
        currentChatId = null;
    } else {
        showLogin();
    }
}

// ==================== VOICE INPUT (Sprint2) ====================
function initSpeechRecognition() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
        recognition = null;
        return;
    }

    recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;
    recognition.lang = speechRecognitionLang;

    recognition.onstart = () => {
        isRecording = true;
        finalTranscript = '';
        if (voiceBtn) voiceBtn.classList.add('recording');
    };

    recognition.onresult = (event) => {
        let interimTranscript = '';
        for (let i = event.resultIndex; i < event.results.length; i++) {
            const transcript = event.results[i][0].transcript;
            if (event.results[i].isFinal) {
                finalTranscript += transcript + ' ';
            } else {
                interimTranscript += transcript;
            }
        }
        if (chatInput) {
            chatInput.value = (finalTranscript + interimTranscript).trim();
            chatInput.style.height = 'auto';
            chatInput.style.height = (chatInput.scrollHeight) + 'px';
        }
    };

    recognition.onerror = (event) => {
        console.error('Speech recognition error:', event.error);
        isRecording = false;
        if (voiceBtn) voiceBtn.classList.remove('recording');
    };

    recognition.onend = () => {
        isRecording = false;
        if (voiceBtn) voiceBtn.classList.remove('recording');
    };
}

function openVoicePopup() {
    if (!recognition) {
        alert("Your browser does not support voice input.");
        return;
    }
    if (voicePopup && overlay) {
        recognition.lang = speechRecognitionLang;
        finalTranscript = '';
        recognition.start();
        voicePopup.classList.remove('hidden');
        overlay.classList.remove('hidden');
    }
}

function closeVoicePopup() {
    if (voicePopup && overlay) {
        if (recognition && isRecording) recognition.stop();
        voicePopup.classList.add('hidden');
        overlay.classList.add('hidden');
        if (chatInput) chatInput.focus();
    }
}

// ==================== LOAD AND DISPLAY USER NAME ====================
async function loadUserInfo() {
    if (!currentToken) return;
    try {
        const res = await fetch(`${BACKEND_URL}/user`, {
            method: 'GET',
            headers: { 'Authorization': `Bearer ${currentToken}` }
        });
        if (res.ok) {
            const user = await res.json();
            const userNameEl = document.getElementById('user-name-display');
            if (userNameEl) userNameEl.textContent = user.name || "Fisherman";
        }
    } catch (e) {
        console.error("Failed to load user info:", e);
        document.getElementById('user-name-display').textContent = "Fisherman";
    }
}

// ==================== AUTH ====================
async function handleLogin(e) {
    e.preventDefault();
    const fishermanId = document.getElementById('login-fisherman-id').value.trim();
    const password = document.getElementById('login-password').value.trim();

    if (!fishermanId || !password) {
        alert("Please enter Fisherman ID and Password");
        return;
    }

    try {
        const formData = new URLSearchParams();
        formData.append('username', fishermanId);
        formData.append('password', password);

        const res = await fetch(`${BACKEND_URL}/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: formData
        });

        if (!res.ok) {
            const errorData = await res.json().catch(() => ({}));
            throw new Error(errorData.detail || "Invalid credentials");
        }

        const data = await res.json();
        currentToken = data.access_token;
        localStorage.setItem('token', currentToken);

        showChatInterface();
        appendSystemMessage("Welcome back! 👋");
        await loadUserChats();
        await createNewChat();
    } catch (err) {
        alert("Login failed: " + err.message);
    }
}

async function handleSignup(e) {
    e.preventDefault();
    const name = document.getElementById('signup-name').value.trim();
    const fishermanId = document.getElementById('signup-fisherman-id').value.trim();
    const location = document.getElementById('signup-location').value.trim();
    const password = document.getElementById('signup-password').value.trim();
    const confirmPassword = document.getElementById('signup-confirm-password').value.trim();

    if (password !== confirmPassword) {
        alert('Passwords do not match!');
        return;
    }

    try {
        const res = await fetch(`${BACKEND_URL}/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, fisherman_id: fishermanId, location, password })
        });

        if (!res.ok) {
            const errorData = await res.json().catch(() => ({}));
            throw new Error(errorData.detail || "Registration failed");
        }

        const data = await res.json();
        currentToken = data.access_token;
        localStorage.setItem('token', currentToken);

        showChatInterface();
        appendSystemMessage(`Welcome aboard, ${name}! 🎣`);
        await loadUserChats();
        await createNewChat();
    } catch (err) {
        alert("Signup failed: " + err.message);
    }
}

function logout() {
    localStorage.removeItem('token');
    currentToken = null;
    currentChatId = null;
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
    if (!currentToken) return;

    try {
        const res = await fetch(`${BACKEND_URL}/chats`, {
            method: 'GET',
            headers: { 'Authorization': `Bearer ${currentToken}` }
        });

        if (!res.ok) {
            if (res.status === 401) {
                alert("Session expired. Please login again.");
                logout();
                return;
            }
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

        const date = new Date(chat.updated_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        const pinIcon = chat.pinned ? '📌 ' : '';

        item.innerHTML = `
            <i class="fas fa-comment"></i>
            <div class="chat-item-title" style="flex:1; cursor:pointer;">
                ${pinIcon}${chat.title || 'New Chat'}
            </div>
            <small style="opacity:0.7;">${date}</small>
            <button class="menu-dots" title="More options">⋮</button>
        `;

        const dots = item.querySelector('.menu-dots');

        dots.addEventListener('click', (e) => {
            e.stopImmediatePropagation();
            showChatMenu(item, chat._id, chat.pinned || false);
        });

        item.addEventListener('click', (e) => {
            if (!e.target.closest('.menu-dots') && !e.target.closest('.chat-dropdown')) {
                loadSpecificChat(chat._id, chat.messages || []);
                // Close mobile sidebar after selection
                if (window.innerWidth <= 768 && sidebar) {
                    sidebar.classList.remove('expanded');
                }
            }
        });

        chatHistory.appendChild(item);
    });
}

async function loadSpecificChat(chatId, messages) {
    currentChatId = chatId;
    chatMessages.innerHTML = '';

    if (messages && messages.length > 0) {
        messages.forEach(msg => addMessage(msg.content, msg.sender));
    } else {
        const welcomeDiv = document.createElement('div');
        welcomeDiv.classList.add('welcome-message');
        welcomeDiv.innerHTML = '<h1>Welcome to FisherMen Chatbot</h1><p>How can I assist you today?</p>';
        chatMessages.appendChild(welcomeDiv);
    }
    await loadUserChats();
}

// ==================== DELETE CHAT ====================
async function deleteChat(chatId) {
    if (!currentToken) return;

    try {
        const res = await fetch(`${BACKEND_URL}/chats/${chatId}`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${currentToken}` }
        });

        if (!res.ok) {
            if (res.status === 404) {
                alert("Chat not found or you do not have permission to delete it.");
                return;
            }
            if (res.status === 401) {
                alert("Session expired. Please login again.");
                logout();
                return;
            }
            throw new Error(`HTTP ${res.status}`);
        }

        if (currentChatId === chatId) {
            currentChatId = null;
            chatMessages.innerHTML = '';
            const welcomeDiv = document.createElement('div');
            welcomeDiv.classList.add('welcome-message');
            welcomeDiv.innerHTML = '<h1>Welcome to FisherMen Chatbot</h1><p>How can I assist you today?</p>';
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

    if (existingMenu) {
        cleanupMenu();
        return;
    }

    cleanupMenu();

    const menu = document.createElement('div');
    menu.className = 'chat-dropdown show';

    menu.innerHTML = `
        <button class="menu-rename"><i class="fas fa-edit"></i> Rename</button>
        <button class="menu-pin"><i class="fas fa-thumbtack"></i> ${isPinned ? 'Unpin' : 'Pin'} chat</button>
        <button class="menu-share"><i class="fas fa-share-alt"></i> Share</button>
        <button class="menu-delete" style="color:var(--danger-color)"><i class="fas fa-trash-alt"></i> Delete</button>
    `;

    chatItem.appendChild(menu);

    document.querySelectorAll('.chat-item').forEach(item => {
        if (item !== chatItem) item.style.pointerEvents = 'none';
    });

    menu.querySelector('.menu-rename').addEventListener('click', (e) => {
        e.stopImmediatePropagation();
        cleanupMenu();
        renameChat(chatId);
    });

    menu.querySelector('.menu-pin').addEventListener('click', (e) => {
        e.stopImmediatePropagation();
        cleanupMenu();
        togglePin(chatId, !isPinned);
    });

    menu.querySelector('.menu-share').addEventListener('click', (e) => {
        e.stopImmediatePropagation();
        cleanupMenu();
        shareChat(chatId);
    });

    menu.querySelector('.menu-delete').addEventListener('click', (e) => {
        e.stopImmediatePropagation();
        cleanupMenu();
        if (confirm('Delete this chat permanently?')) deleteChat(chatId);
    });

    const closeHandler = (e) => {
        if (!chatItem.contains(e.target)) cleanupMenu();
    };
    setTimeout(() => document.addEventListener('click', closeHandler), 10);
}

function cleanupMenu() {
    document.querySelectorAll('.chat-dropdown').forEach(menu => {
        if (menu.parentNode) menu.remove();
    });
    document.querySelectorAll('.chat-item').forEach(item => {
        item.style.pointerEvents = 'auto';
    });
    document.removeEventListener('click', cleanupMenu);
}

// ==================== TOGGLE PIN ====================
async function togglePin(chatId, newPinnedState) {
    try {
        const res = await fetch(`${BACKEND_URL}/chats/${chatId}/pin`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${currentToken}`
            },
            body: JSON.stringify({ pinned: newPinnedState })
        });

        if (res.ok) {
            await loadUserChats();
        } else {
            alert("Failed to pin/unpin chat.");
        }
    } catch (e) {
        console.error(e);
        alert("Could not update pin status.");
    }
}

// ==================== RENAME CHAT ====================
async function renameChat(chatId) {
    const newTitle = prompt("Enter new title for this chat:", "");
    if (!newTitle || newTitle.trim() === "") return;

    try {
        const res = await fetch(`${BACKEND_URL}/chats/${chatId}/title`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${currentToken}`
            },
            body: JSON.stringify({ title: newTitle.trim() })
        });

        if (res.ok) {
            await loadUserChats();
        } else {
            alert("Failed to rename chat.");
        }
    } catch (e) {
        console.error(e);
        alert("Could not rename the chat.");
    }
}

// ==================== SHARE CHAT ====================
async function shareChat(chatId) {
    try {
        const res = await fetch(`${BACKEND_URL}/chats/${chatId}`, {
            method: 'GET',
            headers: { 'Authorization': `Bearer ${currentToken}` }
        });

        if (!res.ok) throw new Error("Failed to load chat");

        const chat = await res.json();

        let shareText = ` ${chat.title || 'FisherMen Chatbot Conversation'}\n\n`;
        if (chat.messages && chat.messages.length > 0) {
            chat.messages.forEach(msg => {
                const sender = msg.sender === 'user' ? 'You' : 'FisherMen Bot';
                shareText += `${sender}: ${msg.content}\n\n`;
            });
        }
        shareText += `\n Shared from FisherMen Chatbot`;

        const encodedText = encodeURIComponent(shareText);

        const modal = document.createElement('div');
        modal.className = 'share-modal';
        modal.innerHTML = `
            <h3>Share this chat</h3>
            <div class="share-options">
                <button class="share-btn whatsapp-btn" title="Share on WhatsApp">
                    <img src="https://upload.wikimedia.org/wikipedia/commons/6/6b/WhatsApp.svg" alt="WhatsApp">
                    <span>WhatsApp</span>
                </button>
                <button class="share-btn facebook-btn" title="Share on Facebook">
                    <img src="https://upload.wikimedia.org/wikipedia/commons/5/51/Facebook_f_logo_%282019%29.svg" alt="Facebook">
                    <span>Facebook</span>
                </button>
                <button class="share-btn messenger-btn" title="Share on Messenger">
                    <img src="https://img.icons8.com/color/48/facebook-messenger--v1.png" alt="Messenger">
                    <span>Messenger</span>
                </button>
            </div>
            <div class="copy-option">
                <button id="copy-btn">📋 Copy to clipboard</button>
            </div>
            <button onclick="this.closest('.share-modal').remove()" style="margin-top:20px; width:100%; padding:10px; background:none; border:1px solid var(--border-color); border-radius:8px; cursor:pointer;">
                Cancel
            </button>
        `;

        document.body.appendChild(modal);

        modal.querySelector('.whatsapp-btn').addEventListener('click', () => {
            window.open(`https://wa.me/?text=${encodedText}`, '_blank');
            modal.remove();
        });
        modal.querySelector('.facebook-btn').addEventListener('click', () => {
            window.open(`https://www.facebook.com/sharer/sharer.php?quote=${encodedText}`, '_blank');
            modal.remove();
        });
        modal.querySelector('.messenger-btn').addEventListener('click', () => {
            window.open(`https://www.messenger.com/t/?text=${encodedText}`, '_blank');
            modal.remove();
        });
        modal.querySelector('#copy-btn').addEventListener('click', async () => {
            try {
                await navigator.clipboard.writeText(shareText);
                const btn = modal.querySelector('#copy-btn');
                const originalText = btn.textContent;
                btn.textContent = '✅ Copied!';
                setTimeout(() => { btn.textContent = originalText; }, 2000);
            } catch (err) {
                alert("Failed to copy to clipboard");
            }
        });

    } catch (e) {
        console.error(e);
        alert("Could not share the chat. Please try again.");
    }
}

// ==================== CREATE / START NEW CHAT ====================
async function createNewChat() {
    if (!currentToken) return;

    try {
        const res = await fetch(`${BACKEND_URL}/chats`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${currentToken}`,
                'Content-Type': 'application/json'
            }
        });

        if (!res.ok) {
            if (res.status === 401) {
                alert("Session expired. Please login again.");
                logout();
                return;
            }
            throw new Error(`HTTP ${res.status}`);
        }

        const data = await res.json();
        currentChatId = data.chat_id;
        await loadUserChats();
    } catch (e) {
        console.error("Could not create new chat:", e);
        alert("Could not create new chat. Please try again.");
    }
}

function startNewChatUI() {
    currentChatId = null;
    chatMessages.innerHTML = '';

    const welcomeDiv = document.createElement('div');
    welcomeDiv.classList.add('welcome-message');
    welcomeDiv.innerHTML = `
        <h1>Welcome to FisherMen Chatbot</h1>
        <p>How can I assist you today?</p>
        <p style="margin-top:20px; font-size:15px; color:var(--text-secondary);">
            Send your first message to create the chat
        </p>
    `;
    chatMessages.appendChild(welcomeDiv);

    document.querySelectorAll('.chat-item').forEach(item => item.classList.remove('active'));
}

// ==================== CHAT SEND ====================
async function handleChatSubmit(e) {
    e.preventDefault();
    let message = chatInput.value.trim();

    if (!message || !currentToken) return;

    if (!currentChatId) {
        await createNewChat();
        if (!currentChatId) {
            alert("Failed to create a new chat. Please try again.");
            return;
        }
    }

    addMessage(message, 'user');
    chatInput.value = '';
    chatInput.style.height = 'auto';

    await sendMessageToBackend(message);
}

async function sendMessageToBackend(message) {
    if (!currentToken || !currentChatId) {
        removeTypingIndicator();
        addMessage("⚠️ Please login and create a new chat first.", 'bot');
        return;
    }

    showTypingIndicator();

    try {
        const res = await fetch(`${BACKEND_URL}/chat`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${currentToken}`
            },
            body: JSON.stringify({ message, chat_id: currentChatId })
        });

        if (!res.ok) {
            if (res.status === 401) {
                alert("Session expired. Please login again.");
                logout();
                return;
            }
            const errorData = await res.json().catch(() => ({}));
            console.error("Chat API error:", res.status, errorData);
            throw new Error(`Server error: ${res.status}`);
        }

        const data = await res.json();
        removeTypingIndicator();
        addMessage(data.reply, 'bot');
        await loadUserChats();
    } catch (err) {
        removeTypingIndicator();
        console.error("Chat request failed:", err);
        addMessage("⚠️ Couldn't reach the chatbot server. Please ensure the backend is running properly.", 'bot');
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

        feedbackDiv.appendChild(thumbsUpBtn);
        feedbackDiv.appendChild(thumbsDownBtn);
        messageDiv.appendChild(feedbackDiv);
    }

    chatMessages.appendChild(messageDiv);
    chatMessages.scrollTop = chatMessages.scrollHeight;
}

function showTypingIndicator() {
    const typingDiv = document.createElement('div');
    typingDiv.classList.add('message', 'bot-message', 'typing-indicator');
    typingDiv.innerHTML = `<div class="message-content"><span></span><span></span><span></span></div>`;
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
    sysMsg.innerHTML = `<div class="message-content" style="background:#e8f5e9;color:#2e7d32;">${text}</div>`;
    chatMessages.appendChild(sysMsg);
    chatMessages.scrollTop = chatMessages.scrollHeight;
}

// ==================== FEEDBACK ====================
async function handleFeedback(messageDiv, isPositive) {
    const thumbsUp = messageDiv.querySelector('.thumbs-up');
    const thumbsDown = messageDiv.querySelector('.thumbs-down');
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
    if (!currentToken) return;
    try {
        const res = await fetch(`${BACKEND_URL}/feedback`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${currentToken}`
            },
            body: JSON.stringify(feedbackData)
        });
        if (res.ok) {
            console.log('Feedback saved successfully');
        } else {
            console.error("Failed to save feedback");
        }
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
    const reason = document.querySelector('input[name="feedback"]:checked')?.value || "other";
    const comments = document.getElementById('feedback-text').value.trim();
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
    const icon = input.nextElementSibling.querySelector('i');
    if (input.type === 'password') {
        input.type = 'text';
        icon.classList.remove('fa-eye');
        icon.classList.add('fa-eye-slash');
    } else {
        input.type = 'password';
        icon.classList.remove('fa-eye-slash');
        icon.classList.add('fa-eye');
    }
}

// Export chat
document.getElementById('export-chat')?.addEventListener('click', () => {
    const messages = Array.from(chatMessages.querySelectorAll('.message')).map(m => ({
        sender: m.classList.contains('user-message') ? 'user' : 'bot',
        content: m.querySelector('.message-content').textContent,
        time: m.querySelector('.timestamp')?.textContent || ''
    }));
    const dataStr = JSON.stringify(messages, null, 2);
    const blob = new Blob([dataStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `fishermen-chat-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
});

function searchChatHistory() {
    const term = searchChats.value.toLowerCase();
    const items = chatHistory.querySelectorAll('.chat-item');
    items.forEach(item => {
        const title = item.querySelector('.chat-item-title').textContent.toLowerCase();
        item.style.display = title.includes(term) ? 'flex' : 'none';
    });
}

// Expose global functions for inline onclick handlers
window.togglePasswordVisibility = togglePasswordVisibility;
window.showSignup = showSignup;
window.showLogin = showLogin;
window.logout = logout;
window.closeFeedbackPopup = closeFeedbackPopup;
