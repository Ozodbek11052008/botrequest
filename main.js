const TelegramBot = require("node-telegram-bot-api");

const token = "8318189443:AAHdp7AcIxwgIbYR0HOueTZ3lzUBX4slW8Q";
const bot = new TelegramBot(token, { 
    polling: true,
    // Add polling options for better stability
    polling: {
        interval: 300,
        autoStart: true,
        params: {
            timeout: 10
        }
    }
});

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

// NEW: User tracking functions with error handling
function addOrUpdateUser(userId, username, firstName, lastName) {
    try {
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
    } catch (error) {
        console.error('❌ Error in addOrUpdateUser:', error.message);
    }
}

function getActiveUsers() {
    try {
        const now = new Date();
        const twentyFourHoursAgo = new Date(now - 24 * 60 * 60 * 1000);
        
        return Array.from(users.values())
            .filter(user => user.lastSeen >= twentyFourHoursAgo)
            .sort((a, b) => b.lastSeen - a.lastSeen);
    } catch (error) {
        console.error('❌ Error in getActiveUsers:', error.message);
        return [];
    }
}

function getAllTrackedUsers() {
    try {
        return Array.from(users.values()).sort((a, b) => 
            b.lastSeen - a.lastSeen
        );
    } catch (error) {
        console.error('❌ Error in getAllTrackedUsers:', error.message);
        return [];
    }
}

function getUserStats() {
    try {
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
    } catch (error) {
        console.error('❌ Error in getUserStats:', error.message);
        return {
            totalUsers: 0,
            totalStarts: 0,
            activeUsers: 0,
            newToday: 0,
            uptime: '0h 0m'
        };
    }
}

// When someone submits a join request with error handling
bot.on("chat_join_request", async (msg) => {
    try {
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
    } catch (error) {
        console.error('❌ Error in chat_join_request handler:', error.message);
    }
});

// Handle messages with comprehensive error handling
bot.on("message", async (msg) => {
    try {
        const chatId = msg.chat.id;
        const text = msg.text;
        const user = msg.from;

        if (!user || !text) return;

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

            case "🎯 Faol Foydalanuvchilar":
                await showActiveUsers(chatId);
                break;
            
            default:
                if (text.startsWith("/approve_")) {
                    const userId = parseInt(text.split("_")[1]);
                    if (!isNaN(userId)) {
                        await approveSingleUser(userId, chatId);
                    }
                } else if (text.startsWith("/broadcast_")) {
                    const userId = parseInt(text.split("_")[1]);
                    if (!isNaN(userId)) {
                        await sendUserBroadcast(userId, chatId);
                    }
                } else {
                    await showAdminPanel(chatId);
                }
        }
    } catch (err) {
        console.error("❌ Error handling admin command:", err.message);
        try {
            await bot.sendMessage(msg.chat.id, "❌ Xatolik yuz berdi. Iltimos, qayta urinib ko'ring.", adminKeyboard);
        } catch (sendError) {
            console.error("❌ Even sending error message failed:", sendError.message);
        }
    }
});

// UPDATED: Admin panel with error handling
async function showAdminPanel(chatId) {
    try {
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
    } catch (error) {
        console.error('❌ Error in showAdminPanel:', error.message);
    }
}

// NEW: Function to show active users with error handling
async function showActiveUsers(chatId) {
    try {
        const activeUsers = getActiveUsers();
        
        if (activeUsers.length === 0) {
            await bot.sendMessage(chatId, "📭 So'ngi 24 soatda faol foydalanuvchilar yo'q.", adminKeyboard);
            return;
        }

        let message = `🎯 Faol Foydalanuvchilar (So'ngi 24 soat) - Jami: ${activeUsers.length}\n\n`;
        
        activeUsers.forEach((user, index) => {
            const username = user.username ? `@${user.username}` : 'Username yo\'q';
            const fullName = `${user.firstName}${user.lastName ? ' ' + user.lastName : ''}`;
            const lastSeen = user.lastSeen ? user.lastSeen.toLocaleString() : 'Noma\'lum';
            
            message += `${index + 1}. ${fullName}\n`;
            message += `   👤 Username: ${username}\n`;
            message += `   🆔 User ID: ${user.userId}\n`;
            message += `   🔄 Startlar: ${user.startCount || 1}\n`;
            message += `   ⏰ So'ngi faollik: ${lastSeen}\n`;
            message += `   📨 Xabar yuborish: /broadcast_${user.userId}\n\n`;
        });

        const messages = splitMessage(message);
        for (const msg of messages) {
            await bot.sendMessage(chatId, msg, adminKeyboard);
        }
    } catch (error) {
        console.error('❌ Error in showActiveUsers:', error.message);
        await bot.sendMessage(chatId, "❌ Faol foydalanuvchilarni ko'rsatishda xatolik. Iltimos, qayta urinib ko'ring.", adminKeyboard);
    }
}

// NEW: Function to show ALL tracked users with error handling
async function showAllTrackedUsers(chatId) {
    try {
        const allUsers = getAllTrackedUsers();
        
        if (allUsers.length === 0) {
            await bot.sendMessage(chatId, "📭 Tizimda foydalanuvchilar topilmadi.", adminKeyboard);
            return;
        }

        let message = `📊 Barcha Foydalanuvchilar - Jami: ${allUsers.length}\n\n`;
        
        allUsers.forEach((user, index) => {
            const username = user.username ? `@${user.username}` : 'Username yo\'q';
            const fullName = `${user.firstName}${user.lastName ? ' ' + user.lastName : ''}`;
            const lastSeen = user.lastSeen ? user.lastSeen.toLocaleString() : 'Noma\'lum';
            const firstSeen = user.firstSeen ? user.firstSeen.toLocaleString() : 'Noma\'lum';
            
            message += `${index + 1}. ${fullName}\n`;
            message += `   👤 Username: ${username}\n`;
            message += `   🆔 User ID: ${user.userId}\n`;
            message += `   🔄 Startlar: ${user.startCount || 1}\n`;
            message += `   📅 Birinchi ko'rinish: ${firstSeen}\n`;
            message += `   ⏰ So'ngi faollik: ${lastSeen}\n`;
            message += `   📨 Xabar yuborish: /broadcast_${user.userId}\n\n`;
        });

        const messages = splitMessage(message);
        for (const msg of messages) {
            await bot.sendMessage(chatId, msg, adminKeyboard);
        }
    } catch (error) {
        console.error('❌ Error in showAllTrackedUsers:', error.message);
        await bot.sendMessage(chatId, "❌ Foydalanuvchilarni ko'rsatishda xatolik. Iltimos, qayta urinib ko'ring.", adminKeyboard);
    }
}

// Helper function to split long messages with error handling
function splitMessage(text, maxLength = 4096) {
    try {
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
    } catch (error) {
        console.error('❌ Error in splitMessage:', error.message);
        return [text.substring(0, maxLength)];
    }
}

// Broadcast functions with error handling
async function startBroadcastMode(chatId, adminId) {
    try {
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
    } catch (error) {
        console.error('❌ Error in startBroadcastMode:', error.message);
        broadcastStates.delete(adminId);
    }
}

async function handleBroadcastMessage(adminId, message, adminChatId) {
    try {
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
                    try {
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
                    } catch (editError) {
                        console.error('❌ Error editing broadcast message:', editError.message);
                    }
                }
                
                await new Promise(resolve => setTimeout(resolve, 100));
                
            } catch (error) {
                failCount++;
                console.error(`❌ Failed to send to user ${userId}:`, error.message);
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
    } catch (error) {
        console.error('❌ Error in handleBroadcastMessage:', error.message);
        broadcastStates.delete(adminId);
        try {
            await bot.sendMessage(adminChatId, "❌ Xabar tarqatishda xatolik yuz berdi.", adminKeyboard);
        } catch (sendError) {
            console.error('❌ Even sending error message failed:', sendError.message);
        }
    }
}

// Handle callback queries with error handling
bot.on("callback_query", async (callbackQuery) => {
    try {
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
    } catch (error) {
        console.error('❌ Error in callback_query handler:', error.message);
    }
});

// Global error handlers
bot.on("polling_error", (error) => {
    console.error('❌ Polling error:', error.message);
    // Don't crash, just log the error
});

bot.on("webhook_error", (error) => {
    console.error('❌ Webhook error:', error.message);
    // Don't crash, just log the error
});

bot.on("error", (error) => {
    console.error('❌ General bot error:', error.message);
    // Don't crash, just log the error
});

// Process level error handling
process.on('uncaughtException', (error) => {
    console.error('❌ Uncaught Exception:', error.message);
    console.error('Stack:', error.stack);
    // Don't exit the process
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
    // Don't exit the process
});

console.log("🤖 Bot foydalanuvchilarni kuzatish va faol foydalanuvchilar funksiyasi bilan ishga tushdi...");
console.log("🛡️  Bot hozir xatolarga chidamli. Server qulamasdan ishlaydi.");

// Keep the existing functions (approveSingleUser, acceptAllPendingRequests, etc.) 
// but add similar try-catch blocks to all of them...

// For functions that are not modified above, here's the pattern to add:
async function acceptAllPendingRequests(adminChatId) {
    try {
        // ... existing code with added null checks
        console.log('✅ Accept All called');
        
        let totalApproved = 0;
        let errors = 0;

        const pendingCopy = new Map(pendingRequests);

        for (const [chatId, users] of pendingCopy.entries()) {
            if (!users || !Array.isArray(users)) continue;
            
            for (const user of users) {
                if (!user || !user.id) continue;
                
                try {
                    console.log(`Approving user ${user.id} for chat ${chatId}`);
                    await bot.approveChatJoinRequest(chatId, user.id);
                    
                    approvedUsers.set(user.id, {
                        ...user,
                        approvedAt: new Date().toISOString()
                    });

                    addOrUpdateUser(user.id, user.username || '', user.first_name || '', user.last_name || '');
                    
                    console.log(`✅ Approved and stored: ${user.first_name} (ID: ${user.id})`);
                    
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
                    
                    const currentUsers = pendingRequests.get(chatId);
                    if (currentUsers) {
                        const userIndex = currentUsers.findIndex(u => u && u.id === user.id);
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
    } catch (error) {
        console.error('❌ Error in acceptAllPendingRequests:', error.message);
        try {
            await bot.sendMessage(adminChatId, "❌ So'rovlarni tasdiqlashda xatolik yuz berdi.", adminKeyboard);
        } catch (sendError) {
            console.error('❌ Even sending error message failed:', sendError.message);
        }
    }
}

// Apply similar error handling to all other functions...
// showApprovedUsers, approveSingleUser, notifyAdminsAboutNewRequest, etc.