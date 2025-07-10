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

        const feed = await parser.parseURL(process.env.PODCAST_RSS_URL);
        const cache = loadCache();
        const lastCheck = new Date(cache.lastPodcastCheck);
        
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

        console.log('🕷️ Scraping Patreon with modern techniques...');

        const response = await fetch('https://www.patreon.com/lowlimitcashgames', {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.5',
                'Accept-Encoding': 'gzip, deflate, br',
                'DNT': '1',
                'Connection': 'keep-alive',
                'Upgrade-Insecure-Requests': '1'
            }
        });
        
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        
        const html = await response.text();
        const cache = loadCache();
        
        console.log('🔍 Analyzing page for Next.js data structures...');
        
        // Method 1: Look for __NEXT_DATA__ (Next.js hydration data)
        const nextDataMatch = html.match(/<script id="__NEXT_DATA__"[^>]*>(.*?)<\/script>/s);
        if (nextDataMatch) {
            console.log('📊 Found __NEXT_DATA__ - extracting post data...');
            try {
                const nextData = JSON.parse(nextDataMatch[1]);
                const posts = await extractPostsFromNextData(nextData, channel, cache);
                if (posts.length > 0) {
                    console.log(`✅ Successfully found ${posts.length} posts from Next.js data`);
                    return;
                }
            } catch (parseError) {
                console.log(`⚠️ Failed to parse __NEXT_DATA__: ${parseError.message}`);
            }
        }
        
        // Method 2: Look for self.__next_f.push() calls (App Router)
        const nextFMatches = html.match(/self\.__next_f\.push\(\[(.*?)\]\)/gs);
        if (nextFMatches && nextFMatches.length > 0) {
            console.log(`📊 Found ${nextFMatches.length} App Router data chunks - scanning...`);
            
            for (let i = 0; i < Math.min(nextFMatches.length, 20); i++) {
                try {
                    const match = nextFMatches[i];
                    const jsonMatch = match.match(/self\.__next_f\.push\(\[.*?"(.*?)"\]\)/s);
                    if (jsonMatch && jsonMatch[1]) {
                        const unescapedJson = jsonMatch[1]
                            .replace(/\\"/g, '"')
                            .replace(/\\n/g, '\n')
                            .replace(/\\r/g, '\r')
                            .replace(/\\t/g, '\t')
                            .replace(/\\\\/g, '\\');
                        
                        const posts = await extractPostsFromJsonChunk(unescapedJson, channel, cache);
                        if (posts.length > 0) {
                            console.log(`✅ Found ${posts.length} posts in App Router chunk ${i + 1}`);
                            return;
                        }
                    }
                } catch (parseError) {
                    continue;
                }
            }
        }
        
        // Method 3: Enhanced HTML pattern matching
        console.log('🔍 Trying enhanced HTML pattern extraction...');
        await enhancedHtmlExtraction(html, channel, cache);
        
    } catch (error) {
        console.error('❌ Error scraping Patreon page:', error.message);
    }
}

async function extractPostsFromNextData(nextData, channel, cache) {
    console.log('🔍 Scanning Next.js data for posts...');
    
    try {
        const searchPaths = [
            nextData.props?.pageProps?.bootstrap?.campaign?.included,
            nextData.props?.pageProps?.bootstrap?.posts,
            nextData.props?.pageProps?.data?.posts,
            nextData.props?.pageProps?.campaign?.posts,
            nextData.props?.pageProps?.included,
            nextData.props?.pageProps?.bootstrap?.data,
            nextData.props?.pageProps?.initialReduxState?.posts,
            nextData.props?.pageProps?.apolloState
        ];
        
        for (const dataPath of searchPaths) {
            if (Array.isArray(dataPath)) {
                console.log(`📝 Checking array with ${dataPath.length} items...`);
                
                const posts = dataPath.filter(item => 
                    item?.type === 'post' || 
                    item?.attributes?.title ||
                    item?.data?.attributes?.title ||
                    (item?.id && item?.attributes)
                );
                
                if (posts.length > 0) {
                    console.log(`🎯 Found ${posts.length} posts in Next.js data!`);
                    
                    for (const post of posts.slice(0, 10)) {
                        await processFoundPost(post, channel, cache);
                    }
                    
                    return posts;
                }
            } else if (dataPath && typeof dataPath === 'object') {
                const postKeys = Object.keys(dataPath).filter(key => 
                    key.includes('post') || key.includes('Post')
                );
                
                if (postKeys.length > 0) {
                    console.log(`📝 Found post-related keys: ${postKeys.join(', ')}`);
                    for (const key of postKeys.slice(0, 5)) {
                        const postData = dataPath[key];
                        if (postData && typeof postData === 'object') {
                            await processFoundPost(postData, channel, cache);
                        }
                    }
                }
            }
        }
        
        console.log('⚠️ No posts found in Next.js data structure');
        return [];
        
    } catch (error) {
        console.error('❌ Error extracting from Next.js data:', error.message);
        return [];
    }
}

async function extractPostsFromJsonChunk(jsonChunk, channel, cache) {
    try {
        const postIndicators = [
            /"type":"post"/,
            /"title":"[^"]+"/,
            /posts\/\d+/,
            /"url":"\/posts\/[^"]+"/,
            /"post_id":/,
            /"patreon\.com\/posts\//
        ];
        
        const hasPostData = postIndicators.some(pattern => pattern.test(jsonChunk));
        
        if (hasPostData) {
            console.log('🎯 Found post indicators in JSON chunk...');
            
            const urlMatches = jsonChunk.match(/"url":"\/posts\/([^"]+)"/g) || [];
            const titleMatches = jsonChunk.match(/"title":"([^"]+)"/g) || [];
            const postIdMatches = jsonChunk.match(/posts\/(\d+)/g) || [];
            
            const allMatches = [...urlMatches, ...postIdMatches];
            
            if (allMatches.length > 0) {
                console.log(`📝 Extracting ${allMatches.length} potential posts...`);
                
                for (let i = 0; i < Math.min(allMatches.length, 10); i++) {
                    let postSlug = null;
                    let title = 'Low Limit Cash Games Episode';
                    
                    if (urlMatches[i]) {
                        const urlMatch = urlMatches[i].match(/"url":"\/posts\/([^"]+)"/);
                        if (urlMatch) postSlug = urlMatch[1];
                    } else if (postIdMatches[i]) {
                        const idMatch = postIdMatches[i].match(/posts\/(\d+)/);
                        if (idMatch) postSlug = idMatch[1];
                    }
                    
                    if (titleMatches[i]) {
                        const titleMatch = titleMatches[i].match(/"title":"([^"]+)"/);
                        if (titleMatch) {
                            title = titleMatch[1]
                                .replace(/\\u[\da-f]{4}/gi, '')
                                .replace(/\\\//g, '/')
                                .replace(/\\"/g, '"');
                        }
                    }
                    
                    if (postSlug) {
                        await processFoundPost({
                            id: postSlug,
                            attributes: { title: title },
                            url: `/posts/${postSlug}`
                        }, channel, cache);
                    }
                }
                
                return allMatches;
            }
        }
        
        return [];
        
    } catch (error) {
        console.error('❌ Error extracting from JSON chunk:', error.message);
        return [];
    }
}

async function enhancedHtmlExtraction(html, channel, cache) {
    console.log('🔍 Enhanced HTML pattern matching...');
    
    const patterns = [
        /href="\/posts\/([a-zA-Z0-9\-_]+)"/g,
        /\/posts\/([0-9]+)/g,
        /data-post-id="([^"]+)"/g,
        /post-(\d+)/g,
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
    
    console.log(`📄 HTML extraction found ${foundSlugs.size} unique post identifiers`);
    
    if (foundSlugs.size > 0) {
        const slugArray = Array.from(foundSlugs).slice(0, 10);
        
        for (const slug of slugArray) {
            await processFoundPost({
                id: slug,
                attributes: { title: 'Low Limit Cash Games Episode' },
                url: `/posts/${slug}`
            }, channel, cache);
        }
        
        return Array.from(foundSlugs);
    }
    
    console.log('❌ No post identifiers found in HTML');
    return [];
}

async function processFoundPost(post, channel, cache) {
    try {
        const postId = post.id || post.attributes?.post_id || post.attributes?.id || 'unknown';
        const title = post.attributes?.title || post.data?.attributes?.title || 'Low Limit Cash Games Episode';
        const postSlug = post.url?.replace('/posts/', '') || postId;
        
        const patreonPostUrl = `https://www.patreon.com/posts/${postSlug}`;
        const episodeId = `patreon_${postSlug}`;
        
        console.log(`📝 Processing: "${title}" (${postSlug})`);
        
        if (!cache.seenEpisodes.includes(episodeId) && title.length > 3) {
            console.log(`🆕 Creating thread for new episode: ${title}`);
            
            await createEpisodeThread(channel, title, patreonPostUrl);
            console.log(`✅ Created thread: ${title}`);
            console.log(`🔗 Link: ${patreonPostUrl}`);
            
            cache.seenEpisodes.push(episodeId);
            
            if (cache.seenEpisodes.length > 50) {
                cache.seenEpisodes = cache.seenEpisodes.slice(-50);
            }
            
            cache.lastPatreonCheck = new Date().toISOString();
            saveCache(cache);
        } else if (cache.seenEpisodes.includes(episodeId)) {
            console.log(`✅ Already seen: ${title}`);
        }
        
    } catch (error) {
        console.error('❌ Error processing post:', error.message);
    }
}

async function checkContent() {
    console.log('🔍 Checking for new content...');
    console.log('📡 Checking RSS for free episodes...');
    await checkPublicRSS();
    console.log('🕷️ Scraping Patreon for paid episodes...');
    await scrapePatreonPage();
    console.log('✅ Content check completed');
}

client.once('ready', async () => {
    console.log(`🤖 Bot logged in as ${client.user.tag}!`);
    
    const channel = client.channels.cache.get(process.env.CHANNEL_ID);
    if (channel) {
        await channel.send('🚀 **Low Limit Cash Games bot is online!**\n🎧 Monitoring for new episodes with improved scraping\n📝 Type `!help` for commands');
    }
    
    cron.schedule('*/15 * * * *', checkContent);
    
    setTimeout(() => {
        console.log('🚀 Starting initial content check...');
        checkContent();
    }, 5000);
});

client.on('messageCreate', async (message) => {
    if (message.author.bot) return;
    
    console.log(`📝 Message: "${message.content}" in ${message.channel.name}`);
    
    if (message.content === '!test-format') {
        const testTitle = 'Test Episode: Advanced Cash Game Strategy';
        const testUrl = 'https://www.patreon.com/posts/test-12345';
        
        try {
            await createEpisodeThread(message.channel, testTitle, testUrl);
            await message.reply('✅ Test thread created - check format!');
        } catch (error) {
            await message.reply(`❌ Test failed: ${error.message}`);
        }
    }
    
    if (message.content === '!test-patreon') {
        await message.reply('🕷️ Testing Patreon scraping...');
        try {
            const originalChannelId = process.env.CHANNEL_ID;
            process.env.CHANNEL_ID = message.channel.id;
            
            await scrapePatreonPage();
            
            process.env.CHANNEL_ID = originalChannelId;
            await message.reply('✅ Patreon test completed - check logs');
        } catch (error) {
            await message.reply(`❌ Test failed: ${error.message}`);
        }
    }
    
    if (message.content === '!test-rss') {
        await message.reply('🔍 Testing RSS feed...');
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
    
    if (message.content === '!test-both') {
        await message.reply('🔍 Testing full content check...');
        try {
            const originalChannelId = process.env.CHANNEL_ID;
            process.env.CHANNEL_ID = message.channel.id;
            
            await checkContent();
            
            process.env.CHANNEL_ID = originalChannelId;
            await message.reply('✅ Full test completed');
        } catch (error) {
            await message.reply(`❌ Test failed: ${error.message}`);
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
            await message.reply('🗑️ Cache cleared');
        } catch (error) {
            await message.reply(`❌ Cache clear failed: ${error.message}`);
        }
    }
    
    if (message.content === '!status') {
        const cache = loadCache();
        await message.reply({
            embeds: [{
                title: 'Bot Status',
                fields: [
                    {
                        name: '📡 Last RSS Check',
                        value: new Date(cache.lastPodcastCheck).toLocaleString(),
                        inline: true
                    },
                    {
                        name: '🕷️ Last Patreon Check', 
                        value: new Date(cache.lastPatreonCheck).toLocaleString(),
                        inline: true
                    },
                    {
                        name: '📚 Episodes Tracked',
                        value: `${cache.seenEpisodes.length} episodes`,
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
                title: '🤖 Low Limit Cash Games Bot',
                description: 'Commands for testing and management:',
                fields: [
                    {
                        name: '!test-format',
                        value: 'Create test thread with proper formatting',
                        inline: false
                    },
                    {
                        name: '!test-patreon',
                        value: 'Test Patreon scraping (safe - current channel)', 
                        inline: false
                    },
                    {
                        name: '!test-rss',
                        value: 'Test RSS feed parsing',
                        inline: false
                    },
                    {
                        name: '!test-both',
                        value: 'Run complete content check',
                        inline: false
                    },
                    {
                        name: '!post Title Here URL',
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
                        value: 'Show bot status and stats',
                        inline: false
                    }
                ],
                color: 0x1DB954
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
