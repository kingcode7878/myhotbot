require('dotenv').config(); 
const { Telegraf } = require('telegraf');
const { MongoClient } = require('mongodb');
const express = require('express');

// 1. CONFIGURATION
const BOT_TOKEN = process.env.BOT_TOKEN;
const MONGO_URI = process.env.MONGO_URI;
const APP_URL = process.env.APP_URL;
const PORT = process.env.PORT || 3000;

const ADMIN_IDS = process.env.ADMIN_IDS ? process.env.ADMIN_IDS.split(',').map(id => parseInt(id.trim())) : [];

const bot = new Telegraf(BOT_TOKEN);
const client = new MongoClient(MONGO_URI, { 
    connectTimeoutMS: 60000, 
    socketTimeoutMS: 60000,
    maxIdleTimeMS: 120000,
    maxPoolSize: 10
});
const app = express();

let usersCollection;
let broadcastLogsCollection;
let settingsCollection;
let isBroadcasting = false; 

const isAdmin = (id) => ADMIN_IDS.includes(id);

// 2. KEEP RENDER ALIVE & HEALTH ENDPOINT
app.get('/', (req, res) => res.send('Afro Bot is Online!'));

// Health check endpoint for Cron-Job.org
app.get('/health', (req, res) => {
    console.log("💓 [KEEP-ALIVE] Ping received at " + new Date().toISOString());
    res.status(200).send('OK');
});

app.listen(PORT, () => console.log(`✅ [SERVER] Web Server active on port ${PORT}`));

// 3. CONNECT TO DATABASE
async function connectDB() {
    console.log("🔄 [DATABASE] Attempting connection...");
    try {
        await client.connect();
        const database = client.db('afro_leaks_db');
        usersCollection = database.collection('users');
        broadcastLogsCollection = database.collection('broadcast_logs');
        settingsCollection = database.collection('settings');
        console.log("✅ [DATABASE] Connection successful.");
    } catch (e) {
        console.error("❌ [DATABASE ERROR]:", e);
        setTimeout(connectDB, 5000);
    }
}

// 4. USER REGISTRATION
bot.start(async (ctx) => {
    const userId = ctx.chat.id;
    console.log(`👤 [ACTIVITY] /start triggered by ${userId} (${ctx.from.username || 'no-username'})`);
    try {
        const updateResult = await usersCollection.updateOne(
            { chat_id: userId },
            { $set: { username: ctx.from.username || "anonymous", first_name: ctx.from.first_name || "User", last_active: new Date() } },
            { upsert: true }
        );
        console.log(`💾 [DATABASE] User ${userId} updated/inserted. UpsertedId: ${updateResult.upsertedId || 'Existing'}`);

        const welcomeData = await settingsCollection.findOne({ key: "welcome_config" });
        await ctx.reply(welcomeData?.text || `Welcome ${ctx.from.first_name}!`, {
            reply_markup: { inline_keyboard: [[{ text: welcomeData?.button || "WATCH HOT LEAKS 🔞", web_app: { url: APP_URL } }]] }
        });
    } catch (err) {
        console.error(`❌ [USER ERROR] Start failed for ${userId}:`, err.message);
    }
});

// 5. ADMIN COMMANDS
bot.command('admin', (ctx) => {
    if (!isAdmin(ctx.from.id)) {
        console.warn(`🚫 [SECURITY] Unauthorized /admin access attempt by ${ctx.from.id}`);
        return;
    }
    console.log(`🔑 [ADMIN] Panel accessed by ${ctx.from.id}`);
    ctx.reply("🛠 **Admin Panel**", {
        reply_markup: {
            inline_keyboard: [
                [{ text: "📊 View Stats", callback_data: "admin_stats" }],
                [{ text: "👁 Preview Info", callback_data: "admin_help" }],
                [{ text: "🔄 Refresh System", callback_data: "admin_refresh" }]
            ]
        }
    });
});

bot.action('admin_stats', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    try {
        const total = await usersCollection.countDocuments();
        console.log(`📊 [ACTIVITY] Stats requested. Total users: ${total}`);
        await ctx.answerCbQuery();
        await ctx.reply(`📊 Total Users: ${total}`);
    } catch (e) { console.error("❌ [STATS ERROR]:", e.message); }
});

bot.action('admin_help', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    await ctx.answerCbQuery();
    await ctx.reply("📢 /setwelcome | /preview | /send");
});

bot.action('admin_refresh', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    console.log(`🔄 [ACTIVITY] Refresh clicked. Broadcasting: ${isBroadcasting}`);
    await ctx.answerCbQuery();
    ctx.reply(isBroadcasting ? "⚠️ BROADCAST RUNNING" : "✅ SYSTEM READY");
});

bot.command('setwelcome', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    const input = ctx.message.text.split(' ').slice(1).join(' ');
    if (!input.includes('|')) return ctx.reply("Format: Text | Button");
    const [text, button] = input.split('|').map(s => s.trim());
    try {
        await settingsCollection.updateOne({ key: "welcome_config" }, { $set: { text, button } }, { upsert: true });
        console.log(`📝 [ADMIN] Welcome message updated by ${ctx.from.id}`);
        ctx.reply("✅ Welcome updated.");
    } catch (e) { console.error("❌ [DB ERROR] setwelcome:", e.message); }
});

bot.command('preview', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    console.log(`👁 [ACTIVITY] Preview generated by ${ctx.from.id}`);
    const fullInput = ctx.message.text.split(' ').slice(1).join(' ');
    const [content, btnLabel] = fullInput.split('|').map(s => s.trim());
    const extra = btnLabel ? { reply_markup: { inline_keyboard: [[{ text: btnLabel, web_app: { url: APP_URL } }]] } } : {};
    const args = content.split(' ');
    const isUrl = args[0].startsWith('http');
    try {
        if (isUrl) {
            if (args[0].match(/\.(mp4|mov|avi)$/i)) await ctx.replyWithVideo(args[0], { caption: args.slice(1).join(' '), ...extra });
            else await ctx.replyWithPhoto(args[0], { caption: args.slice(1).join(' '), ...extra });
        } else { await ctx.reply(content, extra); }
    } catch (e) { console.error(`❌ [PREVIEW ERROR]:`, e.message); ctx.reply(`Error: ${e.message}`); }
});

// 6. REPAIRED BROADCAST ENGINE WITH MAXIMUM LOGGING
bot.command('send', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    if (isBroadcasting) return ctx.reply("⚠️ Already broadcasting!");

    const fullInput = ctx.message.text.split(' ').slice(1).join(' ');
    if (!fullInput.includes('|')) return ctx.reply("Format: Content | Button");

    const [content, btnLabel] = fullInput.split('|').map(s => s.trim());
    const extra = btnLabel ? { reply_markup: { inline_keyboard: [[{ text: btnLabel, web_app: { url: APP_URL } }]] } } : {};
    
    const isUrl = content.split(' ')[0].startsWith('http');
    const media = isUrl ? content.split(' ')[0] : null;
    const cap = isUrl ? content.split(' ').slice(1).join(' ') : content;

    const totalUsers = await usersCollection.countDocuments();
    isBroadcasting = true;
    console.log(`🚀 [BROADCAST START] Initiated by ${ctx.from.id}. Target: ${totalUsers} users.`);
    ctx.reply(`🚀 Broadcasting to ${totalUsers} users...`);

    (async () => {
        let successCount = 0;
        let errorCount = 0;
        const cursor = usersCollection.find({});

        try {
            while (await cursor.hasNext()) {
                const user = await cursor.next();
                console.log(`📡 [ATTEMPT] Sending to ${user.chat_id}...`);

                try {
                    let sent;
                    if (isUrl) {
                        if (media.match(/\.(mp4|mov|avi)$/i)) sent = await bot.telegram.sendVideo(user.chat_id, media, { caption: cap, ...extra });
                        else sent = await bot.telegram.sendPhoto(user.chat_id, media, { caption: cap, ...extra });
                    } else {
                        sent = await bot.telegram.sendMessage(user.chat_id, cap, extra);
                    }
                    
                    successCount++;
                    console.log(`✅ [SUCCESS] ${successCount}/${totalUsers} sent to ${user.chat_id}`);
                    
                    broadcastLogsCollection.insertOne({ chat_id: user.chat_id, message_id: sent.message_id, sent_at: new Date() })
                        .catch((e) => console.error(`⚠️ [LOG ERROR] Failed to log success for ${user.chat_id}:`, e.message));

                } catch (err) {
                    errorCount++;
                    console.error(`❌ [SEND ERROR] User ${user.chat_id}: ${err.message}`);
                    if (err.response?.error_code === 403) {
                        console.log(`🗑 [DATABASE] Removing blocked user ${user.chat_id}`);
                        await usersCollection.deleteOne({ chat_id: user.chat_id }).catch((e) => console.error(`⚠️ [DB ERROR] Deletion failed:`, e.message));
                    }
                }

                if ((successCount + errorCount) % 150 === 0 && (successCount + errorCount) > 0) {
                    console.log(`⏳ [PAUSE] 150 batch limit reached. Sleeping 30s for Telegram flood protection...`);
                    await new Promise(r => setTimeout(r, 30000));
                    console.log(`▶️ [RESUME] Batch pause finished.`);
                }
                
                await new Promise(r => setTimeout(r, 200));
            }
        } catch (fatal) {
            console.error(`🔴 [FATAL ERROR] Broadcast loop crashed:`, fatal);
        } finally {
            isBroadcasting = false;
            console.log(`✅ [BROADCAST FINISHED] Success: ${successCount}, Errors: ${errorCount}, Total: ${totalUsers}`);
            bot.telegram.sendMessage(ctx.from.id, `✅ Broadcast Done.\nSuccess: ${successCount}\nErrors: ${errorCount}`).catch(()=>{});
        }
    })();
});

// 7. STARTUP & GLOBAL CATCH
connectDB().then(() => {
    bot.launch({ dropPendingUpdates: true });
    console.log("🚀 [SYSTEM] Bot is live and listening for updates.");
});

process.on('unhandledRejection', (e) => console.error('🔴 [REJECTION]:', e));
process.on('uncaughtException', (e) => console.error('🔴 [EXCEPTION]:', e));