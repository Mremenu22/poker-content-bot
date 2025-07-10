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
const SESSION_FILE = 'patreon_session.json';

class PatreonAPIClient {
    constructor() {
        this.sessionData = this.loadSession();
        this.campaignId = null; // Will be discovered automatically
    }

    async discoverCampaignId() {
        if (this.campaignId) return this.campaignId;
        
        try {
            console.log('🔍 Discovering campaign ID...');
            
            // Method 1: Extract from page HTML
            const response = await fetch('https://www.patreon.com/lowlimitcashgames');
            const html = await response.text();
            
            const patterns = [
                /"campaign_id":"(\d+)"/,
                /"campaign":{"id":"(\d+)"/,
                /campaign_id=(\d+)/,
                /campaigns\/(\d+)/
            ];
            
            for (const pattern of patterns) {
                const match = html.match(pattern);
                if (match) {
                    this.campaignId = match[1];
                    console.log('✅ Discovered campaign ID:', this.campaignId);
                    return this.campaignId;
                }
            }
            
            console.log('⚠️ Could not auto-discover campaign ID');
            return null;
            
        } catch (error) {
            console.error('❌ Campaign ID discovery failed:', error.message);
            return null;
        }
    }

    loadSession() {
        if (fs.existsSync(SESSION_FILE)) {
            const data = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
            // Check if session is less than 6 hours old
            if (Date.now() - data.timestamp < 6 * 60 * 60 * 1000) {
                return data;
            }
        }
        return null;
    }

    saveSession(cookies, csrfToken = null) {
        const sessionData = {
            cookies: cookies,
            csrfToken: csrfToken,
            timestamp: Date.now()
        };
        fs.writeFileSync(SESSION_FILE, JSON.stringify(sessionData, null, 2));
        this.sessionData = sessionData;
    }

    async getPatreonPosts() {
        try {
            // Always discover campaign ID first
            await this.discoverCampaignId();
            
            if (!this.campaignId) {
                console.log('❌ No campaign ID available - skipping API methods');
                return null;
            }

            // Method 1: Try posts endpoint
            let posts = await this.tryPostsAPI();
            if (posts && posts.length > 0) {
                console.log('✅ Posts API method successful');
                return posts;
            }

            // Method 2: Try campaign endpoint  
            posts = await this.tryCampaignAPI();
            if (posts && posts.length > 0) {
                console.log('✅ Campaign API method successful');
                return posts;
            }

            // Method 3: Try stream endpoint (doesn't need campaign ID)
            posts = await this.tryStreamAPI();
            if (posts && posts.length > 0) {
                console.log('✅ Stream API method successful');
                return posts;
            }

            console.log('⚠️ All API methods failed');
            return null;

        } catch (error) {
            console.error('❌ API client error:', error.message);
            return null;
        }
    }

    async tryPostsAPI() {
        const headers = this.getHeaders();
        
        try {
            const response = await fetch(`https://www.patreon.com/api/posts?filter[campaign_id]=${this.campaignId}&sort=-published_at&page[count]=10&include=campaign,user`, {
                headers: headers,
                timeout: 10000
            });

            if (response.ok) {
                const data = await response.json();
                return this.parseAPIResponse(data);
            }
            
            if (response.status === 403) {
                console.log('🔄 Posts API session expired');
            }
            
        } catch (error) {
            console.log('⚠️ Posts API failed:', error.message);
        }
        
        return null;
    }

    async tryCampaignAPI() {
        const headers = this.getHeaders();
        
        try {
            const response = await fetch(`https://www.patreon.com/api/campaigns/${this.campaignId}?include=posts&fields[post]=title,published_at,post_type,url`, {
                headers: headers,
                timeout: 10000
            });

            if (response.ok) {
                const data = await response.json();
                if (data.included) {
                    return this.parseIncludedPosts(data.included);
                }
            }
            
        } catch (error) {
            console.log('⚠️ Campaign API failed:', error.message);
        }
        
        return null;
    }

    async tryStreamAPI() {
        const headers = this.getHeaders();
        
        try {
            const response = await fetch('https://www.patreon.com/api/stream?filter[is_following]=true&sort=-published_at&page[count]=10&include=user,campaign', {
                headers: headers,
                timeout: 10000
            });

            if (response.ok) {
                const data = await response.json();
                return this.parseAPIResponse(data);
            }
            
        } catch (error) {
            console.log('⚠️ Stream API failed:', error.message);
        }
        
        return null;
    }

    getHeaders() {
        const baseHeaders = {
            'Accept': 'application/vnd.api+json',
            'Accept-Language': 'en-US,en;q=0.9',
            'Accept-Encoding': 'gzip, deflate, br',
            'Cache-Control': 'no-cache',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Referer': 'https://www.patreon.com/lowlimitcashgames',
            'Sec-Fetch-Dest': 'empty',
            'Sec-Fetch-Mode': 'cors',
            'Sec-Fetch-Site': 'same-origin'
        };

        if (this.sessionData?.cookies) {
            baseHeaders['Cookie'] = this.sessionData.cookies;
        }

        return baseHeaders;
    }

    parseAPIResponse(data) {
        if (!data.data || !Array.isArray(data.data)) {
            return [];
        }

        return data.data
            .filter(post => post.type === 'post')
            .map(post => ({
                id: post.id,
                title: post.attributes?.title || 'New Episode',
                publishedAt: post.attributes?.published_at,
                url: `https://www.patreon.com/posts/${post.id}`,
                type: post.attributes?.post_type
            }))
            .filter(post => 
                // Filter for likely episode content
                post.title && (
                    post.title.toLowerCase().includes('episode') ||
                    post.title.toLowerCase().includes('poker') ||
                    post.title.toLowerCase().includes('cash') ||
                    post.type === 'audio_file' ||
                    post.type === 'video_file'
                )
            );
    }

    parseIncludedPosts(included) {
        return included
            .filter(item => item.type === 'post')
            .map(post => ({
                id: post.id,
                title: post.attributes?.title || 'New Episode',
                publishedAt: post.attributes?.published_at,
                url: `https://www.patreon.com/posts/${post.id}`,
                type: post.attributes?.post_type
            }))
            .filter(post => 
                post.title && (
                    post.title.toLowerCase().includes('episode') ||
                    post.title.toLowerCase().includes('poker')
                )
            );
    }
}

// Initialize API client
const patreonAPI = new PatreonAPIClient();

function loadCache() {
    if (fs.existsSync(CACHE_FILE)) {
        return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    }
    return {
        lastPodcastCheck: new Date().toISOString(),
        lastPatreonCheck: new Date().toISOString(),
        seenEpisodes: []
    };
}

function saveCache(cache) {
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
}

async function createEpisodeThread(channel, title, patreonPostUrl) {
    const thread = await channel.threads.create({
        name: title,
        autoArchiveDuration: null,
        reason: 'New poker episode discussion'
    });
    const message = `**${title}**\n\n${patreonPostUrl}`;
    await thread.send(message);
    return thread;
}

async function checkPublicRSS() {
    try {
        const channel = client.channels.cache.get(process.env.CHANNEL_ID);
        if (!channel) return;

        console.log('📡 Checking RSS for free episodes...');
        const feed = await parser.parseURL(process.env.PODCAST_RSS_URL);
        const cache = loadCache();
        const lastCheck = new Date(cache.lastPodcastCheck);
        
        let newEpisodes = 0;
        for (const item of feed.items) {
            const publishDate = new Date(item.pubDate);
            const episodeId = `public_${item.title.replace(/[^\w]/g, '_')}`;
            
            if (publishDate > lastCheck && !cache.seenEpisodes.includes(episodeId)) {
                const thread = await channel.threads.create({
                    name: item.title,
                    autoArchiveDuration: null,
                    reason: 'New free poker episode'
                });
                
                await thread.send(`**${item.title}**\n\n🆓 **Free Episode** - Available on all podcast platforms`);
                console.log(`✅ Created thread for FREE episode: ${item.title}`);
                cache.seenEpisodes.push(episodeId);
                newEpisodes++;
            }
        }
        
        if (newEpisodes === 0) {
            console.log('📝 No new free episodes found');
        }
        
        cache.lastPodcastCheck = new Date().toISOString();
        saveCache(cache);
    } catch (error) {
        console.error('❌ Error checking podcast RSS:', error.message);
    }
}

async function checkPatreonAPI() {
    try {
        const channel = client.channels.cache.get(process.env.CHANNEL_ID);
        if (!channel) return;

        console.log('🔍 Checking Patreon via API...');

        // Try API methods first
        let posts = await patreonAPI.getPatreonPosts();

        if (!posts || posts.length === 0) {
            console.log('⚠️ API methods failed, trying enhanced scraping...');
            posts = await fallbackScraping();
        }

        if (posts && posts.length > 0) {
            const cache = loadCache();
            let newEpisodes = 0;

            for (const post of posts) {
                const episodeId = `patreon_${post.id}`;
                
                if (!cache.seenEpisodes.includes(episodeId)) {
                    await createEpisodeThread(channel, post.title, post.url);
                    cache.seenEpisodes.push(episodeId);
                    newEpisodes++;
                    console.log(`✅ Created thread for PAID episode: ${post.title}`);
                    
                    // Rate limiting
                    await new Promise(resolve => setTimeout(resolve, 1000));
                }
            }

            if (newEpisodes === 0) {
                console.log('📝 No new paid episodes found');
            }

            // Clean up cache
            if (cache.seenEpisodes.length > 50) {
                cache.seenEpisodes = cache.seenEpisodes.slice(-50);
            }

            cache.lastPatreonCheck = new Date().toISOString();
            saveCache(cache);
        } else {
            console.log('❌ No posts found with any method');
        }

    } catch (error) {
        console.error('❌ Error checking Patreon API:', error.message);
    }
}

async function fallbackScraping() {
    try {
        console.log('🕷️ Fallback scraping with enhanced headers...');

        const response = await fetch('https://www.patreon.com/lowlimitcashgames', {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.5',
                'Accept-Encoding': 'gzip, deflate, br',
                'DNT': '1',
                'Connection': 'keep-alive',
                'Upgrade-Insecure-Requests': '1',
                'Sec-Fetch-Dest': 'document',
                'Sec-Fetch-Mode': 'navigate',
                'Sec-Fetch-Site': 'none'
            },
            timeout: 15000
        });
        
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        
        const html = await response.text();
        
        // Enhanced pattern matching for posts
        const patterns = [
            /href="\/posts\/([a-zA-Z0-9\-_]+)"/g,
            /\/posts\/([0-9]+)/g,
            /"url":"\/posts\/([^"]+)"/g,
            /patreon\.com\/posts\/([a-zA-Z0-9\-_]+)/g
        ];
        
        const foundSlugs = new Set();
        
        for (const pattern of patterns) {
            const matches = [...html.matchAll(pattern)];
            matches.forEach(match => {
                if (match[1] && match[1].length > 2) {
                    foundSlugs.add(match[1]);
                }
            });
        }
        
        console.log(`📄 Fallback scraping found ${foundSlugs.size} potential posts`);
        
        if (foundSlugs.size > 0) {
            return Array.from(foundSlugs).slice(0, 10).map(slug => ({
                id: slug,
                title: 'Low Limit Cash Games Episode',
                url: `https://www.patreon.com/posts/${slug}`
            }));
        }
        
        return [];
        
    } catch (error) {
        console.error('❌ Fallback scraping failed:', error.message);
        return [];
    }
}

async function checkContent() {
    console.log('🔍 Checking for new content...');
    console.log(`📊 Using campaign ID: ${patreonAPI.campaignId || 'Not discovered yet'}`);
    
    // Check RSS first (faster)
    await checkPublicRSS();
    
    // Then check Patreon API/scraping
    await checkPatreonAPI();
    
    console.log('✅ Content check completed');
}

client.once('ready', async () => {
    console.log(`🤖 Bot logged in as ${client.user.tag}!`);
    
    // Discover campaign ID on startup
    const campaignId = await patreonAPI.discoverCampaignId();
    
    // Only send startup message in test channels, not production
    const channel = client.channels.cache.get(process.env.CHANNEL_ID);
    const isTestChannel = channel && (
        channel.name.toLowerCase().includes('test') || 
        channel.name.toLowerCase().includes('bot') ||
        process.env.NODE_ENV === 'development'
    );
    
    if (channel && isTestChannel) {
        await channel.send(`🚀 **Enhanced Low Limit Cash Games Bot Online!**\n⚡ Campaign ID: ${campaignId || 'Not Found'}\n📝 Type \`!help\` for commands`);
    }
    
    // Log startup info to console (always visible in Railway logs)
    console.log('🚀 Enhanced Low Limit Cash Games Bot is online!');
    console.log(`📊 Campaign ID: ${campaignId || 'Not Found'}`);
    console.log('🎧 Monitoring for new episodes with improved scraping');
    console.log('📝 API-first approach with intelligent fallbacks');
    console.log('⏰ Checking every 8 minutes');
    
    // Check every 8 minutes for optimal balance
    cron.schedule('*/8 * * * *', checkContent);
    
    // Initial check after 30 seconds
    setTimeout(() => {
        console.log('🚀 Starting initial content check...');
        checkContent();
    }, 30000);
});

client.on('messageCreate', async (message) => {
    if (message.author.bot) return;
    
    if (message.content === '!find-campaign-id') {
        await message.reply('🔍 Searching for campaign ID...');
        try {
            const campaignId = await patreonAPI.discoverCampaignId();
            if (campaignId) {
                await message.reply(`✅ Found campaign ID: ${campaignId}`);
            } else {
                await message.reply('❌ Could not find campaign ID automatically. Try checking browser dev tools.');
            }
        } catch (error) {
            await message.reply(`❌ Error: ${error.message}`);
        }
    }
    
    if (message.content === '!test-api') {
        await message.reply('🔍 Testing Patreon API methods...');
        try {
            const posts = await patreonAPI.getPatreonPosts();
            if (posts && posts.length > 0) {
                await message.reply(`✅ API working! Found ${posts.length} posts:\n${posts.map(p => `• ${p.title}`).join('\n').slice(0, 1500)}`);
            } else {
                await message.reply('❌ API methods failed - will use fallback scraping');
            }
        } catch (error) {
            await message.reply(`❌ API test failed: ${error.message}`);
        }
    }
    
    if (message.content === '!test-scraping') {
        await message.reply('🕷️ Testing fallback scraping...');
        try {
            const posts = await fallbackScraping();
            if (posts && posts.length > 0) {
                await message.reply(`✅ Scraping found ${posts.length} potential posts`);
            } else {
                await message.reply('❌ Scraping found no posts');
            }
        } catch (error) {
            await message.reply(`❌ Scraping test failed: ${error.message}`);
        }
    }
    
    if (message.content === '!test-rss') {
        await message.reply('📡 Testing RSS feed...');
        try {
            const originalChannelId = process.env.CHANNEL_ID;
            process.env.CHANNEL_ID = message.channel.id;
            
            await checkPublicRSS();
            
            process.env.CHANNEL_ID = originalChannelId;
            await message.reply('✅ RSS test completed');
        } catch (error) {
            await message.reply(`❌ RSS test failed: ${error.message}`);
        }
    }
    
    if (message.content === '!force-check') {
        await message.reply('🔍 Force checking all content sources...');
        try {
            const originalChannelId = process.env.CHANNEL_ID;
            process.env.CHANNEL_ID = message.channel.id;
            
            await checkContent();
            
            process.env.CHANNEL_ID = originalChannelId;
            await message.reply('✅ Force check completed');
        } catch (error) {
            await message.reply(`❌ Force check failed: ${error.message}`);
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
            await message.reply('🗑️ Cache cleared - will re-detect recent episodes');
        } catch (error) {
            await message.reply(`❌ Cache clear failed: ${error.message}`);
        }
    }
    
    if (message.content === '!status') {
        const cache = loadCache();
        const campaignId = patreonAPI.campaignId || 'Not Found';
        
        await message.reply({
            embeds: [{
                title: 'Enhanced Bot Status',
                fields: [
                    {
                        name: '📡 Last RSS Check',
                        value: new Date(cache.lastPodcastCheck).toLocaleString(),
                        inline: true
                    },
                    {
                        name: '🔍 Last Patreon Check',
                        value: new Date(cache.lastPatreonCheck).toLocaleString(),
                        inline: true
                    },
                    {
                        name: '📚 Episodes Tracked',
                        value: `${cache.seenEpisodes.length} episodes`,
                        inline: true
                    },
                    {
                        name: '🆔 Campaign ID',
                        value: campaignId,
                        inline: true
                    },
                    {
                        name: '⚡ Check Frequency',
                        value: 'Every 8 minutes',
                        inline: true
                    },
                    {
                        name: '🛠️ Methods',
                        value: 'API → Scraping → RSS',
                        inline: true
                    }
                ],
                color: 0x0099ff,
                timestamp: new Date().toISOString()
            }]
        });
    }
    
    if (message.content.startsWith('!post ')) {
        const parts = message.content.split(' ');
        if (parts.length >= 3) {
            const title = parts.slice(1, -1).join(' ');
            const url = parts[parts.length - 1];
            
            try {
                await createEpisodeThread(message.channel, title, url);
                await message.reply('✅ Episode posted manually');
            } catch (error) {
                await message.reply(`❌ Failed: ${error.message}`);
            }
        } else {
            await message.reply('❌ Usage: `!post Episode Title Here https://patreon.com/posts/12345`');
        }
    }
    
    if (message.content === '!help') {
        await message.reply({
            embeds: [{
                title: '🤖 Enhanced Low Limit Cash Games Bot',
                description: 'Advanced automation with multiple detection methods:',
                fields: [
                    {
                        name: '!test-api',
                        value: 'Test Patreon API methods',
                        inline: false
                    },
                    {
                        name: '!test-scraping',
                        value: 'Test fallback scraping method',
                        inline: false
                    },
                    {
                        name: '!test-rss',
                        value: 'Test RSS feed for free episodes',
                        inline: false
                    },
                    {
                        name: '!force-check',
                        value: 'Run immediate content check',
                        inline: false
                    },
                    {
                        name: '!post Title URL',
                        value: 'Manually post episode',
                        inline: false
                    },
                    {
                        name: '!clear-cache',
                        value: 'Reset episode tracking',
                        inline: false
                    },
                    {
                        name: '!status',
                        value: 'Show detailed bot status',
                        inline: false
                    }
                ],
                color: 0x1DB954,
                footer: {
                    text: 'Checks every 8 minutes • API-first approach'
                }
            }]
        });
    }
});

process.on('SIGINT', () => {
    console.log('🛑 Bot shutting down...');
    client.destroy();
    process.exit(0);
});

client.login(process.env.DISCORD_BOT_TOKEN);
