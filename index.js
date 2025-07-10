import { Client, GatewayIntentBits } from ‘discord.js’;
import Parser from ‘rss-parser’;
import cron from ‘node-cron’;
import fs from ‘fs’;
import dotenv from ‘dotenv’;
import fetch from ‘node-fetch’;

dotenv.config();

const client = new Client({
intents: [
GatewayIntentBits.Guilds,
GatewayIntentBits.GuildMessages,
GatewayIntentBits.MessageContent
]
});

const parser = new Parser();
const CACHE_FILE = ‘last_checked.json’;

function loadCache() {
if (fs.existsSync(CACHE_FILE)) {
return JSON.parse(fs.readFileSync(CACHE_FILE, ‘utf8’));
}
return {
lastPodcastCheck: new Date().toISOString(),
lastPatreonCheck: new Date().toISOString(),
seenEpisodes: [] // Track episodes we’ve already posted
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
reason: ‘New poker episode discussion’
});

```
// Minimal message: just title and link
const message = `**${title}**\n\n${patreonPostUrl}`;

await thread.send(message);
return thread;
```

}

async function checkPublicRSS() {
try {
const channel = client.channels.cache.get(process.env.CHANNEL_ID);
if (!channel) return;

```
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
```

}

async function scrapePatreonPage() {
try {
const channel = client.channels.cache.get(process.env.CHANNEL_ID);
if (!channel) return;

```
    console.log('🕷️ Scraping Brett\'s Patreon page with updated patterns...');

    // Scrape Brett's public Patreon page
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
    
    console.log('🔍 Modern Patreon scraping - looking for Next.js data structures...');
    
    // Method 1: Look for __NEXT_DATA__ (Next.js hydration data)
    const nextDataMatch = html.match(/<script id="__NEXT_DATA__"[^>]*>(.*?)<\/script>/s);
    if (nextDataMatch) {
        console.log('📊 Found __NEXT_DATA__ - parsing Next.js hydration data...');
        try {
            const nextData = JSON.parse(nextDataMatch[1]);
            const posts = await extractPostsFromNextData(nextData, channel, cache);
            if (posts.length > 0) {
                console.log(`✅ Successfully extracted ${posts.length} posts from __NEXT_DATA__`);
                return;
            }
        } catch (parseError) {
            console.log(`⚠️  Failed to parse __NEXT_DATA__: ${parseError.message}`);
        }
    }
    
    // Method 2: Look for self.__next_f.push() calls (newer Next.js App Router)
    const nextFMatches = html.match(/self\.__next_f\.push\(\[(.*?)\]\)/gs);
    if (nextFMatches && nextFMatches.length > 0) {
        console.log(`📊 Found ${nextFMatches.length} self.__next_f.push() calls - parsing App Router data...`);
        
        for (let i = 0; i < nextFMatches.length; i++) {
            try {
                const match = nextFMatches[i];
                // Extract the JSON content inside the push call
                const jsonMatch = match.match(/self\.__next_f\.push\(\[.*?"(.*?)"\]\)/s);
                if (jsonMatch && jsonMatch[1]) {
                    // Unescape the JSON string
                    const unescapedJson = jsonMatch[1]
                        .replace(/\\"/g, '"')
                        .replace(/\\n/g, '\n')
                        .replace(/\\r/g, '\r')
                        .replace(/\\t/g, '\t')
                        .replace(/\\\\/g, '\\');
                    
                    // Look for post data in this chunk
                    const posts = await extractPostsFromJsonChunk(unescapedJson, channel, cache);
                    if (posts.length > 0) {
                        console.log(`✅ Successfully extracted ${posts.length} posts from App Router data chunk ${i + 1}`);
                        return;
                    }
                }
            } catch (parseError) {
                console.log(`⚠️  Failed to parse App Router chunk ${i + 1}: ${parseError.message}`);
                continue;
            }
        }
    }
    
    // Method 3: Enhanced fallback HTML scraping
    console.log('🔍 Falling back to enhanced HTML pattern matching...');
    await fallbackHtmlScraping(html, channel, cache);
    
} catch (error) {
    console.error('❌ Error scraping Patreon page:', error.message);
}
```

}

// Extract posts from Next.js **NEXT_DATA**
async function extractPostsFromNextData(nextData, channel, cache) {
console.log(‘🔍 Searching for posts in Next.js data structure…’);

```
try {
    // Common paths where post data might be found
    const possiblePaths = [
        nextData.props?.pageProps?.bootstrap?.campaign?.included,
        nextData.props?.pageProps?.bootstrap?.posts,
        nextData.props?.pageProps?.data?.posts,
        nextData.props?.pageProps?.campaign?.posts,
        nextData.props?.pageProps?.included
    ];
    
    for (const dataPath of possiblePaths) {
        if (Array.isArray(dataPath)) {
            console.log(`📝 Found array with ${dataPath.length} items, checking for posts...`);
            
            const posts = dataPath.filter(item => 
                item?.type === 'post' || 
                item?.attributes?.title ||
                item?.data?.attributes?.title
            );
            
            if (posts.length > 0) {
                console.log(`🎯 Found ${posts.length} posts in Next.js data!`);
                
                for (const post of posts.slice(0, 10)) { // Limit to prevent spam
                    await processFoundPost(post, channel, cache);
                }
                
                return posts;
            }
        }
    }
    
    console.log('⚠️  No posts found in __NEXT_DATA__ structure');
    return [];
    
} catch (error) {
    console.error('❌ Error extracting from Next.js data:', error.message);
    return [];
}
```

}

// Extract posts from JSON chunks in App Router calls
async function extractPostsFromJsonChunk(jsonChunk, channel, cache) {
try {
// Look for post-like objects in the JSON chunk
const postPatterns = [
/“type”:“post”/g,
/“title”:”[^”]+”/g,
/posts/\d+/g,
/“url”:”/posts/[^”]+”/g
];

```
    let foundPosts = [];
    
    // Check if this chunk contains post data
    const hasPostData = postPatterns.some(pattern => pattern.test(jsonChunk));
    
    if (hasPostData) {
        console.log('🎯 Found post data in JSON chunk, extracting...');
        
        // Try to extract post URLs and titles
        const urlMatches = jsonChunk.match(/"url":"\/posts\/([^"]+)"/g);
        const titleMatches = jsonChunk.match(/"title":"([^"]+)"/g);
        
        if (urlMatches && titleMatches) {
            const maxItems = Math.min(urlMatches.length, titleMatches.length, 10);
            
            for (let i = 0; i < maxItems; i++) {
                const urlMatch = urlMatches[i].match(/"url":"\/posts\/([^"]+)"/);
                const titleMatch = titleMatches[i].match(/"title":"([^"]+)"/);
                
                if (urlMatch && titleMatch) {
                    const postSlug = urlMatch[1];
                    const title = titleMatch[1].replace(/\\u[\da-f]{4}/gi, ''); // Remove unicode escapes
                    
                    await processFoundPost({
                        id: postSlug,
                        attributes: { title: title },
                        url: `/posts/${postSlug}`
                    }, channel, cache);
                    
                    foundPosts.push({ postSlug, title });
                }
            }
        }
    }
    
    return foundPosts;
    
} catch (error) {
    console.error('❌ Error extracting from JSON chunk:', error.message);
    return [];
}
```

}

// Enhanced fallback HTML scraping
async function fallbackHtmlScraping(html, channel, cache) {
console.log(‘🔍 Enhanced HTML fallback scraping…’);

```
// More comprehensive patterns for 2024/2025 Patreon structure
const enhancedPatterns = [
    // API endpoint patterns
    /api\/posts\/(\d+)/g,
    /\/posts\/([a-zA-Z0-9\-_]+)/g,
    // Data attribute patterns
    /data-post-id="([^"]+)"/g,
    /data-href="\/posts\/([^"]+)"/g,
    // Next.js link patterns
    /href="\/posts\/([^"]+)"/g,
    // JSON-LD structured data
    /"@type":\s*"BlogPosting".*?"url":\s*"[^"]*\/posts\/([^"]+)"/g
];

let allPostSlugs = new Set();

for (const pattern of enhancedPatterns) {
    const matches = [...html.matchAll(pattern)];
    matches.forEach(match => {
        if (match[1] && match[1].length > 3) { // Valid post slug
            allPostSlugs.add(match[1]);
        }
    });
}

console.log(`📄 Enhanced HTML parsing found ${allPostSlugs.size} unique post slugs`);

if (allPostSlugs.size > 0) {
    // Convert to array and process first 10
    const slugArray = Array.from(allPostSlugs).slice(0, 10);
    
    for (const slug of slugArray) {
        await processFoundPost({
            id: slug,
            attributes: { title: `Low Limit Cash Games Episode` },
            url: `/posts/${slug}`
        }, channel, cache);
    }
} else {
    console.log('❌ No post URLs found with enhanced HTML patterns');
}
```

}

// Process a found post (common function)
async function processFoundPost(post, channel, cache) {
try {
const postId = post.id || post.attributes?.post_id || ‘unknown’;
const title = post.attributes?.title || post.data?.attributes?.title || `New Low Limit Cash Games Episode`;
const postSlug = post.url?.replace(’/posts/’, ‘’) || postId;

```
    const patreonPostUrl = `https://www.patreon.com/posts/${postSlug}`;
    const episodeId = `patreon_${postSlug}`;
    
    console.log(`📝 Processing: "${title}" (${postSlug})`);
    
    // Check if this is a new episode we haven't seen
    if (!cache.seenEpisodes.includes(episodeId) && title.length > 5) {
        console.log(`🆕 Creating thread for new episode: ${title}`);
        
        await createEpisodeThread(channel, title, patreonPostUrl);
        console.log(`✅ Created thread for episode: ${title}`);
        console.log(`🔗 Patreon link: ${patreonPostUrl}`);
        
        // Add to seen episodes
        cache.seenEpisodes.push(episodeId);
        
        // Keep only last 50 seen episodes
        if (cache.seenEpisodes.length > 50) {
            cache.seenEpisodes = cache.seenEpisodes.slice(-50);
        }
        
        cache.lastPatreonCheck = new Date().toISOString();
        saveCache(cache);
    } else if (cache.seenEpisodes.includes(episodeId)) {
        console.log(`✅ Already seen: ${title}`);
    } else {
        console.log(`⚠️  Skipping short title: ${title}`);
    }
    
} catch (error) {
    console.error('❌ Error processing found post:', error.message);
}
```

}) continue;

```
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
```

}

async function checkContent() {
console.log(‘🔍 Checking for new content…’);
console.log(‘📡 Checking public RSS for free episodes…’);
await checkPublicRSS();
console.log(‘🕷️ Scraping Patreon page for paid episodes…’);
await scrapePatreonPage();
console.log(‘✅ Content check completed’);
}

client.once(‘ready’, async () => {
console.log(`🤖 Bot logged in as ${client.user.tag}!`);

```
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
```

});

// Test commands and message handling
client.on(‘messageCreate’, async (message) => {
// Ignore bot messages
if (message.author.bot) return;

```
// Log all messages for debugging
console.log(`📝 Message received: "${message.content}" in channel: ${message.channel.name} (${message.channel.id})`);

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
```

});

// Handle graceful shutdown
process.on(‘SIGINT’, () => {
console.log(‘🛑 Bot shutting down…’);
client.destroy();
process.exit(0);
});

client.login(process.env.DISCORD_BOT_TOKEN);