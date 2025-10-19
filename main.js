const TelegramBot = require("node-telegram-bot-api");
const express = require('express');
const axios = require('axios');

// Create a simple HTTP server to satisfy port binding requirement
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
  res.send('🤖 Telegram Bot is running...');
});

app.get('/health', (req, res) => {
  res.status(200).json({ 
    status: 'OK', 
    message: 'Bot is healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    memory: process.memoryUsage()
  });
});

app.listen(PORT, () => {
  console.log(`🔄 HTTP server running on port ${PORT}`);
});

// Self-pinging to keep the bot awake
const PING_INTERVAL = 10 * 60 * 1000; // 10 minutes
const APP_URL = process.env.APP_URL || 'https://botrequest.onrender.com';

async function pingSelf() {
  try {
    const response = await axios.get(`${APP_URL}/health`);
    console.log(`✅ Self-ping successful: ${response.status} - ${new Date().toLocaleTimeString()}`);
  } catch (error) {
    console.error(`❌ Self-ping failed: ${error.message}`);
  }
}

// Start periodic pinging
setInterval(pingSelf, PING_INTERVAL);

// Initial ping
setTimeout(pingSelf, 5000);

console.log(`🔄 Self-pinging enabled. Pinging ${APP_URL} every 10 minutes`);

// Your existing bot code continues here...
const token = "8318189443:AAHdp7AcIxwgIbYR0HOueTZ3lzUBX4slW8Q";
const bot = new TelegramBot(token, { polling: true });

// Store admin IDs and pending join requests
const ADMINS = [5310317109, 5543574742];
const pendingRequests = new Map();
const approvedUsers = new Map();
const broadcastStates = new Map();

// NEW: Memory-based user tracking
let users = new Map();
let totalStarts = 0;
let botStartTime = new Date();

// Admin keyboard (UPDATED with Uzbek translations)
const adminKeyboard = {
    reply_markup: {
        keyboard: [
            ["📊 Barcha Foydalanuvchilar", "🎯 Faol Foydalanuvchilar"],
            ["✅ Hammasini Tasdiqlash", "👥 Tasdiqlanganlar"],
            ["📢 Xabar Yuborish", "🔄 Yangilash"]
        ],
        resize_keyboard: true
    }
};

// NEW: User tracking functions
function addOrUpdateUser(userId, username, firstName, lastName) {
    const timestamp = new Date();
    const userKey = userId.toString();
    
    if (users.has(userKey)) {
        const user = users.get(userKey);
        user.startCount += 1;
        user.lastSeen = timestamp;
        user.username = username;
        user.firstName = firstName;
        user.lastName = lastName;
    } else {
        users.set(userKey, {
            userId: userId,
            username: username,
            firstName: firstName,
            lastName: lastName,
            startCount: 1,
            firstSeen: timestamp,
            lastSeen: timestamp,
            isActive: true
        });
    }
    
    totalStarts += 1;
}

function getActiveUsers() {
    const now = new Date();
    const twentyFourHoursAgo = new Date(now - 24 * 60 * 60 * 1000);
    
    return Array.from(users.values())
        .filter(user => user.lastSeen >= twentyFourHoursAgo)
        .sort((a, b) => b.lastSeen - a.lastSeen);
}

function getAllTrackedUsers() {
    return Array.from(users.values()).sort((a, b) => 
        b.lastSeen - a.lastSeen
    );
}

function getUserStats() {
    const totalUsers = users.size;
    const now = new Date();
    
    const activeUsers = Array.from(users.values()).filter(user => {
        const timeDiff = now - user.lastSeen;
        const hoursDiff = timeDiff / (1000 * 60 * 60);
        return hoursDiff <= 24;
    }).length;
    
    const newToday = Array.from(users.values()).filter(user => {
        const today = new Date();
        return user.firstSeen.getDate() === today.getDate() &&
               user.firstSeen.getMonth() === today.getMonth() &&
               user.firstSeen.getFullYear() === today.getFullYear();
    }).length;
    
    const uptime = Math.floor((now - botStartTime) / 1000);
    const hours = Math.floor(uptime / 3600);
    const minutes = Math.floor((uptime % 3600) / 60);
    
    return {
        totalUsers,
        totalStarts,
        activeUsers,
        newToday,
        uptime: `${hours}h ${minutes}m`
    };
}

// When someone submits a join request
bot.on("chat_join_request", async (msg) => {
    const user = msg.from;
    const chat = msg.chat;

    console.log(`🔔 Yangi so'rov: ${user.username || user.first_name} dan ${chat.title} kanaliga`);

    if (!pendingRequests.has(chat.id)) {
        pendingRequests.set(chat.id, []);
    }
    
    const existingUser = pendingRequests.get(chat.id).find(u => u.id === user.id);
    if (!existingUser) {
        pendingRequests.get(chat.id).push(user);
        console.log(`📥 Kutish ro'yxatiga qo'shildi: ${user.first_name} (ID: ${user.id})`);
        
        notifyAdminsAboutNewRequest(user, chat);
    }
});

// Handle messages
bot.on("message", async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;
    const user = msg.from;

    // NEW: Track all user interactions
    if (text === '/start' || text === '/admin') {
        addOrUpdateUser(user.id, user.username || '', user.first_name || '', user.last_name || '');
    }

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
            
            case "📊 Barcha Foydalanuvchilar":
                await showAllTrackedUsers(chatId);
                break;
            
            case "✅ Hammasini Tasdiqlash":
                await acceptAllPendingRequests(chatId);
                break;
            
            case "🔄 Yangilash":
                await showAdminPanel(chatId);
                break;
            
            case "📢 Xabar Yuborish":
                await startBroadcastMode(chatId, user.id);
                break;
            
            case "👥 Tasdiqlanganlar":
                await showApprovedUsers(chatId);
                break;

            // NEW: Active Users button
            case "🎯 Faol Foydalanuvchilar":
                await showActiveUsers(chatId);
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
        await bot.sendMessage(chatId, "❌ Xatolik: " + err.message, adminKeyboard);
    }
});

// UPDATED: Admin panel with Uzbek translations
async function showAdminPanel(chatId) {
    const totalPending = Array.from(pendingRequests.values()).reduce((sum, users) => sum + users.length, 0);
    const totalApproved = approvedUsers.size;
    const stats = getUserStats();
    
    await bot.sendMessage(
        chatId,
        `🛠️ *Admin Panel*\n\n` +
        `📊 *Statistika:*\n` +
        `• Jami Foydalanuvchilar: ${stats.totalUsers}\n` +
        `• Faol Foydalanuvchilar (24 soat): ${stats.activeUsers}\n` +
        `• Bugun qo'shilganlar: ${stats.newToday}\n` +
        `• Jami startlar: ${stats.totalStarts}\n\n` +
        `📋 *So'rovlar:*\n` +
        `• Kutayotgan so'rovlar: ${totalPending}\n` +
        `• Tasdiqlanganlar: ${totalApproved}\n` +
        `• Faol kanallar: ${pendingRequests.size}\n\n` +
        `⏰ Ish vaqti: ${stats.uptime}\n\n` +
        `*Mavjud buyruqlar:*\n` +
        `• 📊 Barcha Foydalanuvchilar - Barcha foydalanuvchilarni ko'rish\n` +
        `• 🎯 Faol Foydalanuvchilar - 24 soatlik faol foydalanuvchilar\n` +
        `• ✅ Hammasini Tasdiqlash - Barcha so'rovlarni tasdiqlash\n` +
        `• 👥 Tasdiqlanganlar - Kanalga tasdiqlanganlar\n` +
        `• 📢 Xabar Yuborish - Xabar tarqatish\n` +
        `• 🔄 Yangilash - Statistikan yangilash`,
        { 
            parse_mode: "Markdown",
            ...adminKeyboard 
        }
    );
}

// NEW: Function to show active users (last 24 hours) in Uzbek
async function showActiveUsers(chatId) {
    const activeUsers = getActiveUsers();
    
    if (activeUsers.length === 0) {
        await bot.sendMessage(chatId, "📭 So'ngi 24 soatda faol foydalanuvchilar yo'q.", adminKeyboard);
        return;
    }

    try {
        let message = `🎯 Faol Foydalanuvchilar (So'ngi 24 soat) - Jami: ${activeUsers.length}\n\n`;
        
        

        // Send without Markdown to avoid parsing errors
        const messages = splitMessage(message);
        for (const msg of messages) {
            await bot.sendMessage(chatId, msg, adminKeyboard);
        }
    } catch (error) {
        console.error("Error showing active users:", error);
        await bot.sendMessage(chatId, "❌ Faol foydalanuvchilarni ko'rsatishda xatolik. Iltimos, qayta urinib ko'ring.", adminKeyboard);
    }
}

// NEW: Function to show ALL tracked users in Uzbek
async function showAllTrackedUsers(chatId) {
    console.log('📊 Show ALL Tracked Users called');
    
    const allUsers = getAllTrackedUsers();
    
    if (allUsers.length === 0) {
        await bot.sendMessage(chatId, "📭 Tizimda foydalanuvchilar topilmadi.", adminKeyboard);
        return;
    }

    try {
        let message = `📊 Barcha Foydalanuvchilar - Jami: ${allUsers.length}\n\n`;
    
    } catch (error) {
        console.error("Error showing all users:", error);
        await bot.sendMessage(chatId, "❌ Foydalanuvchilarni ko'rsatishda xatolik: " + error.message, adminKeyboard);
    }
}

// NEW: Function to show pending channel requests in Uzbek
async function showPendingRequests(chatId) {
    console.log('📋 Show Pending Requests called');
    console.log('Pending requests map:', Array.from(pendingRequests.entries()));
    
    if (pendingRequests.size === 0) {
        console.log('No pending requests found');
        await bot.sendMessage(chatId, "📭 Kutayotgan kanal so'rovlari topilmadi.", adminKeyboard);
        return;
    }

    try {
        let allUsers = [];
        
        for (const [chatIdKey, users] of pendingRequests.entries()) {
            console.log(`Chat ${chatIdKey} has ${users.length} users:`, users);
            allUsers = allUsers.concat(users.map(user => ({ ...user, chatId: chatIdKey })));
        }

        if (allUsers.length === 0) {
            console.log('No users found in pending requests');
            await bot.sendMessage(chatId, "📭 Kutayotgan kanal so'rovlari topilmadi.", adminKeyboard);
            return;
        }

        console.log(`Total pending users: ${allUsers.length}`);
        
        let message = `📋 Kutayotgan Kanal So'rovlari - Jami: ${allUsers.length}\n\n`;
        
        allUsers.forEach((user, index) => {
            const username = user.username ? `@${user.username}` : 'Username yo\'q';
            const fullName = `${user.first_name}${user.last_name ? ' ' + user.last_name : ''}`;
            
            message += `${index + 1}. ${fullName}\n`;
            message += `   👤 Username: ${username}\n`;
            message += `   🆔 User ID: ${user.id}\n`;
            message += `   💬 Kanal ID: ${user.chatId}\n`;
            message += `   ✅ Tasdiqlash: /approve_${user.id}\n\n`;
        });

        console.log('Generated message:', message);
        
        const messages = splitMessage(message);
        for (const msg of messages) {
            await bot.sendMessage(chatId, msg, adminKeyboard);
        }
    } catch (error) {
        console.error("Error showing pending requests:", error);
        await bot.sendMessage(chatId, "❌ Kutayotgan so'rovlarni ko'rsatishda xatolik: " + error.message, adminKeyboard);
    }
}

async function showApprovedUsers(chatId) {
    console.log('👥 Show Approved Users called');
    console.log('Approved users map:', Array.from(approvedUsers.entries()));
    
    if (approvedUsers.size === 0) {
        await bot.sendMessage(chatId, "✅ Hali tasdiqlangan foydalanuvchilar yo'q.", adminKeyboard);
        return;
    }

    try {
        let message = `👥 Tasdiqlangan Foydalanuvchilar - Jami: ${approvedUsers.size}\n\n`;
        let count = 1;
        
        for (const [userId, userData] of approvedUsers.entries()) {
            const username = userData.username ? `@${userData.username}` : 'Username yo\'q';
            const fullName = `${userData.first_name}${userData.last_name ? ' ' + userData.last_name : ''}`;
            
            message += `${count}. ${fullName}\n`;
            message += `   👤 Username: ${username}\n`;
            message += `   🆔 User ID: ${userId}\n`;
            message += `   ✅ Tasdiqlangan: ${new Date(userData.approvedAt).toLocaleString()}\n`;
            message += `   📨 Xabar yuborish: /broadcast_${userId}\n\n`;
            count++;
        }

        const messages = splitMessage(message);
        for (const msg of messages) {
            await bot.sendMessage(chatId, msg, adminKeyboard);
        }
    } catch (error) {
        console.error("Error showing approved users:", error);
        await bot.sendMessage(chatId, "❌ Tasdiqlangan foydalanuvchilarni ko'rsatishda xatolik: " + error.message, adminKeyboard);
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

    const pendingCopy = new Map(pendingRequests);

    for (const [chatId, users] of pendingCopy.entries()) {
        for (const user of users) {
            try {
                console.log(`Approving user ${user.id} for chat ${chatId}`);
                await bot.approveChatJoinRequest(chatId, user.id);
                
                approvedUsers.set(user.id, {
                    ...user,
                    approvedAt: new Date().toISOString()
                });

                // NEW: Track approved users
                addOrUpdateUser(user.id, user.username || '', user.first_name || '', user.last_name || '');
                
                console.log(`✅ Approved and stored: ${user.first_name} (ID: ${user.id})`);
                
                await bot.sendMessage(
                    user.id,
                    `Salom, ${user.first_name}! 👋\n\n` +
                    `Sizning kanalga qo'shilish so'rovingiz tasdiqlandi ✅\n\n` +
                    `Xush kelibsiz! 🎉`
                ).catch(err => {
                    console.log(`Cannot send message to user ${user.id}: ${err.message}`);
                });
                
                totalApproved++;
                
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
        `✅ *Barcha So'rovlar Tasdiqlandi*\n\n` +
        `✅ Tasdiqlandi: ${totalApproved} foydalanuvchi\n` +
        `❌ Xatolar: ${errors}\n` +
        `📭 Kutayotgan so'rovlar tozalandi.`,
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
                
                approvedUsers.set(user.id, {
                    ...user,
                    approvedAt: new Date().toISOString()
                });

                // NEW: Track approved users
                addOrUpdateUser(user.id, user.username || '', user.first_name || '', user.last_name || '');
                
                console.log(`✅ Approved single user: ${user.first_name} (ID: ${user.id})`);
                
                await bot.sendMessage(
                    user.id,
                    `Salom, ${user.first_name}! 👋\n\n` +
                    `Sizning kanalga qo'shilish so'rovingiz tasdiqlandi ✅\n\n` +
                    `Xush kelibsiz! 🎉`
                ).catch(err => {
                    console.log(`Cannot send message to user ${user.id}: ${err.message}`);
                });
                
                users.splice(userIndex, 1);
                if (users.length === 0) {
                    pendingRequests.delete(chatId);
                }
                
                await bot.sendMessage(
                    adminChatId, 
                    `✅ Tasdiqlandi: ${user.first_name}\nUser ID: ${user.id}`,
                    adminKeyboard
                );
                approved = true;
                break;
                
            } catch (err) {
                console.error(`❌ Error approving user ${userId}:`, err);
                await bot.sendMessage(
                    adminChatId, 
                    `❌ Foydalanuvchini tasdiqlashda xatolik: ${err.message}`, 
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
            "❌ Foydalanuvchi kutayotgan so'rovlar ro'yxatida topilmadi.", 
            adminKeyboard
        );
    }
    
    console.log('Pending requests after single approval:', Array.from(pendingRequests.entries()));
    console.log('Approved users after single approval:', Array.from(approvedUsers.entries()));
}

// Broadcast functions in Uzbek
async function startBroadcastMode(chatId, adminId) {
    broadcastStates.set(adminId, { waitingForMessage: true });
    
    await bot.sendMessage(
        chatId,
        `📢 *Xabar Tarqatish Rejimi*\n\n` +
        `Iltimos, barcha ${approvedUsers.size} tasdiqlangan foydalanuvchilarga yubormoqchi bo'lgan xabaringizni kiriting.\n\n` +
        `*Xabaringizni hozir yuboring...*\n\n` +
        `Bekor qilish uchun /cancel yuboring`,
        { 
            parse_mode: "Markdown",
            reply_markup: {
                remove_keyboard: true,
                inline_keyboard: [[{ text: "❌ Bekor qilish", callback_data: "cancel_broadcast" }]]
            }
        }
    );
}

async function handleBroadcastMessage(adminId, message, adminChatId) {
    broadcastStates.delete(adminId);

    if (message === '/cancel') {
        await bot.sendMessage(adminChatId, "❌ Xabar tarqatish bekor qilindi.", adminKeyboard);
        return;
    }

    if (approvedUsers.size === 0) {
        await bot.sendMessage(adminChatId, "❌ Xabar yuborish uchun tasdiqlangan foydalanuvchilar yo'q.", adminKeyboard);
        return;
    }

    const broadcastMsg = await bot.sendMessage(
        adminChatId,
        `📢 *Xabar Tarqatish Boshlandi...*\n\n` +
        `${approvedUsers.size} foydalanuvchiga yuborilmoqda...\n` +
        `⏳ Iltimos, kuting...`,
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
                    `📢 *Xabar Tarqatilmoqda...*\n\n` +
                    `${approvedUsers.size} foydalanuvchiga yuborilmoqda...\n` +
                    `✅ Muvaffaqiyatli: ${successCount}\n` +
                    `❌ Xatolar: ${failCount}\n` +
                    `⏳ Jarayon: ${current}/${approvedUsers.size} (${Math.round((current / approvedUsers.size) * 100)}%)`,
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
        `📢 *Xabar Tarqatish Yakunlandi!*\n\n` +
        `✅ Muvaffaqiyatli yuborildi: ${successCount} foydalanuvchi\n` +
        `❌ Xatolar: ${failCount} foydalanuvchi\n` +
        `📊 Jami: ${approvedUsers.size} foydalanuvchi\n\n` +
        `*Yuborilgan xabar:*\n${message.substring(0, 100)}${message.length > 100 ? '...' : ''}`,
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
        await bot.editMessageText("❌ Xabar tarqatish bekor qilindi.", {
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
        `Foydalanuvchi ${userId} ga xabar yuborish:\n\n` +
        `Barcha foydalanuvchilarga xabar yuborish uchun asosiy "📢 Xabar Yuborish" tugmasidan foydalaning.`,
        adminKeyboard
    );
}

function notifyAdminsAboutNewRequest(user, chat) {
    const message = `🔔 *Yangi Kanal So'rovi*\n\n` +
                   `Foydalanuvchi: ${user.first_name} ${user.username ? `(@${user.username})` : ''}\n` +
                   `User ID: ${user.id}\n` +
                   `Kanal: ${chat.title}\n` +
                   `Vaqt: ${new Date().toLocaleString()}`;

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
        bot.sendMessage(msg.chat.id, "❌ Operatsiya bekor qilindi.", adminKeyboard);
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
            "📊 Barcha Foydalanuvchilar",
            "🎯 Faol Foydalanuvchilar",
            "✅ Hammasini Tasdiqlash", 
            "📢 Xabar Yuborish",
            "🔄 Yangilash",
            "👥 Tasdiqlanganlar"
        ].includes(text)) {
        
        showAdminPanel(msg.chat.id);
    }
});

// Error handling
bot.on("error", (error) => {
    console.error("Bot error:", error);
});

console.log("🤖 Bot foydalanuvchilarni kuzatish va faol foydalanuvchilar funksiyasi bilan ishga tushdi...");
console.log("🔄 Bot will stay awake with automatic self-pinging every 10 minutes");