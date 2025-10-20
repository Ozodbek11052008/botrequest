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
    timestamp: new Date().toISOString()
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
setTimeout(pingSelf, 5000);

console.log(`🔄 Self-pinging enabled. Pinging ${APP_URL} every 10 minutes`);

// Your existing bot code continues here...
const token = "8318189443:AAHdp7AcIxwgIbYR0HOueTZ3lzUBX4slW8Q";
const bot = new TelegramBot(token, { polling: true });

// Store admin IDs and pending join requests
const ADMINS = [5310317109, 5543574742];
const pendingRequests = new Map(); // chatId -> array of user objects
const approvedUsers = new Map(); // userId -> user data
const broadcastStates = new Map();
const adminSelectedChannels = new Map(); // adminId -> selected chatId

// NEW: Memory-based user tracking
let users = new Map();
let totalStarts = 0;
let botStartTime = new Date();

// Main admin keyboard - TO'G'RIDAN-TO'G'RI KANAL TANLASH
const mainAdminKeyboard = {
    reply_markup: {
        keyboard: [
            ["📊 Barcha Foydalanuvchilar", "🎯 Faol Foydalanuvchilar"],
            ["👥 Tasdiqlanganlar", "🔄 Yangilash"]
        ],
        resize_keyboard: true
    }
};

// NEW: Function to create channel selection keyboard
function getChannelSelectionKeyboard() {
    const keyboard = [];
    
    for (const [channelId, channelUsers] of pendingRequests.entries()) {
        if (channelUsers && channelUsers.length > 0) {
            keyboard.push([`📺 Kanal: ${channelId} (${channelUsers.length} so'rov)`]);
        }
    }
    
    keyboard.push(["🔙 Asosiy Menyuga"]);
    return {
        reply_markup: {
            keyboard: keyboard,
            resize_keyboard: true
        }
    };
}

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
        await showMainAdminPanel(chatId);
        return;
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

        // Check if text is a channel selection
        if (text.startsWith("📺 Kanal: ")) {
            const channelId = text.split(" ")[2]; // "📺 Kanal: 123456789" -> "123456789"
            await selectChannel(chatId, user.id, channelId);
            return;
        }

        // Check if admin has selected a channel
        const selectedChannelId = adminSelectedChannels.get(user.id);
        
        switch (text) {
            case "/start":
            case "/admin":
            case "🔙 Asosiy Menyuga":
                adminSelectedChannels.delete(user.id);
                await showMainAdminPanel(chatId);
                break;
            
            case "📊 Barcha Foydalanuvchilar":
                await showAllTrackedUsers(chatId);
                break;
            
            case "🔄 Yangilash":
                await showMainAdminPanel(chatId);
                break;
            
            case "🎯 Faol Foydalanuvchilar":
                await showActiveUsers(chatId);
                break;
            
            case "👥 Tasdiqlanganlar":
                await showApprovedUsers(chatId);
                break;

            // Channel management commands
            case "✅ Hammasini Tasdiqlash":
                if (selectedChannelId) {
                    await acceptAllPendingRequests(chatId, selectedChannelId);
                } else {
                    await showChannelSelection(chatId);
                }
                break;
            
            case "📋 So'rovlarni Ko'rish":
                if (selectedChannelId) {
                    await showChannelPendingRequests(chatId, selectedChannelId);
                } else {
                    await showChannelSelection(chatId);
                }
                break;
            
            case "📢 Xabar Yuborish":
                if (selectedChannelId) {
                    await startChannelBroadcastMode(chatId, user.id, selectedChannelId);
                } else {
                    await showChannelSelection(chatId);
                }
                break;
            
            default:
                if (text.startsWith("/approve_")) {
                    const userId = parseInt(text.split("_")[1]);
                    if (selectedChannelId) {
                        await approveSingleUser(userId, chatId, selectedChannelId);
                    } else {
                        await bot.sendMessage(chatId, "❌ Iltimos, avval kanalni tanlang.", mainAdminKeyboard);
                    }
                } else {
                    await showMainAdminPanel(chatId);
                }
        }
    } catch (err) {
        console.error("Error handling admin command:", err);
        await bot.sendMessage(chatId, "❌ Xatolik: " + err.message, mainAdminKeyboard);
    }
});

// NEW: Show main admin panel with channel options
async function showMainAdminPanel(chatId) {
    const totalPending = Array.from(pendingRequests.values()).reduce((sum, users) => sum + users.length, 0);
    const totalApproved = approvedUsers.size;
    const stats = getUserStats();
    const totalChannels = pendingRequests.size;
    
    let message = `🛠️ *Asosiy Admin Panel*\n\n` +
        `📊 *Statistika:*\n` +
        `• Jami Foydalanuvchilar: ${stats.totalUsers}\n` +
        `• Faol Foydalanuvchilar (24 soat): ${stats.activeUsers}\n` +
        `• Bugun qo'shilganlar: ${stats.newToday}\n` +
        `• Jami startlar: ${stats.totalStarts}\n\n` +
        `📋 *So'rovlar:*\n` +
        `• Kutayotgan so'rovlar: ${totalPending}\n` +
        `• Tasdiqlanganlar: ${totalApproved}\n` +
        `• Faol kanallar: ${totalChannels}\n\n` +
        `⏰ Ish vaqti: ${stats.uptime}\n\n`;

    // Add channel information if there are pending requests
    if (totalChannels > 0) {
        message += `📺 *Kanal So'rovlari:*\n`;
        for (const [channelId, channelUsers] of pendingRequests.entries()) {
            if (channelUsers && channelUsers.length > 0) {
                message += `• Kanal ${channelId}: ${channelUsers.length} so'rov\n`;
            }
        }
        message += `\n`;
    }

    message += `*Mavjud buyruqlar:*\n` +
        `• ✅ Hammasini Tasdiqlash - Kanal tanlab so'rovlarni tasdiqlash\n` +
        `• 📋 So'rovlarni Ko'rish - Kanal tanlab so'rovlarni ko'rish\n` +
        `• 📢 Xabar Yuborish - Kanal tanlab xabar yuborish\n` +
        `• 📊 Barcha Foydalanuvchilar - Barcha foydalanuvchilarni ko'rish\n` +
        `• 🎯 Faol Foydalanuvchilar - 24 soatlik faol foydalanuvchilar\n` +
        `• 👥 Tasdiqlanganlar - Barcha tasdiqlanganlar`;

    // Create dynamic keyboard based on available channels
    const keyboard = {
        reply_markup: {
            keyboard: [
                ["✅ Hammasini Tasdiqlash", "📋 So'rovlarni Ko'rish"],
                ["📢 Xabar Yuborish", "📊 Barcha Foydalanuvchilar"],
                ["🎯 Faol Foydalanuvchilar", "👥 Tasdiqlanganlar"],
                ["🔄 Yangilash"]
            ],
            resize_keyboard: true
        }
    };

    await bot.sendMessage(chatId, message, { 
        parse_mode: "Markdown",
        ...keyboard 
    });
}

// NEW: Show channel selection
async function showChannelSelection(chatId) {
    if (pendingRequests.size === 0) {
        await bot.sendMessage(chatId, "📭 Hozircha hech qanday kanalda kutayotgan so'rovlar yo'q.", mainAdminKeyboard);
        return;
    }

    await bot.sendMessage(
        chatId,
        `📺 *Kanalni Tanlang:*\n\n` +
        `Quyidagi kanallardan birini tanlang:`,
        {
            parse_mode: "Markdown",
            ...getChannelSelectionKeyboard()
        }
    );
}

// NEW: Select channel for management
async function selectChannel(chatId, adminId, channelId) {
    try {
        const channelRequests = pendingRequests.get(channelId);
        if (!channelRequests || channelRequests.length === 0) {
            await bot.sendMessage(chatId, "❌ Ushbu kanalda so'rovlar topilmadi.", mainAdminKeyboard);
            return;
        }

        adminSelectedChannels.set(adminId, channelId);
        
        await bot.sendMessage(
            chatId,
            `✅ *Kanal Tanlandi:* ${channelId}\n\n` +
            `📊 *Kanal statistikasi:*\n` +
            `• Kutayotgan so'rovlar: ${channelRequests.length}\n\n` +
            `🛠️ Endi siz faqat shu kanal uchun operatsiyalarni bajarishingiz mumkin.`,
            {
                parse_mode: "Markdown",
                reply_markup: {
                    keyboard: [
                        ["✅ Hammasini Tasdiqlash", "📋 So'rovlarni Ko'rish"],
                        ["📢 Xabar Yuborish", "🔙 Asosiy Menyuga"]
                    ],
                    resize_keyboard: true
                }
            }
        );
    } catch (error) {
        console.error("Error selecting channel:", error);
        await bot.sendMessage(chatId, "❌ Kanalni tanlashda xatolik yuz berdi.", mainAdminKeyboard);
    }
}

// NEW: Show pending requests for specific channel
async function showChannelPendingRequests(chatId, channelId) {
    const channelRequests = pendingRequests.get(channelId);
    
    if (!channelRequests || channelRequests.length === 0) {
        await bot.sendMessage(chatId, "📭 Ushbu kanalda kutayotgan so'rovlar yo'q.", mainAdminKeyboard);
        return;
    }

    let message = `📋 *Kanal ${channelId} dagi So'rovlar - Jami: ${channelRequests.length}*\n\n`;
    
    channelRequests.forEach((user, index) => {
        const username = user.username ? `@${user.username}` : 'Username yo\'q';
        const fullName = `${user.first_name}${user.last_name ? ' ' + user.last_name : ''}`;
        
        message += `${index + 1}. ${fullName}\n`;
        message += `   👤 Username: ${username}\n`;
        message += `   🆔 User ID: ${user.id}\n`;
        message += `   ✅ Tasdiqlash: /approve_${user.id}\n\n`;
    });

    const messages = splitMessage(message);
    for (const msg of messages) {
        await bot.sendMessage(chatId, msg, {
            reply_markup: {
                keyboard: [
                    ["✅ Hammasini Tasdiqlash", "📋 So'rovlarni Ko'rish"],
                    ["📢 Xabar Yuborish", "🔙 Asosiy Menyuga"]
                ],
                resize_keyboard: true
            }
        });
    }
}

// MODIFIED: Accept all pending requests for specific channel
async function acceptAllPendingRequests(adminChatId, channelId) {
    const channelRequests = pendingRequests.get(channelId);
    
    if (!channelRequests || channelRequests.length === 0) {
        await bot.sendMessage(adminChatId, "📭 Ushbu kanalda kutayotgan so'rovlar yo'q.", mainAdminKeyboard);
        return;
    }

    console.log(`✅ Accept All called for channel ${channelId}`);
    
    let totalApproved = 0;
    let errors = 0;

    // Create a copy to avoid modification during iteration
    const requestsCopy = [...channelRequests];
    
    for (const user of requestsCopy) {
        try {
            console.log(`Approving user ${user.id} for chat ${channelId}`);
            await bot.approveChatJoinRequest(channelId, user.id);
            
            approvedUsers.set(user.id, {
                ...user,
                approvedAt: new Date().toISOString(),
                channelId: channelId
            });

            // Track approved users
            addOrUpdateUser(user.id, user.username || '', user.first_name || '', user.last_name || '');
            
            console.log(`✅ Approved and stored: ${user.first_name} (ID: ${user.id})`);
            
            // Send welcome message
            try {
                await bot.sendMessage(
                    user.id,
                    `Salom, ${user.first_name}! 👋\n\n` +
                    `Sizning kanalga qo'shilish so'rovingiz tasdiqlandi ✅\n\n` +
                    `Xush kelibsiz! 🎉`
                );
            } catch (sendError) {
                console.log(`Cannot send message to user ${user.id}: ${sendError.message}`);
            }
            
            totalApproved++;
            
            // Remove from pending requests
            const currentIndex = channelRequests.findIndex(u => u.id === user.id);
            if (currentIndex !== -1) {
                channelRequests.splice(currentIndex, 1);
            }
            
            await new Promise(resolve => setTimeout(resolve, 100));
            
        } catch (err) {
            console.error(`❌ Error approving ${user.username || user.id}:`, err.message);
            errors++;
        }
    }

    // Clean up empty channel
    if (channelRequests.length === 0) {
        pendingRequests.delete(channelId);
    }

    await bot.sendMessage(
        adminChatId,
        `✅ *Kanal ${channelId} dagi Barcha So'rovlar Tasdiqlandi*\n\n` +
        `✅ Tasdiqlandi: ${totalApproved} foydalanuvchi\n` +
        `❌ Xatolar: ${errors}\n` +
        `📭 Kanaldagi kutayotgan so'rovlar tozalandi.`,
        { 
            parse_mode: "Markdown",
            ...mainAdminKeyboard
        }
    );
}

// MODIFIED: Approve single user for specific channel
async function approveSingleUser(userId, adminChatId, channelId) {
    const channelRequests = pendingRequests.get(channelId);
    
    if (!channelRequests) {
        await bot.sendMessage(adminChatId, "❌ Ushbu kanalda so'rovlar topilmadi.", mainAdminKeyboard);
        return;
    }

    const userIndex = channelRequests.findIndex(user => user.id === userId);
    if (userIndex === -1) {
        await bot.sendMessage(adminChatId, "❌ Foydalanuvchi ushbu kanalning kutayotgan so'rovlari ro'yxatida topilmadi.", mainAdminKeyboard);
        return;
    }

    const user = channelRequests[userIndex];
    
    try {
        await bot.approveChatJoinRequest(channelId, user.id);
        
        approvedUsers.set(user.id, {
            ...user,
            approvedAt: new Date().toISOString(),
            channelId: channelId
        });

        addOrUpdateUser(user.id, user.username || '', user.first_name || '', user.last_name || '');
        
        console.log(`✅ Approved single user: ${user.first_name} (ID: ${user.id})`);
        
        // Send welcome message
        try {
            await bot.sendMessage(
                user.id,
                `Salom, ${user.first_name}! 👋\n\n` +
                `Sizning kanalga qo'shilish so'rovingiz tasdiqlandi ✅\n\n` +
                `Xush kelibsiz! 🎉`
            );
        } catch (sendError) {
            console.log(`Cannot send message to user ${user.id}: ${sendError.message}`);
        }
        
        // Remove from pending requests
        channelRequests.splice(userIndex, 1);
        if (channelRequests.length === 0) {
            pendingRequests.delete(channelId);
        }
        
        await bot.sendMessage(
            adminChatId, 
            `✅ Tasdiqlandi: ${user.first_name}\n` +
            `📺 Kanal: ${channelId}\n` +
            `🆔 User ID: ${user.id}`,
            mainAdminKeyboard
        );
        
    } catch (err) {
        console.error(`❌ Error approving user ${userId}:`, err);
        await bot.sendMessage(
            adminChatId, 
            `❌ Foydalanuvchini tasdiqlashda xatolik: ${err.message}`, 
            mainAdminKeyboard
        );
    }
}

// NEW: Channel-specific broadcast
async function startChannelBroadcastMode(chatId, adminId, channelId) {
    // Get approved users for this specific channel
    const channelApprovedUsers = Array.from(approvedUsers.entries())
        .filter(([userId, userData]) => userData.channelId === channelId);
    
    if (channelApprovedUsers.length === 0) {
        await bot.sendMessage(chatId, "❌ Ushbu kanalda tasdiqlangan foydalanuvchilar yo'q.", mainAdminKeyboard);
        return;
    }

    broadcastStates.set(adminId, { 
        waitingForMessage: true,
        channelId: channelId,
        targetUsers: channelApprovedUsers.map(([userId]) => userId)
    });
    
    await bot.sendMessage(
        chatId,
        `📢 *Kanal ${channelId} ga Xabar Tarqatish*\n\n` +
        `Iltimos, ${channelApprovedUsers.length} tasdiqlangan foydalanuvchilarga yubormoqchi bo'lgan xabaringizni kiriting.\n\n` +
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

// MODIFIED: Handle broadcast message for specific channel
async function handleBroadcastMessage(adminId, message, adminChatId) {
    const broadcastState = broadcastStates.get(adminId);
    if (!broadcastState) return;
    
    broadcastStates.delete(adminId);

    if (message === '/cancel') {
        await bot.sendMessage(adminChatId, "❌ Xabar tarqatish bekor qilindi.", mainAdminKeyboard);
        return;
    }

    const targetUsers = broadcastState.targetUsers || [];
    if (targetUsers.length === 0) {
        await bot.sendMessage(adminChatId, "❌ Xabar yuborish uchun foydalanuvchilar yo'q.", mainAdminKeyboard);
        return;
    }

    const broadcastMsg = await bot.sendMessage(
        adminChatId,
        `📢 *Kanal ${broadcastState.channelId} ga Xabar Tarqatish Boshlandi...*\n\n` +
        `${targetUsers.length} foydalanuvchiga yuborilmoqda...\n` +
        `⏳ Iltimos, kuting...`,
        { parse_mode: "Markdown" }
    );

    let successCount = 0;
    let failCount = 0;
    let current = 0;

    for (const userId of targetUsers) {
        current++;
        
        try {
            await bot.sendMessage(userId, message);
            successCount++;
            
            if (current % 10 === 0 || current === targetUsers.length) {
                await bot.editMessageText(
                    `📢 *Kanal ${broadcastState.channelId} ga Xabar Tarqatilmoqda...*\n\n` +
                    `${targetUsers.length} foydalanuvchiga yuborilmoqda...\n` +
                    `✅ Muvaffaqiyatli: ${successCount}\n` +
                    `❌ Xatolar: ${failCount}\n` +
                    `⏳ Jarayon: ${current}/${targetUsers.length} (${Math.round((current / targetUsers.length) * 100)}%)`,
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
        `📢 *Kanal ${broadcastState.channelId} ga Xabar Tarqatish Yakunlandi!*\n\n` +
        `✅ Muvaffaqiyatli yuborildi: ${successCount} foydalanuvchi\n` +
        `❌ Xatolar: ${failCount} foydalanuvchi\n` +
        `📊 Jami: ${targetUsers.length} foydalanuvchi\n\n` +
        `*Yuborilgan xabar:*\n${message.substring(0, 100)}${message.length > 100 ? '...' : ''}`,
        {
            chat_id: adminChatId,
            message_id: broadcastMsg.message_id,
            parse_mode: "Markdown",
            ...mainAdminKeyboard
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
            ...mainAdminKeyboard
        });
        await bot.answerCallbackQuery(callbackQuery.id);
    }
});

// Keep all other existing functions (showActiveUsers, showAllTrackedUsers, showApprovedUsers, etc.)
// ... (include all your existing functions like showActiveUsers, showAllTrackedUsers, 
// showApprovedUsers, splitMessage, notifyAdminsAboutNewRequest, etc.)

async function showActiveUsers(chatId) {
    const activeUsers = getActiveUsers();
    
    if (activeUsers.length === 0) {
        await bot.sendMessage(chatId, "📭 So'ngi 24 soatda faol foydalanuvchilar yo'q.", mainAdminKeyboard);
        return;
    }

    try {
        let message = `🎯 Faol Foydalanuvchilar (So'ngi 24 soat) - Jami: ${activeUsers.length}\n\n`;
        
        activeUsers.forEach((user, index) => {
            const username = user.username ? `@${user.username}` : 'Username yo\'q';
            const fullName = `${user.firstName}${user.lastName ? ' ' + user.lastName : ''}`;
            const lastSeen = user.lastSeen.toLocaleString();
            
            message += `${index + 1}. ${fullName}\n`;
            message += `   👤 Username: ${username}\n`;
            message += `   🆔 User ID: ${user.userId}\n`;
            message += `   🔄 Startlar: ${user.startCount}\n`;
            message += `   ⏰ So'ngi faollik: ${lastSeen}\n\n`;
        });

        const messages = splitMessage(message);
        for (const msg of messages) {
            await bot.sendMessage(chatId, msg, mainAdminKeyboard);
        }
    } catch (error) {
        console.error("Error showing active users:", error);
        await bot.sendMessage(chatId, "❌ Faol foydalanuvchilarni ko'rsatishda xatolik.", mainAdminKeyboard);
    }
}

async function showAllTrackedUsers(chatId) {
    const allUsers = getAllTrackedUsers();
    
    if (allUsers.length === 0) {
        await bot.sendMessage(chatId, "📭 Tizimda foydalanuvchilar topilmadi.", mainAdminKeyboard);
        return;
    }

    try {
        let message = `📊 Barcha Foydalanuvchilar - Jami: ${allUsers.length}\n\n`;
        
        allUsers.forEach((user, index) => {
            const username = user.username ? `@${user.username}` : 'Username yo\'q';
            const fullName = `${user.firstName}${user.lastName ? ' ' + user.lastName : ''}`;
            const lastSeen = user.lastSeen.toLocaleString();
            const firstSeen = user.firstSeen.toLocaleString();
            
            message += `${index + 1}. ${fullName}\n`;
            message += `   👤 Username: ${username}\n`;
            message += `   🆔 User ID: ${user.userId}\n`;
            message += `   🔄 Startlar: ${user.startCount}\n`;
            message += `   📅 Birinchi ko'rinish: ${firstSeen}\n`;
            message += `   ⏰ So'ngi faollik: ${lastSeen}\n\n`;
        });

        const messages = splitMessage(message);
        for (const msg of messages) {
            await bot.sendMessage(chatId, msg, mainAdminKeyboard);
        }
    } catch (error) {
        console.error("Error showing all users:", error);
        await bot.sendMessage(chatId, "❌ Foydalanuvchilarni ko'rsatishda xatolik: " + error.message, mainAdminKeyboard);
    }
}

async function showApprovedUsers(chatId) {
    if (approvedUsers.size === 0) {
        await bot.sendMessage(chatId, "✅ Hali tasdiqlangan foydalanuvchilar yo'q.", mainAdminKeyboard);
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
            if (userData.channelId) {
                message += `   📺 Kanal: ${userData.channelId}\n`;
            }
            message += `\n`;
            count++;
        }

        const messages = splitMessage(message);
        for (const msg of messages) {
            await bot.sendMessage(chatId, msg, mainAdminKeyboard);
        }
    } catch (error) {
        console.error("Error showing approved users:", error);
        await bot.sendMessage(chatId, "❌ Tasdiqlangan foydalanuvchilarni ko'rsatishda xatolik: " + error.message, mainAdminKeyboard);
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

// Notify admins about new request
function notifyAdminsAboutNewRequest(user, chat) {
    const message = `🔔 *Yangi Kanal So'rovi*\n\n` +
                   `Foydalanuvchi: ${user.first_name} ${user.username ? `(@${user.username})` : ''}\n` +
                   `User ID: ${user.id}\n` +
                   `Kanal: ${chat.title}\n` +
                   `Kanal ID: ${chat.id}\n` +
                   `Vaqt: ${new Date().toLocaleString()}\n\n` +
                   `Kanalni boshqarish uchun /admin buyrug'idan foydalaning`;

    ADMINS.forEach(adminId => {
        bot.sendMessage(adminId, message, { parse_mode: "Markdown", ...mainAdminKeyboard })
            .catch(err => console.error("Error notifying admin:", err));
    });
}

console.log("🤖 Bot foydalanuvchilarni kuzatish va ko'p kanalli boshqaruv funksiyasi bilan ishga tushdi...");