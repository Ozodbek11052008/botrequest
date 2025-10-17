const TelegramBot = require("node-telegram-bot-api");

const token = "8318189443:AAHdp7AcIxwgIbYR0HOueTZ3lzUBX4slW8Q";
const bot = new TelegramBot(token, { polling: true });

// Store admin IDs and pending join requests
const ADMINS = [5310317109, 5543574742]; // Replace with actual admin user IDs
const pendingRequests = new Map(); // chatId -> array of user objects
const approvedUsers = new Map(); // Store approved user objects with their info

// Track broadcast state
const broadcastStates = new Map(); // adminId -> { waitingForMessage: true }

// Admin keyboard
const adminKeyboard = {
    reply_markup: {
        keyboard: [
            ["📊 Show Users", "✅ Accept All"],
            ["📢 Send Message", "🔄 Refresh"],
            ["👥 Approved Users"]
        ],
        resize_keyboard: true
    }
};

// When someone submits a join request
bot.on("chat_join_request", async (msg) => {
    const user = msg.from;
    const chat = msg.chat;

    console.log(`🔔 Новая заявка от ${user.username || user.first_name} в ${chat.title}`);

    // Store the pending request
    if (!pendingRequests.has(chat.id)) {
        pendingRequests.set(chat.id, []);
    }
    
    // Check if user is already in pending requests to avoid duplicates
    const existingUser = pendingRequests.get(chat.id).find(u => u.id === user.id);
    if (!existingUser) {
        pendingRequests.get(chat.id).push(user);
        console.log(`📥 Added to pending: ${user.first_name} (ID: ${user.id})`);
        
        // Notify admins about new request
        notifyAdminsAboutNewRequest(user, chat);
    }
});

// Handle messages
bot.on("message", async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;
    const user = msg.from;

    // Check if user is admin
    if (!ADMINS.includes(user.id)) {
        if (broadcastStates.has(user.id) && broadcastStates.get(user.id).waitingForMessage) {
            return;
        }
        return;
    }

    try {
        if (broadcastStates.has(user.id) && broadcastStates.get(user.id).waitingForMessage) {
            await handleBroadcastMessage(user.id, text, chatId);
            return;
        }

        switch (text) {
            case "/start":
            case "/admin":
                await showAdminPanel(chatId);
                break;
            
            case "📊 Show Users":
                await showPendingUsers(chatId);
                break;
            
            case "✅ Accept All":
                await acceptAllPendingRequests(chatId);
                break;
            
            case "🔄 Refresh":
                await showAdminPanel(chatId);
                break;
            
            case "📢 Send Message":
                await startBroadcastMode(chatId, user.id);
                break;
            
            case "👥 Approved Users":
                await showApprovedUsers(chatId);
                break;
            
            default:
                if (text.startsWith("/approve_")) {
                    const userId = parseInt(text.split("_")[1]);
                    await approveSingleUser(userId, chatId);
                } else if (text.startsWith("/broadcast_")) {
                    const userId = parseInt(text.split("_")[1]);
                    await sendUserBroadcast(userId, chatId);
                } else {
                    await showAdminPanel(chatId);
                }
        }
    } catch (err) {
        console.error("Error handling admin command:", err);
        await bot.sendMessage(chatId, "❌ Error: " + err.message, adminKeyboard);
    }
});

// Admin panel functions
async function showAdminPanel(chatId) {
    const totalPending = Array.from(pendingRequests.values()).reduce((sum, users) => sum + users.length, 0);
    const totalApproved = approvedUsers.size;
    
    await bot.sendMessage(
        chatId,
        `🛠️ *Admin Panel*\n\n` +
        `📊 *Pending Requests:* ${totalPending}\n` +
        `✅ *Approved Users:* ${totalApproved}\n` +
        `👥 *Active Chats:* ${pendingRequests.size}\n\n` +
        `*Available Commands:*\n` +
        `• 📊 Show Users - View all pending requests\n` +
        `• ✅ Accept All - Approve all pending requests\n` +
        `• 👥 Approved Users - View approved users\n` +
        `• 📢 Send Message - Broadcast message to users\n` +
        `• 🔄 Refresh - Update statistics`,
        { 
            parse_mode: "Markdown",
            ...adminKeyboard 
        }
    );
}

async function showPendingUsers(chatId) {
    console.log('📊 Show Pending Users called');
    console.log('Pending requests map:', Array.from(pendingRequests.entries()));
    
    if (pendingRequests.size === 0) {
        console.log('No pending requests found');
        await bot.sendMessage(chatId, "📭 No pending requests found.", adminKeyboard);
        return;
    }

    try {
        let allUsers = [];
        
        // Collect all users from all chats
        for (const [chatIdKey, users] of pendingRequests.entries()) {
            console.log(`Chat ${chatIdKey} has ${users.length} users:`, users);
            allUsers = allUsers.concat(users.map(user => ({ ...user, chatId: chatIdKey })));
        }

        if (allUsers.length === 0) {
            console.log('No users found in pending requests');
            await bot.sendMessage(chatId, "📭 No pending requests found.", adminKeyboard);
            return;
        }

        console.log(`Total pending users: ${allUsers.length}`);
        
        let message = `📋 *Pending Requests - Total: ${allUsers.length}*\n\n`;
        
        allUsers.forEach((user, index) => {
            const username = user.username ? `@${user.username}` : 'No username';
            const fullName = `${user.first_name}${user.last_name ? ' ' + user.last_name : ''}`;
            
            message += `${index + 1}. ${fullName}\n`;
            message += `   Username: ${username}\n`;
            message += `   User ID: ${user.id}\n`;
            message += `   Chat ID: ${user.chatId}\n`;
            message += `   Approve: /approve_${user.id}\n\n`;
        });

        console.log('Generated message:', message);
        
        // Split long messages
        const messages = splitMessage(message);
        for (const msg of messages) {
            await bot.sendMessage(chatId, msg, { 
                parse_mode: "Markdown",
                ...adminKeyboard 
            });
        }
    } catch (error) {
        console.error("Error showing pending users:", error);
        await bot.sendMessage(chatId, "❌ Error displaying pending users: " + error.message, adminKeyboard);
    }
}

async function showApprovedUsers(chatId) {
    console.log('👥 Show Approved Users called');
    console.log('Approved users map:', Array.from(approvedUsers.entries()));
    
    if (approvedUsers.size === 0) {
        await bot.sendMessage(chatId, "✅ No approved users yet.", adminKeyboard);
        return;
    }

    try {
        let message = `👥 *Approved Users - Total: ${approvedUsers.size}*\n\n`;
        let count = 1;
        
        for (const [userId, userData] of approvedUsers.entries()) {
            const username = userData.username ? `@${userData.username}` : 'No username';
            const fullName = `${userData.first_name}${userData.last_name ? ' ' + userData.last_name : ''}`;
            
            message += `${count}. ${fullName}\n`;
            message += `   Username: ${username}\n`;
            message += `   User ID: ${userId}\n`;
            message += `   Approved: ${new Date(userData.approvedAt).toLocaleString()}\n`;
            message += `   Broadcast: /broadcast_${userId}\n\n`;
            count++;
        }

        const messages = splitMessage(message);
        for (const msg of messages) {
            await bot.sendMessage(chatId, msg, { 
                parse_mode: "Markdown",
                ...adminKeyboard 
            });
        }
    } catch (error) {
        console.error("Error showing approved users:", error);
        await bot.sendMessage(chatId, "❌ Error displaying approved users: " + error.message, adminKeyboard);
    }
}

// Helper function to split long messages
function splitMessage(text, maxLength = 4096) {
    const messages = [];
    while (text.length > 0) {
        let chunk = text.substring(0, maxLength);
        
        if (chunk.length === maxLength && text.length > maxLength) {
            const lastNewline = chunk.lastIndexOf('\n');
            if (lastNewline > 0) {
                chunk = chunk.substring(0, lastNewline);
            }
        }
        
        messages.push(chunk);
        text = text.substring(chunk.length).trim();
    }
    return messages;
}

async function acceptAllPendingRequests(adminChatId) {
    console.log('✅ Accept All called');
    console.log('Pending requests before approval:', Array.from(pendingRequests.entries()));
    
    let totalApproved = 0;
    let errors = 0;

    // Create a copy of pending requests to avoid modification during iteration
    const pendingCopy = new Map(pendingRequests);

    for (const [chatId, users] of pendingCopy.entries()) {
        for (const user of users) {
            try {
                console.log(`Approving user ${user.id} for chat ${chatId}`);
                await bot.approveChatJoinRequest(chatId, user.id);
                
                // Store approved user with full data
                approvedUsers.set(user.id, {
                    ...user,
                    approvedAt: new Date().toISOString()
                });
                
                console.log(`✅ Approved and stored: ${user.first_name} (ID: ${user.id})`);
                
                // Send welcome message
                await bot.sendMessage(
                    user.id,
                    `Привет, ${user.first_name}! 👋\n\n` +
                    `Твоя заявка на вступление в канал одобрена ✅\n\n` +
                    `Добро пожаловать! 🎉`
                ).catch(err => {
                    console.log(`Cannot send message to user ${user.id}: ${err.message}`);
                });
                
                totalApproved++;
                
                // Remove from pending requests
                const currentUsers = pendingRequests.get(chatId);
                if (currentUsers) {
                    const userIndex = currentUsers.findIndex(u => u.id === user.id);
                    if (userIndex !== -1) {
                        currentUsers.splice(userIndex, 1);
                    }
                    if (currentUsers.length === 0) {
                        pendingRequests.delete(chatId);
                    }
                }
                
                await new Promise(resolve => setTimeout(resolve, 100));
                
            } catch (err) {
                console.error(`❌ Error approving ${user.username || user.id}:`, err.message);
                errors++;
            }
        }
    }

    console.log('Pending requests after approval:', Array.from(pendingRequests.entries()));
    console.log('Approved users after approval:', Array.from(approvedUsers.entries()));

    await bot.sendMessage(
        adminChatId,
        `✅ *Batch Approval Complete*\n\n` +
        `✅ Approved: ${totalApproved} users\n` +
        `❌ Errors: ${errors}\n` +
        `📭 Pending requests cleared.`,
        { 
            parse_mode: "Markdown",
            ...adminKeyboard 
        }
    );
}

async function approveSingleUser(userId, adminChatId) {
    console.log(`🔄 Approving single user: ${userId}`);
    console.log('Pending requests:', Array.from(pendingRequests.entries()));
    
    let approved = false;
    
    for (const [chatId, users] of pendingRequests.entries()) {
        const userIndex = users.findIndex(user => user.id === userId);
        if (userIndex !== -1) {
            const user = users[userIndex];
            
            try {
                await bot.approveChatJoinRequest(chatId, user.id);
                
                // Store approved user with full data
                approvedUsers.set(user.id, {
                    ...user,
                    approvedAt: new Date().toISOString()
                });
                
                console.log(`✅ Approved single user: ${user.first_name} (ID: ${user.id})`);
                
                // Send welcome message
                await bot.sendMessage(
                    user.id,
                    `Привет, ${user.first_name}! 👋\n\n` +
                    `Твоя заявка на вступление в канал одобрена ✅\n\n` +
                    `Добро пожаловать! 🎉`
                ).catch(err => {
                    console.log(`Cannot send message to user ${user.id}: ${err.message}`);
                });
                
                // Remove from pending
                users.splice(userIndex, 1);
                if (users.length === 0) {
                    pendingRequests.delete(chatId);
                }
                
                await bot.sendMessage(
                    adminChatId, 
                    `✅ Approved user: ${user.first_name}\nUser ID: ${user.id}`,
                    adminKeyboard
                );
                approved = true;
                break;
                
            } catch (err) {
                console.error(`❌ Error approving user ${userId}:`, err);
                await bot.sendMessage(
                    adminChatId, 
                    `❌ Error approving user: ${err.message}`, 
                    adminKeyboard
                );
                return;
            }
        }
    }
    
    if (!approved) {
        console.log(`❌ User ${userId} not found in pending requests`);
        await bot.sendMessage(
            adminChatId, 
            "❌ User not found in pending requests.", 
            adminKeyboard
        );
    }
    
    console.log('Pending requests after single approval:', Array.from(pendingRequests.entries()));
    console.log('Approved users after single approval:', Array.from(approvedUsers.entries()));
}

// Broadcast functions (keep the same as before)
async function startBroadcastMode(chatId, adminId) {
    broadcastStates.set(adminId, { waitingForMessage: true });
    
    await bot.sendMessage(
        chatId,
        `📢 *Broadcast Mode*\n\n` +
        `Please send the message you want to broadcast to all ${approvedUsers.size} approved users.\n\n` +
        `*Type your message now...*\n\n` +
        `To cancel, send /cancel`,
        { 
            parse_mode: "Markdown",
            reply_markup: {
                remove_keyboard: true,
                inline_keyboard: [[{ text: "❌ Cancel", callback_data: "cancel_broadcast" }]]
            }
        }
    );
}

async function handleBroadcastMessage(adminId, message, adminChatId) {
    broadcastStates.delete(adminId);

    if (message === '/cancel') {
        await bot.sendMessage(adminChatId, "❌ Broadcast cancelled.", adminKeyboard);
        return;
    }

    if (approvedUsers.size === 0) {
        await bot.sendMessage(adminChatId, "❌ No approved users to broadcast to.", adminKeyboard);
        return;
    }

    const broadcastMsg = await bot.sendMessage(
        adminChatId,
        `📢 *Starting Broadcast...*\n\n` +
        `Sending to ${approvedUsers.size} users...\n` +
        `⏳ Please wait...`,
        { parse_mode: "Markdown" }
    );

    let successCount = 0;
    let failCount = 0;
    let current = 0;

    for (const userId of approvedUsers.keys()) {
        current++;
        
        try {
            await bot.sendMessage(userId, message);
            successCount++;
            
            if (current % 10 === 0 || current === approvedUsers.size) {
                await bot.editMessageText(
                    `📢 *Broadcasting...*\n\n` +
                    `Sending to ${approvedUsers.size} users...\n` +
                    `✅ Success: ${successCount}\n` +
                    `❌ Failed: ${failCount}\n` +
                    `⏳ Progress: ${current}/${approvedUsers.size} (${Math.round((current / approvedUsers.size) * 100)}%)`,
                    {
                        chat_id: adminChatId,
                        message_id: broadcastMsg.message_id,
                        parse_mode: "Markdown"
                    }
                );
            }
            
            await new Promise(resolve => setTimeout(resolve, 50));
            
        } catch (error) {
            failCount++;
            console.error(`Failed to send to user ${userId}:`, error.message);
        }
    }

    await bot.editMessageText(
        `📢 *Broadcast Complete!*\n\n` +
        `✅ Successfully sent: ${successCount} users\n` +
        `❌ Failed: ${failCount} users\n` +
        `📊 Total: ${approvedUsers.size} users\n\n` +
        `*Message sent:*\n${message.substring(0, 100)}${message.length > 100 ? '...' : ''}`,
        {
            chat_id: adminChatId,
            message_id: broadcastMsg.message_id,
            parse_mode: "Markdown",
            ...adminKeyboard
        }
    );
}

// Handle callback queries
bot.on("callback_query", async (callbackQuery) => {
    const message = callbackQuery.message;
    const data = callbackQuery.data;
    const user = callbackQuery.from;

    if (data === "cancel_broadcast" && ADMINS.includes(user.id)) {
        broadcastStates.delete(user.id);
        await bot.editMessageText("❌ Broadcast cancelled.", {
            chat_id: message.chat.id,
            message_id: message.message_id,
            ...adminKeyboard
        });
        await bot.answerCallbackQuery(callbackQuery.id);
    }
});

async function sendUserBroadcast(userId, adminChatId) {
    await bot.sendMessage(
        adminChatId,
        `Send broadcast message for user ${userId}:\n\n` +
        `Use the main "📢 Send Message" button to broadcast to all users, or implement individual user messaging here.`,
        adminKeyboard
    );
}

function notifyAdminsAboutNewRequest(user, chat) {
    const message = `🔔 *New Join Request*\n\n` +
                   `User: ${user.first_name} ${user.username ? `(@${user.username})` : ''}\n` +
                   `User ID: ${user.id}\n` +
                   `Chat: ${chat.title}\n` +
                   `Time: ${new Date().toLocaleString()}`;

    ADMINS.forEach(adminId => {
        bot.sendMessage(adminId, message, { parse_mode: "Markdown", ...adminKeyboard })
            .catch(err => console.error("Error notifying admin:", err));
    });
}

// Handle /cancel command
bot.onText(/\/cancel/, (msg) => {
    const user = msg.from;
    if (ADMINS.includes(user.id)) {
        if (broadcastStates.has(user.id)) {
            broadcastStates.delete(user.id);
        }
        bot.sendMessage(msg.chat.id, "❌ Operation cancelled.", adminKeyboard);
    }
});

// Auto-restore keyboard
bot.on("message", (msg) => {
    const user = msg.from;
    const text = msg.text;
    
    if (ADMINS.includes(user.id) && 
        !broadcastStates.has(user.id) && 
        !text.startsWith('/') &&
        ![
            "📊 Show Users",
            "✅ Accept All", 
            "📢 Send Message",
            "🔄 Refresh",
            "👥 Approved Users"
        ].includes(text)) {
        
        showAdminPanel(msg.chat.id);
    }
});

// Error handling
bot.on("error", (error) => {
    console.error("Bot error:", error);
});

console.log("🤖 Bot started with debug logging...");