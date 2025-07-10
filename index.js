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

function getEpisodeLinks(episodeTitle, episodeIds = null, isPatreonOnly = false, patreonPostUrl = null) {
    if (isPatreonOnly && patreonPostUrl) {
        // For Patreon episodes: ONLY provide the Patreon link
        console.log(`🔗 Patreon episode "${episodeTitle}": ${patreonPostUrl}`);
        return {
            patreon: patreonPostUrl,
            type: 'patreon'
        };
    } else {
        // For free episodes: provide Spotify and Apple links
        let appleLink = 'https://podcasts.apple.com/us/podcast/low-limit-cash-games/id1496651303';
        let spotifyLink = 'https://open.spotify.com/show/2ycOlKRTGA9ugMmIIjqjSE';
        
        if (episodeIds) {
            if (episodeIds.apple) {
                appleLink = `https://podcasts.apple.com/us/podcast/low-limit-cash-games/id1496651303?i=${episodeIds.apple}`;
            }
            if (episodeIds.spotify) {
                spotifyLink = `https://open.spotify.com/episode/${episodeIds.spotify}`;
            }
        }
        
        console.log(`🔗 Free episode "${episodeTitle}":`);
        console.log(`   🍎 Apple: ${appleLink}`);
        console.log(`   🎵 Spotify: ${spotifyLink}`);
        
        return {
            apple: appleLink,
            spotify: spotifyLink,
            type: 'free',
            isDirect: !!(episodeIds?.apple || episodeIds?.spotify)
        };
    }
}

async function createEpisodeThread(channel, title, links, isPatreonOnly = false, patreonPostUrl = null) {
    // Create the thread with episode title
    const thread = await channel.threads.create({
        name: title,
        autoArchiveDuration: 1440, // 24 hours
        reason: 'New poker episode discussion'
    });

    let message = `**${title}**\n\n`;
    
    if (isPatreonOnly && links.type === 'patreon') {
        // Patreon exclusive episode - ONLY show Patreon link
        message += `🔒 **Patreon Exclusive**\n`;
        message += `🎧 **Listen Now:** ${links.patreon}\n\n`;
        message += `*Click the link above → "Listen in app" → Spotify*`;
    } else {
        // Free episode - show Spotify and Apple links
        message += `🆓 **Free Episode**\n\n`;
        message += `🍎 **Apple Podcasts**\n${links.apple}\n\n`;
        message += `🎵 **Spotify**\n${links.spotify}`;
    }

    await thread.send(message);
    return thread;
}

async function checkPodcast() {
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
                // For public episodes, get Spotify/Apple links
                const episodeIds = await extractEpisodeIdsFromRSS(item);
                const links = getEpisodeLinks(item.title, episodeIds, false); // false = not Patreon only
                
                await createEpisodeThread(channel, item.title, links, false); // false = not Patreon only
                console.log(`✅ Created thread for FREE episode: ${item.title}`);
                if (links.isDirect) {
                    console.log(`🎯 Using direct episode links`);
                }
                
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
        
        console.log('🔍 Analyzing Patreon page structure...');
        
        // Try to find structured data (JSON-LD or embedded data)
        const jsonMatches = html.match(/<script[^>]*type="application\/json"[^>]*>(.*?)<\/script>/gs);
        const jsonLdMatches = html.match(/<script[^>]*type="application\/ld\+json"[^>]*>(.*?)<\/script>/gs);
        
        if (jsonMatches || jsonLdMatches) {
            console.log('📊 Found structured data, parsing...');
            console.log(`   📄 Found ${(jsonMatches || []).length} JSON scripts`);
            console.log(`   📄 Found ${(jsonLdMatches || []).length} JSON-LD scripts`);
            
            // Try to parse JSON data for episode information
            const allJsonData = [...(jsonMatches || []), ...(jsonLdMatches || [])];
            
            for (let i = 0; i < allJsonData.length; i++) {
                try {
                    const jsonScript = allJsonData[i];
                    const jsonContent = jsonScript.replace(/<script[^>]*>/, '').replace(/<\/script>/, '');
                    const data = JSON.parse(jsonContent);
                    
                    console.log(`   🔍 Parsing JSON block ${i + 1}...`);
                    
                    // Look for episode/post data in various possible structures
                    if (data.props?.pageProps?.bootstrap?.post) {
                        console.log(`   📝 Found single post data`);
                        const post = data.props.pageProps.bootstrap.post;
                        await processPatreonPost(post, channel, cache);
                    } else if (data.props?.pageProps?.bootstrap?.campaign?.posts) {
                        console.log(`   📝 Found campaign posts data`);
                        const posts = data.props.pageProps.bootstrap.campaign.posts;
                        console.log(`   📊 Processing ${posts.length} posts from structured data`);
                        for (const post of posts) {
                            await processPatreonPost(post, channel, cache);
                        }
                    } else if (data['@type'] === 'PodcastEpisode' || data.episodeNumber) {
                        console.log(`   🎧 Found podcast episode structured data`);
                        await processStructuredEpisodeData(data, channel, cache);
                    } else {
                        console.log(`   ⚠️  JSON block ${i + 1} doesn't contain recognizable episode data`);
                        // Log first few keys to help debug structure
                        const keys = Object.keys(data).slice(0, 5);
                        console.log(`   🔑 Available keys: ${keys.join(', ')}`);
                    }
                } catch (parseError) {
                    console.log(`   ❌ Failed to parse JSON block ${i + 1}: ${parseError.message}`);
                    continue;
                }
            }
        }
        
        // Fallback: Look for post links and titles in HTML
        console.log('🔍 Trying HTML fallback parsing...');
        const postLinkMatches = html.match(/href="\/posts\/([^"]+)"/g);
        const titleMatches = html.match(/data-tag="post-title"[^>]*>([^<]+)/g);
        
        console.log(`   📄 Found ${(postLinkMatches || []).length} post links`);
        console.log(`   📝 Found ${(titleMatches || []).length} titles`);
        
        if (postLinkMatches && titleMatches) {
            console.log(`📝 Found ${postLinkMatches.length} posts via HTML parsing`);
            
            for (let i = 0; i < Math.min(postLinkMatches.length, titleMatches.length); i++) {
                const postMatch = postLinkMatches[i];
                const titleMatch = titleMatches[i];
                
                // Extract post slug and title
                const postSlug = postMatch.match(/href="\/posts\/([^"]+)"/)[1];
                const title = titleMatch.replace(/data-tag="post-title"[^>]*>/, '').trim();
                const patreonPostUrl = `https://www.patreon.com/posts/${postSlug}`;
                
                console.log(`   📝 Found post: "${title}" (${postSlug})`);
                
                const episodeId = `patreon_${postSlug}`;
                
                // Check if this is a new episode we haven't seen
                if (title.length > 10 && !cache.seenEpisodes.includes(episodeId)) {
                    console.log(`   🆕 Processing new Patreon episode: ${title}`);
                    
                    // For Patreon episodes, ONLY use Patreon link
                    const links = getEpisodeLinks(title, null, true, patreonPostUrl); // true = Patreon only
                    
                    await createEpisodeThread(channel, title, links, true, patreonPostUrl); // true = Patreon only
                    console.log(`✅ Created thread for PATREON episode: ${title}`);
                    console.log(`🔗 Patreon post: ${patreonPostUrl}`);
                    
                    // Add to seen episodes
                    cache.seenEpisodes.push(episodeId);
                } else if (cache.seenEpisodes.includes(episodeId)) {
                    console.log(`   ✅ Already seen episode: ${title}`);
                } else {
                    console.log(`   ⚠️  Skipping short title: ${title}`);
                }
            }
        } else {
            console.log('   ❌ No post links or titles found in HTML');
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

async function processPatreonPost(post, channel, cache) {
    console.log(`   🔍 Processing post data...`);
    
    if (!post.attributes || !post.attributes.title) {
        console.log(`   ⚠️  Post missing title or attributes`);
        return;
    }
    
    const title = post.attributes.title;
    const postId = post.id;
    const episodeId = `patreon_${postId}`;
    
    console.log(`   📝 Found post: "${title}" (ID: ${postId})`);
    
    if (!cache.seenEpisodes.includes(episodeId)) {
        console.log(`   🆕 Processing new Patreon post: ${title}`);
        const patreonPostUrl = `https://www.patreon.com/posts/${postId}`;
        
        // For Patreon posts, ONLY use Patreon link
        const links = getEpisodeLinks(title, null, true, patreonPostUrl); // true = Patreon only
        
        await createEpisodeThread(channel, title, links, true, patreonPostUrl); // true = Patreon only
        console.log(`✅ Created thread for structured Patreon episode: ${title}`);
        
        cache.seenEpisodes.push(episodeId);
    } else {
        console.log(`   ✅ Already seen post: ${title}`);
    }
}

async function processStructuredEpisodeData(data, channel, cache) {
    const title = data.name || data.title;
    if (!title) return;
    
    const episodeId = `structured_${title.replace(/[^\w]/g, '_')}`;
    
    if (!cache.seenEpisodes.includes(episodeId)) {
        // Assuming structured episodes are Patreon exclusive
        const patreonPostUrl = data.url || `https://www.patreon.com/lowlimitcashgames`;
        const links = getEpisodeLinks(title, null, true, patreonPostUrl);
        
        await createEpisodeThread(channel, title, links, true, patreonPostUrl);
        console.log(`✅ Created thread for structured episode: ${title}`);
        
        cache.seenEpisodes.push(episodeId);
    }
}

async function findEpisodeIds(episodeTitle, postSlug) {
    console.log(`🔍 Searching for episode IDs for: ${episodeTitle}`);
    
    try {
        // Method 1: Search Apple Podcasts API (if available)
        // Note: Apple doesn't have a public search API, but we can try iTunes Search
        const cleanTitle = encodeURIComponent(episodeTitle.substring(0, 50));
        const itunesSearchUrl = `https://itunes.apple.com/search?term=${cleanTitle}+Low+Limit+Cash+Games&entity=podcastEpisode&limit=5`;
        
        const itunesResponse = await fetch(itunesSearchUrl);
        if (itunesResponse.ok) {
            const itunesData = await itunesResponse.json();
            if (itunesData.results && itunesData.results.length > 0) {
                // Look for matching episode
                const match = itunesData.results.find(result => 
                    result.trackName && result.trackName.toLowerCase().includes(episodeTitle.toLowerCase().substring(0, 20))
                );
                if (match && match.trackId) {
                    console.log(`🍎 Found Apple Podcasts episode ID: ${match.trackId}`);
                    console.log(`📱 Full episode data: ${match.trackName} - ${match.trackViewUrl}`);
                    return {
                        apple: match.trackId,
                        spotify: null // We'll try to find Spotify ID separately
                    };
                }
            }
        }
        
        // Method 2: Try to extract from RSS if we have a working one
        // This would require the working Apple RSS URL
        
        console.log(`⚠️  Could not find specific episode IDs for: ${episodeTitle}`);
        return { apple: null, spotify: null };
        
    } catch (error) {
        console.error(`❌ Error finding episode IDs: ${error.message}`);
        return { apple: null, spotify: null };
    }
}

async function extractEpisodeIdsFromRSS(rssItem) {
    try {
        // RSS items often contain episode URLs or IDs in various fields
        let appleId = null;
        let spotifyId = null;
        
        // Look for iTunes episode ID in RSS item
        if (rssItem.itunes && rssItem.itunes.episode) {
            appleId = rssItem.itunes.episode;
        }
        
        // Look for episode URLs in enclosure or link fields
        if (rssItem.enclosure && rssItem.enclosure.url) {
            // Sometimes episode IDs are in the URL
            const urlMatch = rssItem.enclosure.url.match(/episode[_-]?(\d+)/i);
            if (urlMatch) {
                appleId = urlMatch[1];
            }
        }
        
        // Look in GUID for episode identifiers
        if (rssItem.guid) {
            const guidMatch = rssItem.guid.match(/(\d{10,})/);
            if (guidMatch) {
                appleId = guidMatch[1];
            }
        }
        
        console.log(`🔍 Extracted episode IDs from RSS - Apple: ${appleId}, Spotify: ${spotifyId}`);
        return { apple: appleId, spotify: spotifyId };
        
    } catch (error) {
        console.error(`❌ Error extracting episode IDs from RSS: ${error.message}`);
        return { apple: null, spotify: null };
    }
}

async function checkContent() {
    console.log('🔍 Checking for new content...');
    console.log('📡 Checking Spreaker RSS for public episodes...');
    await checkPodcast();
    console.log('🕷️ Scraping Patreon page for all episodes...');
    await scrapePatreonPage();
    console.log('✅ Content check completed');
}

client.once('ready', async () => {
    console.log(`🤖 Bot logged in as ${client.user.tag}!`);
    
    // Send startup message
    const channel = client.channels.cache.get(process.env.CHANNEL_ID);
    if (channel) {
        await channel.send('🚀 **Enhanced poker content bot is online!**\n📡 Now monitoring both public episodes and Patreon content\n📝 Type `!help` for test commands');
    }
    
    // Schedule checks every 15 minutes
    cron.schedule('*/15 * * * *', checkContent);
    
    // Initial check after 5 seconds
    setTimeout(() => {
        console.log('🚀 Starting initial content check...');
        checkContent();
    }, 5000);
});

// Test commands
client.on('messageCreate', async (message) => {
    // Ignore bot messages
    if (message.author.bot) return;
    
    // Only respond in your designated channel
    if (message.channel.id !== process.env.CHANNEL_ID) return;
    
    // Test commands
    if (message.content === '!test-rss') {
        await message.reply('🔍 Testing RSS feed...');
        try {
            await checkPodcast();
            await message.reply('✅ RSS check completed - check logs for details');
        } catch (error) {
            await message.reply(`❌ RSS test failed: ${error.message}`);
        }
    }
    
    if (message.content === '!test-patreon') {
        await message.reply('🕷️ Testing Patreon scraping...');
        try {
            await scrapePatreonPage();
            await message.reply('✅ Patreon scrape completed - check logs for details');
        } catch (error) {
            await message.reply(`❌ Patreon test failed: ${error.message}`);
        }
    }
    
    if (message.content === '!test-both') {
        await message.reply('🔍 Testing both RSS and Patreon...');
        try {
            await checkContent();
            await message.reply('✅ Full content check completed');
        } catch (error) {
            await message.reply(`❌ Content check failed: ${error.message}`);
        }
    }
    
    if (message.content === '!clear-cache') {
        try {
            const cache = {
                lastPodcastCheck: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(), // 24 hours ago
                lastPatreonCheck: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
                seenEpisodes: []
            };
            saveCache(cache);
            await message.reply('🗑️ Cache cleared - bot will now check for "new" episodes from the last 24 hours');
        } catch (error) {
            await message.reply(`❌ Cache clear failed: ${error.message}`);
        }
    }
    
    if (message.content === '!test-links') {
        // Test the new link generation
        const testTitle = "Test Episode: Cash Game Strategy";
        const testPatreonUrl = "https://www.patreon.com/posts/test-12345";
        
        const freeLinks = getEpisodeLinks(testTitle, null, false);
        const patreonLinks = getEpisodeLinks(testTitle, null, true, testPatreonUrl);
        
        await message.reply({
            embeds: [{
                title: "Link Generation Test",
                fields: [
                    {
                        name: "🆓 Free Episode Links",
                        value: `Apple: ${freeLinks.apple}\nSpotify: ${freeLinks.spotify}`,
                        inline: false
                    },
                    {
                        name: "🔒 Patreon Episode Links", 
                        value: `Patreon: ${patreonLinks.patreon}`,
                        inline: false
                    }
                ],
                color: 0x00ff00
            }]
        });
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
                    }
                ],
                color: 0x0099ff,
                timestamp: new Date().toISOString()
            }]
        });
    }
    
    if (message.content === '!help') {
        await message.reply({
            embeds: [{
                title: "🤖 Bot Test Commands",
                description: "Use these commands to test the bot functionality:",
                fields: [
                    {
                        name: "!test-rss",
                        value: "Test RSS feed checking for public episodes",
                        inline: false
                    },
                    {
                        name: "!test-patreon",
                        value: "Test Patreon page scraping for exclusive episodes", 
                        inline: false
                    },
                    {
                        name: "!test-both",
                        value: "Run full content check (both RSS and Patreon)",
                        inline: false
                    },
                    {
                        name: "!test-links",
                        value: "Test link generation for both episode types",
                        inline: false
                    },
                    {
                        name: "!clear-cache",
                        value: "Clear episode cache (will reprocess recent episodes)",
                        inline: false
                    },
                    {
                        name: "!status",
                        value: "Show bot status and last check times",
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
