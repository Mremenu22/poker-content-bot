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

function getEpisodeLinks(episodeTitle, episodeId = null) {
    // Direct episode links that work for connected patrons
    let appleLink = 'https://podcasts.apple.com/us/podcast/low-limit-cash-games/id1496651303';
    let spotifyLink = 'https://open.spotify.com/show/2ycOlKRTGA9ugMmIIjqjSE';
    
    // If we can extract episode ID from scraping, create direct episode links
    if (episodeId) {
        appleLink = `https://podcasts.apple.com/us/podcast/low-limit-cash-games/id1496651303?i=${episodeId}`;
        spotifyLink = `https://open.spotify.com/episode/${episodeId}`;
    }
    
    return {
        apple: appleLink,
        spotify: spotifyLink
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
                const links = getEpisodeLinks(item.title);
                await createEpisodeThread(channel, item.title, links, false);
                console.log(`✅ Created thread for public episode: ${item.title}`);
                
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
        
        // Look for post links and titles
        // Pattern: href="/posts/episode-title-12345" or similar
        const postLinkMatches = html.match(/href="\/posts\/([^"]+)"/g);
        const titleMatches = html.match(/data-tag="post-title"[^>]*>([^<]+)</g);
        
        if (postLinkMatches && titleMatches) {
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
                    const links = getEpisodeLinks(title);
                    await createEpisodeThread(channel, title, links, true, patreonPostUrl);
                    console.log(`✅ Created thread for Patreon episode: ${title}`);
                    console.log(`🔗 Patreon post: ${patreonPostUrl}`);
                    
                    // Add to seen episodes
                    cache.seenEpisodes.push(episodeId);
                }
            }
        }
        
        // Keep only last 50 seen episodes to prevent cache from growing too large
        if (cache.seenEpisodes.length > 50) {
            cache.seenEpisodes = cache.seenEpisodes.slice(-50);
        }
        
        cache.lastPatreonCheck = new Date().toISOString();
        saveCache(cache);
        
    } catch (error) {
        console.error('❌ Error scraping Patreon page:', error.message);
    }
}

async function checkAppleRSSForDetails() {
    try {
        // If you have a working Apple RSS URL, we can use it to get episode details
        // For now, we'll rely on the scraping approach
        console.log('Apple RSS check placeholder - using scraping for detection');
    } catch (error) {
        console.error('❌ Error checking Apple RSS:', error.message);
    }
}

async function checkContent() {
    console.log('🔍 Checking for new content...');
    await checkPodcast(); // Check Spreaker RSS for public episodes
    await scrapePatreonPage(); // Scrape Patreon page for all episodes
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
    
    // Initial check after 10 seconds
    setTimeout(checkContent, 10000);
});

// Handle graceful shutdown
process.on('SIGINT', () => {
    console.log('🛑 Bot shutting down...');
    client.destroy();
    process.exit(0);
});

client.login(process.env.DISCORD_BOT_TOKEN);
