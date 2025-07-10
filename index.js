import { Client, GatewayIntentBits } from 'discord.js';
import Parser from 'rss-parser';
import cron from 'node-cron';
import fs from 'fs';
import dotenv from 'dotenv';
import fetch from 'node-fetch';

dotenv.config();

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

const parser = new Parser();
const CACHE_FILE = 'last_checked.json';

function loadCache() {
    if (fs.existsSync(CACHE_FILE)) {
        return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    }
    return {
        lastPodcastCheck: new Date().toISOString(),
        lastPatreonCheck: new Date().toISOString(),
        seenEpisodes: [] // Track episodes we've already posted
    };
}

function saveCache(cache) {
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
}

async function createEpisodeThread(channel, title, patreonPostUrl) {
    // Create the thread with episode title - NO auto-archive
    const thread = await channel.threads.create({
        name: title,
        autoArchiveDuration: null, // Never auto-archive
        reason: 'New poker episode discussion'
    });

    // Minimal message: just title and link
    const message = `**${title}**\n\n${patreonPostUrl}`;

    await thread.send(message);
    return thread;
}

async function checkPublicRSS() {
    try {
        const channel = client.channels.cache.get(process.env.CHANNEL_ID);
        if (!channel) return;

        const feed = await parser.parseURL(process.env.PODCAST_RSS_URL);
        const cache = loadCache();
        const lastCheck = new Date(cache.lastPodcastCheck);
        
        for (const item of feed.items) {
            const publishDate = new Date(item.pubDate);
            const episodeId = `public_${item.title.replace(/[^\w]/g, '_')}`;
            
            if (publishDate > lastCheck && !cache.seenEpisodes.includes(episodeId)) {
                // For public episodes, create a simple thread (no platform links needed per Brett)
                const thread = await channel.threads.create({
                    name: item.title,
                    autoArchiveDuration: null, // Never auto-archive
                    reason: 'New free poker episode'
                });
                
                await thread.send(`**${item.title}**\n\n🆓 **Free Episode** - Available on all podcast platforms`);
                console.log(`✅ Created thread for FREE episode: ${item.title}`);
                
                // Add to seen episodes
                cache.seenEpisodes.push(episodeId);
            }
        }
        
        cache.lastPodcastCheck = new Date().toISOString();
        saveCache(cache);
    } catch (error) {
        console.error('❌ Error checking podcast RSS:', error.message);
    }
}

async function scrapePatreonPage() {
    try {
        const channel = client.channels.cache.get(process.env.CHANNEL_ID);
        if (!channel) return;

        // Scrape Brett's public Patreon page
        const response = await fetch('https://www.patreon.com/lowlimitcashgames', {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
            }
        });
        
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        
        const html = await response.text();
        const cache = loadCache();
        
        console.log('🔍 Analyzing Patreon page for episodes...');
        
        // Look for post links in multiple possible formats
        const patterns = [
            /href="\/posts\/([^"]+)"/g,
            /\/posts\/([a-zA-Z0-9\-_]+)/g,
            /"url":"\/posts\/([^"]+)"/g
        ];
        
        let allPostMatches = [];
        
        for (const pattern of patterns) {
            const matches = [...html.matchAll(pattern)];
            allPostMatches = allPostMatches.concat(matches);
        }
        
        // Remove duplicates
        const uniquePosts = [...new Set(allPostMatches.map(match => match[1]))];
        
        console.log(`📄 Found ${uniquePosts.length} potential posts`);
        
        // Look for titles in various formats
        const titlePatterns = [
            /data-tag="post-title"[^>]*>([^<]+)/g,
            /"title":"([^"]+)"/g,
            /<h[1-6][^>]*>([^<]*(?:episode|cash|game|poker)[^<]*)<\/h[1-6]>/gi
        ];
        
        let allTitles = [];
        
        for (const pattern of titlePatterns) {
            const matches = [...html.matchAll(pattern)];
            allTitles = allTitles.concat(matches.map(match => match[1]));
        }
        
        console.log(`📝 Found ${allTitles.length} potential titles`);
        
        // Process posts - try to match posts with titles
        for (let i = 0; i < Math.min(uniquePosts.length, allTitles.length, 10); i++) {
            const postSlug = uniquePosts[i];
            const title = allTitles[i]?.trim();
            
            if (!title || title.length < 5) continue;
            
            const patreonPostUrl = `https://www.patreon.com/posts/${postSlug}`;
            const episodeId = `patreon_${postSlug}`;
            
            console.log(`📝 Found: "${title}" (${postSlug})`);
            
            // Check if this is a new episode we haven't seen
            if (!cache.seenEpisodes.includes(episodeId)) {
                console.log(`🆕 Processing new Patreon episode: ${title}`);
                
                await createEpisodeThread(channel, title, patreonPostUrl);
                console.log(`✅ Created thread for PATREON episode: ${title}`);
                console.log(`🔗 Patreon link: ${patreonPostUrl}`);
                
                // Add to seen episodes
                cache.seenEpisodes.push(episodeId);
            } else {
                console.log(`✅ Already seen: ${title}`);
            }
        }
        
        // If HTML parsing failed, try a more aggressive approach
        if (uniquePosts.length === 0) {
            console.log('🔍 HTML parsing failed, trying alternative approach...');
            
            // Look for any URL patterns that might be posts
            const urlMatches = html.match(/patreon\.com\/posts\/[a-zA-Z0-9\-_]+/g);
            if (urlMatches && urlMatches.length > 0) {
                console.log(`📄 Found ${urlMatches.length} post URLs via alternative method`);
                
                // Take first few unique URLs
                const uniqueUrls = [...new Set(urlMatches)].slice(0, 5);
                
                for (const fullUrl of uniqueUrls) {
                    const postSlug = fullUrl.split('/posts/')[1];
                    const episodeId = `patreon_${postSlug}`;
                    
                    if (!cache.seenEpisodes.includes(episodeId)) {
                        // Use a generic title since we can't extract it
                        const title = `New Low Limit Cash Games Episode`;
                        const patreonPostUrl = `https://www.patreon.com/posts/${postSlug}`;
                        
                        await createEpisodeThread(channel, title, patreonPostUrl);
                        console.log(`✅ Created thread for episode: ${patreonPostUrl}`);
                        
                        cache.seenEpisodes.push(episodeId);
                    }
                }
            } else {
                console.log('❌ No post URLs found via any method');
            }
        }
        
        // Keep only last 50 seen episodes
        if (cache.seenEpisodes.length > 50) {
            cache.seenEpisodes = cache.seenEpisodes.slice(-50);
        }
        
        cache.lastPatreonCheck = new Date().toISOString();
        saveCache(cache);
        
    } catch (error) {
        console.error('❌ Error scraping Patreon page:', error.message);
    }
}

async function checkContent() {
    console.log('🔍 Checking for new content...');
    console.log('📡 Checking public RSS for free episodes...');
    await checkPublicRSS();
    console.log('🕷️ Scraping Patreon page for paid episodes...');
    await scrapePatreonPage();
    console.log('✅ Content check completed');
}

client.once('ready', async () => {
    console.log(`🤖 Bot logged in as ${client.user.tag}!`);
    
    // Send startup message
    const channel = client.channels.cache.get(process.env.CHANNEL_ID);
    if (channel) {
        await channel.send('🚀 **Low Limit Cash Games bot is online!**\n🎧 Now monitoring for new episodes - Patreon links only for paid content\n📝 Type `!help` for test commands');
    }
    
    // Schedule checks every 15 minutes
    cron.schedule('*/15 * * * *', checkContent);
    
    // Initial check after 5 seconds
    setTimeout(() => {
        console.log('🚀 Starting initial content check...');
        checkContent();
    }, 5000);
});

// Test commands and message handling
client.on('messageCreate', async (message) => {
    // Ignore bot messages
    if (message.author.bot) return;
    
    // Respond in any channel the bot is in (for testing)
    
    if (message.content === '!test-format') {
        const testTitle = "Test Episode: Advanced Cash Game Strategy";
        const testUrl = "https://www.patreon.com/posts/test-12345";
        
        try {
            await createEpisodeThread(message.channel, testTitle, testUrl);
            await message.reply('✅ Test thread created - check the format!');
        } catch (error) {
            await message.reply(`❌ Test failed: ${error.message}`);
        }
    }
    
    if (message.content === '!test-patreon') {
        await message.reply('🕷️ Testing Patreon scraping...');
        try {
            // For testing, we'll use the current channel instead of production channel
            const originalChannelId = process.env.CHANNEL_ID;
            process.env.CHANNEL_ID = message.channel.id; // Temporarily use test channel
            
            await scrapePatreonPage();
            
            process.env.CHANNEL_ID = originalChannelId; // Restore original
            await message.reply('✅ Patreon scrape completed - check logs for details');
        } catch (error) {
            await message.reply(`❌ Patreon test failed: ${error.message}`);
        }
    }
    
    if (message.content === '!test-rss') {
        await message.reply('🔍 Testing RSS feed...');
        try {
            // For testing, we'll use the current channel instead of production channel
            const originalChannelId = process.env.CHANNEL_ID;
            process.env.CHANNEL_ID = message.channel.id; // Temporarily use test channel
            
            await checkPublicRSS();
            
            process.env.CHANNEL_ID = originalChannelId; // Restore original
            await message.reply('✅ RSS check completed - check logs for details');
        } catch (error) {
            await message.reply(`❌ RSS test failed: ${error.message}`);
        }
    }
    
    if (message.content === '!test-both') {
        await message.reply('🔍 Testing full content check...');
        try {
            // For testing, we'll use the current channel instead of production channel
            const originalChannelId = process.env.CHANNEL_ID;
            process.env.CHANNEL_ID = message.channel.id; // Temporarily use test channel
            
            await checkContent();
            
            process.env.CHANNEL_ID = originalChannelId; // Restore original
            await message.reply('✅ Full content check completed');
        } catch (error) {
            await message.reply(`❌ Content check failed: ${error.message}`);
        }
    }
    
    if (message.content === '!clear-cache') {
        try {
            const cache = {
                lastPodcastCheck: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
                lastPatreonCheck: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
                seenEpisodes: []
            };
            saveCache(cache);
            await message.reply('🗑️ Cache cleared - will check for new episodes');
        } catch (error) {
            await message.reply(`❌ Cache clear failed: ${error.message}`);
        }
    }
    
    if (message.content === '!status') {
        const cache = loadCache();
        await message.reply({
            embeds: [{
                title: "Bot Status",
                fields: [
                    {
                        name: "📡 Last RSS Check",
                        value: new Date(cache.lastPodcastCheck).toLocaleString(),
                        inline: true
                    },
                    {
                        name: "🕷️ Last Patreon Check", 
                        value: new Date(cache.lastPatreonCheck).toLocaleString(),
                        inline: true
                    },
                    {
                        name: "📚 Seen Episodes",
                        value: `${cache.seenEpisodes.length} episodes tracked`,
                        inline: true
                    },
                    {
                        name: "🎯 Production Channel",
                        value: `<#${process.env.CHANNEL_ID}>`,
                        inline: true
                    }
                ],
                color: 0x0099ff,
                timestamp: new Date().toISOString()
            }]
        });
    }
    
    if (message.content === '!post' || message.content.startsWith('!post ')) {
        const parts = message.content.split(' ');
        if (parts.length >= 3) {
            const title = parts.slice(1, -1).join(' ');
            const url = parts[parts.length - 1];
            
            try {
                await createEpisodeThread(message.channel, title, url);
                await message.reply('✅ Episode posted manually');
            } catch (error) {
                await message.reply(`❌ Manual post failed: ${error.message}`);
            }
        } else {
            await message.reply('❌ Usage: `!post Episode Title Here https://patreon.com/posts/12345`');
        }
    }
    
    if (message.content === '!help') {
        await message.reply({
            embeds: [{
                title: "🤖 Bot Commands",
                description: "Test commands for the Low Limit Cash Games bot:",
                fields: [
                    {
                        name: "!test-format",
                        value: "Create a test thread to check formatting",
                        inline: false
                    },
                    {
                        name: "!test-patreon",
                        value: "Test Patreon scraping (safe - uses current channel)", 
                        inline: false
                    },
                    {
                        name: "!test-rss",
                        value: "Test RSS feed (safe - uses current channel)",
                        inline: false
                    },
                    {
                        name: "!test-both",
                        value: "Run full content check (safe - uses current channel)",
                        inline: false
                    },
                    {
                        name: "!post Title Here URL",
                        value: "Manually post an episode",
                        inline: false
                    },
                    {
                        name: "!clear-cache",
                        value: "Clear episode cache",
                        inline: false
                    },
                    {
                        name: "!status",
                        value: "Show bot status",
                        inline: false
                    }
                ],
                color: 0xffaa00
            }]
        });
    }
});

// Handle graceful shutdown
process.on('SIGINT', () => {
    console.log('🛑 Bot shutting down...');
    client.destroy();
    process.exit(0);
});

client.login(process.env.DISCORD_BOT_TOKEN);
