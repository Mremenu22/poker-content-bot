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

function getEpisodeLinks(episodeTitle, episodeIds = null) {
    // Try to create direct episode links if we have IDs
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
    
    // Log the actual links being generated
    console.log(`🔗 Generated links for "${episodeTitle}":`);
    console.log(`   🍎 Apple: ${appleLink}`);
    console.log(`   🎵 Spotify: ${spotifyLink}`);
    console.log(`   📊 Direct links: ${!!(episodeIds?.apple || episodeIds?.spotify)}`);
    
    return {
        apple: appleLink,
        spotify: spotifyLink,
        isDirect: !!(episodeIds?.apple || episodeIds?.spotify)
    };
}

async function createEpisodeThread(channel, title, links, isPatreonOnly = false, patreonPostUrl = null) {
    // Create the thread with episode title
    const thread = await channel.threads.create({
        name: title,
        autoArchiveDuration: 1440, // 24 hours
        reason: 'New poker episode discussion'
    });

    let message = `**${title}**\n\n`;
    message += `🍎 **Apple Podcasts**\n${links.apple}\n\n`;
    message += `🎵 **Spotify**\n${links.spotify}`;
    
    if (isPatreonOnly && patreonPostUrl) {
        message += `\n\n🔗 **Patreon Post**\n${patreonPostUrl}`;
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
                // For public episodes, try to get specific episode IDs from RSS
                const episodeIds = await extractEpisodeIdsFromRSS(item);
                const links = getEpisodeLinks(item.title, episodeIds);
                
                await createEpisodeThread(channel, item.title, links, false);
                console.log(`✅ Created thread for public episode: ${item.title}`);
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
            
            // Try to parse JSON data for episode information
            const allJsonData = [...(jsonMatches || []), ...(jsonLdMatches || [])];
            
            for (const jsonScript of allJsonData) {
                try {
                    const jsonContent = jsonScript.replace(/<script[^>]*>/, '').replace(/<\/script>/, '');
                    const data = JSON.parse(jsonContent);
                    
                    // Look for episode/post data in various possible structures
                    if (data.props?.pageProps?.bootstrap?.post) {
                        const post = data.props.pageProps.bootstrap.post;
                        await processPatreonPost(post, channel, cache);
                    } else if (data.props?.pageProps?.bootstrap?.campaign?.posts) {
                        const posts = data.props.pageProps.bootstrap.campaign.posts;
                        for (const post of posts) {
                            await processPatreonPost(post, channel, cache);
                        }
                    } else if (data['@type'] === 'PodcastEpisode' || data.episodeNumber) {
                        await processStructuredEpisodeData(data, channel, cache);
                    }
                } catch (parseError) {
                    // Continue to next JSON block if this one fails to parse
                    continue;
                }
            }
        }
        
        // Fallback: Look for post links and titles in HTML
        const postLinkMatches = html.match(/href="\/posts\/([^"]+)"/g);
        const titleMatches = html.match(/data-tag="post-title"[^>]*>([^<]+)/g);
        
        if (postLinkMatches && titleMatches) {
            console.log(`📝 Found ${postLinkMatches.length} posts via HTML parsing`);
            
            for (let i = 0; i < Math.min(postLinkMatches.length, titleMatches.length); i++) {
                const postMatch = postLinkMatches[i];
                const titleMatch = titleMatches[i];
                
                // Extract post slug and title
                const postSlug = postMatch.match(/href="\/posts\/([^"]+)"/)[1];
                const title = titleMatch.replace(/data-tag="post-title"[^>]*>/, '').trim();
                const patreonPostUrl = `https://www.patreon.com/posts/${postSlug}`;
                
                const episodeId = `patreon_${postSlug}`;
                
                // Check if this is a new episode we haven't seen
                if (title.length > 10 && !cache.seenEpisodes.includes(episodeId)) {
                    // Try to get episode IDs by searching RSS feeds or making additional requests
                    const episodeIds = await findEpisodeIds(title, postSlug);
                    const links = getEpisodeLinks(title, episodeIds);
                    
                    await createEpisodeThread(channel, title, links, true, patreonPostUrl);
                    console.log(`✅ Created thread for Patreon episode: ${title}`);
                    console.log(`🔗 Patreon post: ${patreonPostUrl}`);
                    
                    // Show the actual clickable links for verification
                    console.log(`📲 COPY THESE LINKS TO TEST:`);
                    console.log(`   Apple Podcasts: ${links.apple}`);
                    console.log(`   Spotify: ${links.spotify}`);
                    
                    if (episodeIds.apple || episodeIds.spotify) {
                        console.log(`🎯 Found episode IDs - Apple: ${episodeIds.apple}, Spotify: ${episodeIds.spotify}`);
                    } else {
                        console.log(`⚠️  Using generic show links (no episode IDs found)`);
                    }
                    
                    // Add to seen episodes
                    cache.seenEpisodes.push(episodeId);
                }
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

async function processPatreonPost(post, channel, cache) {
    if (!post.attributes || !post.attributes.title) return;
    
    const title = post.attributes.title;
    const postId = post.id;
    const episodeId = `patreon_${postId}`;
    
    if (!cache.seenEpisodes.includes(episodeId)) {
        const patreonPostUrl = `https://www.patreon.com/posts/${postId}`;
        const episodeIds = await findEpisodeIds(title, postId);
        const links = getEpisodeLinks(title, episodeIds);
        
        await createEpisodeThread(channel, title, links, true, patreonPostUrl);
        console.log(`✅ Created thread for structured Patreon episode: ${title}`);
        
        cache.seenEpisodes.push(episodeId);
    }
}

async function processStructuredEpisodeData(data, channel, cache) {
    const title = data.name || data.title;
    if (!title) return;
    
    const episodeId = `structured_${title.replace(/[^\w]/g, '_')}`;
    
    if (!cache.seenEpisodes.includes(episodeId)) {
        const episodeIds = {
            apple: data.url?.find(url => url.includes('apple.com'))?.split('i=')[1],
            spotify: data.url?.find(url => url.includes('spotify.com'))?.split('/episode/')[1]
        };
        
        const links = getEpisodeLinks(title, episodeIds);
        await createEpisodeThread(channel, title, links, true);
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
        await channel.send('🚀 **Enhanced poker content bot is online!**\n📡 Now monitoring both public episodes and Patreon content');
    }
    
    // Schedule checks every 15 minutes
    cron.schedule('*/15 * * * *', checkContent);
    
    // Initial check after 5 seconds
    setTimeout(() => {
        console.log('🚀 Starting initial content check...');
        checkContent();
    }, 5000);
});

// Handle graceful shutdown
process.on('SIGINT', () => {
    console.log('🛑 Bot shutting down...');
    client.destroy();
    process.exit(0);
});

client.login(process.env.DISCORD_BOT_TOKEN);
