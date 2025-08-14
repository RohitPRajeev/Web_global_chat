// Online Chat Application with Firebase
class OnlineChatApp {
    constructor() {
        this.db = null;
        this.auth = null;
        this.storage = null;
        this.currentUser = null;
        this.messagesRef = null;
        this.usersRef = null;
        this.unsubscribeMessages = null;
        this.unsubscribeUsers = null;
        this.typingTimeout = null;
        this.isTyping = false;
        this.heartbeatIntervalId = null;
        this.onlineActiveWindowMs = 30000; // Consider users active if seen within last 30 seconds
        this.typingActiveWindowMs = 4000; // Consider users typing if updated within last 4 seconds
        this.initialMessageLimit = 50;
        this.currentMessageLimit = this.initialMessageLimit;
        this.reactionsBound = false;
        this.actionsBound = false;
        this.userColors = [
            '#3B82F6', '#10B981', '#8B5CF6', '#F59E0B', '#EC4899', '#EF4444',
            '#06B6D4', '#84CC16', '#F97316', '#8B5A2B', '#6366F1', '#14B8A6'
        ];
        
        this.initializeElements();
        this.bindEvents();
        this.initializeFirebase();
    }

    async handleToggleReaction(messageId, emoji) {
        const userId = this.currentUser && this.currentUser.uid;
        if (!userId) return;
        const docRef = this.messagesRef.doc(messageId);
        await this.db.runTransaction(async (tx) => {
            const snap = await tx.get(docRef);
            if (!snap.exists) return;
            const data = snap.data() || {};
            const maps = data.reactionMaps || {};
            const setForEmoji = new Set(maps[emoji] || []);
            let delta = 0;
            if (setForEmoji.has(userId)) {
                setForEmoji.delete(userId);
                delta = -1;
            } else {
                setForEmoji.add(userId);
                delta = 1;
            }
            maps[emoji] = Array.from(setForEmoji);
            const updates = {
                reactionMaps: maps,
            };
            // Maintain a numeric count for quick render
            updates[`reactions.${emoji}`] = (data.reactions?.[emoji] || 0) + delta;
            if (updates[`reactions.${emoji}`] < 0) updates[`reactions.${emoji}`] = 0;
            tx.update(docRef, updates);
        });
    }

    initializeElements() {
        // Screens
        this.welcomeScreen = document.getElementById('welcome-screen');
        this.chatScreen = document.getElementById('chat-screen');
        this.loadingScreen = document.getElementById('loading-screen');
        
        // Welcome elements
        this.guestLoginBtn = document.getElementById('guest-login');
        this.googleLoginBtn = document.getElementById('google-login');
        
        // Chat elements
        this.messagesContainer = document.getElementById('messages');
        this.messagesScrollContainer = document.querySelector('.messages-container');
        this.loadOlderBtn = document.getElementById('load-older');
        this.messageForm = document.getElementById('message-form');
        this.messageInput = document.getElementById('message-input');
        this.sendBtn = document.querySelector('.btn-send');
        this.searchInput = document.getElementById('search-input');
        this.emojiBtn = document.getElementById('emoji-btn');
        this.emojiPicker = document.getElementById('emoji-picker');
        this.attachBtn = document.getElementById('attach-btn');
        this.fileInput = document.getElementById('file-input');
        this.gifBtn = document.getElementById('gif-btn');
        this.replyPreview = document.getElementById('reply-preview');
        this.pinnedBar = document.getElementById('pinned-bar');
        this.pendingReplyTo = null;
        this.backBtn = document.getElementById('back-btn');
        this.connectionStatus = document.getElementById('connection-status');
        this.userCount = document.getElementById('user-count');
        this.username = document.getElementById('username');
        this.userAvatar = document.getElementById('user-avatar');
        this.typingIndicator = document.getElementById('typing-indicator');
        this.typingText = document.getElementById('typing-text');
    }

    bindEvents() {
        // Login buttons
        this.guestLoginBtn.addEventListener('click', () => this.handleGuestLogin());
        this.googleLoginBtn.addEventListener('click', () => this.handleGoogleLogin());
        
        // Chat events
        this.messageForm.addEventListener('submit', (e) => {
            e.preventDefault();
            this.sendMessage();
        });

        // Ensure mobile tap on send triggers as well
        if (this.sendBtn) {
            this.sendBtn.addEventListener('click', (e) => {
                e.preventDefault();
                this.sendMessage();
            });
            this.sendBtn.addEventListener('touchend', (e) => {
                e.preventDefault();
                this.sendMessage();
            }, { passive: false });
        }

        this.backBtn.addEventListener('click', () => {
            this.showWelcomeScreen();
        });

        // Typing indicator
        this.messageInput.addEventListener('input', () => {
            this.handleTyping();
        });

        // Emoji picker toggle and insert
        if (this.emojiBtn && this.emojiPicker) {
            this.emojiBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.emojiPicker.classList.toggle('hidden');
            });
            this.emojiPicker.addEventListener('click', (e) => {
                const btn = e.target.closest('.emoji-item');
                if (!btn) return;
                e.preventDefault();
                e.stopPropagation();
                this.messageInput.value += btn.textContent;
                this.emojiPicker.classList.add('hidden');
                this.messageInput.focus();
                this.handleTyping();
            });
            // Close picker when clicking outside (mobile friendly)
            document.addEventListener('click', (e) => {
                if (!this.emojiPicker || this.emojiPicker.classList.contains('hidden')) return;
                const clickedInside = e.target.closest('#emoji-picker') || e.target.closest('#emoji-btn');
                if (!clickedInside) {
                    this.emojiPicker.classList.add('hidden');
                }
            }, true);
            // Prevent scroll from closing the picker on mobile
            this.emojiPicker.addEventListener('touchstart', (e) => e.stopPropagation(), { passive: true });
            this.emojiPicker.addEventListener('touchmove', (e) => e.stopPropagation(), { passive: true });
        }

        // Attachments
        if (this.attachBtn && this.fileInput) {
            this.attachBtn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                this.fileInput.click();
            });
            this.fileInput.addEventListener('change', (e) => this.handleFileSelected(e));
        }

        // GIF URL quick add
        if (this.gifBtn) {
            this.gifBtn.addEventListener('click', async () => {
                const url = prompt('Paste an image/GIF URL');
                if (url && this.currentUser) {
                    await this.sendAttachmentMessage({ type: 'image', url });
                }
            });
        }

        // Search filter
        if (this.searchInput) {
            this.searchInput.addEventListener('input', () => this.applySearchFilter());
        }

        // Load older pagination
        if (this.loadOlderBtn) {
            this.loadOlderBtn.addEventListener('click', () => {
                this.currentMessageLimit += this.initialMessageLimit;
                this.setupRealtimeListeners();
            });
        }

        // Bind a single delegated handler for reactions
        if (!this.reactionsBound && this.messagesContainer) {
            this.messagesContainer.addEventListener('click', (e) => {
                const btn = e.target.closest('.reaction-btn');
                if (!btn) return;
                const messageEl = e.target.closest('[data-message-id]');
                if (!messageEl) return;
                const id = messageEl.getAttribute('data-message-id');
                const emoji = btn.getAttribute('data-emoji');
                this.handleToggleReaction(id, emoji).catch((err) => console.error('Reaction failed:', err));
            });
            this.reactionsBound = true;
        }

        // Bind a single delegated handler for message actions
        if (!this.actionsBound && this.messagesContainer) {
            this.messagesContainer.addEventListener('click', async (e) => {
                const actionBtn = e.target.closest('.msg-action');
                if (!actionBtn) return;
                const id = actionBtn.getAttribute('data-id');
                const action = actionBtn.getAttribute('data-action');
                const docRef = this.messagesRef.doc(id);
                if (action === 'edit') {
                    const snap = await docRef.get();
                    const cur = (snap.exists && snap.data().text) || '';
                    const next = prompt('Edit your message', cur);
                    if (next !== null) {
                        await docRef.update({ text: next });
                    }
                } else if (action === 'delete') {
                    await docRef.update({ deleted: true, text: '' });
                } else if (action === 'pin') {
                    await docRef.update({ pinned: true });
                    this.renderPinnedBar();
                } else if (action === 'reply') {
                    this.pendingReplyTo = id;
                    this.showReplyPreview(id);
                }
            });
            this.actionsBound = true;
        }
    }

    initializeFirebase() {
        // Firebase configuration for chatappbyrohit
        const firebaseConfig = {
            apiKey: "AIzaSyA9MhyVk0IdHN110rarX9x0p7MvaOBosPU",
            authDomain: "chatappbyrohit.firebaseapp.com",
            projectId: "chatappbyrohit",
            storageBucket: "chatappbyrohit.firebasestorage.app",
            messagingSenderId: "371757082136",
            appId: "1:371757082136:web:93faa61a01f896987b456d",
            measurementId: "G-D67RR1ME2P"
        };

        // Initialize Firebase
        firebase.initializeApp(firebaseConfig);
        this.db = firebase.firestore();
        this.auth = firebase.auth();
        this.storage = firebase.storage();

        // Set up real-time listeners
        this.setupRealtimeListeners();
        
        // Handle auth state changes
        this.auth.onAuthStateChanged((user) => {
            if (user) {
                this.currentUser = user;
                this.showChatScreen();
                this.updateUserProfile();
                this.ensureOnlinePresenceForCurrentUser();
            } else {
                this.currentUser = null;
                this.showWelcomeScreen();
            }
        });
    }

    setupRealtimeListeners() {
        // Clean up existing listeners first
        if (this.unsubscribeMessages) {
            this.unsubscribeMessages();
        }
        if (this.unsubscribeUsers) {
            this.unsubscribeUsers();
        }

        // Listen for messages
        this.messagesRef = this.db.collection('messages');
        this.unsubscribeMessages = this.messagesRef
            .orderBy('timestamp', 'asc')
            .limitToLast(this.currentMessageLimit)
            .onSnapshot((snapshot) => {
                snapshot.docChanges().forEach((change) => {
                    const messageId = change.doc.id;
                    const data = change.doc.data();
                    if (change.type === 'added') {
                        const existingMessage = document.querySelector(`[data-message-id="${messageId}"]`);
                        if (!existingMessage) {
                            this.displayMessage(data, messageId);
                        }
                    } else if (change.type === 'modified') {
                        this.updateMessageDom(messageId, data);
                    }
                });
            }, (error) => {
                console.error('Error listening to messages:', error);
            });

        // Listen for online users
        this.usersRef = this.db.collection('users');
        this.unsubscribeUsers = this.usersRef
            .where('online', '==', true)
            .onSnapshot((snapshot) => {
                const nowMs = Date.now();
                const activeUsers = snapshot.docs.filter((doc) => {
                    const data = doc.data();
                    const lastSeenDate = data.lastSeen && data.lastSeen.toDate ? data.lastSeen.toDate() : null;
                    if (!lastSeenDate) return false;
                    return nowMs - lastSeenDate.getTime() <= this.onlineActiveWindowMs;
                });
                this.updateUserCount(activeUsers.length);

                const currentUid = this.auth && this.auth.currentUser ? this.auth.currentUser.uid : null;
                const typingUsernames = activeUsers
                    .map((doc) => ({ id: doc.id, data: doc.data() }))
                    .filter(({ id, data }) => {
                        if (id === currentUid) return false;
                        const lastTypingDate = data.lastTyping && data.lastTyping.toDate ? data.lastTyping.toDate() : null;
                        if (!data.isTyping || !lastTypingDate) return false;
                        return nowMs - lastTypingDate.getTime() <= this.typingActiveWindowMs;
                    })
                    .map(({ data }) => data.username || 'Someone');

                this.updateTypingIndicator(typingUsernames);
            }, (error) => {
                console.error('Error listening to users:', error);
            });
    }

    async handleGuestLogin() {
        this.showLoadingScreen();
        
        try {
            // Generate a random guest name
            const guestName = `Guest_${Math.random().toString(36).substr(2, 6)}`;
            const guestColor = this.userColors[Math.floor(Math.random() * this.userColors.length)];
            
            // Sign in anonymously
            await this.auth.signInAnonymously();
            
            // Update user profile
            await this.auth.currentUser.updateProfile({
                displayName: guestName,
                photoURL: null
            });
            
            // Add user to online users
            await this.addUserToOnline(guestName, guestColor);
            this.startPresenceHeartbeat();
            
        } catch (error) {
            console.error('Guest login error:', error);
            this.showWelcomeScreen();
            alert('Failed to connect. Please try again.');
        }
    }

    async handleGoogleLogin() {
        this.showLoadingScreen();
        
        try {
            const provider = new firebase.auth.GoogleAuthProvider();
            await this.auth.signInWithPopup(provider);
            
            // Add user to online users
            const user = this.auth.currentUser;
            const color = this.userColors[Math.floor(Math.random() * this.userColors.length)];
            await this.addUserToOnline(user.displayName || user.email, color);
            this.startPresenceHeartbeat();
            
        } catch (error) {
            if (error && (error.code === 'auth/popup-blocked' || error.code === 'auth/cancelled-popup-request' || error.code === 'auth/popup-closed-by-user')) {
                try {
                    const provider = new firebase.auth.GoogleAuthProvider();
                    await this.auth.signInWithRedirect(provider);
                    return;
                } catch (redirectError) {
                    console.error('Google redirect login error:', redirectError);
                    this.showWelcomeScreen();
                    alert('Popup was blocked and redirect sign-in failed. Please try again or allow popups.');
                    return;
                }
            }
            console.error('Google login error:', error);
            this.showWelcomeScreen();
            alert('Failed to sign in with Google. Please try again.');
        }
    }

    async addUserToOnline(username, color) {
        if (!this.auth.currentUser) return;
        
        const userDoc = {
            uid: this.auth.currentUser.uid,
            username: username,
            color: color,
            online: true,
            lastSeen: firebase.firestore.FieldValue.serverTimestamp()
        };
        
        await this.usersRef.doc(this.auth.currentUser.uid).set(userDoc, { merge: true });
    }

    async sendMessage() {
        const text = this.messageInput.value.trim();
        
        if (!text || !this.currentUser) return;

        try {
            const message = {
                text: text,
                userId: this.currentUser.uid,
                username: this.currentUser.displayName || this.currentUser.email || 'Anonymous',
                color: await this.getUserColor(),
                timestamp: firebase.firestore.FieldValue.serverTimestamp(),
                replyTo: this.pendingReplyTo || null,
                deleted: false,
                pinned: false
            };
            
            await this.messagesRef.add(message);
            this.messageInput.value = '';
            this.stopTyping();
            this.clearReplyPreview();
            // Clear any active search so the new message is visible
            if (this.searchInput) {
                this.searchInput.value = '';
                this.applySearchFilter();
            }
            
        } catch (error) {
            console.error('Error sending message:', error);
            alert('Failed to send message. Please try again.');
        }
    }

    async handleFileSelected(e) {
        const file = e.target.files && e.target.files[0];
        if (!file || !this.currentUser) return;
        try {
            const ext = (file.name.split('.').pop() || '').toLowerCase();
            const type = file.type.startsWith('image/') ? 'image' : file.type.startsWith('video/') ? 'video' : 'file';
            const storageRef = this.storage.ref().child(`uploads/${this.currentUser.uid}/${Date.now()}-${file.name}`);
            await storageRef.put(file);
            const url = await storageRef.getDownloadURL();
            await this.sendAttachmentMessage({ type, url, name: file.name, ext });
        } catch (error) {
            console.error('Upload failed:', error);
            alert('Upload failed. Please try again.');
        } finally {
            this.fileInput.value = '';
        }
    }

    async sendAttachmentMessage(attachment) {
        try {
            const msg = {
                text: this.messageInput.value.trim() || '',
                userId: this.currentUser.uid,
                username: this.currentUser.displayName || this.currentUser.email || 'Anonymous',
                color: await this.getUserColor(),
                timestamp: firebase.firestore.FieldValue.serverTimestamp(),
                attachment: attachment,
                replyTo: this.pendingReplyTo || null,
                deleted: false,
                pinned: false
            };
            await this.messagesRef.add(msg);
            this.messageInput.value = '';
            this.clearReplyPreview();
        } catch (error) {
            console.error('Error sending attachment:', error);
        }
    }

    async getUserColor() {
        if (!this.currentUser) return this.userColors[0];
        
        const userDoc = await this.usersRef.doc(this.currentUser.uid).get();
        return userDoc.exists ? userDoc.data().color : this.userColors[0];
    }

    handleTyping() {
        if (!this.currentUser) return;

        if (!this.isTyping) {
            this.isTyping = true;
            this.broadcastTyping(true);
        }

        // Clear existing timeout
        if (this.typingTimeout) {
            clearTimeout(this.typingTimeout);
        }

        // Set new timeout
        this.typingTimeout = setTimeout(() => {
            this.stopTyping();
        }, 1000);
    }

    async broadcastTyping(isTyping) {
        if (!this.currentUser) return;
        
        try {
            await this.usersRef.doc(this.currentUser.uid).update({
                isTyping: isTyping,
                lastTyping: firebase.firestore.FieldValue.serverTimestamp()
            });
        } catch (error) {
            console.error('Error broadcasting typing:', error);
        }
    }

    stopTyping() {
        if (this.isTyping && this.currentUser) {
            this.isTyping = false;
            this.broadcastTyping(false);
        }
        
        if (this.typingTimeout) {
            clearTimeout(this.typingTimeout);
            this.typingTimeout = null;
        }
    }

    updateTypingIndicator(typingUsernames) {
        if (!this.typingIndicator || !this.typingText) return;
        if (!typingUsernames || typingUsernames.length === 0) {
            this.typingIndicator.classList.add('hidden');
            return;
        }

        let text;
        if (typingUsernames.length === 1) {
            text = `${typingUsernames[0]} is typing...`;
        } else if (typingUsernames.length === 2) {
            text = `${typingUsernames[0]} and ${typingUsernames[1]} are typing...`;
        } else {
            text = `Several people are typing...`;
        }
        this.typingText.textContent = text;
        this.typingIndicator.classList.remove('hidden');
    }

    displayMessage(messageData, messageId = null) {
        const messageElement = document.createElement('div');
        const isOwnMessage = messageData.userId === this.currentUser?.uid;
        messageElement.className = `message ${isOwnMessage ? 'own' : ''}`;
        
        // Add message ID to prevent duplicates
        if (messageId) {
            messageElement.setAttribute('data-message-id', messageId);
        }
        
        const time = messageData.timestamp?.toDate ? 
            messageData.timestamp.toDate().toLocaleTimeString([], { 
                hour: '2-digit', 
                minute: '2-digit' 
            }) : 
            new Date().toLocaleTimeString([], { 
                hour: '2-digit', 
                minute: '2-digit' 
            });

        const quotedHtml = messageData.replyTo ? `<div class="quoted">Replying to #${this.escapeHtml(messageData.replyTo)}</div>` : '';
        const attachmentHtml = this.renderAttachmentHtml(messageData.attachment);
        const textHtml = messageData.deleted ? '<em>This message was deleted</em>' : this.linkifyAndHighlightMentions(this.escapeHtml(messageData.text || ''));
        const actionsHtml = this.renderActionsHtml(messageId, isOwnMessage);
        const reactionsHtml = this.renderReactionsHtml(messageData);

        messageElement.innerHTML = `
            <div class="message-avatar" style="background-color: ${messageData.color}">
                ${(messageData.username || 'A').charAt(0).toUpperCase()}
            </div>
            <div class="message-content">
                <div class="message-header">
                    <span class="message-username">${this.escapeHtml(messageData.username)}</span>
                    <span class="message-time">${time}</span>
                </div>
                ${quotedHtml}
                <div class="message-text">${textHtml}</div>
                ${attachmentHtml}
                ${reactionsHtml}
                ${actionsHtml}
            </div>
        `;

        this.messagesContainer.appendChild(messageElement);
        this.scrollToBottom();
    }

    updateMessageDom(messageId, data) {
        const el = document.querySelector(`[data-message-id="${messageId}"]`);
        if (!el) return;
        const content = el.querySelector('.message-content');
        if (!content) return;
        const time = data.timestamp?.toDate ? data.timestamp.toDate().toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'}) : '';
        const quotedHtml = data.replyTo ? `<div class="quoted">Replying to #${this.escapeHtml(data.replyTo)}</div>` : '';
        const attachmentHtml = this.renderAttachmentHtml(data.attachment);
        const textHtml = data.deleted ? '<em>This message was deleted</em>' : this.linkifyAndHighlightMentions(this.escapeHtml(data.text || ''));
        const reactionsHtml = this.renderReactionsHtml(data);
        const actionsHtml = this.renderActionsHtml(messageId, data.userId === this.currentUser?.uid);
        content.innerHTML = `
            <div class="message-header">
                <span class="message-username">${this.escapeHtml(data.username)}</span>
                <span class="message-time">${time}</span>
            </div>
            ${quotedHtml}
            <div class="message-text">${textHtml}</div>
            ${attachmentHtml}
            ${reactionsHtml}
            ${actionsHtml}
        `;
    }

    renderAttachmentHtml(attachment) {
        if (!attachment || !attachment.url) return '';
        if (attachment.type === 'image') {
            return `<div class="attachment"><img src="${attachment.url}" alt="attachment" style="max-width:220px;border-radius:10px;"></div>`;
        }
        if (attachment.type === 'video') {
            return `<div class="attachment"><video controls style="max-width:260px;border-radius:10px;"><source src="${attachment.url}"></video></div>`;
        }
        return `<div class="attachment"><a href="${attachment.url}" target="_blank" rel="noopener">${attachment.name || 'Download file'}</a></div>`;
    }

    renderActionsHtml(messageId, isOwn) {
        const replyBtn = `<button class="msg-action" data-action="reply" data-id="${messageId}"><i class="fas fa-reply"></i></button>`;
        const pinBtn = `<button class="msg-action" data-action="pin" data-id="${messageId}"><i class="fas fa-thumbtack"></i></button>`;
        const editBtn = isOwn ? `<button class="msg-action" data-action="edit" data-id="${messageId}"><i class="fas fa-edit"></i></button>` : '';
        const delBtn = isOwn ? `<button class="msg-action" data-action="delete" data-id="${messageId}"><i class="fas fa-trash"></i></button>` : '';
        const actions = `<div class="message-actions">${replyBtn}${pinBtn}${editBtn}${delBtn}</div>`;
        return actions;
    }

    renderReactionsHtml(data) {
        const counts = data.reactions || {};
        const emojis = ['👍','❤️','😂','🎉'];
        const items = emojis.map((e) => {
            const count = counts[e] || 0;
            return `<button class="reaction-btn" data-emoji="${e}">${e}${count > 0 ? ` <span class=\"reaction-count\">${count}</span>` : ''}</button>`;
        }).join('');
        return `<div class="reactions">${items}</div>`;
    }


    async renderPinnedBar() {
        if (!this.pinnedBar) return;
        const pinned = await this.messagesRef.where('pinned','==',true).orderBy('timestamp','desc').limit(5).get();
        const items = pinned.docs.map((d) => {
            const data = d.data();
            const text = (data.text || data.attachment?.name || 'Pinned').slice(0,50);
            return `<button class="pin-item" data-id="${d.id}">📌 ${this.escapeHtml(text)}</button>`;
        }).join('');
        if (!items) {
            this.pinnedBar.classList.add('hidden');
            this.pinnedBar.innerHTML = '';
            return;
        }
        this.pinnedBar.innerHTML = items;
        this.pinnedBar.classList.remove('hidden');
        this.pinnedBar.onclick = (e) => {
            const btn = e.target.closest('.pin-item');
            if (!btn) return;
            const id = btn.getAttribute('data-id');
            const target = document.querySelector(`[data-message-id="${id}"]`);
            if (target && this.messagesScrollContainer) {
                this.messagesScrollContainer.scrollTop = target.offsetTop - 20;
            }
        };
    }

    showReplyPreview(messageId) {
        if (!this.replyPreview) return;
        this.replyPreview.textContent = `Replying to message #${messageId} (click to cancel)`;
        this.replyPreview.classList.remove('hidden');
        this.replyPreview.onclick = () => this.clearReplyPreview();
    }

    clearReplyPreview() {
        this.pendingReplyTo = null;
        if (this.replyPreview) {
            this.replyPreview.textContent = '';
            this.replyPreview.classList.add('hidden');
        }
    }

    linkifyAndHighlightMentions(text) {
        const urlRegex = /(https?:\/\/[^\s]+)/g;
        const linked = text.replace(urlRegex, (url) => `<a href="${url}" target="_blank" rel="noopener">${url}</a>`);
        const mentionRegex = /(^|\s)@([A-Za-z0-9_]+)/g;
        return linked.replace(mentionRegex, (m, p1, p2) => `${p1}<span class="mention">@${p2}</span>`);
    }

    applySearchFilter() {
        const q = (this.searchInput.value || '').toLowerCase();
        const items = this.messagesContainer.querySelectorAll('.message');
        items.forEach((el) => {
            const text = (el.textContent || '').toLowerCase();
            el.style.display = !q || text.includes(q) ? '' : 'none';
        });
    }

    updateUserCount(count) {
        this.userCount.textContent = count || 0;
    }

    updateUserProfile() {
        if (!this.currentUser) return;
        
        const displayName = this.currentUser.displayName || 
                           this.currentUser.email?.split('@')[0] || 
                           'Anonymous';
        
        this.username.textContent = displayName;
        
        if (this.currentUser.photoURL) {
            this.userAvatar.innerHTML = `<img src="${this.currentUser.photoURL}" alt="Profile" style="width: 100%; height: 100%; border-radius: 50%; object-fit: cover;">`;
        } else {
            this.userAvatar.innerHTML = `<i class="fas fa-user"></i>`;
        }
    }

    showLoadingScreen() {
        this.welcomeScreen.classList.remove('active');
        this.chatScreen.classList.remove('active');
        this.loadingScreen.classList.add('active');
    }

    showChatScreen() {
        this.welcomeScreen.classList.remove('active');
        this.loadingScreen.classList.remove('active');
        this.chatScreen.classList.add('active');
        this.messageInput.focus();
        this.updateConnectionStatus(true);
    }

    showWelcomeScreen() {
        this.chatScreen.classList.remove('active');
        this.loadingScreen.classList.remove('active');
        this.welcomeScreen.classList.add('active');
        
        // Sign out user
        if (this.auth.currentUser) {
            const uid = this.auth.currentUser.uid;
            this.setUserOnline(false, uid).finally(() => {
                this.auth.signOut();
            });
        }
        
        // Clear messages and listeners
        this.clearMessages();
        this.updateUserCount(0);
        this.updateConnectionStatus(false);
    }

    clearMessages() {
        this.messagesContainer.innerHTML = '';
    }

    updateConnectionStatus(connected) {
        if (connected) {
            this.connectionStatus.className = 'status online';
            this.connectionStatus.innerHTML = '<i class="fas fa-circle"></i> Connected';
        } else {
            this.connectionStatus.className = 'status offline';
            this.connectionStatus.innerHTML = '<i class="fas fa-circle"></i> Disconnected';
        }
    }

    scrollToBottom() {
        const container = this.messagesScrollContainer || this.messagesContainer;
        if (!container) return;
        container.scrollTop = container.scrollHeight;
    }

    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    // Cleanup when leaving
    cleanup() {
        if (this.unsubscribeMessages) {
            this.unsubscribeMessages();
        }
        if (this.unsubscribeUsers) {
            this.unsubscribeUsers();
        }
        this.stopTyping();
        if (this.auth.currentUser) {
            const uid = this.auth.currentUser.uid;
            this.setUserOnline(false, uid);
        }
        this.stopPresenceHeartbeat();
    }

    // Presence tracking
    startPresenceHeartbeat() {
        this.stopPresenceHeartbeat();
        if (!this.auth.currentUser) return;
        // Immediately mark online
        this.setUserOnline(true);
        // Continue to ping every 10s
        this.heartbeatIntervalId = setInterval(() => {
            this.setUserOnline(true);
        }, 10000);
    }

    stopPresenceHeartbeat() {
        if (this.heartbeatIntervalId) {
            clearInterval(this.heartbeatIntervalId);
            this.heartbeatIntervalId = null;
        }
    }

    async setUserOnline(isOnline, uidOverride = null) {
        try {
            const uid = uidOverride || (this.auth.currentUser && this.auth.currentUser.uid);
            if (!uid) return;
            await this.usersRef.doc(uid).set({
                online: isOnline,
                lastSeen: firebase.firestore.FieldValue.serverTimestamp()
            }, { merge: true });
        } catch (error) {
            console.warn('Failed to update presence:', error);
        }
    }

    async ensureOnlinePresenceForCurrentUser() {
        try {
            if (!this.auth || !this.auth.currentUser || !this.usersRef) return;
            const uid = this.auth.currentUser.uid;
            const existing = await this.usersRef.doc(uid).get();
            const existingColor = existing.exists && existing.data().color ? existing.data().color : null;
            const color = existingColor || this.userColors[Math.floor(Math.random() * this.userColors.length)];
            const username = this.auth.currentUser.displayName || this.auth.currentUser.email || 'Anonymous';
            await this.usersRef.doc(uid).set({
                uid: uid,
                username: username,
                color: color,
                online: true,
                lastSeen: firebase.firestore.FieldValue.serverTimestamp()
            }, { merge: true });
            this.startPresenceHeartbeat();
        } catch (error) {
            console.warn('Failed ensuring online presence:', error);
        }
    }
}

// Initialize the app when DOM is loaded
let chatApp;
document.addEventListener('DOMContentLoaded', () => {
    chatApp = new OnlineChatApp();
});

// Handle page visibility changes
document.addEventListener('visibilitychange', () => {
    if (document.hidden && chatApp) {
        chatApp.stopTyping();
    }
});

// Handle beforeunload
window.addEventListener('beforeunload', () => {
    if (chatApp) {
        chatApp.cleanup();
    }
});

// Fallback for Firebase connection issues
window.addEventListener('error', (e) => {
    if (e.message.includes('firebase') || e.message.includes('Firebase')) {
        console.log('Firebase connection issue detected. Using demo mode.');
        // You could implement a fallback chat system here
    }
});
