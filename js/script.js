// Global variables for DOM elements
let loginForm, signupForm, chatForm, feedbackForm;
let loginContainer, signupContainer, chatContainer, feedbackPopup, overlay;
let chatMessages, chatInput, chatHistory, newChatBtn, searchChats, userNameDisplay;
let languageSelect;
let sidebarToggle;
let sidebar;
let voicePopup, voiceBtn, voiceDoneBtn;
let recognition = null;
let isRecording = false;
let finalTranscript = '';
let speechRecognitionLang = 'bn-BD';
let currentChatId = null;

const BACKEND_URL = "http://localhost:8000"

// DOM Elements
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
    languageSelect = document.getElementById('language-select');
    sidebarToggle = document.getElementById('sidebar-toggle');
    sidebar = document.querySelector('.sidebar');
    voiceBtn = document.getElementById('voice-btn');
    voiceDoneBtn = document.getElementById('voice-done-btn');

    initApp();
    initSpeechRecognition();

    const darkToggle = document.getElementById('dark-toggle');
    if (darkToggle) {
        const isDark = localStorage.getItem('darkMode') === 'true';
        document.documentElement.classList.toggle('dark', isDark);
        darkToggle.addEventListener('click', () => {
            document.documentElement.classList.toggle('dark');
            localStorage.setItem('darkMode', document.documentElement.classList.contains('dark'));
        });
    }

    if (loginForm) loginForm.addEventListener('submit', handleLogin);
    if (signupForm) signupForm.addEventListener('submit', handleSignup);
    if (chatForm) chatForm.addEventListener('submit', handleChatSubmit);
    if (feedbackForm) feedbackForm.addEventListener('submit', handleFeedbackSubmit);
    if (newChatBtn) newChatBtn.addEventListener('click', createNewChat);
    if (searchChats) searchChats.addEventListener('input', searchChatHistory);
    if (sidebarToggle) {
        sidebarToggle.addEventListener('click', () => {
            if (sidebar) sidebar.classList.toggle('expanded');
        });
    }
    if (voiceBtn) voiceBtn.addEventListener('click', openVoicePopup);
    if (voiceDoneBtn) voiceDoneBtn.addEventListener('click', closeVoicePopup);

    const exportChatBtn = document.getElementById('export-chat');
    if (exportChatBtn) {
        exportChatBtn.addEventListener('click', () => {
            const history = getChatHistory();
            if (!history.length) {
                alert('No chat history to export. Start a conversation first.');
                return;
            }
            const currentChat = history.find(chat => chat.id === currentChatId) || history[0];
            const safeTitle = (currentChat.title || 'chat').replace(/[^a-z0-9]/gi, '_');
            const dataStr = JSON.stringify(currentChat, null, 2);
            const blob = new Blob([dataStr], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `fishermen-chat-${safeTitle}.json`;
            a.click();
            URL.revokeObjectURL(url);
        });
    }

    document.addEventListener('click', function(e) {
        if (e.target.matches('.btn-secondary') && e.target.textContent === 'Cancel') {
            closeFeedbackPopup();
        }
    });

    if (chatInput) {
        chatInput.addEventListener('input', () => {
            chatInput.style.height = 'auto';
            chatInput.style.height = (chatInput.scrollHeight) + 'px';
        });
    }
});

function initApp() {
    const currentUser = localStorage.getItem('currentUser');
    if (currentUser) {
        const user = JSON.parse(currentUser);
        showChatInterface(user);
        loadChatHistory();
    } else {
        showLogin();
    }
}

function initSpeechRecognition() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

    if (!SpeechRecognition) {
        recognition = null;
        return;
    }

    recognition = true;
}

// Authentication Functions
function handleLogin(e) {
    e.preventDefault();

    const name = document.getElementById('login-name').value.trim();
    const fishermanId = document.getElementById('login-fisherman-id').value.trim();
    const password = document.getElementById('login-password').value.trim();

    if (!name || !fishermanId || !password) {
        alert("Please fill out all fields.");
        return;
    }

    const user = {
        name,
        fishermanId,
        location: 'Unknown'
    };

    localStorage.setItem('currentUser', JSON.stringify(user));
    showChatInterface(user);
    appendSystemMessage(`Welcome back, ${name}! 👋`);
}

function handleSignup(e) {
    e.preventDefault();

    const name = document.getElementById('signup-name').value.trim();
    const fishermanId = document.getElementById('signup-fisherman-id').value.trim();
    const country = document.getElementById('signup-country').value;
    const location = document.getElementById('signup-location').value.trim();
    const password = document.getElementById('signup-password').value.trim();
    const confirmPassword = document.getElementById('signup-confirm-password').value.trim();

    if (!name || !fishermanId || !country || !location || !password || !confirmPassword) {
        alert("Please fill out all fields.");
        return;
    }

    if (password !== confirmPassword) {
        alert('Passwords do not match!');
        return;
    }

    const user = {
        name,
        fishermanId,
        country,
        location
    };

    localStorage.setItem('currentUser', JSON.stringify(user));
    showChatInterface(user);
    appendSystemMessage(`Welcome aboard, ${name}! 🎣`);
}

function logout() {
    localStorage.removeItem('currentUser');
    localStorage.removeItem('chatHistory');
    appendSystemMessage("You have logged out successfully.");
    showLogin();
}

// UI Navigation Functions
function showLogin() {
    document.getElementById('login-container').classList.remove('hidden');
    document.getElementById('signup-container').classList.add('hidden');
    document.getElementById('chat-container').classList.add('hidden');
}

function showSignup() {
    document.getElementById('login-container').classList.add('hidden');
    document.getElementById('signup-container').classList.remove('hidden');
    document.getElementById('chat-container').classList.add('hidden');
}

function showChatInterface(user) {
    document.getElementById('login-container').classList.add('hidden');
    document.getElementById('signup-container').classList.add('hidden');
    document.getElementById('chat-container').classList.remove('hidden');
    document.getElementById('user-name-display').textContent = user.name;
}

// Chat Functions
async function handleChatSubmit(e) {
    e.preventDefault();

    let message = chatInput.value.trim();
    message = message
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');

    if (!message) return;

    if (!currentChatId) {
        createNewChat();
    }

    addMessage(message, 'user');
    chatInput.value = '';
    chatInput.style.height = 'auto';

    await sendMessage(message);
}

async function sendMessage(message) {
    showTypingIndicator();

    try {
        const response = await fetch(`${BACKEND_URL}/chat`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ message }),
        });

        if (!response.ok) {
            throw new Error(`Server error ${response.status}`);
        }

        const data = await response.json();
        removeTypingIndicator();
        addMessage(data.reply, 'bot');
        saveChatToHistory(message, data.reply);
    } catch (err) {
        console.error("Chatbot fetch error:", err);
        removeTypingIndicator();
        const errorReply = "⚠️ Couldn't reach the chatbot server. Please ensure it's running.";
        addMessage(errorReply, 'bot');
        saveChatToHistory(message, errorReply);
    }
}

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

    const typingContent = document.createElement('div');
    typingContent.classList.add('message-content');
    typingContent.innerHTML = '<span class="dot"></span><span class="dot"></span><span class="dot"></span>';

    typingDiv.appendChild(typingContent);
    chatMessages.appendChild(typingDiv);
    chatMessages.scrollTop = chatMessages.scrollHeight;
}

function removeTypingIndicator() {
    const typingIndicator = document.querySelector('.typing-indicator');
    if (typingIndicator) {
        typingIndicator.remove();
    }
}

// Feedback Functions
async function handleFeedback(messageDiv, isPositive) {
    const thumbsUp = messageDiv.querySelector('.thumbs-up');
    const thumbsDown = messageDiv.querySelector('.thumbs-down');

    thumbsUp.classList.remove('active', 'thumbs-up-animation');
    thumbsDown.classList.remove('active', 'thumbs-down-animation');

    const reportedMessage = messageDiv.querySelector('.message-content').textContent;

    if (isPositive) {
        thumbsUp.classList.add('active', 'thumbs-up-animation');
        thumbsUp.style.color = 'var(--secondary-color)';

        await sendFeedback({
            type: 'positive',
            message: reportedMessage
        });
    } else {
        thumbsDown.classList.add('active', 'thumbs-down-animation');
        thumbsDown.style.color = 'var(--danger-color)';
        showFeedbackPopup(reportedMessage);
    }
}

function showFeedbackPopup(message) {
    feedbackPopup.dataset.reportedMessage = message;
    feedbackPopup.classList.remove('hidden');
    overlay.classList.remove('hidden');
}

function closeFeedbackPopup() {
    feedbackPopup.classList.add('hidden');
    overlay.classList.add('hidden');
    document.getElementById('feedback-form').reset();
}

function openVoicePopup() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

    if (!SpeechRecognition) {
        alert("Your browser does not support voice input.");
        return;
    }

    if (voicePopup && overlay) {
        voicePopup.classList.remove('hidden');
        overlay.classList.remove('hidden');

        finalTranscript = '';

        recognition = new SpeechRecognition();
        recognition.lang = speechRecognitionLang;
        recognition.continuous = false;
        recognition.interimResults = false;
        recognition.maxAlternatives = 1;

        recognition.onstart = () => {
            isRecording = true;
            if (voiceBtn) voiceBtn.classList.add('recording');
            console.log("Listening...");
        };

        recognition.onresult = (event) => {
            const transcript = event.results[0][0].transcript;

            if (chatInput) {
                chatInput.value = transcript;
                chatInput.style.height = 'auto';
                chatInput.style.height = chatInput.scrollHeight + 'px';
            }
        };

        recognition.onerror = (event) => {
            console.error("Speech recognition error:", event.error);
            alert("Speech recognition error: " + event.error);
            isRecording = false;
            if (voiceBtn) voiceBtn.classList.remove('recording');
        };

        recognition.onend = () => {
            isRecording = false;
            if (voiceBtn) voiceBtn.classList.remove('recording');
        };

        recognition.start();
    }
}

function closeVoicePopup() {
    if (voicePopup && overlay) {
        if (recognition && isRecording && recognition.stop) {
            recognition.stop();
        }

        voicePopup.classList.add('hidden');
        overlay.classList.add('hidden');

        if (chatInput) {
            chatInput.focus();
        }
    }
}

async function handleFeedbackSubmit(e) {
    e.preventDefault();

    const feedbackOption = document.querySelector('input[name="feedback"]:checked');
    const feedbackText = document.getElementById('feedback-text').value;
    const reportedMessage = feedbackPopup.dataset.reportedMessage;

    const feedbackData = {
        type: 'negative',
        reason: feedbackOption ? feedbackOption.value : 'not specified',
        comments: feedbackText,
        message: reportedMessage
    };

    await sendFeedback(feedbackData);
    closeFeedbackPopup();
    alert('Thank you for your feedback!');
}

async function sendFeedback(feedbackData) {
    try {
        const response = await fetch(`${BACKEND_URL}/feedback`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(feedbackData),
        });

        if (!response.ok) {
            throw new Error('Failed to save feedback');
        }

        console.log('Feedback saved successfully');
    } catch (error) {
        console.error('Error saving feedback:', error);
    }
}

// Chat History Functions
function createNewChat() {
    chatMessages.innerHTML = '';

    const welcomeDiv = document.createElement('div');
    welcomeDiv.classList.add('welcome-message');
    welcomeDiv.innerHTML = '<h1>Welcome to FisherMen Chatbot</h1><p>How can I assist you today?</p>';
    chatMessages.appendChild(welcomeDiv);

    const chatId = 'chat_' + Date.now();
    const newChat = {
        id: chatId,
        title: 'New Chat',
        timestamp: Date.now(),
        messages: []
    };

    currentChatId = chatId;

    const history = getChatHistory();
    history.unshift(newChat);
    localStorage.setItem('chatHistory', JSON.stringify(history));

    updateChatHistoryUI();
}

function saveChatToHistory(userMessage, botResponse) {
    let history = getChatHistory();

    if (history.length === 0) {
        createNewChat();
        history = getChatHistory();
    }

    let currentChat = history.find(chat => chat.id === currentChatId);

    if (!currentChat) {
        currentChat = history[0];
        currentChatId = currentChat.id;
    }

    currentChat.messages.push(
        { sender: 'user', content: userMessage },
        { sender: 'bot', content: botResponse }
    );

    if (currentChat.title === 'New Chat' && currentChat.messages.length === 2) {
        currentChat.title = userMessage.substring(0, 30) + (userMessage.length > 30 ? '...' : '');
    }

    currentChat.timestamp = Date.now();

    localStorage.setItem('chatHistory', JSON.stringify(history));
    updateChatHistoryUI();
}

function loadChatHistory() {
    const history = getChatHistory();

    if (history.length === 0) {
        createNewChat();
    } else {
        currentChatId = history[0].id;
        loadChat(history[0]);
        updateChatHistoryUI();
    }
}

function loadChat(chat) {
    currentChatId = chat.id;
    chatMessages.innerHTML = '';

    if (chat.messages && chat.messages.length > 0) {
        chat.messages.forEach(message => {
            addMessage(message.content, message.sender);
        });
    } else {
        const welcomeDiv = document.createElement('div');
        welcomeDiv.classList.add('welcome-message');
        welcomeDiv.innerHTML = '<h1>Welcome to FisherMen Chatbot</h1><p>How can I assist you today?</p>';
        chatMessages.appendChild(welcomeDiv);
    }
}

function updateChatHistoryUI() {
    const history = getChatHistory();
    history.sort((a, b) => b.timestamp - a.timestamp);

    document.getElementById('chat-history').innerHTML = '';

    history.forEach(chat => {
        const chatItem = document.createElement('div');
        chatItem.classList.add('chat-item');
        chatItem.dataset.chatId = chat.id;

        if (chat.id === currentChatId) {
            chatItem.classList.add('active');
        }

        chatItem.innerHTML = `
            <i class="fas fa-comment"></i>
            <div class="chat-item-title">${chat.title}</div>
        `;

        chatItem.addEventListener('click', () => {
            const latestHistory = getChatHistory();
            const latestChat = latestHistory.find(item => item.id === chat.id);
            loadChat(latestChat || chat);

            document.querySelectorAll('.chat-item').forEach(item => {
                item.classList.remove('active');
            });
            chatItem.classList.add('active');

            if (window.innerWidth <= 768 && sidebar) {
                sidebar.classList.remove('expanded');
            }
        });

        document.getElementById('chat-history').appendChild(chatItem);
    });

    if (!currentChatId && history.length > 0) {
        currentChatId = history[0].id;
        const firstItem = document.querySelector('.chat-item');
        if (firstItem) firstItem.classList.add('active');
    }
}

function searchChatHistory() {
    const searchTerm = document.getElementById('search-chats').value.toLowerCase();
    const history = getChatHistory();

    const filteredChats = history.filter(chat =>
        chat.title.toLowerCase().includes(searchTerm) ||
        chat.messages.some(msg => msg.content.toLowerCase().includes(searchTerm))
    );

    document.getElementById('chat-history').innerHTML = '';

    filteredChats.forEach(chat => {
        const chatItem = document.createElement('div');
        chatItem.classList.add('chat-item');
        chatItem.dataset.chatId = chat.id;

        if (chat.id === currentChatId) {
            chatItem.classList.add('active');
        }

        chatItem.innerHTML = `
            <i class="fas fa-comment"></i>
            <div class="chat-item-title">${chat.title}</div>
        `;

        chatItem.addEventListener('click', () => {
            const latestHistory = getChatHistory();
            const latestChat = latestHistory.find(item => item.id === chat.id);
            loadChat(latestChat || chat);

            document.querySelectorAll('.chat-item').forEach(item => {
                item.classList.remove('active');
            });
            chatItem.classList.add('active');

            if (window.innerWidth <= 768 && sidebar) {
                sidebar.classList.remove('expanded');
            }
        });

        document.getElementById('chat-history').appendChild(chatItem);
    });
}

function getChatHistory() {
    const history = localStorage.getItem('chatHistory');
    return history ? JSON.parse(history) : [];
}

// Utility Functions
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

function appendSystemMessage(text) {
    const sysMsg = document.createElement("div");
    sysMsg.classList.add("system-message");
    sysMsg.textContent = text;
    chatMessages.appendChild(sysMsg);
    chatMessages.scrollTop = chatMessages.scrollHeight;
}

// Helper Functions for Window
window.togglePasswordVisibility = togglePasswordVisibility;
window.showSignup = showSignup;
window.showLogin = showLogin;
window.logout = logout;
window.closeFeedbackPopup = closeFeedbackPopup;