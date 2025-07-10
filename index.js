import { Client, GatewayIntentBits } from 'discord.js';
import Parser from 'rss-parser';
import cron from 'node-cron';
import fs from 'fs';
import dotenv from 'dotenv';

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
        lastPatreonCheck: new Date().toISOString()
    };
}

function saveCache(cache) {
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
}

function getEpisodeLinks(item) {
    const episodeTitle = item.title;
    
    // Get specific Apple Podcasts episode link if available
    let appleLink = 'https://podcasts.apple.com/us/podcast/low-limit-cash-games/id1496651303';
    if (item.link && item.link.includes('podcasts.apple.com')) {
        appleLink = item.link;
    }
    
    const spotifyLink = 'https://open.spotify.com/show/2ycOlKRTGA9ugMmIIjqjSE';
    
    // Create episode-specific Google search
    const cleanTitle = encodeURIComponent(episodeTitle.replace(/[^\w\s]/g, '').trim());
    const googleLink = `https://podcasts.google.com/search/${cleanTitle}%20Low%20Limit%20Cash%20Games`;
    
    return {
        apple: appleLink,
        spotify: spotifyLink,
        google: googleLink
    };
}

async function createEpisodeThread(channel, title, links) {
    // Create the thread with episode title
    const thread = await channel.threads.create({
        name: title,
        autoArchiveDuration: 1440, // 24 hours
        reason: 'New poker episode discussion'
    });

    // Post the links as the first message in the thread
    await thread.send(`**${title}**\n\n**iOS link**\n${links.apple}\n\n**Spotify link**\n${links.spotify}\n\n**Google Podcasts**\n${links.google}`);
    
    return thread;
}

async function checkPodcast() {
    const channel = client.channels.cache.get(process.env.CHANNEL_ID);
    if (!channel) return;

    const feed = await parser.parseURL(process.env.PODCAST_RSS_URL);
    const cache = loadCache();
    const lastCheck = new Date(cache.lastPodcastCheck);
    
    for (const item of feed.items) {
        const publishDate = new Date(item.pubDate);
        if (publishDate > lastCheck) {
            const links = getEpisodeLinks(item);
            await createEpisodeThread(channel, item.title, links);
            console.log(`Created thread for: ${item.title}`);
        }
    }
    
    cache.lastPodcastCheck = new Date().toISOString();
    saveCache(cache);
}

async function checkPatreon() {
    const channel = client.channels.cache.get(process.env.CHANNEL_ID);
    if (!channel) return;

    const feed = await parser.parseURL(process.env.PATREON_RSS_URL);
    const cache = loadCache();
    const lastCheck = new Date(cache.lastPatreonCheck);
    
    for (const item of feed.items) {
        const publishDate = new Date(item.pubDate);
        if (publishDate > lastCheck) {
            const links = getEpisodeLinks(item);
            
            // Create thread for Patreon content too
            const thread = await channel.threads.create({
                name: item.title,
                autoArchiveDuration: 1440,
                reason: 'New Patreon content discussion'
            });

            await thread.send(`**${item.title}**\n\n**iOS link**\n${links.apple}\n\n**Spotify link**\n${links.spotify}\n\n**Google Podcasts**\n${links.google}\n\n**Patreon**\nhttps://www.patreon.com/lowlimitcashgames`);
            
            console.log(`Created Patreon thread for: ${item.title}`);
        }
    }
    
    cache.lastPatreonCheck = new Date().toISOString();
    saveCache(cache);
}

async function checkContent() {
    console.log('Checking for new content...');
    await checkPodcast();
    await checkPatreon();
}

client.once('ready', async () => {
    console.log(`✅ Bot logged in as ${client.user.tag}!`);
    
    // Send test message
    const channel = client.channels.cache.get(process.env.CHANNEL_ID);
    if (channel) {
        await channel.send('🤖 **Thread-creating bot is online!**');
    }
    
    // Schedule checks every 15 minutes
    cron.schedule('*/15 * * * *', checkContent);
    
    // Initial check after 5 seconds
    setTimeout(checkContent, 5000);
});

client.login(process.env.DISCORD_BOT_TOKEN);
